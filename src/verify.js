// Automatic quality check, run on every output before the user sees it.
// Everything happens on the user's device; nothing is uploaded.

import { toLuma, compare, judge, overall } from "./quality.js";
import { formatSize } from "./core.js";
import * as pdf from "./pdf.js";

const ANALYSIS = 1000; // longest side, in px, used for comparison
const MAX_SAMPLE_PAGES = 6;

const pct = (x) => `${Math.round(x * 100)}%`;
const check = (status, label, detail = "") => ({ status, label, detail });

function sizeCheck(size, target, minBytes, expectFit) {
  const detail = isFinite(target) ? `${formatSize(size)}, limit ${formatSize(target)}` : formatSize(size);
  if (size <= target && size >= minBytes) return check("pass", "Meets your size limit", detail);
  if (!expectFit) return check("note", "Over your size limit", `${detail}. This is the smallest readable size.`);
  return check("fail", size > target ? "Over your size limit" : "Under your minimum size", detail);
}

function lumaOf(draw, w, h) {
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = "high";
  draw(ctx, w, h);
  const luma = toLuma(ctx.getImageData(0, 0, w, h).data, w * h);
  c.width = c.height = 0;
  return luma;
}

function scoreChecks(m) {
  return [
    m.ssim >= 0.9
      ? check("pass", "Looks like the original", `Similarity ${pct(m.ssim)}`)
      : m.ssim >= 0.75
      ? check("warn", "Slightly different from the original", `Similarity ${pct(m.ssim)}`)
      : check("fail", "Clearly different from the original", `Similarity ${pct(m.ssim)}`),
    m.sharp >= 0.75
      ? check("pass", "Text and edges stay sharp", `${pct(m.sharp)} of edge detail kept`)
      : m.sharp >= 0.5
      ? check("warn", "Edges are softer", `${pct(m.sharp)} of edge detail kept`)
      : check("fail", "Text and edges are blurry", `${pct(m.sharp)} of edge detail kept`),
  ];
}

function finish(checks, metrics) {
  return { verdict: overall(checks, metrics ? judge(metrics) : "good"), checks, metrics };
}

export async function checkImage({ original, outBlob, target, minBytes, expectFit = true, plan = null }) {
  const checks = [];
  if (isFinite(target) || minBytes) checks.push(sizeCheck(outBlob.size, target, minBytes, expectFit));
  let outBmp;
  try {
    outBmp = await createImageBitmap(outBlob);
    checks.push(check("pass", "File opens correctly"));
  } catch {
    checks.push(check("fail", "File does not open"));
    return finish(checks, null);
  }
  // Compare against the part of the original that was kept (it may have been cropped).
  const src = plan ? { sx: plan.sx, sy: plan.sy, sw: plan.sw, sh: plan.sh } : { sx: 0, sy: 0, sw: original.width, sh: original.height };
  // When the user asked for specific pixel dimensions, judge at those dimensions:
  // shrinking on purpose is not a flaw, so don't blow the output back up to the original's size.
  const asked = plan && plan.active;
  const baseW = asked ? outBmp.width : src.sw;
  const baseH = asked ? outBmp.height : src.sh;
  const k = Math.min(1, ANALYSIS / Math.max(baseW, baseH));
  const w = Math.max(16, Math.round(baseW * k));
  const h = Math.max(16, Math.round(baseH * k));
  const ref = lumaOf((ctx) => ctx.drawImage(original, src.sx, src.sy, src.sw, src.sh, 0, 0, w, h), w, h);
  const out = lumaOf((ctx) => ctx.drawImage(outBmp, 0, 0, w, h), w, h);
  const m = compare(ref, out, w, h);
  checks.push(...scoreChecks(m));

  if (plan && plan.active) {
    checks.push(check("pass", plan.exact ? "Exact pixel size" : "Within your pixel limit", `${outBmp.width}×${outBmp.height}px`));
    if (plan.exact && src.sw < outBmp.width * 0.99) {
      checks.push(check("warn", "Enlarged to reach this size", `Original detail is ${Math.round(src.sw)}px wide, so it may look soft`));
    }
    if (plan.exact && (src.sw < original.width * 0.99 || src.sh < original.height * 0.99)) {
      checks.push(check("note", "Edges were cropped", "To match the shape of the size you asked for"));
    }
  } else {
    const ratio = outBmp.width / original.width;
    checks.push(
      ratio < 0.6
        ? check("warn", "Resolution reduced", `${outBmp.width}×${outBmp.height}px, ${pct(ratio)} of original`)
        : check("pass", ratio < 0.99 ? "Resolution mostly kept" : "Full resolution kept", `${outBmp.width}×${outBmp.height}px`)
    );
  }
  outBmp.close();
  return finish(checks, m);
}

async function textChars(doc) {
  let n = 0;
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    for (const it of tc.items) n += (it.str || "").replace(/\s/g, "").length;
  }
  return n;
}

async function pageLuma(doc, n, scale) {
  const page = await doc.getPage(n);
  const vp = page.getViewport({ scale });
  const c = document.createElement("canvas");
  c.width = Math.round(vp.width);
  c.height = Math.round(vp.height);
  const ctx = c.getContext("2d", { willReadFrequently: true });
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, c.width, c.height);
  await page.render({ canvasContext: ctx, viewport: vp }).promise;
  const luma = toLuma(ctx.getImageData(0, 0, c.width, c.height).data, c.width * c.height);
  const dims = { w: c.width, h: c.height };
  c.width = c.height = 0;
  return { luma, ...dims };
}

function samplePages(count) {
  if (count <= MAX_SAMPLE_PAGES) return Array.from({ length: count }, (_, i) => i + 1);
  const picks = new Set([1, count]);
  for (let i = 1; picks.size < MAX_SAMPLE_PAGES; i++) picks.add(1 + Math.round((i * (count - 1)) / (MAX_SAMPLE_PAGES - 1)));
  return [...picks].sort((a, b) => a - b);
}

export async function checkPdf({ originalBytes, outBytes, target, minBytes, flattened = false, expectFit = true }) {
  const checks = [sizeCheck(outBytes.length, target, minBytes, expectFit)];
  let a, b;
  try {
    a = await pdf.openForRender(originalBytes);
    b = await pdf.openForRender(outBytes);
    checks.push(check("pass", "File opens correctly"));
  } catch {
    a?.destroy();
    checks.push(check("fail", "File does not open"));
    return finish(checks, null);
  }
  try {
    // Pages
    if (a.numPages !== b.numPages) {
      checks.push(check("fail", "Pages missing", `${b.numPages} of ${a.numPages} pages`));
      return finish(checks, null);
    }
    checks.push(check("pass", "All pages kept", `${a.numPages} page${a.numPages === 1 ? "" : "s"}`));

    // Page sizes
    let sameSize = true;
    for (let i = 1; i <= a.numPages && sameSize; i++) {
      const [pa, pb] = [await a.getPage(i), await b.getPage(i)];
      const [va, vb] = [pa.getViewport({ scale: 1 }), pb.getViewport({ scale: 1 })];
      sameSize = Math.abs(va.width - vb.width) < 2 && Math.abs(va.height - vb.height) < 2;
    }
    checks.push(sameSize ? check("pass", "Page sizes unchanged") : check("warn", "Page sizes changed"));

    // Text
    const [ta, tb] = [await textChars(a), await textChars(b)];
    if (ta === 0) checks.push(check("pass", "No selectable text to lose", "This looks like a scan"));
    else if (flattened && tb === 0) checks.push(check("note", "Text is no longer selectable", "You chose to convert pages to images"));
    else if (tb >= ta * 0.98) checks.push(check("pass", "Text kept and selectable"));
    else checks.push(check("fail", "Some text was lost", `${pct(tb / ta)} of text remains`));

    // Visual comparison on a sample of pages
    const first = await a.getPage(1);
    const base = first.getViewport({ scale: 1 });
    const scale = Math.min(2, ANALYSIS / Math.max(base.width, base.height));
    let worst = null;
    let worstPage = 1;
    for (const n of samplePages(a.numPages)) {
      const [ra, rb] = [await pageLuma(a, n, scale), await pageLuma(b, n, scale)];
      if (ra.w !== rb.w || ra.h !== rb.h) continue;
      const m = compare(ra.luma, rb.luma, ra.w, ra.h);
      if (!worst || m.ssim < worst.ssim) {
        worst = m;
        worstPage = n;
      }
    }
    if (worst) {
      const sc = scoreChecks(worst);
      if (a.numPages > 1) sc[0].detail += `, weakest page ${worstPage}`;
      checks.push(...sc);
    }
    return finish(checks, worst);
  } finally {
    a.destroy();
    b.destroy();
  }
}

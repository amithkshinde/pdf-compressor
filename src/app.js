import { fitToTarget, padJpeg, toBytes, formatSize } from "./core.js";
import * as pdf from "./pdf.js";
import { checkImage, checkPdf } from "./verify.js";

const $ = (id) => document.getElementById(id);
const MAX_INPUT_BYTES = 50 * 1000 * 1000;

let file = null;
let kind = null; // "image" | "pdf"
let plan = null; // image output geometry for the current run
let bitmap = null; // image only
let pdfBytes = null; // pdf only
let pdfPages = 0;
let pending = null; // pdf: target info kept for the opt-in "convert to images" step
let limits = { target: 0, minBytes: 0, flattened: false }; // what the quality check compares against
let urls = [];

function trackUrl(blob) {
  const u = URL.createObjectURL(blob);
  urls.push(u);
  return u;
}
function clearUrls() {
  urls.forEach(URL.revokeObjectURL);
  urls = [];
}
function showInfo(text) {
  const el = $("file-info");
  el.textContent = text;
  el.hidden = false;
}

async function loadFile(f) {
  if (!f) return;
  const isPdf = f.type === "application/pdf" || /\.pdf$/i.test(f.name);
  if (!isPdf && !/^image\/(jpeg|png|webp)$/.test(f.type)) {
    return showInfo("Unsupported file. Please choose a PDF, JPG, PNG or WEBP.");
  }
  if (f.size > MAX_INPUT_BYTES) {
    return showInfo("This file is over 50 MB. Please choose a smaller one.");
  }
  try {
    if (isPdf) {
      pdfBytes = new Uint8Array(await f.arrayBuffer());
      pdfPages = await pdf.pageCount(pdfBytes);
      bitmap = null;
      kind = "pdf";
      showInfo(`${f.name} · ${formatSize(f.size)} · ${pdfPages} page${pdfPages === 1 ? "" : "s"}`);
    } else {
      bitmap = await createImageBitmap(f, { imageOrientation: "from-image" });
      pdfBytes = null;
      kind = "image";
      showInfo(`${f.name} · ${formatSize(f.size)} · ${bitmap.width}×${bitmap.height}px`);
    }
  } catch (e) {
    return showInfo(
      e instanceof pdf.EncryptedPdfError
        ? "This PDF is password-protected. Remove the password first, then try again."
        : "This file could not be opened. It may be corrupt."
    );
  }
  file = f;
  pending = null;
  clearUrls();
  $("result").hidden = true;
  renderPresets();
  $("dims-box").hidden = kind !== "image";
  $("cur-dims").textContent = kind === "image" ? `Your image is ${bitmap.width} × ${bitmap.height} px.` : "";
  $("target-card").hidden = false;
}

const PRESETS = {
  image: [["Signature", 50, "KB"], ["Photo", 100, "KB"], ["ID photo", 200, "KB"], ["Scanned ID", 500, "KB"]],
  pdf: [["Certificate", 200, "KB"], ["ID proof", 500, "KB"], ["Application form", 1, "MB"], ["Resume", 2, "MB"]],
};

function renderPresets() {
  const box = $("presets");
  box.replaceChildren();
  // Only suggest sizes smaller than the file; larger ones need no compression.
  const list = PRESETS[kind].filter(([, v, u]) => v * (u === "MB" ? 1e6 : 1e3) < file.size);
  list.forEach(([name, v, u]) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.v = v;
    b.dataset.u = u;
    b.textContent = `${name} ${v} ${u}`;
    box.appendChild(b);
  });
  box.hidden = list.length === 0;
}

function offerLossy(target) {
  const b = $("lossy");
  b.textContent = `Yes, go down to ${formatSize(target)} anyway`;
  b.hidden = false;
}

function readDims() {
  // Optional pixel limits (images only). Returns the output geometry, or null on a user error.
  if (kind !== "image") return { active: false, exact: false };
  const full = { sx: 0, sy: 0, sw: bitmap.width, sh: bitmap.height, outW: bitmap.width, outH: bitmap.height, exact: false, active: false };
  const W = parseInt($("dim-w").value, 10) || 0;
  const H = parseInt($("dim-h").value, 10) || 0;
  if (!W && !H) return full;
  const bw = bitmap.width, bh = bitmap.height;
  const exact = document.querySelector('input[name="dim-mode"]:checked').value === "exact";
  if (exact) {
    if (!W || !H) {
      showMessage("Enter both width and height for an exact size.", "warn");
      return null;
    }
    const s = Math.max(W / bw, H / bh); // cover, then crop the overflow evenly
    const sw = W / s, sh = H / s;
    return { sx: (bw - sw) / 2, sy: (bh - sh) / 2, sw, sh, outW: W, outH: H, exact: true, active: true };
  }
  const s = Math.min(1, W ? W / bw : Infinity, H ? H / bh : Infinity); // never enlarge
  return { ...full, outW: Math.max(1, Math.round(bw * s)), outH: Math.max(1, Math.round(bh * s)), active: true };
}

function readTargets() {
  const p = readDims();
  if (!p) return null;
  const value = parseFloat($("target").value);
  let target;
  const unit = $("unit").value;
  if (value > 0) target = toBytes(value, unit, "max");
  else if (p.active) target = Infinity; // dimensions only, no size limit
  else {
    showMessage(kind === "image" ? "Enter the maximum size, or a width and height." : "Enter the maximum size first.", "warn");
    return null;
  }
  const minVal = parseFloat($("min").value);
  const minBytes = minVal > 0 ? toBytes(minVal, unit, "min") : 0;
  if (minBytes && minBytes > target) {
    showMessage("The minimum is larger than the maximum.", "warn");
    return null;
  }
  return { target, minBytes, plan: p };
}

function busy(on, label) {
  const btn = $("go");
  btn.disabled = on;
  $("flatten").disabled = on;
  $("lossy").disabled = on;
  btn.textContent = on ? label || "Optimising…" : "Make it fit";
}

async function run() {
  const t = readTargets();
  if (!t) return;
  busy(true);
  clearUrls();
  $("result").hidden = true;
  $("flatten").hidden = true;
  $("lossy").hidden = true;
  pending = null;
  plan = t.plan;
  limits = { ...t, flattened: false };
  try {
    const resizes = kind === "image" && (plan.outW !== bitmap.width || plan.outH !== bitmap.height || plan.exact);
    if (!resizes && file.size <= t.target && file.size >= t.minBytes) {
      const msg = isFinite(t.target)
        ? `Already ${formatSize(file.size)}, within your ${formatSize(t.target)} limit. No change needed.`
        : `Already within your pixel limit (${bitmap.width}×${bitmap.height} px). No change needed.`;
      return await present(file, msg, "ok");
    }
    if (kind === "pdf") await runPdf(t);
    else await runImage(t);
  } catch (e) {
    console.error(e);
    showMessage("Something went wrong while compressing. Please try again.", "warn");
  } finally {
    busy(false);
  }
}

// ---------- images ----------

const canvas = document.createElement("canvas");
function imageEncoder() {
  const p = plan;
  return (scale, quality) =>
    new Promise((resolve, reject) => {
      canvas.width = Math.max(1, Math.round(p.outW * scale));
      canvas.height = Math.max(1, Math.round(p.outH * scale));
      const ctx = canvas.getContext("2d");
      ctx.imageSmoothingQuality = "high";
      ctx.fillStyle = "#fff"; // JPEG has no transparency
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, p.sx, p.sy, p.sw, p.sh, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Encoding failed"))), "image/jpeg", quality);
    });
}

async function runImage({ target, minBytes }) {
  // An exact pixel size can't be reduced further, so only quality may change.
  const outcome = await fitToTarget(imageEncoder(), target, plan.exact ? { scales: [1] } : {});
  if (!outcome.ok) {
    const s = outcome.smallest;
    pending = { target, minBytes };
    offerLossy(target);
    await present(s.result, `${formatSize(target)} is lower than this file can go without losing quality. The smallest clear version is ${formatSize(s.result.size)}. Do you really want to go down to ${formatSize(target)}? It will look worse.`, "warn", {
      caption: dimsCaption(s.scale),
      download: `Keep the clear ${formatSize(s.result.size)} version`,
      expectFit: false,
    });
    return;
  }
  let blob = outcome.result;
  if (minBytes && blob.size < minBytes) {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    blob = new Blob([padJpeg(bytes, minBytes)], { type: "image/jpeg" });
  }
  const dims = plan.active ? ` Resized to ${Math.round(plan.outW * outcome.scale)}×${Math.round(plan.outH * outcome.scale)} px.` : "";
  const msg = isFinite(target)
    ? `Done: ${formatSize(blob.size)}, within your ${formatSize(target)} limit.${dims}`
    : `Done: ${formatSize(blob.size)}.${dims}`;
  await present(blob, msg, "ok", { caption: dimsCaption(outcome.scale) });
}

function dimsCaption(scale) {
  return ` · ${Math.round(plan.outW * scale)}×${Math.round(plan.outH * scale)}px`;
}

// ---------- PDFs ----------

async function finishPdf(result, minBytes) {
  let bytes = result.bytes;
  if (minBytes && bytes.length < minBytes) bytes = await pdf.padPdf(result.doc, bytes, minBytes);
  return new Blob([bytes], { type: "application/pdf" });
}

async function runPdf({ target, minBytes }) {
  // Stage 1: lossless. Text stays selectable.
  const lossless = await pdf.saveLossless(pdfBytes);
  if (lossless.bytes.length <= target) {
    const blob = await finishPdf(lossless, minBytes);
    return present(blob, `Done: ${formatSize(blob.size)}, within your ${formatSize(target)} limit. Text and layout are unchanged.`, "ok");
  }

  // Stage 2: recompress embedded JPEG scans. Text stays selectable.
  let smallest = { size: lossless.bytes.length, bytes: lossless.bytes, doc: lossless.doc };
  const images = await pdf.prepareImages(pdfBytes);
  if (images.length) {
    try {
      const outcome = await fitToTarget(pdf.makeRecompressEncoder(pdfBytes, images), target);
      if (outcome.ok) {
        const blob = await finishPdf(outcome.result, minBytes);
        return present(
          blob,
          `Done: ${formatSize(blob.size)}, within your ${formatSize(target)} limit. Scanned images were recompressed; text is unchanged.`,
          "ok"
        );
      }
      smallest = outcome.smallest.result;
    } finally {
      images.forEach((i) => i.bitmap.close());
    }
  }

  // Stage 3 needs the user's consent: it removes selectable text.
  pending = { target, minBytes };
  const blob = new Blob([smallest.bytes], { type: "application/pdf" });
  const tooLong = pdfPages > pdf.FLATTEN_MAX_PAGES;
  if (tooLong && !images.length) $("lossy").hidden = true;
  else offerLossy(target);
  await present(
    blob,
    `${formatSize(target)} is lower than this PDF can go without losing quality. The smallest clear version is ${formatSize(blob.size)}, with text intact. Do you really want to go down to ${formatSize(target)}? It will look worse.` +
      (tooLong
        ? ` Converting pages to images only works for up to ${pdf.FLATTEN_MAX_PAGES} pages; this PDF has ${pdfPages}.`
        : " Converting pages to images also gets smaller, but text can no longer be selected or searched."),
    "warn",
    { download: `Keep the clear ${formatSize(blob.size)} version`, expectFit: false }
  );
  $("flatten").hidden = tooLong;
}

async function runFlatten() {
  if (!pending) return;
  const { target, minBytes } = pending;
  busy(true, "Converting…");
  $("result").hidden = true;
  $("lossy").hidden = true;
  limits = { target, minBytes, flattened: true };
  const encode = await pdf.makeFlattenEncoder(pdfBytes);
  try {
    const outcome = await fitToTarget(encode, target, { scales: pdf.FLATTEN_SCALES, floorQuality: 0.4 });
    $("flatten").hidden = true;
    if (!outcome.ok) {
      offerLossy(target);
      const s = outcome.smallest.result;
      const blob = new Blob([s.bytes], { type: "application/pdf" });
      return await present(blob, `As page images, ${formatSize(target)} is lower than these pages can go without losing quality. The smallest clear version is ${formatSize(blob.size)}. Do you really want to go down to ${formatSize(target)}? It will look worse.`, "warn", { download: `Keep the clear ${formatSize(blob.size)} version`, expectFit: false });
    }
    const blob = await finishPdf(outcome.result, minBytes);
    await present(
      blob,
      `Done: ${formatSize(blob.size)}, within your ${formatSize(target)} limit. Pages are now images, so text can't be selected or searched.`,
      "warn"
    );
  } catch (e) {
    console.error(e);
    showMessage("Something went wrong while converting. Please try again.", "warn");
  } finally {
    encode.close();
    busy(false);
  }
}

// ---------- shrink further (lossy) ----------
// Opt-in last resort: goes below the "readable" floor. Lowering resolution first
// (soft but legible) and only then dropping JPEG quality (blocky).

const LOSSY_SCALES = [1, 0.8, 0.6, 0.5, 0.4, 0.3, 0.25, 0.2, 0.15, 0.1];
const LOSSY_FLATTEN_SCALES = [1.15, 0.85, 0.7, 0.55, 0.4, 0.3, 0.2];

async function lossyFit(encode, target, scales) {
  const first = await fitToTarget(encode, target, { scales, floorQuality: 0.35 });
  if (first.ok) return first;
  return fitToTarget(encode, target, { scales, floorQuality: 0.15 });
}

const LOSSY_NOTE = "Quality was lowered to reach this size. Check the preview before you upload.";

async function runLossy() {
  if (!pending) return;
  const { target, minBytes } = pending;
  busy(true, "Shrinking…");
  $("result").hidden = true;
  $("lossy").hidden = true;
  $("flatten").hidden = true;
  limits = { target, minBytes, flattened: false, plan };
  try {
    if (kind === "image") return await lossyImage(target, minBytes);
    await lossyPdf(target, minBytes);
  } catch (e) {
    console.error(e);
    showMessage("Something went wrong while shrinking. Please try again.", "warn");
  } finally {
    busy(false);
  }
}

async function lossyImage(target, minBytes) {
  const o = await lossyFit(imageEncoder(), target, plan.exact ? [1] : LOSSY_SCALES);
  if (!o.ok) {
    const s = o.smallest;
    return present(s.result, `This is as small as it can go: ${formatSize(s.result.size)}. It is still over ${formatSize(target)}.`, "warn", {
      caption: dimsCaption(s.scale), download: "Download smallest anyway", expectFit: false,
    });
  }
  let blob = o.result;
  if (minBytes && blob.size < minBytes) {
    blob = new Blob([padJpeg(new Uint8Array(await blob.arrayBuffer()), minBytes)], { type: "image/jpeg" });
  }
  await present(blob, `Done: ${formatSize(blob.size)}, within your ${formatSize(target)} limit. ${LOSSY_NOTE}`, "warn", { caption: dimsCaption(o.scale) });
}

async function lossyPdf(target, minBytes) {
  let smallest = null;
  // First keep the text: squeeze the embedded scans harder.
  const images = await pdf.prepareImages(pdfBytes);
  if (images.length) {
    try {
      const o = await lossyFit(pdf.makeRecompressEncoder(pdfBytes, images), target, LOSSY_SCALES);
      if (o.ok) {
        const blob = await finishPdf(o.result, minBytes);
        return present(blob, `Done: ${formatSize(blob.size)}, within your ${formatSize(target)} limit. Scans were compressed harder; text is unchanged. ${LOSSY_NOTE}`, "warn");
      }
      smallest = o.smallest.result;
    } finally {
      images.forEach((i) => i.bitmap.close());
    }
  }
  // Then turn pages into low-resolution images.
  if (pdfPages <= pdf.FLATTEN_MAX_PAGES) {
    const encode = await pdf.makeFlattenEncoder(pdfBytes);
    try {
      limits.flattened = true;
      const o = await lossyFit(encode, target, LOSSY_FLATTEN_SCALES);
      if (o.ok) {
        const blob = await finishPdf(o.result, minBytes);
        return present(blob, `Done: ${formatSize(blob.size)}, within your ${formatSize(target)} limit. Pages are now low-quality images, so text can't be selected. ${LOSSY_NOTE}`, "warn");
      }
      smallest = o.smallest.result;
    } finally {
      encode.close();
    }
  }
  const blob = new Blob([smallest.bytes], { type: "application/pdf" });
  await present(blob, `This is as small as it can go: ${formatSize(blob.size)}. It is still over ${formatSize(target)}.`, "warn", { download: "Download smallest anyway", expectFit: false });
}

// ---------- result card ----------

function showMessage(text, cls) {
  $("result").hidden = false;
  $("msg").textContent = text;
  $("msg").className = cls;
}

async function previewUrl(blobOrFile, isOriginal) {
  if (kind === "image") return trackUrl(blobOrFile);
  try {
    const bytes = isOriginal ? pdfBytes : new Uint8Array(await blobOrFile.arrayBuffer());
    return trackUrl(await pdf.renderPreview(bytes));
  } catch {
    return "";
  }
}

async function runCheck(blob, expectFit) {
  $("go").textContent = "Checking quality…";
  try {
    if (kind === "image") {
      return await checkImage({ original: bitmap, outBlob: blob, ...limits, expectFit });
    }
    const outBytes = new Uint8Array(await blob.arrayBuffer());
    return await checkPdf({ originalBytes: pdfBytes, outBytes, ...limits, expectFit });
  } catch (e) {
    console.error(e);
    return null; // a failed check must never block the download
  }
}

const VERDICT_TEXT = {
  good: "Quality check passed",
  fair: "Quality check: acceptable. Review the preview before uploading.",
  poor: "Quality check failed. This output may be hard to read.",
};
const SYMBOL = { pass: "pass", warn: "warn", fail: "fail", note: "note" };

function showVerdict(report) {
  const box = $("verdict");
  if (!report) {
    box.hidden = true;
    return;
  }
  box.hidden = false;
  box.className = `verdict ${report.verdict}`;
  $("verdict-title").textContent = VERDICT_TEXT[report.verdict];
  const list = $("checks");
  list.replaceChildren();
  for (const c of report.checks) {
    const li = document.createElement("li");
    li.className = SYMBOL[c.status];
    li.textContent = c.label;
    if (c.detail) {
      const d = document.createElement("span");
      d.textContent = ` · ${c.detail}`;
      li.append(d);
    }
    list.append(li);
  }
}

async function present(blob, text, cls, opts = {}) {
  // Check the output before the user sees it. The untouched original needs no check.
  const report = blob === file ? null : await runCheck(blob, opts.expectFit !== false);
  if (report && report.verdict === "poor" && cls === "ok") cls = "warn";
  showMessage(text, cls);
  showVerdict(report);
  const before = $("img-before");
  const after = $("img-after");
  before.removeAttribute("src");
  after.removeAttribute("src");
  $("cap-before").textContent = `Original · ${formatSize(file.size)}`;
  const extra = opts.caption || (kind === "pdf" ? ` · ${pdfPages} page${pdfPages === 1 ? "" : "s"}` : "");
  $("cap-after").textContent = `New · ${formatSize(blob.size)}${extra}`;

  const base = file.name.replace(/\.[^.]+$/, "");
  const ext = kind === "pdf" ? "pdf" : "jpg";
  const dl = $("download");
  dl.href = trackUrl(blob);
  dl.download = blob === file ? file.name : `${base}-fit.${ext}`;
  dl.textContent = opts.download || (report && report.verdict === "poor" ? "Download anyway" : "Download");
  $("result").scrollIntoView({ behavior: "smooth", block: "nearest" });

  const [b, a] = await Promise.all([previewUrl(file, true), previewUrl(blob, false)]);
  if (b) before.src = b;
  if (a) after.src = a;
}

$("file").addEventListener("change", (e) => loadFile(e.target.files[0]));
$("go").addEventListener("click", run);
$("flatten").addEventListener("click", runFlatten);
$("lossy").addEventListener("click", runLossy);
$("presets").addEventListener("click", (e) => {
  const b = e.target.closest("button");
  if (!b) return;
  $("target").value = b.dataset.v;
  $("unit").value = b.dataset.u;
});
const drop = $("drop");
["dragenter", "dragover"].forEach((t) =>
  drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.add("over"); })
);
["dragleave", "drop"].forEach((t) =>
  drop.addEventListener(t, (e) => { e.preventDefault(); drop.classList.remove("over"); })
);
drop.addEventListener("drop", (e) => loadFile(e.dataTransfer.files[0]));

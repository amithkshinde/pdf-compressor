// On-device PDF optimisation. Three stages, from least to most destructive:
//   1. lossless  : strip metadata, pack objects          (text stays selectable)
//   2. recompress: re-encode embedded JPEG scans smaller  (text stays selectable)
//   3. flatten   : render pages to images, rebuild PDF    (text NOT selectable; opt-in)
// Browser-only parts (canvas, pdf.js) are imported lazily so the pure parts run in Node tests.

import { PDFDocument, PDFName, PDFRawStream } from "../vendor/pdf-lib.esm.min.js";

export const FLATTEN_MAX_PAGES = 25; // keeps rendered pages within phone memory
export const FLATTEN_SCALES = [1.5, 1.3, 1.15, 1, 0.85]; // 72 dpi x scale; below ~1.15 text gets soft

const SAVE_OPTS = { useObjectStreams: true, addDefaultPage: false };

export class EncryptedPdfError extends Error {}

export async function loadPdf(bytes) {
  try {
    return await PDFDocument.load(bytes, { updateMetadata: false });
  } catch (e) {
    if (/encrypt/i.test(String(e && e.message))) {
      throw new EncryptedPdfError("This PDF is password-protected.");
    }
    throw e;
  }
}

function stripMetadata(doc) {
  doc.context.trailerInfo.Info = undefined;
  doc.catalog.delete(PDFName.of("Metadata"));
}

/** Stage 1. Returns { bytes, doc }. */
export async function saveLossless(srcBytes) {
  const doc = await loadPdf(srcBytes);
  stripMetadata(doc);
  const bytes = await doc.save(SAVE_OPTS);
  return { bytes, doc };
}

// ---------- Stage 2: recompress embedded JPEG images ----------

const nameOf = (obj) => (obj && obj.asString ? obj.asString() : "");

function isSimpleJpeg(dict) {
  const filter = dict.get(PDFName.of("Filter"));
  const single = filter && (filter.size ? (filter.size() === 1 ? filter.get(0) : null) : filter);
  if (nameOf(single) !== "/DCTDecode") return false;
  if (nameOf(dict.get(PDFName.of("Subtype"))) !== "/Image") return false;
  const cs = nameOf(dict.get(PDFName.of("ColorSpace")));
  if (cs !== "/DeviceRGB" && cs !== "/DeviceGray") return false;
  if (dict.has(PDFName.of("Decode")) || dict.has(PDFName.of("Mask"))) return false;
  if (dict.has(PDFName.of("ImageMask"))) return false;
  const bpc = dict.get(PDFName.of("BitsPerComponent"));
  return !bpc || bpc.asNumber() === 8;
}

/** Decode every simple JPEG image once; the result is reused across search probes. */
export async function prepareImages(srcBytes) {
  const doc = await loadPdf(srcBytes);
  const found = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream) || !isSimpleJpeg(obj.dict)) continue;
    const bytes = obj.getContents();
    let bitmap;
    try {
      bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }), {
        imageOrientation: "none",
      });
    } catch {
      continue; // leave undecodable images alone
    }
    found.push({ ref, original: bytes, bitmap, smask: obj.dict.get(PDFName.of("SMask")) });
  }
  return found;
}

async function encodeBitmap(bitmap, scale, quality, canvas) {
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#fff";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise((res) => canvas.toBlob(res, "image/jpeg", quality));
  return { bytes: new Uint8Array(await blob.arrayBuffer()), w: canvas.width, h: canvas.height };
}

/** Encoder for fitToTarget: (scale, quality) -> { size, bytes, doc }. */
export function makeRecompressEncoder(srcBytes, images) {
  const canvas = document.createElement("canvas");
  return async (scale, quality) => {
    const doc = await loadPdf(srcBytes);
    stripMetadata(doc);
    for (const img of images) {
      const out = await encodeBitmap(img.bitmap, scale, quality, canvas);
      if (out.bytes.length >= img.original.length) continue; // never make an image bigger
      const dict = {
        Type: "XObject",
        Subtype: "Image",
        Width: out.w,
        Height: out.h,
        ColorSpace: "DeviceRGB",
        BitsPerComponent: 8,
        Filter: "DCTDecode",
      };
      if (img.smask) dict.SMask = img.smask;
      doc.context.assign(img.ref, doc.context.stream(out.bytes, dict));
    }
    const bytes = await doc.save(SAVE_OPTS);
    return { size: bytes.length, bytes, doc };
  };
}

// ---------- Stage 3: flatten pages to images (opt-in) ----------

let pdfjsPromise = null;
function pdfjs() {
  pdfjsPromise ||= import("../vendor/pdf.min.mjs").then((m) => {
    m.GlobalWorkerOptions.workerSrc = new URL("../vendor/pdf.worker.min.mjs", import.meta.url).href;
    return m;
  });
  return pdfjsPromise;
}

export async function openForRender(srcBytes) {
  const lib = await pdfjs();
  return lib.getDocument({ data: srcBytes.slice(), isEvalSupported: false }).promise;
}

/** Render page 1 to a small JPEG blob for the before/after preview. */
export async function renderPreview(srcBytes, maxWidth = 360) {
  const pdf = await openForRender(srcBytes);
  try {
    const page = await pdf.getPage(1);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, maxWidth / base.width) });
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvasContext: ctx, viewport }).promise;
    return await new Promise((res) => canvas.toBlob(res, "image/jpeg", 0.8));
  } finally {
    pdf.destroy();
  }
}

export async function pageCount(srcBytes) {
  return (await loadPdf(srcBytes)).getPageCount();
}

/** Encoder for fitToTarget: renders pages once per scale, then re-encodes per quality. */
export async function makeFlattenEncoder(srcBytes) {
  const pdf = await openForRender(srcBytes);
  let cache = { scale: null, pages: [] };

  const release = () => {
    cache.pages.forEach((p) => (p.canvas.width = p.canvas.height = 0));
    cache = { scale: null, pages: [] };
  };

  async function renderAll(scale) {
    release();
    const pages = [];
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const pt = page.getViewport({ scale: 1 }); // size in PDF points, rotation applied
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.round(viewport.width);
      canvas.height = Math.round(viewport.height);
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, viewport }).promise;
      pages.push({ canvas, wPt: pt.width, hPt: pt.height });
    }
    cache = { scale, pages };
  }

  const encode = async (scale, quality) => {
    if (cache.scale !== scale) await renderAll(scale);
    const out = await PDFDocument.create();
    for (const p of cache.pages) {
      const blob = await new Promise((res) => p.canvas.toBlob(res, "image/jpeg", quality));
      const img = await out.embedJpg(new Uint8Array(await blob.arrayBuffer()));
      const page = out.addPage([p.wPt, p.hPt]);
      page.drawImage(img, { x: 0, y: 0, width: p.wPt, height: p.hPt });
    }
    stripMetadata(out);
    const bytes = await out.save(SAVE_OPTS);
    return { size: bytes.length, bytes, doc: out };
  };
  encode.close = () => {
    release();
    pdf.destroy();
  };
  return encode;
}

// ---------- Padding to a minimum size ----------

/**
 * Grow a PDF to at least minBytes by adding an unreferenced, uncompressed stream
 * object inside the file. Page content is untouched and the file stays valid.
 */
export async function padPdf(doc, bytes, minBytes) {
  if (bytes.length >= minBytes) return bytes;
  let padLen = Math.max(0, minBytes - bytes.length - 64);
  let out = bytes;
  const padRef = doc.context.register(doc.context.stream(new Uint8Array(padLen)));
  for (let i = 0; i < 4; i++) {
    out = await doc.save(SAVE_OPTS);
    if (out.length >= minBytes) return out;
    padLen += minBytes - out.length;
    doc.context.assign(padRef, doc.context.stream(new Uint8Array(padLen)));
  }
  return out;
}

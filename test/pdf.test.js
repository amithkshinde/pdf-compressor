import test from "node:test";
import assert from "node:assert/strict";
import { PDFDocument, StandardFonts } from "../vendor/pdf-lib.esm.min.js";
import { saveLossless, padPdf, loadPdf, pageCount } from "../src/pdf.js";

async function makeTextPdf(pages = 2) {
  const doc = await PDFDocument.create();
  doc.setTitle("A very long title ".repeat(50));
  doc.setAuthor("Someone");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < pages; i++) {
    doc.addPage([595, 842]).drawText(`Page ${i + 1} hello`, { x: 50, y: 700, size: 20, font });
  }
  return doc.save();
}

test("lossless stage strips metadata and keeps pages", async () => {
  const src = await makeTextPdf(3);
  const { bytes, doc } = await saveLossless(src);
  assert.equal(doc.getPageCount(), 3);
  assert.equal(doc.getTitle(), undefined);
  assert.ok(bytes.length < src.length, `${bytes.length} should be < ${src.length}`);
  assert.equal(await pageCount(bytes), 3);
});

test("padPdf reaches the minimum size and the file still opens", async () => {
  const src = await makeTextPdf(1);
  const { bytes, doc } = await saveLossless(src);
  for (const min of [bytes.length + 10, 20_000, 150_000]) {
    const { bytes: b, doc: d } = await saveLossless(src);
    const padded = await padPdf(d, b, min);
    assert.ok(padded.length >= min, `${padded.length} >= ${min}`);
    assert.ok(padded.length <= min + 200, `${padded.length} not far above ${min}`);
    const reopened = await loadPdf(padded);
    assert.equal(reopened.getPageCount(), 1);
  }
  void doc;
});

test("padPdf leaves a big-enough file alone", async () => {
  const src = await makeTextPdf(1);
  const { bytes, doc } = await saveLossless(src);
  assert.equal(await padPdf(doc, bytes, 100), bytes);
});

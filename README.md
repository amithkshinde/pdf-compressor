# pdf-compressor

Compress a PDF or image to the exact size a government portal asks for. You upload a file, type the size limit, and get back the best-quality version that fits. Everything runs in your browser: **no uploads, no accounts, no cloud storage.**

## The problem

Government upload forms enforce hard size limits (for example 50 KB for a signature, 200 KB for a photo). Generic compressors can't be told "make this 180 KB", so the output lands at a random size: too big to upload, or squashed far below the limit and unreadable. Most also ask you to upload identity documents to a site you don't know.

## How it works

### Images

1. Pick an image and enter the maximum size (and optionally a minimum).
2. The app searches for the **highest JPEG quality that fits** the target (binary search on the real encoded size, about 8 rounds).
3. If even the lowest readable quality is too big, it reduces resolution one step at a time and searches again.
4. If the target can't be reached without making the image unreadable, it says so and offers the smallest readable size instead.
5. If a minimum size is set and the result is smaller, it pads the file with harmless JPEG comment segments. Pixels are untouched.

### PDFs

PDFs go through three stages, from least to most destructive. The app stops at the first one that fits.

1. **Lossless.** Strip metadata and pack objects. Text and layout are unchanged.
2. **Recompress scans.** Re-encode embedded JPEG images smaller (quality first, then resolution). Text stays selectable. Images that can't be safely re-encoded (masks, CMYK, non-JPEG) are left alone.
3. **Convert pages to images.** Only if stages 1 and 2 can't reach the target, and only after you click the button, because text can no longer be selected or searched. Limited to 25 pages so phones don't run out of memory. Pages are rendered at 61–108 dpi equivalent and the result is flagged if detail is reduced.

A minimum size is met by adding an unreferenced, uncompressed object inside the PDF. Page content is untouched. Password-protected PDFs are rejected with a clear message.

### Automatic quality check

Every output is checked **before** you see it, on your device, and the result is shown with the preview as one of three verdicts: *passed*, *acceptable (review the preview)* or *failed (may be hard to read)*. The download button is always available; the check informs your decision, it doesn't block it.

| Check | Images | PDFs |
| --- | --- | --- |
| Meets the size limit (and minimum) | yes | yes |
| File opens correctly | yes | yes |
| Looks like the original (SSIM on the areas that have content, so blank white pages can't inflate the score) | yes | yes, on up to 6 sampled pages; the weakest page is reported |
| Text and edges stay sharp (edge detail kept) | yes | yes |
| Resolution kept | yes | n/a |
| All pages and page sizes kept | n/a | yes |
| Text still selectable | n/a | yes (informational if you chose to convert pages to images) |

The score thresholds in `src/quality.js` (`judge`) are heuristics and should be tuned against real portal files.

### Details worth knowing

- Portals disagree on whether 1 KB is 1000 or 1024 bytes. Maximums are counted as 1000 and minimums as 1024, so the result passes under either reading.
- PNG and WEBP inputs are converted to JPEG on a white background (JPEG has no transparency).
- Files already within the limit are returned untouched.
- Quality floor is 35%; resolution steps go down to 40% of the original.

## Run it

```bash
npm start        # serves the app at http://localhost:8080
npm test         # unit tests for the size search, JPEG/PDF padding and lossless stage
```

There is no build step and no dependencies. It is plain HTML, CSS and ES modules.

## Project layout

| Path | What it is |
| --- | --- |
| `index.html`, `styles.css` | Mobile-first single-screen UI |
| `src/core.js` | Size search, JPEG padding, size units (pure logic, no DOM) |
| `src/quality.js` | Pure scoring: content-weighted SSIM, edge detail, verdict logic |
| `src/verify.js` | Runs the quality check on an image or PDF output (browser) |
| `src/pdf.js` | PDF stages: lossless, recompress scans, convert pages to images, padding |
| `vendor/` | [pdf-lib](https://pdf-lib.js.org) (MIT) and [pdf.js](https://mozilla.github.io/pdf.js/) (Apache-2.0), vendored so there is no build step |
| `src/app.js` | File handling, canvas encoding, preview and download |
| `test/*.test.js` | Unit tests for core and PDF logic |

## Status and roadmap

- [x] Image compression to a target size (JPG, PNG, WEBP in; JPG out)
- [x] PDF compression to a target size
- [x] Optional minimum size
- [x] Automatic quality check on every output, before the user sees it
- [x] Before/after preview, honest "can't reach this target" message
- [x] PDF compression on-device (lossless, recompress scans, opt-in convert to images)
- [ ] Presets for common portal uploads, editable by the user
- [ ] Dimension and format constraints (for example 3.5 × 4.5 cm photo)
- [ ] Batch mode with ZIP download
- [ ] Hindi, Kannada and other Indian languages

## Privacy

Files are read, compressed and downloaded entirely inside your browser tab (including PDFs: the PDF libraries are bundled in `vendor/`, not fetched from a CDN). Nothing is sent to a server, and closing the tab clears everything from memory. The only thing hosted is the static app itself.

The deployed site also uses Vercel Web Analytics, which counts page views only (no cookies, nothing about your files). It is a single script tag in `index.html`; delete it to run with no analytics at all. Locally it simply 404s and does nothing.

# pdf-compressor

Compress a file to the exact size a government portal asks for. You upload a file, type the size limit, and get back the best-quality version that fits. Everything runs in your browser: **no uploads, no accounts, no cloud storage.**

## The problem

Government upload forms enforce hard size limits (for example 50 KB for a signature, 200 KB for a photo). Generic compressors can't be told "make this 180 KB", so the output lands at a random size: too big to upload, or squashed far below the limit and unreadable. Most also ask you to upload identity documents to a site you don't know.

## How it works

1. Pick an image and enter the maximum size (and optionally a minimum).
2. The app searches for the **highest JPEG quality that fits** the target (binary search on the real encoded size, about 8 rounds).
3. If even the lowest readable quality is too big, it reduces resolution one step at a time and searches again.
4. If the target can't be reached without making the image unreadable, it says so and offers the smallest readable size instead.
5. If a minimum size is set and the result is smaller, it pads the file with harmless JPEG comment segments. Pixels are untouched.

Details worth knowing:

- Portals disagree on whether 1 KB is 1000 or 1024 bytes. Maximums are counted as 1000 and minimums as 1024, so the result passes under either reading.
- PNG and WEBP inputs are converted to JPEG on a white background (JPEG has no transparency).
- Files already within the limit are returned untouched.
- Quality floor is 35%; resolution steps go down to 40% of the original.

## Run it

```bash
npm start        # serves the app at http://localhost:8080
npm test         # unit tests for the size-search and padding logic
```

There is no build step and no dependencies. It is plain HTML, CSS and ES modules.

## Project layout

| Path | What it is |
| --- | --- |
| `index.html`, `styles.css` | Mobile-first single-screen UI |
| `src/core.js` | Size search, JPEG padding, size units (pure logic, no DOM) |
| `src/app.js` | File handling, canvas encoding, preview and download |
| `test/core.test.js` | Unit tests for the core logic |

## Status and roadmap

- [x] Image compression to a target size (JPG, PNG, WEBP in; JPG out)
- [x] Optional minimum size
- [x] Before/after preview, honest "can't reach this target" message
- [ ] PDF compression on-device (recompress embedded images, strip metadata)
- [ ] Presets for common portal uploads, editable by the user
- [ ] Dimension and format constraints (for example 3.5 × 4.5 cm photo)
- [ ] Batch mode with ZIP download
- [ ] Hindi, Kannada and other Indian languages

## Privacy

Files are read, compressed and downloaded entirely inside your browser tab. Nothing is sent to a server, and closing the tab clears everything from memory. The only thing hosted is the static app itself.

import { fitToTarget, padJpeg, toBytes, formatSize } from "./core.js";

const $ = (id) => document.getElementById(id);
const MAX_INPUT_BYTES = 50 * 1000 * 1000;

let file = null;
let bitmap = null;
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

async function loadFile(f) {
  if (!f) return;
  if (!/^image\/(jpeg|png|webp)$/.test(f.type)) {
    return showInfo("Unsupported file. Please choose a JPG, PNG or WEBP image.");
  }
  if (f.size > MAX_INPUT_BYTES) {
    return showInfo("This file is over 50 MB. Please choose a smaller one.");
  }
  try {
    bitmap = await createImageBitmap(f, { imageOrientation: "from-image" });
  } catch {
    return showInfo("This image could not be opened. It may be corrupt.");
  }
  file = f;
  clearUrls();
  $("result").hidden = true;
  $("target-card").hidden = false;
  showInfo(`${f.name} · ${formatSize(f.size)} · ${bitmap.width}×${bitmap.height}px`);
}

function showInfo(text) {
  const el = $("file-info");
  el.textContent = text;
  el.hidden = false;
}

const canvas = document.createElement("canvas");
function makeEncoder() {
  return (scale, quality) =>
    new Promise((resolve, reject) => {
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d");
      ctx.fillStyle = "#fff"; // JPEG has no transparency
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (b) => (b ? resolve(b) : reject(new Error("Encoding failed"))),
        "image/jpeg",
        quality
      );
    });
}

async function run() {
  const value = parseFloat($("target").value);
  if (!(value > 0)) return showMessage("Enter the maximum size first.", "warn");
  const unit = $("unit").value;
  const target = toBytes(value, unit, "max");
  const minVal = parseFloat($("min").value);
  const minBytes = minVal > 0 ? toBytes(minVal, unit, "min") : 0;
  if (minBytes && minBytes > target) {
    return showMessage("The minimum is larger than the maximum.", "warn");
  }

  const btn = $("go");
  btn.disabled = true;
  btn.textContent = "Optimising…";
  clearUrls();

  try {
    // Already small enough: hand the original back untouched.
    if (file.size <= target && file.size >= minBytes) {
      return present(file, `Already ${formatSize(file.size)}, within your ${formatSize(target)} limit. No change needed.`, "ok");
    }

    const outcome = await fitToTarget(makeEncoder(), target);
    if (!outcome.ok) {
      const s = outcome.smallest;
      present(s.result, `Can't reach ${formatSize(target)} without making this unreadable. The smallest readable size is ${formatSize(s.result.size)}.`, "warn", s);
      $("download").textContent = "Download smallest anyway";
      return;
    }

    let blob = outcome.result;
    if (minBytes && blob.size < minBytes) {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      blob = new Blob([padJpeg(bytes, minBytes)], { type: "image/jpeg" });
    }
    const soft = outcome.quality < 0.5 || outcome.scale < 0.6;
    present(
      blob,
      soft
        ? `Fits ${formatSize(target)}, but detail is reduced. Check the preview before uploading.`
        : `Done: ${formatSize(blob.size)}, within your ${formatSize(target)} limit.`,
      soft ? "warn" : "ok",
      outcome
    );
  } catch (e) {
    showMessage("Something went wrong while compressing. Please try again.", "warn");
  } finally {
    btn.disabled = false;
    btn.textContent = "Compress";
  }
}

function showMessage(text, kind) {
  $("result").hidden = false;
  $("msg").textContent = text;
  $("msg").className = kind;
}

function present(blob, text, kind, detail) {
  showMessage(text, kind);
  $("img-before").src = trackUrl(file);
  $("img-after").src = trackUrl(blob);
  $("cap-before").textContent = `Original · ${formatSize(file.size)}`;
  const dims = detail && detail.scale
    ? ` · ${Math.round(bitmap.width * detail.scale)}×${Math.round(bitmap.height * detail.scale)}px`
    : "";
  $("cap-after").textContent = `New · ${formatSize(blob.size)}${dims}`;
  const base = file.name.replace(/\.[^.]+$/, "");
  const ext = blob === file ? file.name.split(".").pop() : "jpg";
  const dl = $("download");
  dl.href = trackUrl(blob);
  dl.download = blob === file ? file.name : `${base}-fit.${ext}`;
  dl.textContent = "Download";
  $("result").scrollIntoView({ behavior: "smooth", block: "nearest" });
}

$("file").addEventListener("change", (e) => loadFile(e.target.files[0]));
$("go").addEventListener("click", run);
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

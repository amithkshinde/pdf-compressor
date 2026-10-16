// Pure image-quality scoring on grayscale (luma) arrays. No DOM, runs in Node tests.
// The thresholds in judge() are heuristics: they are meant to be tuned against real portal files.

const C1 = (0.01 * 255) ** 2;
const C2 = (0.03 * 255) ** 2;

/** Convert RGBA pixel data to luma (0..255). */
export function toLuma(rgba, pixels) {
  const out = new Float32Array(pixels);
  for (let i = 0, j = 0; i < pixels; i++, j += 4) {
    out[i] = 0.299 * rgba[j] + 0.587 * rgba[j + 1] + 0.114 * rgba[j + 2];
  }
  return out;
}

/**
 * Mean SSIM over 8x8 windows, counting only windows where the reference has
 * real content. Mostly-white document pages would otherwise score near 1.0
 * no matter how badly the text was damaged.
 * Returns { ssim, blocks }.
 */
export function contentSsim(ref, out, w, h, win = 8, step = 4, minVar = 25) {
  const n = win * win;
  let sum = 0;
  let blocks = 0;
  for (let y = 0; y + win <= h; y += step) {
    for (let x = 0; x + win <= w; x += step) {
      let ma = 0, mb = 0;
      for (let j = 0; j < win; j++) {
        const row = (y + j) * w + x;
        for (let i = 0; i < win; i++) {
          ma += ref[row + i];
          mb += out[row + i];
        }
      }
      ma /= n;
      mb /= n;
      let va = 0, vb = 0, cov = 0;
      for (let j = 0; j < win; j++) {
        const row = (y + j) * w + x;
        for (let i = 0; i < win; i++) {
          const da = ref[row + i] - ma;
          const db = out[row + i] - mb;
          va += da * da;
          vb += db * db;
          cov += da * db;
        }
      }
      va /= n - 1;
      vb /= n - 1;
      cov /= n - 1;
      if (va < minVar) continue; // blank or flat area: nothing to damage
      sum += ((2 * ma * mb + C1) * (2 * cov + C2)) / ((ma * ma + mb * mb + C1) * (va + vb + C2));
      blocks++;
    }
  }
  return { ssim: blocks ? sum / blocks : 1, blocks };
}

/** Mean absolute gradient: a cheap measure of how much edge detail an image holds. */
export function edgeEnergy(luma, w, h) {
  let sum = 0;
  for (let y = 0; y < h - 1; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      sum += Math.abs(luma[i + 1] - luma[i]) + Math.abs(luma[i + w] - luma[i]);
    }
  }
  return sum / (w * h);
}

/** Compare an output against its reference at the same size. */
export function compare(ref, out, w, h) {
  const { ssim, blocks } = contentSsim(ref, out, w, h);
  const refEdge = edgeEnergy(ref, w, h);
  const sharp = refEdge > 0 ? Math.min(1, edgeEnergy(out, w, h) / refEdge) : 1;
  return { ssim, sharp, blocks };
}

/** Turn scores into a verdict: "good" | "fair" | "poor". */
export function judge({ ssim, sharp }) {
  if (ssim >= 0.9 && sharp >= 0.75) return "good";
  if (ssim >= 0.75 && sharp >= 0.5) return "fair";
  return "poor";
}

const RANK = { good: 0, fair: 1, poor: 2 };

/**
 * Combine check results into one verdict. A failed check makes it "poor", a
 * warning makes it at least "fair"; "note" checks are informational only.
 */
export function overall(checks, scoreVerdict = "good") {
  let v = scoreVerdict;
  for (const c of checks) {
    const level = c.status === "fail" ? "poor" : c.status === "warn" ? "fair" : "good";
    if (RANK[level] > RANK[v]) v = level;
  }
  return v;
}

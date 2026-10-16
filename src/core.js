// Pure logic, no DOM. Everything here runs on the user's device.

export const DEFAULTS = {
  maxQuality: 0.95,
  floorQuality: 0.35, // below this, JPEG artefacts make documents hard to read
  iterations: 7, // binary-search rounds per scale (~0.5% quality precision)
  scales: [1, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4],
};

/**
 * Find the highest-quality encoding that is <= targetBytes.
 *
 * encode(scale, quality) must resolve to an object with a numeric `size`
 * (a Blob works). Quality is searched first; if even the quality floor is too
 * big, the resolution is reduced one step and the search repeats.
 *
 * Returns { ok: true, result, scale, quality } or
 *         { ok: false, smallest: { result, scale, quality } }.
 */
export async function fitToTarget(encode, targetBytes, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  let smallest = null;

  for (const scale of o.scales) {
    const top = await encode(scale, o.maxQuality);
    if (top.size <= targetBytes) {
      return { ok: true, result: top, scale, quality: o.maxQuality };
    }

    const bottom = await encode(scale, o.floorQuality);
    if (!smallest || bottom.size < smallest.result.size) {
      smallest = { result: bottom, scale, quality: o.floorQuality };
    }
    if (bottom.size > targetBytes) continue; // not reachable at this scale

    let lo = o.floorQuality;
    let hi = o.maxQuality;
    let best = bottom;
    let bestQ = lo;
    for (let i = 0; i < o.iterations; i++) {
      const mid = (lo + hi) / 2;
      const r = await encode(scale, mid);
      if (r.size <= targetBytes) {
        best = r;
        bestQ = mid;
        lo = mid;
      } else {
        hi = mid;
      }
    }
    return { ok: true, result: best, scale, quality: bestQ };
  }
  return { ok: false, smallest };
}

/**
 * Grow a JPEG to at least `minBytes` by inserting harmless COM (comment)
 * segments right after the SOI marker. Pixels are untouched.
 */
export function padJpeg(bytes, minBytes) {
  if (bytes.length >= minBytes) return bytes;
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("Not a JPEG");
  }
  let need = Math.max(minBytes - bytes.length, 4);
  const out = new Uint8Array(bytes.length + need);
  out.set(bytes.subarray(0, 2), 0);
  let pos = 2;
  while (need > 0) {
    const seg = Math.min(need, 65535 + 2); // marker(2) + length field(2) + payload
    let total = seg;
    if (total < 4) total = 4;
    const len = total - 2; // length field counts itself + payload, not the marker
    out[pos++] = 0xff;
    out[pos++] = 0xfe;
    out[pos++] = (len >> 8) & 0xff;
    out[pos++] = len & 0xff;
    pos += total - 4; // zero-filled payload
    need -= total;
  }
  out.set(bytes.subarray(2), pos);
  return out.subarray(0, pos + bytes.length - 2);
}

/**
 * Convert a user-entered size to bytes. Portals disagree on whether 1 KB is
 * 1000 or 1024 bytes, so maximums use 1000 and minimums use 1024: the result
 * then satisfies both readings.
 */
export function toBytes(value, unit, kind) {
  const base = kind === "min" ? 1024 : 1000;
  const mult = unit === "MB" ? base * base : base;
  return Math.floor(value * mult);
}

export function formatSize(bytes) {
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(2) + " MB";
  return (bytes / 1e3).toFixed(1) + " KB";
}

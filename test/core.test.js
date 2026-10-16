import test from "node:test";
import assert from "node:assert/strict";
import { fitToTarget, padJpeg, toBytes, formatSize } from "../src/core.js";

// Fake encoder: size grows with resolution and quality, like a real JPEG.
const fake = async (scale, q) => ({
  size: Math.round(1_000_000 * scale * scale * (0.05 + q * q)),
});

test("lands just under the target, not far below", async () => {
  const target = 300_000;
  const r = await fitToTarget(fake, target);
  assert.equal(r.ok, true);
  assert.ok(r.result.size <= target);
  assert.ok(r.result.size >= target * 0.97, `got ${r.result.size}`);
  assert.equal(r.scale, 1); // quality alone was enough
});

test("reduces resolution when quality alone cannot reach the target", async () => {
  const target = 100_000; // floor quality at scale 1 is ~172k
  const r = await fitToTarget(fake, target);
  assert.equal(r.ok, true);
  assert.ok(r.scale < 1);
  assert.ok(r.result.size <= target);
});

test("returns the file at max quality when it already fits", async () => {
  const r = await fitToTarget(fake, 5_000_000);
  assert.equal(r.ok, true);
  assert.equal(r.scale, 1);
  assert.equal(r.quality, 0.95);
});

test("reports the smallest readable size when the target is unreachable", async () => {
  const r = await fitToTarget(fake, 10_000);
  assert.equal(r.ok, false);
  assert.ok(r.smallest.result.size > 10_000);
});

test("padJpeg grows a JPEG to the minimum with valid COM segments", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  for (const min of [10, 5_000, 200_000]) {
    const out = padJpeg(jpeg, min);
    assert.equal(out.length, min);
    assert.deepEqual([...out.subarray(0, 2)], [0xff, 0xd8]);
    assert.deepEqual([...out.subarray(out.length - 2)], [0xff, 0xd9]);
    // Walk the segments: every padding segment must be a well-formed COM.
    let pos = 2;
    while (out[pos] === 0xff && out[pos + 1] === 0xfe) {
      pos += 2 + ((out[pos + 2] << 8) | out[pos + 3]);
    }
    assert.equal(pos, out.length - 2, "segments must end at the original body");
  }
});

test("padJpeg leaves big-enough files alone and rejects non-JPEGs", () => {
  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
  assert.equal(padJpeg(jpeg, 3), jpeg);
  assert.throws(() => padJpeg(new Uint8Array([1, 2, 3, 4]), 100));
});

test("size conversion is conservative for both limits", () => {
  assert.equal(toBytes(200, "KB", "max"), 200_000);
  assert.equal(toBytes(20, "KB", "min"), 20_480);
  assert.equal(toBytes(1, "MB", "max"), 1_000_000);
  assert.equal(formatSize(182_400), "182.4 KB");
  assert.equal(formatSize(1_250_000), "1.25 MB");
});

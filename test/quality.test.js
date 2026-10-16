import test from "node:test";
import assert from "node:assert/strict";
import { contentSsim, edgeEnergy, compare, judge, overall } from "../src/quality.js";

const W = 128, H = 128;
// Synthetic "text": dark vertical strokes on white.
function strokes() {
  const a = new Float32Array(W * H).fill(255);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) if (x % 6 < 2) a[y * W + x] = 20;
  return a;
}
function blur(src) {
  const out = new Float32Array(src.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let s = 0, c = 0;
      for (let dx = -3; dx <= 3; dx++) {
        const xx = x + dx;
        if (xx >= 0 && xx < W) { s += src[y * W + xx]; c++; }
      }
      out[y * W + x] = s / c;
    }
  }
  return out;
}

test("identical images score perfectly", () => {
  const a = strokes();
  const r = compare(a, a, W, H);
  assert.ok(r.ssim > 0.999);
  assert.equal(r.sharp, 1);
  assert.equal(judge(r), "good");
});

test("a blurred copy scores clearly lower and loses sharpness", () => {
  const a = strokes();
  const r = compare(a, blur(a), W, H);
  assert.ok(r.ssim < 0.9, `ssim ${r.ssim}`);
  assert.ok(r.sharp < 0.6, `sharp ${r.sharp}`);
  assert.notEqual(judge(r), "good");
});

test("blank pages do not inflate the score", () => {
  const blank = new Float32Array(W * H).fill(255);
  const { blocks } = contentSsim(blank, blank, W, H);
  assert.equal(blocks, 0); // nothing to damage, nothing counted
  const a = strokes();
  const dead = new Float32Array(W * H).fill(255); // all text erased
  assert.ok(contentSsim(a, dead, W, H).ssim < 0.3);
});

test("overall verdict is the worst of score and checks", () => {
  assert.equal(overall([{ status: "pass" }, { status: "note" }], "good"), "good");
  assert.equal(overall([{ status: "warn" }], "good"), "fair");
  assert.equal(overall([{ status: "fail" }, { status: "pass" }], "good"), "poor");
  assert.equal(overall([{ status: "pass" }], "poor"), "poor");
});

test("edge energy is zero for a flat image", () => {
  assert.equal(edgeEnergy(new Float32Array(16 * 16).fill(100), 16, 16), 0);
});

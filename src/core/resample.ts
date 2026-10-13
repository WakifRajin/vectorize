import type { RGBAImage } from './types.ts';

/** Mitchell–Netravali (B = C = 1/3): sharp, with far less ringing than Catmull-Rom. */
function mitchell(x: number): number {
  x = Math.abs(x);
  const B = 1 / 3;
  const C = 1 / 3;
  if (x < 1) {
    return ((12 - 9 * B - 6 * C) * x * x * x + (-18 + 12 * B + 6 * C) * x * x + (6 - 2 * B)) / 6;
  }
  if (x < 2) {
    return ((-B - 6 * C) * x * x * x + (6 * B + 30 * C) * x * x + (-12 * B - 48 * C) * x + (8 * B + 24 * C)) / 6;
  }
  return 0;
}

interface Weights {
  start: Int32Array;
  count: Int32Array;
  w: Float32Array;
  stride: number;
}

function computeWeights(srcSize: number, dstSize: number): Weights {
  const ratio = srcSize / dstSize;
  // When shrinking, widen the kernel so it also acts as an anti-aliasing filter.
  const filterScale = Math.max(1, ratio);
  const support = 2 * filterScale;
  const stride = Math.ceil(support * 2) + 1;
  const start = new Int32Array(dstSize);
  const count = new Int32Array(dstSize);
  const w = new Float32Array(dstSize * stride);
  for (let i = 0; i < dstSize; i++) {
    const center = (i + 0.5) * ratio;
    const lo = Math.max(0, Math.floor(center - support));
    const hi = Math.min(srcSize - 1, Math.ceil(center + support));
    let sum = 0;
    let n = 0;
    for (let j = lo; j <= hi && n < stride; j++, n++) {
      const v = mitchell((j + 0.5 - center) / filterScale);
      w[i * stride + n] = v;
      sum += v;
    }
    if (sum !== 0) for (let k = 0; k < n; k++) w[i * stride + k] /= sum;
    start[i] = lo;
    count[i] = n;
  }
  return { start, count, w, stride };
}

/** High quality separable resize (up or down) with premultiplied alpha. */
export function resize(src: RGBAImage, dw: number, dh: number): RGBAImage {
  const { width: sw, height: sh, data } = src;
  if (sw === dw && sh === dh) return { width: dw, height: dh, data: new Uint8ClampedArray(data) };

  // Premultiply into float buffer.
  const pre = new Float32Array(sw * sh * 4);
  for (let i = 0; i < sw * sh; i++) {
    const a = data[i * 4 + 3] / 255;
    pre[i * 4] = data[i * 4] * a;
    pre[i * 4 + 1] = data[i * 4 + 1] * a;
    pre[i * 4 + 2] = data[i * 4 + 2] * a;
    pre[i * 4 + 3] = data[i * 4 + 3];
  }

  // Horizontal pass: sw x sh -> dw x sh
  const hw = computeWeights(sw, dw);
  const tmp = new Float32Array(dw * sh * 4);
  for (let y = 0; y < sh; y++) {
    const row = y * sw * 4;
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      const s = hw.start[x];
      const base = x * hw.stride;
      for (let k = 0; k < hw.count[x]; k++) {
        const wt = hw.w[base + k];
        const p = row + (s + k) * 4;
        r += pre[p] * wt;
        g += pre[p + 1] * wt;
        b += pre[p + 2] * wt;
        a += pre[p + 3] * wt;
      }
      const o = (y * dw + x) * 4;
      tmp[o] = r;
      tmp[o + 1] = g;
      tmp[o + 2] = b;
      tmp[o + 3] = a;
    }
  }

  // Vertical pass: dw x sh -> dw x dh, then un-premultiply.
  const vw = computeWeights(sh, dh);
  const out = new Uint8ClampedArray(dw * dh * 4);
  for (let y = 0; y < dh; y++) {
    const s = vw.start[y];
    const base = y * vw.stride;
    const n = vw.count[y];
    for (let x = 0; x < dw; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < n; k++) {
        const wt = vw.w[base + k];
        const p = ((s + k) * dw + x) * 4;
        r += tmp[p] * wt;
        g += tmp[p + 1] * wt;
        b += tmp[p + 2] * wt;
        a += tmp[p + 3] * wt;
      }
      const o = (y * dw + x) * 4;
      if (a > 0.5) {
        const inv = 255 / a;
        out[o] = r * inv;
        out[o + 1] = g * inv;
        out[o + 2] = b * inv;
      }
      out[o + 3] = a;
    }
  }
  return { width: dw, height: dh, data: out };
}

/**
 * Edge-preserving bilateral filter (radius 2). Removes JPEG noise and grain while
 * keeping edges sharp, which yields far cleaner colour regions.
 */
export function bilateral(src: RGBAImage, sigmaRange = 28): RGBAImage {
  const { width: w, height: h, data } = src;
  const out = new Uint8ClampedArray(data.length);
  const R = 2;
  const spatial: number[] = [];
  for (let dy = -R; dy <= R; dy++)
    for (let dx = -R; dx <= R; dx++) spatial.push(Math.exp(-(dx * dx + dy * dy) / (2 * 1.6 * 1.6)));
  const rangeLut = new Float32Array(3 * 255 * 255 + 1);
  for (let i = 0; i < rangeLut.length; i++) rangeLut[i] = Math.exp(-i / (2 * sigmaRange * sigmaRange * 3));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const r0 = data[o], g0 = data[o + 1], b0 = data[o + 2];
      let sr = 0, sg = 0, sb = 0, sw = 0;
      let k = 0;
      for (let dy = -R; dy <= R; dy++) {
        const yy = Math.min(h - 1, Math.max(0, y + dy));
        for (let dx = -R; dx <= R; dx++, k++) {
          const xx = Math.min(w - 1, Math.max(0, x + dx));
          const p = (yy * w + xx) * 4;
          const dr = data[p] - r0, dg = data[p + 1] - g0, db = data[p + 2] - b0;
          const wt = spatial[k] * rangeLut[dr * dr + dg * dg + db * db];
          sr += data[p] * wt;
          sg += data[p + 1] * wt;
          sb += data[p + 2] * wt;
          sw += wt;
        }
      }
      out[o] = sr / sw;
      out[o + 1] = sg / sw;
      out[o + 2] = sb / sw;
      out[o + 3] = data[o + 3];
    }
  }
  return { width: w, height: h, data: out };
}

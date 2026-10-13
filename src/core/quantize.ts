import { oklabToRgb, rgbToOklab } from './color.ts';
import type { RGBAImage } from './types.ts';

/** Palette index used for transparent pixels. */
export const TRANSPARENT = 0xffff;

export interface Quantized {
  /** Palette index per pixel (TRANSPARENT for alpha < 128). */
  index: Uint16Array;
  /** sRGB palette, 3 bytes per colour. */
  rgb: Uint8Array;
  /** OKLab palette, 3 floats per colour. */
  lab: Float32Array;
  count: number;
}

const BITS = 5;
const BINS = 1 << (BITS * 3);

function dist2(a: ArrayLike<number>, i: number, b: ArrayLike<number>, j: number): number {
  const d0 = a[i] - b[j], d1 = a[i + 1] - b[j + 1], d2 = a[i + 2] - b[j + 2];
  return d0 * d0 + d1 * d1 + d2 * d2;
}

/**
 * Reduce the image to a small palette.
 *
 * The palette is learned mostly from "flat" pixels: pixels on anti-aliased edges are blends of
 * their neighbours and would otherwise pull in in-between colours that show up as thin halos.
 * Every pixel (edges included) is then mapped to the nearest palette colour, which splits
 * anti-aliased edges cleanly down the middle.
 */
export function quantize(img: RGBAImage, maxColors: number, scale = 1): Quantized {
  // Compare pixels one *source* pixel apart: after upscaling, edges spread over several working
  // pixels and neighbouring pixels differ too little to reveal them.
  const st = Math.max(1, Math.round(scale));
  const radius = 3 * st + 3;
  const { data, width: w, height: h } = img;
  const n = w * h;
  const auto = maxColors <= 0;
  const K = auto ? 16 : Math.max(2, Math.min(256, maxColors));
  const mergeDist = auto ? 0.03 : 0.02;

  // 1. Weighted histogram over 5-bit bins (flat pixels weigh 1, edge pixels a little).
  const wt = new Float64Array(BINS);
  const sr = new Float64Array(BINS), sg = new Float64Array(BINS), sb = new Float64Array(BINS);
  let opaque = 0;
  let edges = 0;
  const flat = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      if (data[o + 3] < 128) continue;
      opaque++;
      const r = data[o], g = data[o + 1], b = data[o + 2];
      let grad = 0;
      const diff = (p: number) => Math.abs(r - data[p]) + Math.abs(g - data[p + 1]) + Math.abs(b - data[p + 2]);
      grad = Math.max(diff((y * w + Math.min(w - 1, x + st)) * 4), diff((y * w + Math.max(0, x - st)) * 4));
      grad = Math.max(grad, diff((Math.min(h - 1, y + st) * w + x) * 4), diff((Math.max(0, y - st) * w + x) * 4));
      const isFlat = grad <= 30;
      if (isFlat) flat[y * w + x] = 1; else edges++;
      const weight = isFlat ? 1 : 0.06;
      const bin = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
      wt[bin] += weight;
      sr[bin] += r * weight;
      sg[bin] += g * weight;
      sb[bin] += b * weight;
    }
  }

  const index = new Uint16Array(n);
  if (opaque === 0) {
    index.fill(TRANSPARENT);
    return { index, rgb: new Uint8Array(0), lab: new Float32Array(0), count: 0 };
  }

  // 2. Collect non-empty bins as weighted points in OKLab.
  let m = 0;
  for (let i = 0; i < BINS; i++) if (wt[i] > 0) m++;
  const pts = new Float32Array(m * 3);
  const pw = new Float64Array(m);
  let totalW = 0;
  for (let i = 0, j = 0; i < BINS; i++) {
    if (wt[i] <= 0) continue;
    rgbToOklab(sr[i] / wt[i], sg[i] / wt[i], sb[i] / wt[i], pts, j * 3);
    pw[j] = wt[i];
    totalW += wt[i];
    j++;
  }

  // 3. k-means with greedy weighted farthest-point initialisation (deterministic).
  let k = Math.min(K, m);
  let centers = new Float64Array(k * 3);
  const nearest = new Float64Array(m).fill(Infinity);
  {
    let best = 0;
    for (let i = 1; i < m; i++) if (pw[i] > pw[best]) best = i;
    for (let c = 0; c < k; c++) {
      centers[c * 3] = pts[best * 3];
      centers[c * 3 + 1] = pts[best * 3 + 1];
      centers[c * 3 + 2] = pts[best * 3 + 2];
      let score = -1;
      for (let i = 0; i < m; i++) {
        const d = dist2(pts, i * 3, centers, c * 3);
        if (d < nearest[i]) nearest[i] = d;
        // sqrt(weight) keeps a few heavy bins from dominating while ignoring lone outliers.
        const s = nearest[i] * Math.sqrt(pw[i]);
        if (s > score) { score = s; best = i; }
      }
      if (score <= 1e-9) { k = c + 1; break; }
    }
    centers = centers.slice(0, k * 3);
  }

  const assign = new Int32Array(m);
  const runKmeans = (iterations: number) => {
    for (let it = 0; it < iterations; it++) {
      let changed = 0;
      for (let i = 0; i < m; i++) {
        let bi = 0, bd = Infinity;
        for (let c = 0; c < k; c++) {
          const d = dist2(pts, i * 3, centers, c * 3);
          if (d < bd) { bd = d; bi = c; }
        }
        if (assign[i] !== bi || it === 0) { changed++; assign[i] = bi; }
      }
      const acc = new Float64Array(k * 4);
      for (let i = 0; i < m; i++) {
        const c = assign[i] * 4;
        acc[c] += pts[i * 3] * pw[i];
        acc[c + 1] += pts[i * 3 + 1] * pw[i];
        acc[c + 2] += pts[i * 3 + 2] * pw[i];
        acc[c + 3] += pw[i];
      }
      for (let c = 0; c < k; c++) {
        const W = acc[c * 4 + 3];
        if (W > 0) {
          centers[c * 3] = acc[c * 4] / W;
          centers[c * 3 + 1] = acc[c * 4 + 1] / W;
          centers[c * 3 + 2] = acc[c * 4 + 2] / W;
        }
      }
      if (changed === 0 && it > 0) break;
    }
  };
  runKmeans(24);

  // 4. Cluster weights; merge near-duplicates and drop negligible clusters.
  const clusterWeights = () => {
    const cw = new Float64Array(k);
    for (let i = 0; i < m; i++) cw[assign[i]] += pw[i];
    return cw;
  };
  let cw = clusterWeights();
  let list: { c: number[]; w: number }[] = [];
  for (let c = 0; c < k; c++) list.push({ c: [centers[c * 3], centers[c * 3 + 1], centers[c * 3 + 2]], w: cw[c] });
  const minShare = auto ? 0.0015 : 0.0002;
  list = list.filter((e) => e.w / totalW >= minShare);
  for (;;) {
    let bi = -1, bj = -1, bd = mergeDist * mergeDist;
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i].c, b = list[j].c;
        const d = (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
    if (bi < 0) break;
    const A = list[bi], B = list[bj], W = A.w + B.w;
    A.c = [0, 1, 2].map((t) => (A.c[t] * A.w + B.c[t] * B.w) / W);
    A.w = W;
    list.splice(bj, 1);
  }
  if (list.length === 0) list = [{ c: [centers[0], centers[1], centers[2]], w: 1 }];
  k = list.length;
  centers = new Float64Array(k * 3);
  list.forEach((e, c) => centers.set(e.c, c * 3));
  runKmeans(6);
  cw = clusterWeights();

  // Order palette by weight (most used first) for a nicer swatch list.
  const order = Array.from({ length: k }, (_, i) => i).sort((a, b) => cw[b] - cw[a]);
  const lab = new Float32Array(k * 3);
  const rgb = new Uint8Array(k * 3);
  order.forEach((c, i) => {
    lab[i * 3] = centers[c * 3];
    lab[i * 3 + 1] = centers[c * 3 + 1];
    lab[i * 3 + 2] = centers[c * 3 + 2];
    rgb.set(oklabToRgb(lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]), i * 3);
  });

  // 5. Map every pixel to its nearest palette colour (memoised on 6-bit RGB).
  const cache = new Int16Array(1 << 18).fill(-1);
  const tmp = new Float32Array(3);
  for (let p = 0; p < n; p++) {
    const o = p * 4;
    if (data[o + 3] < 128) { index[p] = TRANSPARENT; continue; }
    const key = ((data[o] >> 2) << 12) | ((data[o + 1] >> 2) << 6) | (data[o + 2] >> 2);
    let c = cache[key];
    if (c < 0) {
      rgbToOklab((data[o] & 0xfc) | 2, (data[o + 1] & 0xfc) | 2, (data[o + 2] & 0xfc) | 2, tmp, 0);
      let bd = Infinity;
      for (let j = 0; j < k; j++) {
        const d = dist2(tmp, 0, lab, j * 3);
        if (d < bd) { bd = d; c = j; }
      }
      cache[key] = c;
    }
    index[p] = c;
  }
  if (k > 2 && edges < opaque * 0.35) refineEdges(img, index, flat, lab, k, radius);
  return { index, rgb, lab, count: k };
}

/**
 * Anti-aliased edge pixels are blends of the colours on either side. Mapped to the globally
 * nearest colour they can land on an unrelated third colour (mid-grey between black and white is
 * perceptually close to a saturated red, for example). Restrict each edge pixel to the colours
 * of flat pixels around it.
 */
function refineEdges(img: RGBAImage, index: Uint16Array, flat: Uint8Array, lab: Float32Array, k: number, radius: number): void {
  const { data, width: w, height: h } = img;
  const step = Math.max(1, Math.floor(radius / 5));
  const seen = new Uint8Array(k);
  const cand: number[] = [];
  const tmp = new Float32Array(3);
  const out = index.slice();
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (flat[p] || index[p] === TRANSPARENT) continue;
      const o = p * 4;
      rgbToOklab(data[o], data[o + 1], data[o + 2], tmp, 0);
      // Pixels that clearly are a palette colour (e.g. the thin tip of a shape) stay as they are.
      if (dist2(tmp, 0, lab, index[p] * 3) < 0.0016) continue;
      cand.length = 0;
      for (let dy = -radius; dy <= radius; dy += step) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -radius; dx <= radius; dx += step) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          if (!flat[q]) continue;
          const c = index[q];
          if (c !== TRANSPARENT && !seen[c]) { seen[c] = 1; cand.push(c); }
        }
      }
      for (const c of cand) seen[c] = 0;
      if (cand.length === 0 || (cand.length === 1 && cand[0] === index[p])) continue;
      let best = index[p], bd = Infinity;
      for (const c of cand) {
        const d = dist2(tmp, 0, lab, c * 3);
        if (d < bd) { bd = d; best = c; }
      }
      out[p] = best;
    }
  }
  index.set(out);
}

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

/** Histogram of colour distances from the background: bin width and count (covers 0 … 448). */
const M_STEP = 7, M_BINS = 64;

/** Pixel classes used while learning the palette. */
const FLAT = 1, RIDGE = 2, EDGE = 3;

function dist2(a: ArrayLike<number>, i: number, b: ArrayLike<number>, j: number): number {
  const d0 = a[i] - b[j], d1 = a[i + 1] - b[j + 1], d2 = a[i + 2] - b[j + 2];
  return d0 * d0 + d1 * d1 + d2 * d2;
}

/**
 * Reduce the image to a small palette.
 *
 * The palette is learned from "flat" pixels and from the centre lines of thin features (lines,
 * text strokes, dots). Pixels on anti-aliased edges are blends of their neighbours and barely
 * count, otherwise they would pull in in-between colours that show up as thin halos.
 * Edge pixels are then "unmixed": explained as a blend of a nearby surface colour and another
 * palette colour, and assigned by how much of each they contain.
 */
export function quantize(img: RGBAImage, maxColors: number, scale = 1, source?: RGBAImage): Quantized {
  // Compare pixels one *source* pixel apart: after upscaling, edges spread over several working
  // pixels and neighbouring pixels differ too little to reveal them.
  const st = Math.max(1, Math.round(scale));
  const { data, width: w, height: h } = img;
  const n = w * h;
  const auto = maxColors <= 0;
  const K = auto ? 16 : Math.max(2, Math.min(256, maxColors));
  const mergeDist = auto ? 0.03 : 0.02;

  // 1. Classify pixels: flat, thin-feature centre line ("ridge"), or edge.
  const cls = new Uint8Array(n);
  const prom = new Float32Array(n); // how much a pixel stands out from both of its sides
  let opaque = 0;
  let edges = 0;
  const diff = (a: number, b: number) =>
    Math.abs(data[a] - data[b]) + Math.abs(data[a + 1] - data[b + 1]) + Math.abs(data[a + 2] - data[b + 2]);
  const AXES = [[1, 0], [0, 1], [1, 1], [1, -1]];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x, o = p * 4;
      if (data[o + 3] < 128) continue;
      opaque++;
      let grad = Math.max(diff(o, (y * w + Math.min(w - 1, x + st)) * 4), diff(o, (y * w + Math.max(0, x - st)) * 4));
      grad = Math.max(grad, diff(o, (Math.min(h - 1, y + st) * w + x) * 4), diff(o, (Math.max(0, y - st) * w + x) * 4));
      if (grad <= 30) { cls[p] = FLAT; continue; }
      cls[p] = EDGE;
      edges++;
      // A thin line's pixels differ from both of their sides, while the two sides look alike.
      // Look 1, 2 and 3 source pixels away so lines up to ~5px wide are recognised.
      let best = 0;
      for (let sc = 1; sc <= 3; sc++) {
        const r = sc * st;
        for (const [ax, ay] of AXES) {
          const xa = x - ax * r, ya = y - ay * r, xb = x + ax * r, yb = y + ay * r;
          if (xa < 0 || xb < 0 || xa >= w || xb >= w || ya < 0 || yb < 0 || ya >= h || yb >= h) continue;
          const a = (ya * w + xa) * 4, b = (yb * w + xb) * 4;
          const pa = diff(o, a), pb = diff(o, b);
          if (diff(a, b) < 0.5 * Math.min(pa, pb)) best = Math.max(best, Math.min(pa, pb));
        }
      }
      prom[p] = best;
    }
  }
  // Ridge = local maximum of prominence: the centre line of a thin feature, its purest colour.
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const p = y * w + x;
      const v = prom[p];
      if (v < 45) continue;
      if (
        v >= prom[p - 1] && v >= prom[p + 1] && v >= prom[p - w] && v >= prom[p + w] &&
        v >= prom[p - w - 1] && v >= prom[p - w + 1] && v >= prom[p + w - 1] && v >= prom[p + w + 1]
      ) cls[p] = RIDGE;
    }
  }

  // 2. Weighted histogram over 5-bit bins.
  const wt = new Float64Array(BINS);
  const rw = new Float64Array(BINS); // weight contributed by ridge pixels
  const ew = new Float64Array(BINS); // weight contributed by edge (blend) pixels
  const sr = new Float64Array(BINS), sg = new Float64Array(BINS), sb = new Float64Array(BINS);
  for (let p = 0; p < n; p++) {
    const c = cls[p];
    if (!c) continue;
    const o = p * 4;
    const r = data[o], g = data[o + 1], b = data[o + 2];
    const weight = c === FLAT ? 1 : c === RIDGE ? 0.5 : 0.06;
    const bin = ((r >> 3) << 10) | ((g >> 3) << 5) | (b >> 3);
    wt[bin] += weight;
    if (c === RIDGE) rw[bin] += weight;
    else if (c === EDGE) ew[bin] += weight;
    sr[bin] += r * weight;
    sg[bin] += g * weight;
    sb[bin] += b * weight;
  }

  const index = new Uint16Array(n);
  if (opaque === 0) {
    index.fill(TRANSPARENT);
    return { index, rgb: new Uint8Array(0), lab: new Float32Array(0), count: 0 };
  }

  // 3. Collect non-empty bins as weighted points in OKLab.
  let m = 0;
  for (let i = 0; i < BINS; i++) if (wt[i] > 0) m++;
  const pts = new Float32Array(m * 3);
  const pw = new Float64Array(m);
  const prw = new Float64Array(m);
  const pew = new Float64Array(m);
  let totalW = 0;
  for (let i = 0, j = 0; i < BINS; i++) {
    if (wt[i] <= 0) continue;
    rgbToOklab(sr[i] / wt[i], sg[i] / wt[i], sb[i] / wt[i], pts, j * 3);
    pw[j] = wt[i];
    prw[j] = rw[i];
    pew[j] = ew[i];
    totalW += wt[i];
    j++;
  }

  // 4. k-means with greedy weighted farthest-point initialisation (deterministic).
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
  let frozen: Uint8Array | null = null; // centres that refinement must not move
  const runKmeans = (iterations: number, pw: Float64Array) => {
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
        if (W > 0 && !frozen?.[c]) {
          centers[c * 3] = acc[c * 4] / W;
          centers[c * 3 + 1] = acc[c * 4 + 1] / W;
          centers[c * 3 + 2] = acc[c * 4 + 2] / W;
        }
      }
      if (changed === 0 && it > 0) break;
    }
  };
  runKmeans(24, pw);

  // 5. Cluster weights; merge near-duplicates and drop negligible clusters.
  const clusterWeights = () => {
    const cw = new Float64Array(k);
    for (let i = 0; i < m; i++) cw[assign[i]] += pw[i];
    return cw;
  };
  let cw = clusterWeights();
  // "Pure" weight leaves out anti-aliased blend pixels; a colour that only exists on edges is a
  // blend, not a real colour. (Photos are nearly all edges: fall back to plain weights there.)
  const pure = pw.map((v, i) => v - pew[i]);
  let pureTotal = 0;
  for (let i = 0; i < m; i++) pureTotal += pure[i];
  const usePure = pureTotal > 0.2 * totalW;
  const W = usePure ? pure : pw;
  const WT = usePure ? pureTotal : totalW;
  const cwp = new Float64Array(k), crw = new Float64Array(k);
  for (let i = 0; i < m; i++) { cwp[assign[i]] += W[i]; crw[assign[i]] += prw[i]; }
  let list: { c: number[]; w: number; ridge: number }[] = [];
  for (let c = 0; c < k; c++) {
    if (cwp[c] <= 0) continue;
    list.push({ c: [centers[c * 3], centers[c * 3 + 1], centers[c * 3 + 2]], w: cwp[c], ridge: crw[c] / cwp[c] });
  }

  const minShare = auto ? 0.0015 : 0.0002;
  const d2 = (a: number[], b: number[]) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const mergeInto = (A: (typeof list)[number], B: (typeof list)[number]) => {
    const T = A.w + B.w;
    A.c = [0, 1, 2].map((t) => (A.c[t] * A.w + B.c[t] * B.w) / T);
    A.ridge = (A.ridge * A.w + B.ridge * B.w) / T;
    A.w = T;
  };
  // k-means likes to split one small colour (say a line's dark core) into several shades that are
  // each too small to keep: merge small, similar clusters with each other first.
  for (;;) {
    let bi = -1, bj = -1, bd = 0.12 * 0.12;
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        if (list[i].w / WT >= minShare && list[j].w / WT >= minShare) continue;
        const d = d2(list[i].c, list[j].c);
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
    if (bi < 0) break;
    mergeInto(list[bi], list[bj]);
    list.splice(bj, 1);
  }

  // Tiny clusters are dropped, except the colour of thin features (fine lines, small text): it
  // comes mostly from ridge pixels, differs clearly from every bigger colour, and is not merely a
  // blend lying between two of them. Heaviest first, so each is compared against kept colours.
  const between = (e: number[], a: number[], b: number[]) => {
    const ab = d2(a, b);
    if (ab < 1e-6) return false;
    const t = ((e[0] - a[0]) * (b[0] - a[0]) + (e[1] - a[1]) * (b[1] - a[1]) + (e[2] - a[2]) * (b[2] - a[2])) / ab;
    if (t < 0.05 || t > 0.95) return false;
    const q = [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1]), a[2] + t * (b[2] - a[2])];
    return d2(e, q) < 0.02 * ab + 0.0004;
  };
  // Surface colours first (heaviest first); then thin-feature colours, purest (farthest from the
  // dominant colour) first, so that paler partial-coverage versions are judged after them.
  list.sort((a, b) => b.w - a.w);
  const dominant = list[0]?.c ?? [0, 0, 0];
  const isThin = (e: (typeof list)[number]) => e.ridge >= 0.3;
  list.sort((a, b) =>
    isThin(a) !== isThin(b) ? (isThin(a) ? 1 : -1) : isThin(a) ? d2(b.c, dominant) - d2(a.c, dominant) : b.w - a.w,
  );
  const kept: typeof list = [];
  const isBlend = (e: (typeof list)[number]) => {
    for (let i = 0; i < kept.length; i++)
      for (let j = i + 1; j < kept.length; j++) if (between(e.c, kept[i].c, kept[j].c)) return true;
    return false;
  };
  for (const e of list) {
    const share = e.w / WT;
    // The centre of a hairline only partly covers its pixels, so a hairline of colour C shows up
    // as a paler C. Such a cluster lying between two kept colours is that, not a colour of its own.
    if (e.ridge >= 0.3 && share < 0.02 && isBlend(e)) continue;
    if (share >= minShare) { kept.push(e); continue; }
    if (share < 0.00003 || e.ridge < 0.3) continue;
    if (!kept.every((o) => d2(o.c, e.c) > 0.12 * 0.12)) continue;
    kept.push(e);
  }
  list = kept;
  // Merge perceptual near-duplicates.
  for (;;) {
    let bi = -1, bj = -1, bd = mergeDist * mergeDist;
    for (let i = 0; i < list.length; i++)
      for (let j = i + 1; j < list.length; j++) {
        const d = d2(list[i].c, list[j].c);
        if (d < bd) { bd = d; bi = i; bj = j; }
      }
    if (bi < 0) break;
    mergeInto(list[bi], list[bj]);
    list.splice(bj, 1);
  }
  if (list.length === 0) list = [{ c: [centers[0], centers[1], centers[2]], w: 1, ridge: 0 }];
  k = list.length;
  centers = new Float64Array(k * 3);
  list.forEach((e, c) => centers.set(e.c, c * 3));
  // Refine using pure pixels only: the many blend pixels on edges would otherwise pull small
  // colours (thin lines) towards the background. Thin-feature colours stay put: the pale centres
  // of other hairlines would drag them off (grey looks closer to red than to black); their true
  // colour is estimated after unmixing instead.
  frozen = Uint8Array.from(list, (e) => (e.ridge >= 0.3 && e.w / WT < 0.02 ? 1 : 0));
  runKmeans(6, W);
  cw = clusterWeights();

  // Which colours come mainly from thin features (their pure colour gets re-estimated below).
  const ridgeW = new Float64Array(k), pureW = new Float64Array(k);
  for (let i = 0; i < m; i++) { ridgeW[assign[i]] += prw[i]; pureW[assign[i]] += pw[i] - pew[i]; }

  // Order palette by weight (most used first) for a nicer swatch list.
  const order = Array.from({ length: k }, (_, i) => i).sort((a, b) => cw[b] - cw[a]);
  const lab = new Float32Array(k * 3);
  const rgb = new Uint8Array(k * 3);
  const thin = new Uint8Array(k);
  order.forEach((c, i) => {
    lab[i * 3] = centers[c * 3];
    lab[i * 3 + 1] = centers[c * 3 + 1];
    lab[i * 3 + 2] = centers[c * 3 + 2];
    rgb.set(oklabToRgb(lab[i * 3], lab[i * 3 + 1], lab[i * 3 + 2]), i * 3);
    thin[i] = pureW[c] > 0 && ridgeW[c] / pureW[c] >= 0.3 ? 1 : 0;
  });

  // 6. Map every pixel to its nearest palette colour (memoised on 6-bit RGB).
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
  // Photos are nearly all "edge"; unmixing them is slow and pointless.
  if (k >= 2 && k <= 64 && edges < opaque * 0.5) {
    const nearest = index.slice();
    const stats = unmix(img, index, cls, rgb, k, st);
    // Thin lines and small text rarely cover whole pixels, so the colour learned from them is
    // paler (or, mixed with other partial pixels, duller) than the real ink. Seen from their
    // background S, the stroke's pixels all point the same way, and the most covered ones reach
    // furthest: take the true colour along their mean direction at the 95th percentile of their
    // distance from S. Then unmix again so stroke widths match the corrected colour.
    let corrected = false;
    for (let c = 0; c < k; c++) {
      if (!thin[c]) continue;
      let S = -1, bestN = 0;
      for (let q = 0; q < k; q++) {
        const cnt = stats.dir[(c * k + q) * 4 + 3];
        if (cnt > bestN) { bestN = cnt; S = q; }
      }
      if (S < 0 || bestN < 20) continue;
      const d = stats.dir.subarray((c * k + S) * 4, (c * k + S) * 4 + 3);
      const len = Math.hypot(d[0], d[1], d[2]);
      if (len < 1e-6) continue;
      let hist = stats.mag.subarray((c * k + S) * M_BINS, (c * k + S + 1) * M_BINS);
      let count = bestN;
      if (source) {
        // Upscaling softens one-pixel strokes, so the darkest working pixels understate the ink.
        // Measure the same thing on the original pixels that ended up in this colour.
        const own = new Uint32Array(M_BINS);
        const sw = source.width, sh = source.height, sd = source.data;
        let n2 = 0;
        for (let y = 0; y < sh; y++) {
          const wy = Math.min(h - 1, Math.floor(((y + 0.5) * h) / sh));
          for (let x = 0; x < sw; x++) {
            const wx = Math.min(w - 1, Math.floor(((x + 0.5) * w) / sw));
            if (index[wy * w + wx] !== c) continue;
            const o = (y * sw + x) * 4;
            const proj = ((sd[o] - rgb[S * 3]) * d[0] + (sd[o + 1] - rgb[S * 3 + 1]) * d[1] + (sd[o + 2] - rgb[S * 3 + 2]) * d[2]) / len;
            if (proj <= 0) continue;
            own[Math.min(M_BINS - 1, Math.floor(proj / M_STEP))]++;
            n2++;
          }
        }
        if (n2 >= 8) { hist = own; count = n2; }
      }
      let acc = 0, b = 0;
      while (b < M_BINS - 1 && acc + hist[b] < count * 0.95) acc += hist[b++];
      const ext = (b + 0.5) * M_STEP;
      const next = [0, 1, 2].map((j) => Math.max(0, Math.min(255, Math.round(rgb[S * 3 + j] + (d[j] / len) * ext))));
      const moved = Math.hypot(next[0] - rgb[c * 3], next[1] - rgb[c * 3 + 1], next[2] - rgb[c * 3 + 2]);
      if (moved < 6) continue;
      rgb.set(next, c * 3);
      rgbToOklab(rgb[c * 3], rgb[c * 3 + 1], rgb[c * 3 + 2], lab, c * 3);
      corrected = true;
    }
    if (corrected) {
      index.set(nearest);
      unmix(img, index, cls, rgb, k, st);
    }
  }
  return { index, rgb, lab, count: k };
}

/**
 * Anti-aliased edge pixels are blends of the colours on either side. Mapped to the globally
 * nearest colour they can land on an unrelated third colour (mid-grey between black and white is
 * perceptually close to a saturated red, for example), and all pixels of a thin line can be
 * closer to the background than to the line colour, making the line vanish.
 *
 * So each edge pixel is explained as surface colour S (a flat colour nearby) mixed with some
 * palette colour C: p ≈ S + t·(C − S). It becomes C when t passes a threshold: 0.5 for ordinary
 * edges, but relative to the local peak for faint thin strokes, so that a hairline whose pixels
 * never reach 50% coverage is kept, with about its visual width.
 */
function unmix(img: RGBAImage, index: Uint16Array, cls: Uint8Array, pal: Uint8Array, k: number, st: number) {
  // Per (colour C, surface S): Σ (p − S) and count; histogram of |p − S|.
  const dir = new Float64Array(k * k * 4);
  const mag = new Uint32Array(k * k * M_BINS);
  const { data, width: w, height: h } = img;
  const n = w * h;
  const NONE = 0xffff;
  const pair = new Uint16Array(n).fill(NONE); // S * 256 + C
  const tq = new Uint8Array(n); // t * 255
  const R = 3 * st + 3;
  const all = Array.from({ length: k }, (_, i) => i);
  const many = k > 32;

  // Which colours occur (as flat pixels / at all) in each B×B block, as 64-bit masks (lo, hi).
  // A pixel's surroundings are the union of the blocks within reach: a few ORs, no pixel scan.
  const B = Math.max(2, Math.ceil(R / 2));
  const bw = Math.ceil(w / B), bh = Math.ceil(h / B);
  const flatLo = new Uint32Array(bw * bh), flatHi = new Uint32Array(bw * bh);
  const anyLo = new Uint32Array(bw * bh), anyHi = new Uint32Array(bw * bh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const c = index[p];
      if (c === TRANSPARENT) continue;
      const b = Math.floor(y / B) * bw + Math.floor(x / B);
      if (c < 32) { anyLo[b] |= 1 << c; if (cls[p] === FLAT) flatLo[b] |= 1 << c; }
      else { anyHi[b] |= 1 << (c - 32); if (cls[p] === FLAT) flatHi[b] |= 1 << (c - 32); }
    }
  }
  const bits = (lo: number, hi: number, out: number[]) => {
    out.length = 0;
    for (let i = 0; lo; i++, lo >>>= 1) if (lo & 1) out.push(i);
    for (let i = 32; hi; i++, hi >>>= 1) if (hi & 1) out.push(i);
  };
  const surf: number[] = [];
  const near: number[] = [];

  for (let y = 0; y < h; y++) {
    const by0 = Math.max(0, Math.floor((y - R) / B)), by1 = Math.min(bh - 1, Math.floor((y + R) / B));
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      if (cls[p] !== EDGE && cls[p] !== RIDGE) continue;
      const bx0 = Math.max(0, Math.floor((x - R) / B)), bx1 = Math.min(bw - 1, Math.floor((x + R) / B));
      let fl = 0, fh = 0, al = 0, ah = 0;
      for (let by = by0; by <= by1; by++)
        for (let bx = bx0; bx <= bx1; bx++) {
          const b = by * bw + bx;
          fl |= flatLo[b]; fh |= flatHi[b]; al |= anyLo[b]; ah |= anyHi[b];
        }
      if (!fl && !fh) continue; // nothing flat around: keep the nearest colour
      bits(fl, fh, surf);
      if (many) bits(al, ah, near);
      const cs = many ? near : all;

      const o = p * 4;
      const pr = data[o], pg = data[o + 1], pb = data[o + 2];
      let best = Infinity, bS = -1, bC = -1, bt = 0, bdd = 0, btRaw = 0;
      for (const S of surf) {
        const s0 = pal[S * 3], s1 = pal[S * 3 + 1], s2 = pal[S * 3 + 2];
        const er = pr - s0, eg = pg - s1, eb = pb - s2;
        const pure = er * er + eg * eg + eb * eb;
        if (pure < best) { best = pure; bS = S; bC = -1; bt = 0; bdd = 0; }
        for (const C of cs) {
          if (C === S) continue;
          const dr = pal[C * 3] - s0, dg = pal[C * 3 + 1] - s1, db = pal[C * 3 + 2] - s2;
          const dd = dr * dr + dg * dg + db * db;
          if (dd < 400) continue;
          const tRaw = (er * dr + eg * dg + eb * db) / dd;
          if (tRaw <= 0) continue;
          const t = Math.min(1, tRaw);
          const rr = er - t * dr, rg = eg - t * dg, rb = eb - t * db;
          const res = rr * rr + rg * rg + rb * rb;
          if (res < best) { best = res; bS = S; bC = C; bt = t; bdd = dd; btRaw = tRaw; }
        }
      }
      // Not a two-colour blend (a colour of its own, or a three-colour junction): keep nearest.
      if (best > 900 + 0.02 * bdd) continue;
      if (bC < 0) { index[p] = bS; continue; }
      // An edge between two flat regions reads the same either way round; pick one orientation
      // consistently so neighbouring pixels are compared like for like.
      if (bC < bS && surf.includes(bC)) { const t = bS; bS = bC; bC = t; bt = 1 - bt; btRaw = -1; }
      pair[p] = bS * 256 + bC;
      tq[p] = Math.round(bt * 255);
      if (btRaw > 0.2) {
        const er = pr - pal[bS * 3], eg = pg - pal[bS * 3 + 1], eb = pb - pal[bS * 3 + 2];
        const j = (bC * k + bS) * 4;
        dir[j] += er; dir[j + 1] += eg; dir[j + 2] += eb; dir[j + 3]++;
        mag[(bC * k + bS) * M_BINS + Math.min(M_BINS - 1, Math.floor(Math.hypot(er, eg, eb) / M_STEP))]++;
      }
    }
  }

  // Decide each blend pixel so that ink is conserved locally. Around pixel p, the coverages of
  // colour C add up to how many pixels' worth of C there really are (the "mass"); the most
  // covered pixels get them. So p becomes C if fewer than `mass` neighbours are more covered.
  // Along an ordinary edge this is exactly the 50% split; for a hairline whose pixels never
  // reach 50% it still draws a line of the right weight instead of dropping it.
  const R2 = 2 * st + 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const pp = pair[p];
      if (pp === NONE) continue;
      const S = pp >> 8, C = pp & 255;
      const tp = tq[p];
      if (tp >= 128) { index[p] = C; continue; } // mostly C
      if (tp < 40) { index[p] = S; continue; } // barely touched
      const dr = pal[C * 3] - pal[S * 3], dg = pal[C * 3 + 1] - pal[S * 3 + 1], db = pal[C * 3 + 2] - pal[S * 3 + 2];
      if (dr * dr + dg * dg + db * db < 60 * 60) { index[p] = S; continue; } // low contrast: plain 50% split
      let mass = 0, above = 0, ties = 0;
      for (let dy = -R2; dy <= R2; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -R2; dx <= R2; dx++) {
          const xx = x + dx;
          if (xx < 0 || xx >= w) continue;
          const q = yy * w + xx;
          let tv: number;
          if (pair[q] !== NONE) { if ((pair[q] & 255) !== C) continue; tv = tq[q]; }
          else if (cls[q] === FLAT && index[q] === C) tv = 255;
          else continue;
          mass += tv;
          if (tv > tp) above++;
          else if (tv === tp) ties++;
        }
      }
      index[p] = above + 0.5 * ties < mass / 255 ? C : S;
    }
  }
  return { dir, mag };
}

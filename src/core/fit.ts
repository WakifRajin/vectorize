import { CMD_C, CMD_L } from './types.ts';

export interface FitParams {
  /** Max allowed deviation of the curve from the boundary, in working pixels. */
  tolerance: number;
  /** cos(corner angle): bends sharper than the corner angle are kept as corners. */
  cornerCos: number;
  /** Arm length (in boundary steps) used to measure bend angles. */
  arm: number;
  /** Gaussian σ (working pixels) used to smooth the pixel staircase before fitting. */
  smoothing: number;
}

/** Fitted chain: start point + packed segments (CMD_L x y | CMD_C x1 y1 x2 y2 x y). */
export interface Fitted {
  x0: number;
  y0: number;
  segs: number[];
}

type Pts = Float64Array; // packed x,y

// ---------------------------------------------------------------------------------------------
// Schneider, "An Algorithm for Automatically Fitting Digitized Curves" (Graphics Gems, 1990).

function bez(p: number[], t: number, out: number[]): void {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  out[0] = a * p[0] + b * p[2] + c * p[4] + d * p[6];
  out[1] = a * p[1] + b * p[3] + c * p[5] + d * p[7];
}

function chordParams(d: Pts, first: number, last: number): Float64Array {
  const u = new Float64Array(last - first + 1);
  for (let i = first + 1; i <= last; i++) {
    u[i - first] = u[i - first - 1] + Math.hypot(d[i * 2] - d[i * 2 - 2], d[i * 2 + 1] - d[i * 2 - 1]);
  }
  const total = u[last - first];
  if (total > 0) for (let i = 1; i < u.length; i++) u[i] /= total;
  return u;
}

function generateBezier(d: Pts, first: number, last: number, u: Float64Array, t1: number[], t2: number[]): number[] {
  const p0x = d[first * 2], p0y = d[first * 2 + 1];
  const p3x = d[last * 2], p3y = d[last * 2 + 1];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < u.length; i++) {
    const t = u[i], mt = 1 - t;
    const b0 = mt * mt * mt, b1 = 3 * t * mt * mt, b2 = 3 * t * t * mt, b3 = t * t * t;
    const a1x = t1[0] * b1, a1y = t1[1] * b1;
    const a2x = t2[0] * b2, a2y = t2[1] * b2;
    c00 += a1x * a1x + a1y * a1y;
    c01 += a1x * a2x + a1y * a2y;
    c11 += a2x * a2x + a2y * a2y;
    const tx = d[(first + i) * 2] - (p0x * (b0 + b1) + p3x * (b2 + b3));
    const ty = d[(first + i) * 2 + 1] - (p0y * (b0 + b1) + p3y * (b2 + b3));
    x0 += a1x * tx + a1y * ty;
    x1 += a2x * tx + a2y * ty;
  }
  const det = c00 * c11 - c01 * c01;
  let alphaL = det === 0 ? 0 : (x0 * c11 - x1 * c01) / det;
  let alphaR = det === 0 ? 0 : (c00 * x1 - c01 * x0) / det;
  const segLen = Math.hypot(p3x - p0x, p3y - p0y);
  const eps = 1e-6 * segLen;
  if (alphaL < eps || alphaR < eps || alphaL > segLen * 2 || alphaR > segLen * 2) {
    alphaL = alphaR = segLen / 3;
  }
  return [p0x, p0y, p0x + t1[0] * alphaL, p0y + t1[1] * alphaL, p3x + t2[0] * alphaR, p3y + t2[1] * alphaR, p3x, p3y];
}

function maxError(d: Pts, first: number, last: number, b: number[], u: Float64Array): [number, number] {
  let max = 0;
  let split = Math.floor((last - first + 1) / 2) + first;
  const q = [0, 0];
  for (let i = first + 1; i < last; i++) {
    bez(b, u[i - first], q);
    const dx = q[0] - d[i * 2], dy = q[1] - d[i * 2 + 1];
    const e = dx * dx + dy * dy;
    if (e >= max) { max = e; split = i; }
  }
  return [max, split];
}

function reparameterize(d: Pts, first: number, u: Float64Array, b: number[]): Float64Array {
  const out = new Float64Array(u.length);
  const q = [0, 0];
  for (let i = 0; i < u.length; i++) {
    const t = u[i], mt = 1 - t;
    bez(b, t, q);
    const px = d[(first + i) * 2], py = d[(first + i) * 2 + 1];
    // first and second derivatives
    const q1x = 3 * (mt * mt * (b[2] - b[0]) + 2 * mt * t * (b[4] - b[2]) + t * t * (b[6] - b[4]));
    const q1y = 3 * (mt * mt * (b[3] - b[1]) + 2 * mt * t * (b[5] - b[3]) + t * t * (b[7] - b[5]));
    const q2x = 6 * (mt * (b[4] - 2 * b[2] + b[0]) + t * (b[6] - 2 * b[4] + b[2]));
    const q2y = 6 * (mt * (b[5] - 2 * b[3] + b[1]) + t * (b[7] - 2 * b[5] + b[3]));
    const num = (q[0] - px) * q1x + (q[1] - py) * q1y;
    const den = q1x * q1x + q1y * q1y + (q[0] - px) * q2x + (q[1] - py) * q2y;
    out[i] = den === 0 ? t : Math.min(1, Math.max(0, t - num / den));
  }
  return out;
}

function norm(x: number, y: number): number[] {
  const l = Math.hypot(x, y);
  return l > 1e-12 ? [x / l, y / l] : [0, 0];
}

/** cos(110°): a single cubic may turn at most this much, otherwise wide arcs look lumpy. */
const MAX_TURN_COS = -0.34;

function fitCubic(d: Pts, first: number, last: number, t1: number[], t2: number[], err2: number, reach: number, out: number[], depth: number): void {
  const n = last - first + 1;
  if (n === 2 || depth > 24) {
    const dist = Math.hypot(d[last * 2] - d[first * 2], d[last * 2 + 1] - d[first * 2 + 1]) / 3;
    out.push(
      CMD_C,
      d[first * 2] + t1[0] * dist, d[first * 2 + 1] + t1[1] * dist,
      d[last * 2] + t2[0] * dist, d[last * 2 + 1] + t2[1] * dist,
      d[last * 2], d[last * 2 + 1],
    );
    return;
  }
  const tooWide = n >= 8 && -(t1[0] * t2[0] + t1[1] * t2[1]) < MAX_TURN_COS;
  let u = chordParams(d, first, last);
  let b = generateBezier(d, first, last, u, t1, t2);
  let [e, split] = maxError(d, first, last, b, u);
  if (!tooWide) {
    if (e < err2) { out.push(CMD_C, b[2], b[3], b[4], b[5], b[6], b[7]); return; }
    if (e < err2 * 4) {
      for (let i = 0; i < 6; i++) {
        u = reparameterize(d, first, u, b);
        b = generateBezier(d, first, last, u, t1, t2);
        [e, split] = maxError(d, first, last, b, u);
        if (e < err2) { out.push(CMD_C, b[2], b[3], b[4], b[5], b[6], b[7]); return; }
      }
    }
  } else {
    split = (first + last) >> 1;
  }
  // Tangent at the split from a least-squares line through the neighbouring samples.
  const r = Math.max(1, Math.min(reach, split - first, last - split));
  const l = lineFit((i, c) => d[i * 2 + c], split + r, split - r);
  const tc = [l.dx, l.dy];
  fitCubic(d, first, split, t1, tc, err2, reach, out, depth + 1);
  fitCubic(d, split, last, [-tc[0], -tc[1]], t2, err2, reach, out, depth + 1);
}

// ---------------------------------------------------------------------------------------------

/**
 * Gaussian smoothing of sample positions (σ in samples ≈ working pixels). Removes pixel
 * stair-steps, including the large ones of upscaled aliased images. Open runs keep their end
 * points fixed: samples beyond an end are mirrored through it, which also keeps straight lines
 * straight right up to the end.
 */
function smooth(s: Pts, sigma: number, cyclic: boolean): void {
  const m = s.length / 2;
  if (m < 3 || sigma <= 0) return;
  const r = Math.min(Math.ceil(sigma * 2.5), cyclic ? (m >> 1) - 1 : m - 1);
  if (r < 1) return;
  const k = new Float64Array(r + 1);
  let sum = 0;
  for (let i = 0; i <= r; i++) { k[i] = Math.exp((-i * i) / (2 * sigma * sigma)); sum += i ? 2 * k[i] : k[i]; }
  for (let i = 0; i <= r; i++) k[i] /= sum;
  const src = s.slice();
  const get = (i: number, c: number): number => {
    if (cyclic) return src[(((i % m) + m) % m) * 2 + c];
    if (i < 0) return 2 * src[c] - get(-i, c);
    if (i >= m) return 2 * src[(m - 1) * 2 + c] - get(2 * (m - 1) - i, c);
    return src[i * 2 + c];
  };
  const lo = cyclic ? 0 : 1, hi = cyclic ? m : m - 1;
  for (let i = lo; i < hi; i++) {
    let x = k[0] * src[i * 2], y = k[0] * src[i * 2 + 1];
    for (let j = 1; j <= r; j++) {
      x += k[j] * (get(i - j, 0) + get(i + j, 0));
      y += k[j] * (get(i - j, 1) + get(i + j, 1));
    }
    s[i * 2] = x;
    s[i * 2 + 1] = y;
  }
}

interface Line { mx: number; my: number; dx: number; dy: number }

/**
 * Least-squares line through points i0..i1 of a point getter (centroid + principal direction,
 * oriented from i0 towards i1). Much more robust on pixel staircases than a two-point difference.
 */
function lineFit(get: (i: number, c: 0 | 1) => number, i0: number, i1: number): Line {
  const lo = Math.min(i0, i1), hi = Math.max(i0, i1);
  let mx = 0, my = 0;
  const cnt = hi - lo + 1;
  for (let i = lo; i <= hi; i++) { mx += get(i, 0); my += get(i, 1); }
  mx /= cnt;
  my /= cnt;
  let sxx = 0, sxy = 0, syy = 0;
  for (let i = lo; i <= hi; i++) {
    const dx = get(i, 0) - mx, dy = get(i, 1) - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  let dx = Math.cos(th), dy = Math.sin(th);
  if (dx * (get(i1, 0) - get(i0, 0)) + dy * (get(i1, 1) - get(i0, 1)) < 0) { dx = -dx; dy = -dy; }
  return { mx, my, dx, dy };
}

/** Tangent leaving the start (dir = 1) or end (dir = -1) of a sample run, pointing into it. */
function endTangent(s: Pts, from: number, dir: 1 | -1, reach: number): number[] {
  const m = s.length / 2;
  const get = (i: number, c: 0 | 1) => s[i * 2 + c];
  const r = Math.max(1, Math.min(m - 1, reach));
  const l = dir === 1 ? lineFit(get, 0, r) : lineFit(get, from, from - r);
  return [l.dx, l.dy];
}

/** Fit an open run of samples (endpoints fixed) and append segments to out. */
function fitSpan(s: Pts, t1: number[] | null, t2: number[] | null, P: FitParams, out: number[]): void {
  const m = s.length / 2;
  const lx = s[(m - 1) * 2], ly = s[(m - 1) * 2 + 1];
  if (m <= 2) { out.push(CMD_L, lx, ly); return; }
  const cx = lx - s[0], cy = ly - s[1];
  const chord = Math.hypot(cx, cy);

  if (chord < 1e-6) {
    // Start == end (e.g. a closed loop with a single corner): split at the farthest sample.
    let far = 1, fd = -1;
    for (let i = 1; i < m - 1; i++) {
      const dd = (s[i * 2] - s[0]) ** 2 + (s[i * 2 + 1] - s[1]) ** 2;
      if (dd > fd) { fd = dd; far = i; }
    }
    const tc = norm(s[(far - 1) * 2] - s[(far + 1) * 2], s[(far - 1) * 2 + 1] - s[(far + 1) * 2 + 1]);
    fitSpan(s.slice(0, (far + 1) * 2), t1, tc, P, out);
    fitSpan(s.slice(far * 2), [-tc[0], -tc[1]], t2, P, out);
    return;
  }

  // Straight enough? Emit a line.
  let dev = 0;
  for (let i = 1; i < m - 1; i++) {
    const d = Math.abs((s[i * 2] - s[0]) * cy - (s[i * 2 + 1] - s[1]) * cx) / chord;
    if (d > dev) dev = d;
  }
  if (dev <= P.tolerance * 0.75) { out.push(CMD_L, lx, ly); return; }

  const reach = Math.min(P.arm, Math.floor((m - 1) / 3));
  fitCubic(s, 0, m - 1, t1 ?? endTangent(s, 0, 1, reach), t2 ?? endTangent(s, m - 1, -1, reach), P.tolerance * P.tolerance, Math.max(2, P.arm), out, 0);
}

/**
 * Turn a pixel-edge boundary chain into lines and Bézier curves.
 * `pts` holds the integer grid vertices; a closed chain repeats its first vertex at the end.
 */
export function fitChain(
  pts: Int32Array,
  closed: boolean,
  P: FitParams,
  // Open chains: (refined) junction positions to use for the two ends.
  sx = pts[0],
  sy = pts[1],
  ex = pts[pts.length - 2],
  ey = pts[pts.length - 1],
): Fitted {
  const n = pts.length / 2 - 1; // number of unit edges
  const segs: number[] = [];
  if (!closed && n <= 2) {
    segs.push(CMD_L, ex, ey);
    return { x0: sx, y0: sy, segs };
  }
  const V = (i: number, c: 0 | 1) => pts[(closed ? ((i % n) + n) % n : i) * 2 + c];

  // --- corner detection --------------------------------------------------------------------
  const cosA = new Float64Array(n + 1).fill(-1);
  const armOf = (i: number) => (closed ? Math.max(1, Math.min(P.arm, Math.floor(n / 6))) : Math.min(P.arm, i, n - i));
  // Near the ends of open chains the arms get short and staircases look like bends; skip those.
  const minArm = closed ? 1 : Math.max(2, Math.ceil(P.arm * 0.75));
  const lo = closed ? 0 : 1, hi = n;
  for (let i = lo; i < hi; i++) {
    const k = armOf(i);
    if (k < minArm) continue;
    const ax = V(i - k, 0) - V(i, 0), ay = V(i - k, 1) - V(i, 1);
    const bx = V(i + k, 0) - V(i, 0), by = V(i + k, 1) - V(i, 1);
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by);
    if (la === 0 || lb === 0) continue;
    cosA[i] = (ax * bx + ay * by) / (la * lb);
  }
  const corners: number[] = [];
  for (let i = lo; i < hi; i++) {
    if (cosA[i] <= P.cornerCos) continue;
    const k = Math.max(1, armOf(i));
    let isMax = true;
    for (let j = -k; j <= k && isMax; j++) {
      if (j === 0) continue;
      let q = i + j;
      if (closed) q = ((q % n) + n) % n;
      else if (q < 1 || q > n - 1) continue;
      if (cosA[q] > cosA[i] || (cosA[q] === cosA[i] && j < 0)) isMax = false;
    }
    if (isMax) corners.push(i);
  }

  // --- obtuse corners where two straight edges meet -----------------------------------------
  // The angle test above only catches sharp bends. A shallow bend between two long, straight
  // edges is still a corner (think polygons); smooth curves never have straight arms on both sides.
  // Arms must be long: an arc of radius R deviates L²/8R from straight over length L but bends
  // by L/R, so for L ≥ ~50px no arc can look both straight (≤ 0.8px) and bent (≥ 8°).
  const k2 = Math.max(56, 4 * P.arm);
  if (n > (closed ? 4 : 2) * k2) {
    const bend = new Float64Array(n + 1).fill(-1);
    const lo2 = closed ? 0 : k2, hi2 = closed ? n : n - k2;
    for (let i = lo2; i < hi2; i++) {
      const ax = V(i - k2, 0) - V(i, 0), ay = V(i - k2, 1) - V(i, 1);
      const bx = V(i + k2, 0) - V(i, 0), by = V(i + k2, 1) - V(i, 1);
      bend[i] = (ax * bx + ay * by) / (Math.hypot(ax, ay) * Math.hypot(bx, by));
    }
    const near = (i: number) => corners.some((c) => Math.min(Math.abs(c - i), closed ? n - Math.abs(c - i) : Infinity) < k2);
    const g = Math.max(1, Math.ceil(P.arm / 2));
    // Edge midpoints: far less stair-step noise than the pixel-corner vertices.
    const M = (i: number, c: 0 | 1) => (V(i, c) + V(i + 1, c)) / 2;
    const straight = (l: { mx: number; my: number; dx: number; dy: number }, i0: number, i1: number) => {
      for (let i = i0; i <= i1; i++) {
        if (Math.abs((M(i, 0) - l.mx) * l.dy - (M(i, 1) - l.my) * l.dx) > 0.8) return false;
      }
      return true;
    };
    const extra: number[] = [];
    for (let i = lo2; i < hi2; i++) {
      if (bend[i] < -0.9903 || bend[i] > P.cornerCos) continue; // < ~8° of bend, or already sharp
      let isMax = true;
      for (let j = -(k2 >> 1); j <= k2 >> 1 && isMax; j++) {
        if (j === 0) continue;
        const q = closed ? (((i + j) % n) + n) % n : i + j;
        if (bend[q] > bend[i] || (bend[q] === bend[i] && j < 0)) isMax = false;
      }
      if (!isMax || near(i)) continue;
      const la = lineFit(M, i - k2, i - g), lb = lineFit(M, i + g, i + k2 - 1);
      if (la.dx * lb.dx + la.dy * lb.dy > 0.9903) continue;
      if (!straight(la, i - k2, i - g) || !straight(lb, i + g, i + k2 - 1)) continue;
      // Each arm must not curve on its own (an arc spreads its bend along the arms).
      const turn = Math.acos(Math.min(1, la.dx * lb.dx + la.dy * lb.dy));
      const ma = (i - k2 + i - g) >> 1, mb = (i + g + i + k2) >> 1;
      const a1 = lineFit(M, i - k2, ma), a2 = lineFit(M, ma, i - g);
      const b1 = lineFit(M, i + g, mb), b2 = lineFit(M, mb, i + k2 - 1);
      const ta = Math.acos(Math.min(1, a1.dx * a2.dx + a1.dy * a2.dy));
      const tb = Math.acos(Math.min(1, b1.dx * b2.dx + b1.dy * b2.dy));
      if (ta < 0.3 * turn && tb < 0.3 * turn) extra.push(i);
    }
    if (extra.length) {
      corners.push(...extra);
      corners.sort((a, b) => a - b);
    }
  }

  // --- corner refinement ---------------------------------------------------------------------
  // Upscaling rounds sharp corners a little, so the detected vertex sits on the rounded part.
  // Move each corner to the intersection of lines fitted to its two arms, and skip the rounded
  // samples right next to it.
  const nc = corners.length;
  const cx = new Float64Array(nc), cy = new Float64Array(nc), gap = new Int32Array(nc);
  for (let j = 0; j < nc; j++) {
    const i = corners[j];
    let prev = j > 0 ? corners[j - 1] : closed ? corners[nc - 1] - n : 0;
    let next = j + 1 < nc ? corners[j + 1] : closed ? corners[0] + n : n;
    if (closed && nc === 1) { prev = i - n; next = i + n; }
    cx[j] = V(i, 0);
    cy[j] = V(i, 1);
    const g = Math.max(1, Math.ceil(P.arm / 2));
    const L = 3 * P.arm;
    const a0 = Math.max(i - L, Math.ceil((prev + i) / 2)), a1 = i - g;
    const b0 = i + g, b1 = Math.min(i + L, Math.floor((i + next) / 2));
    if (a1 - a0 < 2 || b1 - b0 < 2) continue;
    const la = lineFit(V, a0, a1), lb = lineFit(V, b0, b1);
    const den = la.dx * lb.dy - la.dy * lb.dx;
    if (Math.abs(den) < 0.17) continue; // arms nearly parallel: keep the vertex
    const t = ((lb.mx - la.mx) * lb.dy - (lb.my - la.my) * lb.dx) / den;
    const ix = la.mx + t * la.dx, iy = la.my + t * la.dy;
    if (Math.hypot(ix - cx[j], iy - cy[j]) > 1.5 * P.arm) continue;
    cx[j] = ix;
    cy[j] = iy;
    gap[j] = g;
  }

  // --- samples between two vertex indices (a < b, may wrap for closed chains) -----------------
  const samples = (a: number, b: number, sx: number, sy: number, ga: number, ex: number, ey: number, gb: number): Pts => {
    const i0 = a + ga, i1 = b - gb;
    if (i1 <= i0) return Float64Array.of(sx, sy, ex, ey);
    const s = new Float64Array((i1 - i0 + 2) * 2);
    s[0] = sx; s[1] = sy;
    for (let i = i0; i < i1; i++) {
      s[(i - i0 + 1) * 2] = (V(i, 0) + V(i + 1, 0)) / 2;
      s[(i - i0 + 1) * 2 + 1] = (V(i, 1) + V(i + 1, 1)) / 2;
    }
    s[(i1 - i0 + 1) * 2] = ex; s[(i1 - i0 + 1) * 2 + 1] = ey;
    smooth(s, P.smoothing, false);
    return s;
  };

  if (!closed) {
    // breakpoints: chain start, corners, chain end (ends are junctions and never move)
    const bi = [0, ...corners, n];
    // Colours of three regions blend near a junction, so the boundary is unreliable right next
    // to it: keep the exact junction point but don't fit the few samples closest to it.
    const gEnd = n > 4 * P.arm ? Math.min(2 * P.arm, Math.floor(n / 4)) : 0;
    const bx = [sx, ...cx, ex], by = [sy, ...cy, ey], bg = [gEnd, ...gap, gEnd];
    for (let k = 0; k + 1 < bi.length; k++) {
      fitSpan(samples(bi[k], bi[k + 1], bx[k], by[k], bg[k], bx[k + 1], by[k + 1], bg[k + 1]), null, null, P, segs);
    }
    return { x0: sx, y0: sy, segs: tidy(sx, sy, segs, P.tolerance) };
  }

  if (nc > 0) {
    for (let j = 0; j < nc; j++) {
      const k = (j + 1) % nc;
      const b = j + 1 < nc ? corners[j + 1] : corners[0] + n;
      fitSpan(samples(corners[j], b, cx[j], cy[j], gap[j], cx[k], cy[k], gap[k]), null, null, P, segs);
    }
    return { x0: cx[0], y0: cy[0], segs: tidy(cx[0], cy[0], segs, P.tolerance) };
  }

  // Smooth closed loop without corners: cyclic samples split into quarters with shared tangents.
  if (n < 8) {
    for (let i = 1; i <= n; i++) segs.push(CMD_L, V(i, 0), V(i, 1));
    return { x0: V(0, 0), y0: V(0, 1), segs };
  }
  const s = new Float64Array(n * 2);
  for (let i = 0; i < n; i++) {
    s[i * 2] = (V(i, 0) + V(i + 1, 0)) / 2;
    s[i * 2 + 1] = (V(i, 1) + V(i + 1, 1)) / 2;
  }
  smooth(s, P.smoothing, true);
  const at = (i: number) => ((i % n) + n) % n;
  const getS = (i: number, c: 0 | 1) => s[at(i) * 2 + c];
  const tangent = (i: number) => {
    const r = Math.max(1, Math.min(2 * P.arm, Math.floor(n / 8)));
    const l = lineFit(getS, i - r, i + r);
    return [l.dx, l.dy];
  };
  const q = [0, Math.round(n / 4), Math.round(n / 2), Math.round((3 * n) / 4), n];
  for (let j = 0; j < 4; j++) {
    const a = q[j], b = q[j + 1];
    const sub = new Float64Array((b - a + 1) * 2);
    for (let i = a; i <= b; i++) { sub[(i - a) * 2] = s[at(i) * 2]; sub[(i - a) * 2 + 1] = s[at(i) * 2 + 1]; }
    const ta = tangent(a), tb = tangent(b);
    fitSpan(sub, ta, [-tb[0], -tb[1]], P, segs);
  }
  return { x0: s[0], y0: s[1], segs: tidy(s[0], s[1], segs, P.tolerance) };
}

/**
 * Clean up fitted segments: cubics that are really straight become lines, and runs of
 * collinear lines are merged.
 */
function tidy(x0: number, y0: number, segs: number[], tol: number): number[] {
  const out: number[] = [];
  const eps = Math.min(0.35, tol * 0.15);
  const distToLine = (px: number, py: number, ax: number, ay: number, bx: number, by: number) => {
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy);
    if (len < 1e-9) return Math.hypot(px - ax, py - ay);
    const t = ((px - ax) * dx + (py - ay) * dy) / (len * len);
    if (t < -0.05 || t > 1.05) return Infinity;
    return Math.abs((px - ax) * dy - (py - ay) * dx) / len;
  };
  let cx = x0, cy = y0;
  // start of the line run currently at the end of out (for merging)
  let runX = NaN, runY = NaN;
  for (let i = 0; i < segs.length; ) {
    let isLine = segs[i] === CMD_L;
    let ex: number, ey: number;
    if (isLine) { ex = segs[i + 1]; ey = segs[i + 2]; i += 3; }
    else {
      ex = segs[i + 5]; ey = segs[i + 6];
      if (distToLine(segs[i + 1], segs[i + 2], cx, cy, ex, ey) <= eps && distToLine(segs[i + 3], segs[i + 4], cx, cy, ex, ey) <= eps) isLine = true;
      else out.push(CMD_C, segs[i + 1], segs[i + 2], segs[i + 3], segs[i + 4], ex, ey);
      i += 7;
    }
    if (isLine) {
      // merge with the previous line if the shared point lies on the combined line
      if (!Number.isNaN(runX) && out.length >= 3 && out[out.length - 3] === CMD_L && distToLine(cx, cy, runX, runY, ex, ey) <= eps) {
        out[out.length - 2] = ex;
        out[out.length - 1] = ey;
      } else {
        out.push(CMD_L, ex, ey);
        runX = cx; runY = cy;
      }
    } else {
      runX = NaN;
    }
    cx = ex; cy = ey;
  }
  return out;
}

/** The same geometry traversed in the opposite direction. */
export function reverseFitted(f: Fitted): Fitted {
  const starts: number[] = [f.x0, f.y0];
  const { segs } = f;
  const idx: number[] = [];
  for (let i = 0; i < segs.length; ) {
    idx.push(i);
    if (segs[i] === CMD_L) { starts.push(segs[i + 1], segs[i + 2]); i += 3; }
    else { starts.push(segs[i + 5], segs[i + 6]); i += 7; }
  }
  const out: number[] = [];
  for (let k = idx.length - 1; k >= 0; k--) {
    const i = idx[k];
    const sx = starts[k * 2], sy = starts[k * 2 + 1];
    if (segs[i] === CMD_L) out.push(CMD_L, sx, sy);
    else out.push(CMD_C, segs[i + 3], segs[i + 4], segs[i + 1], segs[i + 2], sx, sy);
  }
  const last = idx.length;
  return { x0: starts[last * 2], y0: starts[last * 2 + 1], segs: out };
}

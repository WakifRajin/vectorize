import { rgbToOklab } from './color.ts';
import { TRANSPARENT } from './quantize.ts';

export interface Regions {
  /** Region id per pixel. */
  labels: Int32Array;
  count: number;
  /** Palette index of each region (or TRANSPARENT). */
  color: Int32Array;
  area: Int32Array;
}

/** 4-connected component labelling of a palette-index image. */
export function labelRegions(index: Uint16Array, w: number, h: number): Regions {
  const n = w * h;
  const labels = new Int32Array(n).fill(-1);
  const stack = new Int32Array(n);
  const colors: number[] = [];
  const areas: number[] = [];
  let count = 0;
  for (let start = 0; start < n; start++) {
    if (labels[start] >= 0) continue;
    const c = index[start];
    let sp = 0;
    stack[sp++] = start;
    labels[start] = count;
    let area = 0;
    while (sp > 0) {
      const p = stack[--sp];
      area++;
      const x = p % w;
      if (x > 0 && labels[p - 1] < 0 && index[p - 1] === c) { labels[p - 1] = count; stack[sp++] = p - 1; }
      if (x < w - 1 && labels[p + 1] < 0 && index[p + 1] === c) { labels[p + 1] = count; stack[sp++] = p + 1; }
      if (p >= w && labels[p - w] < 0 && index[p - w] === c) { labels[p - w] = count; stack[sp++] = p - w; }
      if (p + w < n && labels[p + w] < 0 && index[p + w] === c) { labels[p + w] = count; stack[sp++] = p + w; }
    }
    colors.push(c);
    areas.push(area);
    count++;
  }
  return { labels, count, color: Int32Array.from(colors), area: Int32Array.from(areas) };
}

function colorDist(lab: Float32Array, a: number, b: number): number {
  if (a === TRANSPARENT || b === TRANSPARENT) return a === b ? 0 : 10;
  const d0 = lab[a * 3] - lab[b * 3], d1 = lab[a * 3 + 1] - lab[b * 3 + 1], d2 = lab[a * 3 + 2] - lab[b * 3 + 2];
  return d0 * d0 + d1 * d1 + d2 * d2;
}

/** Shared-border lengths between flagged regions and their neighbours. */
function adjacency(labels: Int32Array, w: number, h: number, flagged: Uint8Array): Map<number, Map<number, number>> {
  const adj = new Map<number, Map<number, number>>();
  const add = (a: number, b: number) => {
    let m = adj.get(a);
    if (!m) adj.set(a, (m = new Map()));
    m.set(b, (m.get(b) ?? 0) + 1);
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const a = labels[p];
      if (x + 1 < w) {
        const b = labels[p + 1];
        if (a !== b) { if (flagged[a]) add(a, b); if (flagged[b]) add(b, a); }
      }
      if (y + 1 < h) {
        const b = labels[p + w];
        if (a !== b) { if (flagged[a]) add(a, b); if (flagged[b]) add(b, a); }
      }
    }
  }
  return adj;
}

/**
 * Merge every region smaller than minArea pixels into the neighbour it shares the longest
 * border with (ties broken by colour similarity). Modifies and returns `index`.
 */
export function removeSpeckles(index: Uint16Array, w: number, h: number, minArea: number, lab: Float32Array): Uint16Array {
  if (minArea <= 1) return index;
  const reg = labelRegions(index, w, h);
  const { labels, count, area } = reg;
  const color = Int32Array.from(reg.color);
  const small = new Uint8Array(count);
  let any = false;
  for (let r = 0; r < count; r++) if (area[r] < minArea) { small[r] = 1; any = true; }
  if (!any) return index;

  const adj = adjacency(labels, w, h, small);
  const parent = Int32Array.from({ length: count }, (_, i) => i);
  const find = (r: number): number => {
    while (parent[r] !== r) { parent[r] = parent[parent[r]]; r = parent[r]; }
    return r;
  };
  const curArea = Int32Array.from(area);
  const order = [];
  for (let r = 0; r < count; r++) if (small[r]) order.push(r);
  order.sort((a, b) => area[a] - area[b]);

  for (const r of order) {
    if (find(r) !== r || curArea[r] >= minArea) continue;
    const nb = adj.get(r);
    if (!nb) continue;
    // Aggregate neighbour counts by current root.
    const agg = new Map<number, number>();
    for (const [n, c] of nb) {
      const root = find(n);
      if (root !== r) agg.set(root, (agg.get(root) ?? 0) + c);
    }
    let best = -1, bestCount = -1, bestDist = Infinity;
    for (const [n, c] of agg) {
      const d = colorDist(lab, color[r], color[n]);
      if (c > bestCount || (c === bestCount && d < bestDist)) { best = n; bestCount = c; bestDist = d; }
    }
    if (best < 0) continue;
    parent[r] = best;
    curArea[best] += curArea[r];
    if (small[best]) {
      let m = adj.get(best);
      if (!m) adj.set(best, (m = new Map()));
      for (const [n, c] of agg) if (n !== best) m.set(n, (m.get(n) ?? 0) + c);
    }
  }
  for (let p = 0; p < index.length; p++) index[p] = color[find(labels[p])];
  return index;
}

/**
 * Remove thin "halo" regions whose colour is a blend of colours on either side of them
 * (typical for anti-aliased or blurred edges). Their pixels are handed to the adjacent colours,
 * growing in from both sides with each pixel taking the closest neighbouring colour, which puts
 * the boundary at the true edge position.
 */
export function removeSlivers(
  index: Uint16Array,
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  maxWidth: number,
  lab: Float32Array,
): Uint16Array {
  const { labels, count, color, area } = labelRegions(index, w, h);
  const perim = new Int32Array(count);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      const a = labels[p];
      if (x === 0) perim[a]++;
      if (y === 0) perim[a]++;
      if (x === w - 1 || labels[p + 1] !== a) { perim[a]++; if (x < w - 1) perim[labels[p + 1]]++; }
      if (y === h - 1 || labels[p + w] !== a) { perim[a]++; if (y < h - 1) perim[labels[p + w]]++; }
    }
  }
  const thin = new Uint8Array(count);
  let any = false;
  for (let r = 0; r < count; r++) {
    if (color[r] !== TRANSPARENT && (2 * area[r]) / perim[r] < maxWidth) { thin[r] = 1; any = true; }
  }
  if (!any) return index;

  // A thin region is a blend if its colour lies between two of its neighbours' colours.
  const between = (cc: number, ca: number, cb: number) => {
    const ax = lab[ca * 3], ay = lab[ca * 3 + 1], az = lab[ca * 3 + 2];
    const bx = lab[cb * 3] - ax, by = lab[cb * 3 + 1] - ay, bz = lab[cb * 3 + 2] - az;
    const cx = lab[cc * 3] - ax, cy = lab[cc * 3 + 1] - ay, cz = lab[cc * 3 + 2] - az;
    const len2 = bx * bx + by * by + bz * bz;
    if (len2 < 0.01) return false;
    const t = (cx * bx + cy * by + cz * bz) / len2;
    if (t < 0.04 || t > 0.96) return false;
    const px = cx - t * bx, py = cy - t * by, pz = cz - t * bz;
    return Math.sqrt(px * px + py * py + pz * pz) <= 0.3 * Math.sqrt(len2) + 0.02;
  };
  const adj = adjacency(labels, w, h, thin);
  const blend = new Uint8Array(count);
  let anyBlend = false;
  for (const [r, nb] of adj) {
    const byColor = new Map<number, number>();
    for (const [n, c] of nb) {
      const col = color[n];
      if (col !== TRANSPARENT && col !== color[r]) byColor.set(col, (byColor.get(col) ?? 0) + c);
    }
    const ranked = [...byColor.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map((e) => e[0]);
    outer: for (let i = 0; i < ranked.length; i++)
      for (let j = i + 1; j < ranked.length; j++)
        if (between(color[r], ranked[i], ranked[j])) { blend[r] = 1; anyBlend = true; break outer; }
  }
  if (!anyBlend) return index;

  // Grow the surrounding colours into blend pixels, one ring at a time.
  const pending = new Uint8Array(index.length);
  for (let p = 0; p < index.length; p++) if (blend[labels[p]]) pending[p] = 1;
  const tmp = new Float32Array(3);
  let front: number[] = [];
  const touchesAssigned = (p: number) => {
    const x = p % w;
    return (x > 0 && !pending[p - 1]) || (x < w - 1 && !pending[p + 1]) || (p >= w && !pending[p - w]) || (p + w < index.length && !pending[p + w]);
  };
  for (let p = 0; p < index.length; p++) if (pending[p] && touchesAssigned(p)) front.push(p);
  while (front.length) {
    const decided: number[] = [];
    for (const p of front) {
      if (!pending[p]) continue;
      const o = p * 4;
      rgbToOklab(rgba[o], rgba[o + 1], rgba[o + 2], tmp, 0);
      const x = p % w;
      let best = -1, bd = Infinity;
      const consider = (q: number) => {
        if (pending[q]) return;
        const c = index[q];
        if (c === TRANSPARENT) return;
        const d = (tmp[0] - lab[c * 3]) ** 2 + (tmp[1] - lab[c * 3 + 1]) ** 2 + (tmp[2] - lab[c * 3 + 2]) ** 2;
        if (d < bd) { bd = d; best = c; }
      };
      if (x > 0) consider(p - 1);
      if (x < w - 1) consider(p + 1);
      if (p >= w) consider(p - w);
      if (p + w < index.length) consider(p + w);
      if (best >= 0) { index[p] = best; decided.push(p); }
    }
    // Commit this ring only after the whole ring has chosen, so both sides advance evenly.
    const next: number[] = [];
    for (const p of decided) pending[p] = 0;
    for (const p of decided) {
      const x = p % w;
      if (x > 0 && pending[p - 1]) next.push(p - 1);
      if (x < w - 1 && pending[p + 1]) next.push(p + 1);
      if (p >= w && pending[p - w]) next.push(p - w);
      if (p + w < index.length && pending[p + w]) next.push(p + w);
    }
    if (decided.length === 0) break;
    front = next;
  }
  return index;
}

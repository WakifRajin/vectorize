import { fitChain, reverseFitted, type FitParams, type Fitted } from './fit.ts';
import { CMD_M, CMD_Z } from './types.ts';

/**
 * Boundary tracing on the pixel-edge graph.
 *
 * Every boundary between two regions is split into chains that run from junction to junction
 * (points where three or more regions meet). Each chain is curve-fitted exactly once and then
 * shared by the regions on both sides, so neighbouring shapes fit together with no gaps or
 * overlaps.
 */

export interface TracedLoop {
  /** Twice the signed pixel area (positive = outer boundary, negative = hole). */
  area2: number;
  /** Packed path (CMD_M x y ... CMD_Z) in working-pixel coordinates. */
  path: number[];
  /** Region ids on the other side of this loop. */
  neighbours: number[];
}

interface Chain {
  pts: Int32Array;
  closed: boolean;
  left: number;
  right: number;
  v0: number;
  v1: number;
  d0: number;
  d1: number;
  area2: number;
  fit?: Fitted;
  rev?: Fitted;
}

const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];

/**
 * Where three colours meet, anti-aliasing blends all of them, so the pixel junction is often a
 * pixel or two away from where the edges really meet. Move each junction to the point closest
 * (least squares) to the straight continuations of all chains ending there. All chains share
 * the moved point, so shapes still fit together exactly. Border junctions slide along the border.
 */
function refineJunctions(chains: Chain[], w: number, h: number, arm: number): Map<number, [number, number]> {
  const W1 = w + 1;
  // Per junction: normal-equation sums  Σ n nᵀ  and  Σ n (n·m)
  const acc = new Map<number, number[]>();
  const g = Math.max(1, Math.ceil(arm / 2));
  const L = 4 * arm;
  const addEnd = (c: Chain, fromStart: boolean) => {
    const v = fromStart ? c.v0 : c.v1;
    let a = acc.get(v);
    if (!a) acc.set(v, (a = [0, 0, 0, 0, 0, 0]));
    const n = c.pts.length / 2 - 1;
    if (n < g + 4) return;
    const hi = Math.min(n - 1, L);
    // edge midpoints g..hi edges away from this end
    let mx = 0, my = 0, cnt = 0;
    const P = (k: number, comp: 0 | 1) => {
      const i = fromStart ? k : n - 1 - k;
      return (c.pts[i * 2 + comp] + c.pts[(i + 1) * 2 + comp]) / 2;
    };
    for (let k = g; k <= hi; k++) { mx += P(k, 0); my += P(k, 1); cnt++; }
    mx /= cnt; my /= cnt;
    let sxx = 0, sxy = 0, syy = 0;
    for (let k = g; k <= hi; k++) {
      const dx = P(k, 0) - mx, dy = P(k, 1) - my;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const nx = -Math.sin(th), ny = Math.cos(th);
    // only trust chains that run straight away from the junction
    let maxDev = 0;
    for (let k = g; k <= hi; k++) maxDev = Math.max(maxDev, Math.abs((P(k, 0) - mx) * nx + (P(k, 1) - my) * ny));
    if (maxDev > 1) return;
    const d = nx * mx + ny * my;
    a[0] += nx * nx; a[1] += nx * ny; a[2] += ny * ny;
    a[3] += nx * d; a[4] += ny * d; a[5]++;
  };
  for (const c of chains) {
    if (c.closed) continue;
    addEnd(c, true);
    addEnd(c, false);
  }
  const out = new Map<number, [number, number]>();
  const lambda = 0.05; // weak pull towards the pixel junction keeps degenerate cases stable
  for (const [v, a] of acc) {
    const x0 = v % W1, y0 = Math.floor(v / W1);
    let x = x0, y = y0;
    const onX = x0 === 0 || x0 === w, onY = y0 === 0 || y0 === h;
    if (a[5] >= 2 && !(onX && onY)) {
      const m00 = a[0] + lambda, m01 = a[1], m11 = a[2] + lambda;
      const b0 = a[3] + lambda * x0, b1 = a[4] + lambda * y0;
      if (onX) y = b1 / m11 - (m01 * x0) / m11;
      else if (onY) x = b0 / m00 - (m01 * y0) / m00;
      else {
        const det = m00 * m11 - m01 * m01;
        x = (b0 * m11 - b1 * m01) / det;
        y = (m00 * b1 - m01 * b0) / det;
      }
      if (Math.hypot(x - x0, y - y0) > 1.5 * arm) { x = x0; y = y0; }
    }
    out.set(v, [x, y]);
  }
  return out;
}

export function traceRegions(
  labels: Int32Array,
  w: number,
  h: number,
  regionCount: number,
  P: FitParams,
  onProgress?: (f: number) => void,
): TracedLoop[][] {
  const W1 = w + 1;
  const reg = (x: number, y: number) => (x < 0 || y < 0 || x >= w || y >= h ? -1 : labels[y * w + x]);

  const H = new Uint8Array(w * (h + 1));
  const V = new Uint8Array(W1 * h);
  for (let y = 0; y <= h; y++) for (let x = 0; x < w; x++) H[y * w + x] = reg(x, y - 1) !== reg(x, y) ? 1 : 0;
  for (let y = 0; y < h; y++) for (let x = 0; x <= w; x++) V[y * W1 + x] = reg(x - 1, y) !== reg(x, y) ? 1 : 0;
  const HV = new Uint8Array(H.length);
  const VV = new Uint8Array(V.length);

  const hasEdge = (x: number, y: number, d: number): boolean => {
    switch (d) {
      case 0: return x < w && H[y * w + x] === 1;
      case 1: return y < h && V[y * W1 + x] === 1;
      case 2: return x > 0 && H[y * w + x - 1] === 1;
      default: return y > 0 && V[(y - 1) * W1 + x] === 1;
    }
  };
  const visited = (x: number, y: number, d: number): boolean => {
    switch (d) {
      case 0: return HV[y * w + x] === 1;
      case 1: return VV[y * W1 + x] === 1;
      case 2: return HV[y * w + x - 1] === 1;
      default: return VV[(y - 1) * W1 + x] === 1;
    }
  };
  const visit = (x: number, y: number, d: number): void => {
    switch (d) {
      case 0: HV[y * w + x] = 1; break;
      case 1: VV[y * W1 + x] = 1; break;
      case 2: HV[y * w + x - 1] = 1; break;
      default: VV[(y - 1) * W1 + x] = 1;
    }
  };
  const isJunction = (x: number, y: number): boolean => {
    if ((x === 0 || x === w) && (y === 0 || y === h)) return true; // image corners stay sharp
    let deg = 0;
    for (let d = 0; d < 4; d++) if (hasEdge(x, y, d)) deg++;
    return deg >= 3;
  };
  // [left, right] regions when leaving (x, y) in direction d.
  const sides = (x: number, y: number, d: number): [number, number] => {
    switch (d) {
      case 0: return [reg(x, y - 1), reg(x, y)];
      case 1: return [reg(x, y), reg(x - 1, y)];
      case 2: return [reg(x - 1, y), reg(x - 1, y - 1)];
      default: return [reg(x - 1, y - 1), reg(x, y - 1)];
    }
  };

  const chains: Chain[] = [];
  const buf: number[] = [];
  const walk = (sx: number, sy: number, d0: number): Chain => {
    buf.length = 0;
    buf.push(sx, sy);
    const [left, right] = sides(sx, sy, d0);
    let x = sx, y = sy, d = d0, area2 = 0;
    let closed = false;
    for (;;) {
      visit(x, y, d);
      const nx = x + DX[d], ny = y + DY[d];
      area2 += x * ny - nx * y;
      buf.push(nx, ny);
      x = nx;
      y = ny;
      if (isJunction(x, y)) break;
      if (x === sx && y === sy) { closed = true; break; }
      const r = (d + 1) & 3, l = (d + 3) & 3;
      d = hasEdge(x, y, r) ? r : hasEdge(x, y, d) ? d : l;
    }
    return { pts: Int32Array.from(buf), closed, left, right, v0: sy * W1 + sx, v1: y * W1 + x, d0, d1: d, area2 };
  };

  for (let y = 0; y <= h; y++) {
    for (let x = 0; x <= w; x++) {
      if (!isJunction(x, y)) continue;
      for (let d = 0; d < 4; d++) if (hasEdge(x, y, d) && !visited(x, y, d)) chains.push(walk(x, y, d));
    }
  }
  // Remaining edges form closed loops that touch no junction (e.g. an island in one region).
  for (let y = 0; y <= h; y++) {
    for (let x = 0; x < w; x++) {
      if (H[y * w + x] && !HV[y * w + x]) chains.push(walk(x, y, 0));
    }
  }

  const jpos = refineJunctions(chains, w, h, P.arm);

  // Fit every chain once.
  for (let i = 0; i < chains.length; i++) {
    const c = chains[i];
    if (c.closed) c.fit = fitChain(c.pts, true, P);
    else {
      const a = jpos.get(c.v0)!, b = jpos.get(c.v1)!;
      c.fit = fitChain(c.pts, false, P, a[0], a[1], b[0], b[1]);
    }
    if (onProgress && (i & 1023) === 0) onProgress(i / chains.length);
  }

  // Each chain is used forward by its right region and reversed by its left region,
  // so every region sees its own boundary with itself on the right-hand side.
  const uses: number[][] = Array.from({ length: regionCount }, () => []);
  chains.forEach((c, i) => {
    if (c.right >= 0) uses[c.right].push(i * 2);
    if (c.left >= 0) uses[c.left].push(i * 2 + 1);
  });

  const startV = (u: number) => { const c = chains[u >> 1]; return u & 1 ? c.v1 : c.v0; };
  const endV = (u: number) => { const c = chains[u >> 1]; return u & 1 ? c.v0 : c.v1; };
  const startDir = (u: number) => { const c = chains[u >> 1]; return u & 1 ? (c.d1 + 2) & 3 : c.d0; };
  const endDir = (u: number) => { const c = chains[u >> 1]; return u & 1 ? (c.d0 + 2) & 3 : c.d1; };
  const geometry = (u: number): Fitted => {
    const c = chains[u >> 1];
    if (!(u & 1)) return c.fit!;
    return (c.rev ??= reverseFitted(c.fit!));
  };
  const other = (u: number) => { const c = chains[u >> 1]; return u & 1 ? c.right : c.left; };
  const area = (u: number) => { const c = chains[u >> 1]; return u & 1 ? -c.area2 : c.area2; };
  // Prefer turning right (hugging our own region) at pinch points where two loops touch.
  const rank = (din: number, dout: number) => (dout === ((din + 1) & 3) ? 0 : dout === din ? 1 : dout === ((din + 3) & 3) ? 2 : 3);

  const used = new Uint8Array(chains.length * 2);
  const result: TracedLoop[][] = [];
  for (let r = 0; r < regionCount; r++) {
    const loops: TracedLoop[] = [];
    const byStart = new Map<number, number[]>();
    for (const u of uses[r]) {
      if (chains[u >> 1].closed) continue;
      const v = startV(u);
      const list = byStart.get(v);
      if (list) list.push(u); else byStart.set(v, [u]);
    }
    for (const u0 of uses[r]) {
      if (used[u0]) continue;
      used[u0] = 1;
      const seq = [u0];
      if (!chains[u0 >> 1].closed) {
        let cur = u0;
        for (let guard = 0; guard < 1e7; guard++) {
          const v = endV(cur);
          const din = endDir(cur);
          let best = -1, bestRank = 9;
          for (const cand of byStart.get(v) ?? []) {
            if (used[cand] && cand !== u0) continue;
            const rk = rank(din, startDir(cand));
            if (rk < bestRank) { bestRank = rk; best = cand; }
          }
          if (best < 0 || best === u0) break;
          used[best] = 1;
          seq.push(best);
          cur = best;
        }
      }
      const path: number[] = [];
      const first = geometry(seq[0]);
      path.push(CMD_M, first.x0, first.y0);
      let a2 = 0;
      const nb = new Set<number>();
      for (const u of seq) {
        const g = geometry(u);
        for (let i = 0; i < g.segs.length; i++) path.push(g.segs[i]);
        a2 += area(u);
        nb.add(other(u));
      }
      path.push(CMD_Z);
      loops.push({ area2: a2, path, neighbours: [...nb] });
    }
    result.push(loops);
  }
  return result;
}

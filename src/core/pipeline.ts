import { quantize, TRANSPARENT } from './quantize.ts';
import { labelRegions, regionThickness, removeSlivers, removeSpeckles } from './regions.ts';
import { bilateral, resize } from './resample.ts';
import { traceRegions, type TracedLoop } from './trace.ts';
import { CMD_C, CMD_L, CMD_M, CMD_Z, type ProgressFn, type RGBAImage, type VectorImage, type VectorizeOptions, type VectorShape } from './types.ts';

/** Upper bound for the working (upscaled) image, in pixels. Keeps memory and time sane. */
export const MAX_WORKING_PIXELS = 6_000_000;

/** Upscale factor chosen when the user picks "Auto". */
export function autoUpscale(w: number, h: number): number {
  const long = Math.max(w, h);
  return Math.max(1, Math.min(4, Math.floor(3000 / long)));
}

/** Working size for a source image and requested factor (respecting the pixel budget). */
export function workingSize(srcW: number, srcH: number, factor: number): { w: number; h: number; scale: number } {
  let s = factor > 0 ? factor : autoUpscale(srcW, srcH);
  if (srcW * srcH * s * s > MAX_WORKING_PIXELS) s = Math.sqrt(MAX_WORKING_PIXELS / (srcW * srcH));
  const w = Math.max(1, Math.round(srcW * s));
  const h = Math.max(1, Math.round(srcH * s));
  return { w, h, scale: w / srcW };
}

export interface PipelineResult {
  vector: VectorImage;
  working: RGBAImage;
}

/**
 * Full raster → vector pipeline.
 * `input` is either the source image or an already (AI-)upscaled version of it;
 * srcW/srcH are the original dimensions that output coordinates refer to.
 */
export function vectorize(input: RGBAImage, srcW: number, srcH: number, opts: VectorizeOptions, progress: ProgressFn = () => {}): PipelineResult {
  const t0 = performance.now();
  const preUpscaled = input.width !== srcW || input.height !== srcH;
  const factor = preUpscaled ? Math.max(input.width / srcW, opts.upscale) : opts.upscale;
  const { w, h, scale: s } = workingSize(srcW, srcH, factor);

  let img = input;
  if (opts.denoise && !preUpscaled) {
    progress('Denoising', 0.02);
    img = bilateral(img);
  }
  // Source-resolution pixels: they give a truer reading of thin strokes' colour than the
  // (softer) upscaled image. Not available when the input arrives already upscaled.
  const base = preUpscaled ? undefined : img;
  if (img.width !== w || img.height !== h) {
    progress('Upscaling', 0.06);
    img = resize(img, w, h);
  }

  progress('Finding colours', 0.15);
  const q = quantize(img, opts.colors, s, base !== img ? base : undefined);

  progress('Cleaning up regions', 0.3);
  const minArea = Math.max(1, Math.round(opts.speckle * s * s));
  removeSpeckles(q.index, w, h, minArea, q.lab);
  removeSlivers(q.index, img.data, w, h, Math.max(1.5, 0.9 * s), q.lab);
  removeSpeckles(q.index, w, h, Math.max(2, Math.round(minArea / 2)), q.lab);
  const regions = labelRegions(q.index, w, h);

  // Regions that are not drawn: transparent ones and (optionally) the background.
  const skip = new Uint8Array(regions.count);
  for (let r = 0; r < regions.count; r++) if (regions.color[r] === TRANSPARENT) skip[r] = 1;
  if (opts.removeBackground) {
    const borderCount = new Map<number, number>();
    const touches = new Set<number>();
    const visitBorder = (p: number) => {
      const c = q.index[p];
      touches.add(regions.labels[p]);
      if (c !== TRANSPARENT) borderCount.set(c, (borderCount.get(c) ?? 0) + 1);
    };
    for (let x = 0; x < w; x++) { visitBorder(x); visitBorder((h - 1) * w + x); }
    for (let y = 0; y < h; y++) { visitBorder(y * w); visitBorder(y * w + w - 1); }
    let bg = -1, bgCount = 0;
    for (const [c, n] of borderCount) if (n > bgCount) { bg = c; bgCount = n; }
    for (const r of touches) if (regions.color[r] === bg) skip[r] = 1;
  }

  progress('Tracing curves', 0.4);
  const traced = traceRegions(
    regions.labels, w, h, regions.count,
    {
      tolerance: Math.max(0.8, opts.smoothness * s),
      cornerCos: Math.cos((opts.cornerAngle * Math.PI) / 180),
      arm: Math.max(3, Math.min(9, Math.round(2 + 1.5 * s))),
      // Smooth over most of a source pixel: removes stair-steps even from aliased images.
      smoothing: 0.8 * Math.max(1, s),
    },
    (f) => progress('Tracing curves', 0.4 + f * 0.5),
    regionThickness(regions.labels, w, h, regions.count, regions.area),
  );

  progress('Assembling shapes', 0.92);
  const shapes = assemble(traced, regions.color, skip, q.rgb, opts.layering, s);

  // Palette shares (by pixel count, transparent excluded).
  const counts = new Float64Array(q.count);
  let opaque = 0;
  for (let p = 0; p < q.index.length; p++) if (q.index[p] !== TRANSPARENT) { counts[q.index[p]]++; opaque++; }
  const palette = [];
  for (let c = 0; c < q.count; c++) {
    if (counts[c] === 0) continue;
    palette.push({ r: q.rgb[c * 3], g: q.rgb[c * 3 + 1], b: q.rgb[c * 3 + 2], share: counts[c] / opaque });
  }
  palette.sort((a, b) => b.share - a.share);

  let nodes = 0;
  for (const sh of shapes) for (let i = 0; i < sh.path.length; ) {
    const c = sh.path[i];
    i += c === CMD_C ? 7 : c === CMD_Z ? 1 : 3;
    if (c === CMD_C || c === CMD_L) nodes++;
  }

  progress('Done', 1);
  return {
    vector: {
      width: srcW,
      height: srcH,
      shapes,
      palette,
      scale: s,
      stats: { regions: shapes.length, nodes, ms: Math.round(performance.now() - t0) },
    },
    working: img,
  };
}

function pack(paths: number[][], scale: number): Float32Array {
  let len = 0;
  for (const p of paths) len += p.length;
  const out = new Float32Array(len);
  const inv = 1 / scale;
  let o = 0;
  for (const p of paths) {
    for (let i = 0; i < p.length; ) {
      const c = p[i];
      out[o++] = c;
      const n = c === CMD_C ? 6 : c === CMD_M || c === CMD_L ? 2 : 0;
      for (let k = 1; k <= n; k++) out[o++] = Math.round(p[i + k] * inv * 100) / 100;
      i += n + 1;
    }
  }
  return out;
}

function assemble(
  traced: TracedLoop[][],
  regionColor: Int32Array,
  skip: Uint8Array,
  rgb: Uint8Array,
  layering: 'stacked' | 'cutouts',
  scale: number,
): VectorShape[] {
  const colorOf = (c: number) => ({ r: rgb[c * 3], g: rgb[c * 3 + 1], b: rgb[c * 3 + 2] });

  if (layering === 'cutouts') {
    // One shape per colour; holes are cut out so shapes tile the image exactly.
    const byColor = new Map<number, { paths: number[][]; area: number }>();
    traced.forEach((loops, r) => {
      if (skip[r]) return;
      const c = regionColor[r];
      let e = byColor.get(c);
      if (!e) byColor.set(c, (e = { paths: [], area: 0 }));
      for (const l of loops) { e.paths.push(l.path); e.area += l.area2; }
    });
    return [...byColor.entries()]
      .sort((a, b) => b[1].area - a[1].area)
      .map(([c, e]) => ({ ...colorOf(c), path: pack(e.paths, scale) }));
  }

  // Stacked: draw each region's outer boundary without holes, largest first, so that
  // smaller shapes sit on top of larger ones. Holes are only kept where they reveal
  // something that is not drawn (transparency / removed background).
  const items: { r: number; area: number; paths: number[][] }[] = [];
  traced.forEach((loops, r) => {
    if (skip[r]) return;
    let area = 0;
    const paths: number[][] = [];
    for (const l of loops) {
      if (l.area2 > 0) { paths.push(l.path); area = Math.max(area, l.area2); }
      else if (l.neighbours.some((n) => n >= 0 && skip[n])) paths.push(l.path);
    }
    if (paths.length) items.push({ r, area, paths });
  });
  items.sort((a, b) => b.area - a.area);

  // Merge consecutive same-colour items (keeps paint order, shrinks the file).
  const shapes: VectorShape[] = [];
  let curColor = -1;
  let cur: number[][] = [];
  const flush = () => { if (cur.length) shapes.push({ ...colorOf(curColor), path: pack(cur, scale) }); };
  for (const it of items) {
    const c = regionColor[it.r];
    if (c !== curColor) { flush(); curColor = c; cur = []; }
    cur.push(...it.paths);
  }
  flush();
  return shapes;
}

import type { VectorImage } from '../core/types.ts';
import { svgPathData } from './vector.ts';

/** Browsers refuse canvases much larger than this. */
const MAX_SIDE = 16384;
const MAX_AREA = 120_000_000;

export function rasterSize(v: VectorImage, scale: number): { w: number; h: number; scale: number } {
  let s = scale;
  s = Math.min(s, MAX_SIDE / v.width, MAX_SIDE / v.height, Math.sqrt(MAX_AREA / (v.width * v.height)));
  return { w: Math.max(1, Math.round(v.width * s)), h: Math.max(1, Math.round(v.height * s)), scale: s };
}

/** Render the vector image to PNG / JPEG / WebP at any scale. */
export async function toRaster(v: VectorImage, scale: number, type: 'image/png' | 'image/jpeg' | 'image/webp', gapFiller: boolean): Promise<Blob> {
  const { w, h, scale: s } = rasterSize(v, scale);
  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d')!;
  if (type === 'image/jpeg') {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, w, h);
  }
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.lineJoin = 'round';
  ctx.lineWidth = 0.5;
  for (const shape of v.shapes) {
    const p = new Path2D(svgPathData(shape.path));
    const c = `rgb(${shape.r} ${shape.g} ${shape.b})`;
    ctx.fillStyle = c;
    ctx.fill(p);
    if (gapFiller) {
      ctx.strokeStyle = c;
      ctx.stroke(p);
    }
  }
  return canvas.convertToBlob({ type, quality: type === 'image/png' ? undefined : 0.92 });
}

import type { RGBAImage } from './core/types.ts';

/** Largest source we accept; bigger images are downscaled on load to keep the browser responsive. */
const MAX_SOURCE_PIXELS = 24_000_000;

export interface Decoded {
  image: RGBAImage;
  /** How it was decoded, for display. */
  via: 'browser' | 'imagemagick';
  /** Original size if it was reduced on load. */
  originalSize?: { width: number; height: number };
}

function toImageData(source: CanvasImageSource, w: number, h: number): RGBAImage {
  let tw = w, th = h;
  if (w * h > MAX_SOURCE_PIXELS) {
    const f = Math.sqrt(MAX_SOURCE_PIXELS / (w * h));
    tw = Math.max(1, Math.floor(w * f));
    th = Math.max(1, Math.floor(h * f));
  }
  const canvas = new OffscreenCanvas(tw, th);
  const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(source, 0, 0, tw, th);
  const d = ctx.getImageData(0, 0, tw, th);
  return { data: d.data, width: tw, height: th };
}

function isSvg(file: File, head: Uint8Array): boolean {
  if (file.type === 'image/svg+xml' || /\.svgz?$/i.test(file.name)) return true;
  const text = new TextDecoder().decode(head.subarray(0, 512)).trimStart();
  return text.startsWith('<svg') || (text.startsWith('<?xml') && text.includes('<svg'));
}

async function decodeSvg(file: File): Promise<Decoded> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    let w = img.naturalWidth, h = img.naturalHeight;
    if (!w || !h) { w = 1024; h = 1024; }
    // Rasterise small SVGs at a useful size.
    const f = Math.max(1, 1024 / Math.max(w, h));
    return { image: toImageData(img, Math.round(w * f), Math.round(h * f)), via: 'browser' };
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function decodeNative(file: Blob): Promise<Decoded> {
  const bmp = await createImageBitmap(file, { imageOrientation: 'from-image', premultiplyAlpha: 'none', colorSpaceConversion: 'default' });
  try {
    const image = toImageData(bmp, bmp.width, bmp.height);
    return {
      image,
      via: 'browser',
      originalSize: image.width !== bmp.width ? { width: bmp.width, height: bmp.height } : undefined,
    };
  } finally {
    bmp.close();
  }
}

let magickReady: Promise<typeof import('@imagemagick/magick-wasm')> | null = null;
let magickLoaded = false;

/** ImageMagick compiled to WebAssembly: reads 100+ formats (HEIC, TIFF, PSD, RAW, TGA, JXL, …). */
function loadMagick() {
  magickReady ??= (async () => {
    const mod = await import('@imagemagick/magick-wasm');
    const wasmUrl = (await import('@imagemagick/magick-wasm/magick.wasm?url')).default;
    await mod.initializeImageMagick(new URL(wasmUrl, location.href));
    magickLoaded = true;
    return mod;
  })();
  magickReady.catch(() => (magickReady = null));
  return magickReady;
}

async function decodeWithMagick(bytes: Uint8Array, fileName: string): Promise<Decoded> {
  const { ImageMagick, MagickFormat, MagickReadSettings } = await loadMagick();
  const toPng = (img: import('@imagemagick/magick-wasm').IMagickImage) => {
    img.autoOrient();
    return img.write(MagickFormat.Png, (data) => data.slice());
  };
  // Some formats (TGA, raw camera files, …) have no magic bytes: hint the format from the extension.
  const ext = /\.([a-z0-9]+)$/i.exec(fileName)?.[1].toUpperCase();
  const hinted = Object.values(MagickFormat).find((f) => f === ext);
  let png: Uint8Array;
  try {
    png = ImageMagick.read(bytes, toPng);
  } catch (e) {
    if (!hinted) throw e;
    png = ImageMagick.read(bytes, new MagickReadSettings({ format: hinted }), toPng);
  }
  const decoded = await decodeNative(new Blob([png as BlobPart], { type: 'image/png' }));
  return { ...decoded, via: 'imagemagick' };
}

export async function decodeFile(file: File, onStatus: (msg: string) => void): Promise<Decoded> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (isSvg(file, bytes)) return decodeSvg(file);
  try {
    return await decodeNative(file);
  } catch {
    if (!magickLoaded) onStatus('Loading universal decoder (first time only)…');
    try {
      return await decodeWithMagick(bytes, file.name);
    } catch (e) {
      throw new Error(`Could not read “${file.name}”. The format isn't supported or the file is damaged.`, { cause: e });
    }
  }
}

/** Encode RGBA pixels as a PNG blob. */
export async function encodePng(img: RGBAImage, type = 'image/png', quality?: number): Promise<Blob> {
  const canvas = new OffscreenCanvas(img.width, img.height);
  const ctx = canvas.getContext('2d')!;
  ctx.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  return canvas.convertToBlob({ type, quality });
}

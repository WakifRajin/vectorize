import { resize } from './core/resample.ts';
import type { RGBAImage } from './core/types.ts';

/** AI upscaling would exceed this many output pixels → fall back to a smaller factor. */
const MAX_AI_OUTPUT = 8_000_000;

/** Largest AI factor that keeps the output within budget (0 = image too large for AI). */
export function aiFactorFor(w: number, h: number, wanted: number): 0 | 2 | 4 {
  if (wanted >= 3 && w * h * 16 <= MAX_AI_OUTPUT) return 4;
  if (w * h * 4 <= MAX_AI_OUTPUT) return 2;
  return 0;
}

type UpscalerInstance = { upscale: (input: unknown, opts: Record<string, unknown>) => Promise<unknown>; dispose: () => Promise<void> };
const instances = new Map<number, Promise<{ upscaler: UpscalerInstance; tf: typeof import('@tensorflow/tfjs') }>>();

async function getUpscaler(factor: 2 | 4) {
  let p = instances.get(factor);
  if (!p) {
    p = (async () => {
      const tf = await import('@tensorflow/tfjs');
      const { default: Upscaler } = await import('upscaler');
      const def = factor === 2 ? (await import('@upscalerjs/esrgan-slim/2x')).default : (await import('@upscalerjs/esrgan-slim/4x')).default;
      // Self-hosted model weights (public/models) so the site works without any CDN.
      const path = new URL(`${import.meta.env.BASE_URL}models/esrgan-slim/x${factor}/model.json`, location.href).href;
      const upscaler = new Upscaler({ model: { ...def, path } }) as unknown as UpscalerInstance;
      return { upscaler, tf };
    })();
    p.catch(() => instances.delete(factor));
    instances.set(factor, p);
  }
  return p;
}

/** Super-resolve with an ESRGAN model (TensorFlow.js, runs on the GPU via WebGL when available). */
export async function aiUpscale(src: RGBAImage, factor: 2 | 4, onProgress: (f: number) => void): Promise<RGBAImage> {
  const { upscaler, tf } = await getUpscaler(factor);
  const input = tf.browser.fromPixels(new ImageData(new Uint8ClampedArray(src.data), src.width, src.height), 3);
  let output: import('@tensorflow/tfjs').Tensor3D;
  try {
    output = (await upscaler.upscale(input, {
      output: 'tensor',
      patchSize: 64,
      padding: 6,
      progress: (pct: number) => onProgress(pct),
    })) as import('@tensorflow/tfjs').Tensor3D;
  } finally {
    input.dispose();
  }
  const [h, w] = output.shape;
  const rgb = await output.data();
  output.dispose();

  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0, j = 0; i < w * h; i++, j += 3) {
    out[i * 4] = rgb[j];
    out[i * 4 + 1] = rgb[j + 1];
    out[i * 4 + 2] = rgb[j + 2];
    out[i * 4 + 3] = 255;
  }
  // The model only sees RGB: carry the alpha channel over with a classic resize.
  let hasAlpha = false;
  for (let i = 3; i < src.data.length; i += 4) if (src.data[i] < 255) { hasAlpha = true; break; }
  if (hasAlpha) {
    const a = resize(src, w, h).data;
    for (let i = 3; i < out.length; i += 4) out[i] = a[i];
  }
  return { data: out, width: w, height: h };
}

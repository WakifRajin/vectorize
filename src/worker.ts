/// <reference lib="webworker" />
import { vectorize } from './core/pipeline.ts';
import type { VectorizeOptions } from './core/types.ts';

export interface JobRequest {
  id: number;
  data: ArrayBuffer;
  width: number;
  height: number;
  srcW: number;
  srcH: number;
  opts: VectorizeOptions;
}

export type JobMessage =
  | { id: number; type: 'progress'; stage: string; fraction: number }
  | { id: number; type: 'done'; vector: import('./core/types.ts').VectorImage; working: { data: ArrayBuffer; width: number; height: number } }
  | { id: number; type: 'error'; message: string };

const post = (m: JobMessage, transfer: Transferable[] = []) => (self as unknown as DedicatedWorkerGlobalScope).postMessage(m, transfer);

self.onmessage = (e: MessageEvent<JobRequest>) => {
  const { id, data, width, height, srcW, srcH, opts } = e.data;
  try {
    const { vector, working } = vectorize(
      { data: new Uint8ClampedArray(data), width, height },
      srcW,
      srcH,
      opts,
      (stage, fraction) => post({ id, type: 'progress', stage, fraction }),
    );
    const wbuf = working.data.buffer as ArrayBuffer;
    post(
      { id, type: 'done', vector, working: { data: wbuf, width: working.width, height: working.height } },
      [wbuf, ...vector.shapes.map((s) => s.path.buffer as ArrayBuffer)],
    );
  } catch (err) {
    post({ id, type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};

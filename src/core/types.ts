/** Path command opcodes used in the packed path buffers. */
export const CMD_M = 0; // M x y
export const CMD_L = 1; // L x y
export const CMD_C = 2; // C x1 y1 x2 y2 x y
export const CMD_Z = 3; // Z

export type Layering = 'stacked' | 'cutouts';

export interface VectorizeOptions {
  /** Requested upscale factor; 0 = automatic. */
  upscale: number;
  /** Edge-preserving denoise before tracing (helps photos / JPEG artifacts). */
  denoise: boolean;
  /** Number of colors; 0 = automatic. */
  colors: number;
  /** Regions smaller than this many source pixels are merged into a neighbour. */
  speckle: number;
  /** Curve fitting tolerance in source pixels. Higher = smoother, fewer nodes. */
  smoothness: number;
  /** Interior angle in degrees below which a bend is kept as a sharp corner. */
  cornerAngle: number;
  layering: Layering;
  /** Drop the dominant colour that touches the image border. */
  removeBackground: boolean;
}

export const DEFAULT_OPTIONS: VectorizeOptions = {
  upscale: 0,
  denoise: false,
  colors: 0,
  speckle: 4,
  smoothness: 0.5,
  cornerAngle: 130,
  layering: 'stacked',
  removeBackground: false,
};

export interface VectorShape {
  /** sRGB colour. */
  r: number;
  g: number;
  b: number;
  /** Packed path commands (see CMD_*), coordinates in source-image pixels. */
  path: Float32Array;
}

export interface VectorImage {
  width: number;
  height: number;
  shapes: VectorShape[];
  palette: { r: number; g: number; b: number; share: number }[];
  /** Working resolution / source resolution. */
  scale: number;
  stats: { regions: number; nodes: number; ms: number };
}

export interface RGBAImage {
  data: Uint8ClampedArray;
  width: number;
  height: number;
}

export type ProgressFn = (stage: string, fraction: number) => void;

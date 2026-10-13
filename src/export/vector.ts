import { CMD_C, CMD_L, CMD_M, type VectorImage, type VectorShape } from '../core/types.ts';

export interface ExportOptions {
  /** Add a hairline stroke in the fill colour to hide anti-aliasing seams between shapes. */
  gapFiller: boolean;
}

const fmt = (v: number) => {
  const s = (Math.round(v * 100) / 100).toString();
  return s === '-0' ? '0' : s;
};

const hex = (s: VectorShape) => '#' + [s.r, s.g, s.b].map((v) => v.toString(16).padStart(2, '0')).join('');

/** Iterate packed path commands. */
export function walkPath(
  p: Float32Array,
  on: {
    M(x: number, y: number): void;
    L(x: number, y: number): void;
    C(x1: number, y1: number, x2: number, y2: number, x: number, y: number): void;
    Z(): void;
  },
): void {
  for (let i = 0; i < p.length; ) {
    const c = p[i];
    if (c === CMD_M) { on.M(p[i + 1], p[i + 2]); i += 3; }
    else if (c === CMD_L) { on.L(p[i + 1], p[i + 2]); i += 3; }
    else if (c === CMD_C) { on.C(p[i + 1], p[i + 2], p[i + 3], p[i + 4], p[i + 5], p[i + 6]); i += 7; }
    else { on.Z(); i += 1; }
  }
}

/** Compact SVG path data using relative commands. */
export function svgPathData(p: Float32Array): string {
  const out: string[] = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;
  walkPath(p, {
    M(x, y) { out.push(`M${fmt(x)} ${fmt(y)}`); cx = sx = x; cy = sy = y; },
    L(x, y) {
      const dx = x - cx, dy = y - cy;
      if (Math.abs(dy) < 0.005) out.push(`h${fmt(dx)}`);
      else if (Math.abs(dx) < 0.005) out.push(`v${fmt(dy)}`);
      else out.push(`l${fmt(dx)} ${fmt(dy)}`);
      cx = x; cy = y;
    },
    C(x1, y1, x2, y2, x, y) {
      out.push(`c${fmt(x1 - cx)} ${fmt(y1 - cy)} ${fmt(x2 - cx)} ${fmt(y2 - cy)} ${fmt(x - cx)} ${fmt(y - cy)}`);
      cx = x; cy = y;
    },
    Z() { out.push('z'); cx = sx; cy = sy; },
  });
  return out.join('').replace(/ -/g, '-');
}

export function toSVG(v: VectorImage, o: ExportOptions): string {
  const sw = ` stroke-width=".5" stroke-linejoin="round"`;
  const lines = [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${v.width} ${v.height}" width="${v.width}" height="${v.height}">`,
  ];
  for (const s of v.shapes) {
    const c = hex(s);
    lines.push(`<path fill="${c}"${o.gapFiller ? ` stroke="${c}"${sw}` : ''} d="${svgPathData(s.path)}"/>`);
  }
  lines.push('</svg>');
  return lines.join('\n');
}

/** Outline-only SVG used by the viewer to inspect the geometry. */
export function toOutlineSVG(v: VectorImage): string {
  const w = Math.max(0.5, Math.max(v.width, v.height) / 1200);
  const lines = [`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${v.width} ${v.height}" width="${v.width}" height="${v.height}">`];
  lines.push(`<rect width="100%" height="100%" fill="#fff"/>`);
  for (const s of v.shapes) {
    lines.push(`<path fill="none" stroke="#1e1e1e" stroke-width="${fmt(w)}" vector-effect="non-scaling-stroke" d="${svgPathData(s.path)}"/>`);
  }
  lines.push('</svg>');
  return lines.join('\n');
}

const pdfNum = (v: number) => fmt(v);

function psPath(p: Float32Array, H: number, ops: { m: string; l: string; c: string; h: string }, out: string[]) {
  // Flip y here so the output is y-up as both PDF and PostScript expect.
  walkPath(p, {
    M: (x, y) => out.push(`${pdfNum(x)} ${pdfNum(H - y)} ${ops.m}`),
    L: (x, y) => out.push(`${pdfNum(x)} ${pdfNum(H - y)} ${ops.l}`),
    C: (x1, y1, x2, y2, x, y) =>
      out.push(`${pdfNum(x1)} ${pdfNum(H - y1)} ${pdfNum(x2)} ${pdfNum(H - y2)} ${pdfNum(x)} ${pdfNum(H - y)} ${ops.c}`),
    Z: () => out.push(ops.h),
  });
}

const unit = (v: number) => fmt(v / 255).replace(/^0\./, '.');

async function deflate(data: Uint8Array): Promise<Uint8Array | null> {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** Single-page PDF; 1 image pixel = 1 pt. */
export async function toPDF(v: VectorImage, o: ExportOptions): Promise<Uint8Array> {
  const W = v.width, H = v.height;
  const content: string[] = [];
  if (o.gapFiller) content.push('1 j 0.5 w');
  for (const s of v.shapes) {
    const col = `${unit(s.r)} ${unit(s.g)} ${unit(s.b)}`;
    content.push(o.gapFiller ? `${col} rg ${col} RG` : `${col} rg`);
    psPath(s.path, H, { m: 'm', l: 'l', c: 'c', h: 'h' }, content);
    content.push(o.gapFiller ? 'B' : 'f');
  }
  const enc = new TextEncoder();
  const raw = enc.encode(content.join('\n'));
  const packed = await deflate(raw);
  const body = packed ?? raw;

  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const write = (d: string | Uint8Array) => {
    const b = typeof d === 'string' ? enc.encode(d) : d;
    chunks.push(b);
    pos += b.length;
  };
  write('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const obj = (n: number, s: string) => { offsets[n] = pos; write(`${n} 0 obj\n${s}\nendobj\n`); };
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(3, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${W} ${H}] /Contents 4 0 R /Resources << >> >>`);
  offsets[4] = pos;
  write(`4 0 obj\n<< /Length ${body.length}${packed ? ' /Filter /FlateDecode' : ''} >>\nstream\n`);
  write(body);
  write('\nendstream\nendobj\n');
  obj(5, '<< /Producer (Vectorize) /Creator (Vectorize) >>');
  const xref = pos;
  let x = 'xref\n0 6\n0000000000 65535 f \n';
  for (let i = 1; i <= 5; i++) x += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  write(x);
  write(`trailer\n<< /Size 6 /Root 1 0 R /Info 5 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(pos);
  let o2 = 0;
  for (const c of chunks) { out.set(c, o2); o2 += c.length; }
  return out;
}

export function toEPS(v: VectorImage, o: ExportOptions): string {
  const W = v.width, H = v.height;
  const out = [
    '%!PS-Adobe-3.0 EPSF-3.0',
    `%%BoundingBox: 0 0 ${Math.ceil(W)} ${Math.ceil(H)}`,
    `%%HiResBoundingBox: 0 0 ${W} ${H}`,
    '%%Creator: Vectorize',
    '%%LanguageLevel: 2',
    '%%Pages: 1',
    '%%EndComments',
    '%%BeginProlog',
    '/m {moveto} bind def /l {lineto} bind def /c {curveto} bind def /h {closepath} bind def',
    '/f {fill} bind def /fs {gsave fill grestore stroke} bind def /rgb {setrgbcolor} bind def',
    '%%EndProlog',
    '%%Page: 1 1',
    'gsave',
  ];
  if (o.gapFiller) out.push('1 setlinejoin 0.5 setlinewidth');
  for (const s of v.shapes) {
    out.push(`newpath ${unit(s.r)} ${unit(s.g)} ${unit(s.b)} rgb`);
    psPath(s.path, H, { m: 'm', l: 'l', c: 'c', h: 'h' }, out);
    out.push(o.gapFiller ? 'fs' : 'f');
  }
  out.push('grestore', 'showpage', '%%EOF');
  return out.join('\n');
}

/** AutoCAD colour index closest to an RGB colour (standard ACI 1–255 approximation). */
function aci(r: number, g: number, b: number): number {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max - min < 24) {
    // greys: 250..255 ramp, 7 = white/black depending on background
    if (max > 230) return 7;
    if (max < 25) return 250;
    return 250 + Math.min(5, Math.round((max / 255) * 5));
  }
  let hue = 0;
  const d = max - min;
  if (max === r) hue = ((g - b) / d + 6) % 6;
  else if (max === g) hue = (b - r) / d + 2;
  else hue = (r - g) / d + 4;
  hue *= 60;
  const base = 10 + Math.round(hue / 15) % 24 * 10; // 10..240 step 10
  const value = max / 255;
  const sat = d / max;
  let shade = value > 0.8 ? 0 : value > 0.6 ? 2 : value > 0.45 ? 4 : value > 0.3 ? 6 : 8;
  if (sat < 0.5) shade += 1;
  return base + shade;
}

/** DXF (R12, widely compatible) with closed polylines; curves are flattened. */
export function toDXF(v: VectorImage): string {
  const H = v.height;
  const out: string[] = [];
  const g = (code: number, value: string | number) => out.push(String(code), String(value));
  g(0, 'SECTION'); g(2, 'HEADER');
  g(9, '$ACADVER'); g(1, 'AC1009');
  g(9, '$EXTMIN'); g(10, 0); g(20, 0);
  g(9, '$EXTMAX'); g(10, v.width); g(20, v.height);
  g(0, 'ENDSEC');

  const layers = new Map<string, number>();
  for (const s of v.shapes) layers.set(hex(s).slice(1).toUpperCase(), aci(s.r, s.g, s.b));
  g(0, 'SECTION'); g(2, 'TABLES');
  g(0, 'TABLE'); g(2, 'LAYER'); g(70, layers.size);
  for (const [name, color] of layers) {
    g(0, 'LAYER'); g(2, 'C_' + name); g(70, 0); g(62, color); g(6, 'CONTINUOUS');
  }
  g(0, 'ENDTAB'); g(0, 'ENDSEC');

  g(0, 'SECTION'); g(2, 'ENTITIES');
  const tol = Math.max(0.05, Math.max(v.width, v.height) / 4000);
  for (const s of v.shapes) {
    const layer = 'C_' + hex(s).slice(1).toUpperCase();
    let poly: number[] = [];
    let cx = 0, cy = 0;
    const flush = () => {
      if (poly.length >= 6) {
        g(0, 'POLYLINE'); g(8, layer); g(66, 1); g(70, 1);
        for (let i = 0; i < poly.length; i += 2) {
          g(0, 'VERTEX'); g(8, layer); g(10, fmt(poly[i])); g(20, fmt(H - poly[i + 1]));
        }
        g(0, 'SEQEND'); g(8, layer);
      }
      poly = [];
    };
    walkPath(s.path, {
      M(x, y) { flush(); poly.push(x, y); cx = x; cy = y; },
      L(x, y) { poly.push(x, y); cx = x; cy = y; },
      C(x1, y1, x2, y2, x, y) {
        const len = Math.hypot(x1 - cx, y1 - cy) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(x - x2, y - y2);
        const steps = Math.max(2, Math.min(64, Math.ceil(Math.sqrt(len / tol))));
        for (let i = 1; i <= steps; i++) {
          const t = i / steps, mt = 1 - t;
          poly.push(
            mt * mt * mt * cx + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x,
            mt * mt * mt * cy + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y,
          );
        }
        cx = x; cy = y;
      },
      Z() {
        // drop a duplicated closing vertex
        const n = poly.length;
        if (n >= 4 && Math.abs(poly[0] - poly[n - 2]) < 1e-3 && Math.abs(poly[1] - poly[n - 1]) < 1e-3) poly.length = n - 2;
        flush();
      },
    });
    flush();
  }
  g(0, 'ENDSEC');
  g(0, 'EOF');
  return out.join('\n') + '\n';
}

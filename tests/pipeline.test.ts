// Run with: npm test   (Node 22.6+ with type stripping)
import { writeFileSync, mkdirSync } from 'node:fs';
import { vectorize } from '../src/core/pipeline.ts';
import { DEFAULT_OPTIONS, type RGBAImage, type VectorImage, type VectorizeOptions } from '../src/core/types.ts';
import { toDXF, toEPS, toPDF, toSVG, walkPath } from '../src/export/vector.ts';

const out = process.env.TEST_OUT ?? 'tests/out';
mkdirSync(out, { recursive: true });

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures++;
}

type Shape = { color: [number, number, number]; inside: (x: number, y: number) => boolean };

/** Render shapes with 4x4 supersampling (anti-aliased like a real exported logo). */
function render(w: number, h: number, bg: [number, number, number] | null, shapes: Shape[]): RGBAImage {
  const data = new Uint8ClampedArray(w * h * 4);
  const SS = 4;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++)
        for (let sx = 0; sx < SS; sx++) {
          const px = x + (sx + 0.5) / SS, py = y + (sy + 0.5) / SS;
          let c: [number, number, number] | null = bg;
          for (const s of shapes) if (s.inside(px, py)) c = s.color;
          if (c) { r += c[0]; g += c[1]; b += c[2]; a += 255; }
        }
      const n = SS * SS, o = (y * w + x) * 4;
      const cov = a / 255;
      data[o] = cov ? r / cov : 0; data[o + 1] = cov ? g / cov : 0; data[o + 2] = cov ? b / cov : 0; data[o + 3] = a / n;
    }
  return { data, width: w, height: h };
}

/** Signed area enclosed by a shape's paths (flattened curves). */
function shapeArea(path: Float32Array): number {
  let area = 0, cx = 0, cy = 0, sx = 0, sy = 0;
  const seg = (x: number, y: number) => { area += cx * y - x * cy; cx = x; cy = y; };
  walkPath(path, {
    M(x, y) { cx = sx = x; cy = sy = y; },
    L: seg,
    C(x1, y1, x2, y2, x, y) {
      const x0 = cx, y0 = cy;
      for (let i = 1; i <= 32; i++) {
        const t = i / 32, m = 1 - t;
        seg(m * m * m * x0 + 3 * m * m * t * x1 + 3 * m * t * t * x2 + t * t * t * x, m * m * m * y0 + 3 * m * m * t * y1 + 3 * m * t * t * y2 + t * t * t * y);
      }
    },
    Z() { seg(sx, sy); },
  });
  return area / 2;
}

const areaByColor = (v: VectorImage) => {
  const m = new Map<string, number>();
  for (const s of v.shapes) {
    const k = `${s.r},${s.g},${s.b}`;
    m.set(k, (m.get(k) ?? 0) + shapeArea(s.path));
  }
  return m;
};
const closest = (m: Map<string, number>, rgb: [number, number, number]) => {
  let best = '', bd = Infinity;
  for (const k of m.keys()) {
    const c = k.split(',').map(Number);
    const d = (c[0] - rgb[0]) ** 2 + (c[1] - rgb[1]) ** 2 + (c[2] - rgb[2]) ** 2;
    if (d < bd) { bd = d; best = k; }
  }
  return { key: best, area: m.get(best) ?? 0, dist: Math.sqrt(bd) };
};

// --- Test 1: logo-like image -----------------------------------------------------------------
const W = 240, H = 180;
const RED: [number, number, number] = [220, 40, 40];
const BLUE: [number, number, number] = [30, 80, 200];
const BLACK: [number, number, number] = [20, 20, 20];
const WHITE: [number, number, number] = [255, 255, 255];
const circle = { cx: 70, cy: 80, r: 45 };
const logo = render(W, H, WHITE, [
  { color: RED, inside: (x, y) => (x - circle.cx) ** 2 + (y - circle.cy) ** 2 < circle.r ** 2 },
  { color: BLUE, inside: (x, y) => x > 140 && x < 210 && y > 30 && y < 100 },
  // triangle
  { color: BLACK, inside: (x, y) => y < 160 && y > 110 && Math.abs(x - 175) < (y - 110) * 0.8 },
]);
const expected = {
  red: Math.PI * circle.r ** 2,
  blue: 70 * 70,
  black: 0.5 * 80 * 50,
};

for (const layering of ['cutouts', 'stacked'] as const) {
  const opts: VectorizeOptions = { ...DEFAULT_OPTIONS, layering };
  const t = performance.now();
  const { vector } = vectorize(logo, W, H, opts);
  const ms = Math.round(performance.now() - t);
  writeFileSync(`${out}/logo-${layering}.svg`, toSVG(vector, { gapFiller: false }));
  check(`[${layering}] palette has 4 colours`, vector.palette.length === 4, `got ${vector.palette.length}: ${vector.palette.map((p) => `rgb(${p.r},${p.g},${p.b})`).join(' ')}`);
  const areas = areaByColor(vector);
  if (layering === 'cutouts') {
    let total = 0;
    for (const a of areas.values()) total += a;
    check('[cutouts] shapes tile the image exactly', Math.abs(total - W * H) < 1, `total=${total.toFixed(2)} expected=${W * H}`);
    const red = closest(areas, RED), blue = closest(areas, BLUE), black = closest(areas, BLACK);
    const rel = (a: number, e: number) => Math.abs(a - e) / e;
    check('[cutouts] circle area within 1%', rel(red.area, expected.red) < 0.01, `${red.area.toFixed(1)} vs ${expected.red.toFixed(1)}`);
    check('[cutouts] square area within 1%', rel(blue.area, expected.blue) < 0.01, `${blue.area.toFixed(1)} vs ${expected.blue}`);
    check('[cutouts] triangle area within 1%', rel(black.area, expected.black) < 0.01, `${black.area.toFixed(1)} vs ${expected.black}`);
    check('[cutouts] colours accurate', red.dist < 12 && blue.dist < 12 && black.dist < 12, `Δ ${red.dist.toFixed(1)} ${blue.dist.toFixed(1)} ${black.dist.toFixed(1)}`);
  } else {
    check('[stacked] few shapes (no halo slivers)', vector.shapes.length <= 4, `${vector.shapes.length} shapes`);
  }
  check(`[${layering}] compact output`, vector.stats.nodes < 30, `${vector.stats.nodes} nodes, ${ms} ms, scale ${vector.scale}`);
}

// --- Test 2: transparency + remove background ----------------------------------------------
{
  const img = render(120, 120, null, [{ color: BLUE, inside: (x, y) => (x - 60) ** 2 + (y - 60) ** 2 < 40 ** 2 && (x - 60) ** 2 + (y - 60) ** 2 > 20 ** 2 }]);
  const { vector } = vectorize(img, 120, 120, { ...DEFAULT_OPTIONS });
  writeFileSync(`${out}/ring-transparent.svg`, toSVG(vector, { gapFiller: false }));
  const a = vector.shapes.reduce((s, sh) => s + shapeArea(sh.path), 0);
  const e = Math.PI * (40 ** 2 - 20 ** 2);
  check('transparent ring keeps its hole', Math.abs(a - e) / e < 0.015, `${a.toFixed(1)} vs ${e.toFixed(1)}`);

  const img2 = render(120, 120, WHITE, [{ color: RED, inside: (x, y) => Math.abs(x - 60) + Math.abs(y - 60) < 40 }]);
  const v2 = vectorize(img2, 120, 120, { ...DEFAULT_OPTIONS, removeBackground: true }).vector;
  check('remove background drops white', v2.shapes.length === 1 && v2.shapes[0].r > 200 && v2.shapes[0].g < 80, `${v2.shapes.length} shapes`);
  const da = v2.shapes.reduce((s, sh) => s + shapeArea(sh.path), 0);
  check('diamond area within 1.5%', Math.abs(da - 3200) / 3200 < 0.015, `${da.toFixed(1)} vs 3200`);
}

// --- Test 2b: obtuse polygon corners stay sharp, curves stay smooth ---------------------------
{
  const R = 70, cx = 100, cy = 100;
  // regular octagon (135° corners) via half-plane tests
  const inOct = (x: number, y: number) => {
    for (let k = 0; k < 8; k++) {
      const a = (k * Math.PI) / 4 + Math.PI / 8;
      if ((x - cx) * Math.cos(a) + (y - cy) * Math.sin(a) > R * Math.cos(Math.PI / 8)) return false;
    }
    return true;
  };
  const img = render(200, 200, WHITE, [{ color: BLUE, inside: inOct }]);
  const { vector } = vectorize(img, 200, 200, { ...DEFAULT_OPTIONS, removeBackground: true });
  writeFileSync(`${out}/octagon.svg`, toSVG(vector, { gapFiller: false }));
  let lines = 0, curves = 0;
  walkPath(vector.shapes[0].path, { M() {}, L() { lines++; }, C() { curves++; }, Z() {} });
  check('octagon traced as 8 straight lines', lines === 8 && curves === 0, `${lines} lines, ${curves} curves`);
  const area = shapeArea(vector.shapes[0].path);
  const e = 8 * (R * Math.cos(Math.PI / 8)) ** 2 * Math.tan(Math.PI / 8); // 8·r²·tan(π/8), r = inradius
  check('octagon area within 0.5%', Math.abs(area - e) / e < 0.005, `${area.toFixed(1)} vs ${e.toFixed(1)}`);
}

// --- Test 2c: hard-aliased (pixel-art) circle becomes a smooth curve -------------------------
{
  const w = 64, h = 48;
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      const inside = (x - 32) ** 2 + (y - 24) ** 2 < 300;
      data[o] = inside ? 220 : 255; data[o + 1] = data[o + 2] = inside ? 30 : 255; data[o + 3] = 255;
    }
  const { vector } = vectorize({ data, width: w, height: h }, w, h, { ...DEFAULT_OPTIONS, removeBackground: true });
  writeFileSync(`${out}/aliased-disc.svg`, toSVG(vector, { gapFiller: false }));
  let lines = 0, curves = 0;
  walkPath(vector.shapes[0].path, { M() {}, L() { lines++; }, C() { curves++; }, Z() {} });
  check('aliased disc: smooth curves only', lines === 0 && curves >= 4 && curves <= 8, `${lines} lines, ${curves} curves`);
  const area = shapeArea(vector.shapes[0].path);
  check('aliased disc: area within 3% of the true circle', Math.abs(area - 300 * Math.PI) / (300 * Math.PI) < 0.03, `${area.toFixed(1)} vs ${(300 * Math.PI).toFixed(1)}`);
}

// --- Test 3: noisy photo-like gradient doesn't explode ----------------------------------------
{
  const w = 300, h = 200;
  const data = new Uint8ClampedArray(w * h * 4);
  let seed = 1;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 30;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = (y * w + x) * 4;
      data[o] = (x / w) * 255 + rnd(); data[o + 1] = (y / h) * 255 + rnd(); data[o + 2] = 128 + rnd(); data[o + 3] = 255;
    }
  const t = performance.now();
  const { vector } = vectorize({ data, width: w, height: h }, w, h, { ...DEFAULT_OPTIONS, colors: 12, denoise: true, layering: 'cutouts' });
  const ms = performance.now() - t;
  writeFileSync(`${out}/gradient.svg`, toSVG(vector, { gapFiller: true }));
  const total = vector.shapes.reduce((s, sh) => s + shapeArea(sh.path), 0);
  check('noisy gradient: tiles exactly', Math.abs(total - w * h) < 1, `${total.toFixed(2)} vs ${w * h}`);
  check('noisy gradient: palette ≤ 12', vector.palette.length <= 12, `${vector.palette.length} colours, ${vector.stats.nodes} nodes, ${Math.round(ms)} ms`);
}

// --- Exporters produce well-formed output -------------------------------------------------------
{
  const { vector } = vectorize(logo, W, H, DEFAULT_OPTIONS);
  const pdf = await toPDF(vector, { gapFiller: true });
  const pdfText = new TextDecoder('latin1').decode(pdf);
  const xrefAt = Number(/startxref\n(\d+)/.exec(pdfText)?.[1]);
  check('PDF header and xref offset', pdfText.startsWith('%PDF-1.4') && pdfText.slice(xrefAt, xrefAt + 4) === 'xref');
  writeFileSync(`${out}/logo.pdf`, pdf);
  const eps = toEPS(vector, { gapFiller: false });
  check('EPS bounding box', eps.includes(`%%BoundingBox: 0 0 ${W} ${H}`) && eps.trim().endsWith('%%EOF'));
  writeFileSync(`${out}/logo.eps`, eps);
  const dxf = toDXF(vector);
  check('DXF structure', dxf.includes('POLYLINE') && dxf.trim().endsWith('EOF'));
  writeFileSync(`${out}/logo.dxf`, dxf);
}

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);

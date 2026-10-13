import './style.css';
import { aiFactorFor, aiUpscale } from './ai-upscale.ts';
import { autoUpscale } from './core/pipeline.ts';
import { DEFAULT_OPTIONS, type RGBAImage, type VectorImage, type VectorizeOptions } from './core/types.ts';
import { decodeFile, encodePng } from './decode.ts';
import { rasterSize, toRaster } from './export/raster.ts';
import { toDXF, toEPS, toOutlineSVG, toPDF, toSVG } from './export/vector.ts';
import { makeSample } from './sample.ts';
import { Viewer, type ViewMode } from './viewer.ts';
import type { JobMessage, JobRequest } from './worker.ts';

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

// ---------------------------------------------------------------------------------------------
// State

interface Source {
  image: RGBAImage;
  name: string;
  url: string;
  bytes: number;
  via: string;
  originalSize?: { width: number; height: number };
}

let source: Source | null = null;
let opts: VectorizeOptions = { ...DEFAULT_OPTIONS };
let method: 'classic' | 'ai' = 'classic';
let gapFiller = false;
let result: { vector: VectorImage; working: RGBAImage; svg: string; urls: string[] } | null = null;
const aiCache = new Map<number, RGBAImage>();

// ---------------------------------------------------------------------------------------------
// Elements

const app = $('app');
const viewer = new Viewer($('viewport'), $<HTMLImageElement>('img-orig'), $<HTMLImageElement>('img-vec'), $('clip'), $('divider'));
viewer.onZoom = (z) => ($('zoom-label').textContent = `${Math.round(z * 100)}%`);
const fileInput = $<HTMLInputElement>('file-input');
const progressEl = $('progress');
const statsEl = $('stats');

// ---------------------------------------------------------------------------------------------
// Toasts

let toastTimer = 0;
function toast(msg: string, kind: 'info' | 'error' = 'info', ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast ${kind === 'error' ? 'error' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}

function showProgress(text: string, fraction: number) {
  progressEl.hidden = false;
  $('progress-text').textContent = text;
  $('progress-fill').style.width = `${Math.round(fraction * 100)}%`;
}

// ---------------------------------------------------------------------------------------------
// Loading images

async function loadFile(file: File) {
  showProgressIfLoaded('Reading image…');
  try {
    const decoded = await decodeFile(file, (msg) => { app.dataset.state = 'busy'; showProgress(msg, 0.1); });
    const blob = await encodePng(decoded.image);
    setSource({
      image: decoded.image,
      name: file.name.replace(/\.[^.]+$/, '') || 'image',
      url: URL.createObjectURL(blob),
      bytes: file.size,
      via: decoded.via === 'imagemagick' ? 'ImageMagick' : (file.type.split('/')[1] || 'image').toUpperCase(),
      originalSize: decoded.originalSize,
    });
  } catch (e) {
    progressEl.hidden = true;
    if (!source) app.dataset.state = 'empty';
    toast(e instanceof Error ? e.message : 'Could not read that file.', 'error', 6000);
  }
}

function showProgressIfLoaded(msg: string) {
  if (source) showProgress(msg, 0.02);
}

function setSource(s: Source) {
  if (source) URL.revokeObjectURL(source.url);
  source = s;
  aiCache.clear();
  clearResult();
  app.dataset.state = 'loaded';
  $('btn-new').hidden = false;
  viewer.setOriginal(s.url, s.image.width, s.image.height);
  if (s.originalSize) toast(`Large image reduced from ${s.originalSize.width}×${s.originalSize.height} to ${s.image.width}×${s.image.height} for processing.`, 'info', 5000);
  run(true);
}

function clearResult() {
  if (result) for (const u of result.urls) URL.revokeObjectURL(u);
  result = null;
  viewer.clearVector();
  setDownloadEnabled(false);
}

fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) loadFile(f);
  fileInput.value = '';
});
$('dropzone').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('#btn-sample') || t.closest('label')) return;
  if (t.closest('.dropzone-card')) fileInput.click();
});
$('btn-new').addEventListener('click', () => fileInput.click());
$('btn-sample').addEventListener('click', async () => {
  const img = makeSample();
  const blob = await encodePng(img);
  setSource({ image: img, name: 'sample', url: URL.createObjectURL(blob), bytes: blob.size, via: 'PNG' });
});

// Drag & drop anywhere on the page.
const overlay = $('drop-overlay');
let dragDepth = 0;
const hasFiles = (e: DragEvent) => [...(e.dataTransfer?.types ?? [])].includes('Files');
window.addEventListener('dragenter', (e) => { if (hasFiles(e)) { dragDepth++; overlay.classList.add('show'); } });
window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; overlay.classList.remove('show'); } });
window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  overlay.classList.remove('show');
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

// Paste from clipboard.
window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.kind === 'file');
  const f = item?.getAsFile();
  if (f) { e.preventDefault(); loadFile(f); }
});

// ---------------------------------------------------------------------------------------------
// Processing

let worker: Worker | null = null;
let busyJob = 0;
let jobCounter = 0;
let debounce = 0;

function getWorker(): Worker {
  worker ??= new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  return worker;
}

function run(immediate = false) {
  clearTimeout(debounce);
  if (!source) return;
  if (immediate) void process();
  else debounce = window.setTimeout(() => void process(), 250);
}

async function process() {
  if (!source) return;
  const src = source;
  const id = ++jobCounter;
  // Restart the worker if it's still busy with an outdated job.
  if (busyJob && worker) { worker.terminate(); worker = null; }

  let input = src.image;
  const w = src.image.width, h = src.image.height;
  if (method === 'ai') {
    const wanted = opts.upscale || autoUpscale(w, h);
    const f = wanted > 1 ? aiFactorFor(w, h, wanted) : 0;
    if (f) {
      try {
        let up = aiCache.get(f);
        if (!up) {
          showProgress(`AI upscaling ${f}× — loading model…`, 0.02);
          up = await aiUpscale(src.image, f, (p) => { if (id === jobCounter) showProgress(`AI upscaling ${f}×…`, p * 0.5); });
          aiCache.set(f, up);
        }
        if (id !== jobCounter || src !== source) return;
        input = up;
      } catch (e) {
        console.error(e);
        toast('AI upscaling is unavailable in this browser — using classic upscaling.', 'error', 5000);
        setRadio('opt-method', 'classic');
        method = 'classic';
        updateHints();
      }
    } else if (wanted > 1) {
      toast('Image is already large — AI upscaling skipped.', 'info');
    }
  }
  if (id !== jobCounter || src !== source) return;

  const req: JobRequest = {
    id,
    data: input.data.slice().buffer,
    width: input.width,
    height: input.height,
    srcW: w,
    srcH: h,
    opts: { ...opts, upscale: method === 'ai' && input !== src.image ? Math.max(opts.upscale, input.width / w) : opts.upscale },
  };
  busyJob = id;
  const wk = getWorker();
  showProgress('Starting…', method === 'ai' && input !== src.image ? 0.5 : 0.02);
  wk.onmessage = (e: MessageEvent<JobMessage>) => {
    const m = e.data;
    if (m.id !== jobCounter) return;
    if (m.type === 'progress') {
      const base = method === 'ai' && input !== src.image ? 0.5 : 0;
      showProgress(`${m.stage}…`, base + m.fraction * (1 - base));
    } else if (m.type === 'done') {
      busyJob = 0;
      progressEl.hidden = true;
      onResult(m.vector, { data: new Uint8ClampedArray(m.working.data), width: m.working.width, height: m.working.height });
    } else {
      busyJob = 0;
      progressEl.hidden = true;
      toast(`Vectorization failed: ${m.message}`, 'error', 6000);
    }
  };
  wk.onerror = (e) => {
    busyJob = 0;
    progressEl.hidden = true;
    toast(`Vectorization failed: ${e.message || 'worker error'}`, 'error', 6000);
    worker = null;
  };
  wk.postMessage(req, [req.data]);
}

function onResult(vector: VectorImage, working: RGBAImage) {
  if (result) for (const u of result.urls) URL.revokeObjectURL(u);
  const svg = toSVG(vector, { gapFiller });
  const svgUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const outlineUrl = URL.createObjectURL(new Blob([toOutlineSVG(vector)], { type: 'image/svg+xml' }));
  result = { vector, working, svg, urls: [svgUrl, outlineUrl] };
  viewer.setVector(svgUrl, outlineUrl);
  setDownloadEnabled(true);
  renderPalette(vector);
  renderStats();
  updateDownloadHint();
}

function refreshSvg() {
  if (!result) return;
  onResult(result.vector, result.working);
}

// ---------------------------------------------------------------------------------------------
// Info

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

function renderStats() {
  if (!source) return;
  const s = source.image;
  const parts = [`<span><b>${escapeHtml(source.name)}</b> · ${source.via} · ${s.width}×${s.height}</span>`];
  if (result) {
    const v = result.vector;
    parts.push(
      `<span>Worked at <b>${result.working.width}×${result.working.height}</b> (${v.scale.toFixed(v.scale % 1 ? 2 : 0)}×)</span>`,
      `<span><b>${v.palette.length}</b> colors</span>`,
      `<span><b>${v.shapes.length}</b> shapes · <b>${v.stats.nodes.toLocaleString()}</b> nodes</span>`,
      `<span>SVG <b>${fmtBytes(result.svg.length)}</b></span>`,
      `<span><b>${(v.stats.ms / 1000).toFixed(2)}</b> s</span>`,
    );
  }
  statsEl.innerHTML = parts.join('');
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

function renderPalette(v: VectorImage) {
  const el = $('palette');
  el.replaceChildren(
    ...v.palette.map((p) => {
      const hex = '#' + [p.r, p.g, p.b].map((x) => x.toString(16).padStart(2, '0')).join('');
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = hex;
      b.dataset.hex = hex;
      b.dataset.share = `${(p.share * 100).toFixed(p.share < 0.01 ? 2 : 1)}%`;
      b.setAttribute('aria-label', `${hex}, ${b.dataset.share}. Click to copy.`);
      b.addEventListener('click', () => navigator.clipboard?.writeText(hex).then(() => toast(`Copied ${hex}`)));
      return b;
    }),
  );
}

// ---------------------------------------------------------------------------------------------
// Controls

function setRadio(groupId: string, value: string) {
  for (const b of $(groupId).querySelectorAll<HTMLButtonElement>('[role="radio"]')) {
    b.setAttribute('aria-checked', String((b.dataset.value ?? b.dataset.mode) === value));
  }
}

function bindRadio(groupId: string, onChange: (v: string) => void) {
  const group = $(groupId);
  const buttons = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const select = (b: HTMLButtonElement) => {
    const v = b.dataset.value ?? b.dataset.mode ?? '';
    setRadio(groupId, v);
    onChange(v);
  };
  buttons.forEach((b, i) => {
    b.addEventListener('click', () => select(b));
    b.addEventListener('keydown', (e) => {
      const d = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
      if (!d) return;
      e.preventDefault();
      const next = buttons[(i + d + buttons.length) % buttons.length];
      next.focus();
      select(next);
    });
  });
}

bindRadio('view-mode', (v) => viewer.setMode(v as ViewMode));
bindRadio('opt-upscale', (v) => { opts.upscale = Number(v); run(); });
bindRadio('opt-method', (v) => { method = v as 'classic' | 'ai'; updateHints(); run(); });
bindRadio('opt-layering', (v) => { opts.layering = v as VectorizeOptions['layering']; updateHints(); run(); });

$<HTMLInputElement>('opt-denoise').addEventListener('change', (e) => { opts.denoise = (e.target as HTMLInputElement).checked; run(); });
$<HTMLInputElement>('opt-bg').addEventListener('change', (e) => { opts.removeBackground = (e.target as HTMLInputElement).checked; run(); });
$<HTMLInputElement>('opt-gap').addEventListener('change', (e) => { gapFiller = (e.target as HTMLInputElement).checked; refreshSvg(); });
$<HTMLSelectElement>('opt-colors').addEventListener('change', (e) => { opts.colors = Number((e.target as HTMLSelectElement).value); run(); });

function bindRange(id: string, outId: string, fmt: (v: number) => string, apply: (v: number) => void) {
  const input = $<HTMLInputElement>(id);
  const out = $(outId);
  const update = () => { out.textContent = fmt(Number(input.value)); };
  input.addEventListener('input', () => { update(); apply(Number(input.value)); run(); });
  update();
}
bindRange('opt-speckle', 'out-speckle', (v) => (v === 0 ? 'off' : `${v} px`), (v) => (opts.speckle = v));
bindRange('opt-smooth', 'out-smooth', (v) => v.toFixed(2), (v) => (opts.smoothness = v));
bindRange('opt-corner', 'out-corner', (v) => `${v}°`, (v) => (opts.cornerAngle = v));

function updateHints() {
  $('method-hint').textContent =
    method === 'ai'
      ? 'Neural super-resolution (runs on your GPU). Best for small, blurry or low-quality images. First run downloads a ~1 MB model.'
      : 'Fast, sharp resampling. Use AI for small or blurry photos.';
  $('layering-hint').textContent =
    opts.layering === 'stacked'
      ? 'Shapes overlap like paper cut-outs on top of each other — no seams, easy to edit.'
      : 'Shapes fit together like puzzle pieces with no overlap — ideal for cutting, plotting and CAD.';
}

$('zoom-in').addEventListener('click', () => viewer.zoomBy(1.25));
$('zoom-out').addEventListener('click', () => viewer.zoomBy(0.8));
$('zoom-fit').addEventListener('click', () => viewer.fit());
$('zoom-label').addEventListener('click', () => viewer.setZoom(1));

// ---------------------------------------------------------------------------------------------
// Download

const fmtSel = $<HTMLSelectElement>('dl-format');
const scaleSel = $<HTMLSelectElement>('dl-scale');
const isRaster = (f: string) => f === 'png' || f === 'jpg' || f === 'webp';

function setDownloadEnabled(on: boolean) {
  $<HTMLButtonElement>('btn-download').disabled = !on;
  $<HTMLButtonElement>('btn-copy').disabled = !on;
}

function updateDownloadHint() {
  const f = fmtSel.value;
  scaleSel.hidden = !isRaster(f);
  const hint = $('dl-hint');
  if (!result) { hint.textContent = ''; return; }
  const v = result.vector;
  if (isRaster(f)) {
    const r = rasterSize(v, Number(scaleSel.value));
    hint.textContent = `${r.w}×${r.h} px, rendered from the vector.`;
  } else if (f === 'upscaled') {
    hint.textContent = `${result.working.width}×${result.working.height} px raster used for tracing.`;
  } else {
    hint.textContent = {
      svg: 'Scalable, editable in Illustrator, Inkscape, Figma, browsers.',
      pdf: 'Vector PDF — opens in Illustrator, Affinity, any PDF viewer.',
      eps: 'Encapsulated PostScript for print and legacy tools.',
      dxf: 'Closed polylines on one layer per colour, for CAD / laser / CNC.',
    }[f] ?? '';
  }
}
fmtSel.addEventListener('change', updateDownloadHint);
scaleSel.addEventListener('change', updateDownloadHint);

function save(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

$('btn-download').addEventListener('click', async () => {
  if (!result || !source) return;
  const f = fmtSel.value;
  const v = result.vector;
  const base = `${source.name}-vector`;
  const btn = $<HTMLButtonElement>('btn-download');
  btn.disabled = true;
  try {
    switch (f) {
      case 'svg': save(new Blob([result.svg], { type: 'image/svg+xml' }), `${base}.svg`); break;
      case 'pdf': save(new Blob([(await toPDF(v, { gapFiller })) as BlobPart], { type: 'application/pdf' }), `${base}.pdf`); break;
      case 'eps': save(new Blob([toEPS(v, { gapFiller })], { type: 'application/postscript' }), `${base}.eps`); break;
      case 'dxf': save(new Blob([toDXF(v)], { type: 'application/dxf' }), `${base}.dxf`); break;
      case 'png': case 'jpg': case 'webp': {
        const type = f === 'jpg' ? 'image/jpeg' : (`image/${f}` as 'image/png' | 'image/webp');
        save(await toRaster(v, Number(scaleSel.value), type, gapFiller), `${base}.${f}`);
        break;
      }
      case 'upscaled': save(await encodePng(result.working), `${source.name}-upscaled.png`); break;
    }
  } catch (e) {
    toast(`Export failed: ${e instanceof Error ? e.message : e}`, 'error');
  } finally {
    btn.disabled = false;
  }
});

$('btn-copy').addEventListener('click', async () => {
  if (!result) return;
  try {
    await navigator.clipboard.writeText(result.svg);
    toast('SVG copied to clipboard');
  } catch {
    toast('Clipboard is not available here', 'error');
  }
});

updateHints();
updateDownloadHint();

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

// =============================================================================================
// State

type Method = 'classic' | 'ai';
type Format = 'svg' | 'pdf' | 'eps' | 'dxf' | 'png' | 'jpg' | 'webp' | 'upscaled';
type Theme = 'light' | 'dark' | 'system';

interface Settings {
  opts: VectorizeOptions;
  method: Method;
  gapFiller: boolean;
  preset: string; // '' = custom
  format: Format;
  rasterScale: number;
  bg: string;
}

const PRESETS: Record<string, Partial<VectorizeOptions> & { method?: Method }> = {
  auto: {},
  logo: { speckle: 3, smoothness: 0.5, cornerAngle: 130 },
  lineart: { upscale: 4, speckle: 1, smoothness: 0.35, cornerAngle: 140 },
  illustration: { colors: 24, speckle: 4, smoothness: 0.6, cornerAngle: 125 },
  photo: { colors: 32, speckle: 12, smoothness: 0.9, cornerAngle: 115, denoise: true },
};

const DEFAULT_SETTINGS: Settings = {
  opts: { ...DEFAULT_OPTIONS },
  method: 'classic',
  gapFiller: false,
  preset: 'auto',
  format: 'svg',
  rasterScale: 2,
  bg: 'checker',
};

const STORE_KEY = 'vectorize.settings';
function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<Settings>;
      return { ...DEFAULT_SETTINGS, ...s, opts: { ...DEFAULT_OPTIONS, ...(s.opts ?? {}) } };
    }
  } catch { /* storage unavailable */ }
  return structuredClone(DEFAULT_SETTINGS);
}
function saveSettings() {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

const settings = loadSettings();

interface Source {
  image: RGBAImage;
  name: string;
  url: string;
  via: string;
  originalSize?: { width: number; height: number };
}
let source: Source | null = null;
let result: { vector: VectorImage; working: RGBAImage; svg: string; urls: string[] } | null = null;
const aiCache = new Map<number, Promise<RGBAImage>>();

// =============================================================================================
// Elements & helpers

const app = $('app');
const viewer = new Viewer($('viewport'), $<HTMLImageElement>('img-orig'), $<HTMLImageElement>('img-vec'), $('clip'), $('divider'));
viewer.onZoom = (z) => ($('zoom-label').textContent = `${z >= 10 ? Math.round(z * 100) : Math.round(z * 1000) / 10}%`);
const fileInput = $<HTMLInputElement>('file-input');
const progressEl = $('progress');

let toastTimer = 0;
function toast(msg: string, kind: 'info' | 'error' = 'info', ms = 3200) {
  const t = $('toast');
  t.textContent = msg;
  t.className = `toast${kind === 'error' ? ' error' : ''}`;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.hidden = true), ms);
}

function showProgress(text: string, fraction: number) {
  progressEl.hidden = false;
  $('progress-text').textContent = text;
  $('progress-fill').style.width = `${Math.round(Math.max(0.03, fraction) * 100)}%`;
}
function hideProgress() {
  progressEl.hidden = true;
}

const fmtBytes = (n: number) => (n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1048576).toFixed(1)} MB`);

// =============================================================================================
// Theme

function applyTheme(t: Theme) {
  if (t === 'system') delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = t;
  try {
    if (t === 'system') localStorage.removeItem('vectorize.theme');
    else localStorage.setItem('vectorize.theme', t);
  } catch { /* ignore */ }
  setRadio('theme', t);
}
const savedTheme = (document.documentElement.dataset.theme as Theme | undefined) ?? 'system';

// =============================================================================================
// Radio groups

function setRadio(groupId: string, value: string | null) {
  for (const b of $(groupId).querySelectorAll<HTMLButtonElement>('[role="radio"]')) {
    const on = b.dataset.value === value;
    b.setAttribute('aria-checked', String(on));
    b.tabIndex = on || (value === null && b === $(groupId).querySelector('[role="radio"]')) ? 0 : -1;
  }
}

function bindRadio(groupId: string, onChange: (v: string) => void) {
  const group = $(groupId);
  const buttons = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]')];
  const select = (b: HTMLButtonElement) => {
    const v = b.dataset.value ?? '';
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

// =============================================================================================
// Settings UI

const speckleIn = $<HTMLInputElement>('opt-speckle');
const smoothIn = $<HTMLInputElement>('opt-smooth');
const cornerIn = $<HTMLInputElement>('opt-corner');
const colorsSel = $<HTMLSelectElement>('opt-colors');

function rangeFill(input: HTMLInputElement) {
  const f = (Number(input.value) - Number(input.min)) / (Number(input.max) - Number(input.min));
  input.style.setProperty('--fill', `${f * 100}%`);
}

function syncControls() {
  const o = settings.opts;
  setRadio('presets', settings.preset || null);
  setRadio('opt-upscale', String(o.upscale));
  setRadio('opt-method', settings.method);
  setRadio('opt-layering', o.layering);
  setRadio('dl-format', settings.format);
  setRadio('bg-mode', settings.bg);
  $<HTMLInputElement>('opt-denoise').checked = o.denoise;
  $<HTMLInputElement>('opt-bg').checked = o.removeBackground;
  $<HTMLInputElement>('opt-gap').checked = settings.gapFiller;
  colorsSel.value = String(o.colors);
  if (colorsSel.value !== String(o.colors)) colorsSel.value = '0';
  speckleIn.value = String(o.speckle);
  smoothIn.value = String(o.smoothness);
  cornerIn.value = String(o.cornerAngle);
  $<HTMLSelectElement>('dl-scale').value = String(settings.rasterScale);
  viewer.setBackground(settings.bg);
  updateLabels();
}

function updateLabels() {
  const o = settings.opts;
  $('out-speckle').textContent = o.speckle === 0 ? 'Off' : `${o.speckle} px`;
  $('out-smooth').textContent = o.smoothness.toFixed(2);
  $('out-corner').textContent = `${o.cornerAngle}°`;
  for (const r of [speckleIn, smoothIn, cornerIn]) rangeFill(r);
  $('sum-upscale').textContent = `${o.upscale ? `${o.upscale}×` : 'Auto'} · ${settings.method === 'ai' ? 'AI' : 'Standard'}`;
  $('sum-colors').textContent = result ? `${result.vector.palette.length} colors` : o.colors ? `${o.colors} max` : 'Auto';
  $('sum-output').textContent = `${o.layering === 'stacked' ? 'Stacked' : 'Cutouts'}${o.removeBackground ? ' · no bg' : ''}`;
  $('method-hint').textContent =
    settings.method === 'ai'
      ? 'Neural super-resolution on your GPU. Best for small, blurry or low-quality images. Downloads a 1 MB model once.'
      : 'Fast, sharp resampling. Try AI for small or blurry images.';
  $('layering-hint').textContent =
    o.layering === 'stacked'
      ? 'Shapes are layered on top of each other: no seams, easy to edit.'
      : 'Shapes fit together like puzzle pieces with no overlap: best for cutting, plotting and CAD.';
  updateExportUi();
}

/** A setting changed by hand: the preset no longer applies. */
function changed(rerun = true) {
  settings.preset = '';
  setRadio('presets', null);
  updateLabels();
  saveSettings();
  if (rerun) run();
}

bindRadio('presets', (v) => {
  const p = PRESETS[v] ?? {};
  settings.opts = { ...DEFAULT_OPTIONS, ...p };
  if (p.method) settings.method = p.method;
  settings.preset = v;
  syncControls();
  saveSettings();
  run();
});
bindRadio('opt-upscale', (v) => { settings.opts.upscale = Number(v); changed(); });
bindRadio('opt-method', (v) => { settings.method = v as Method; changed(); });
bindRadio('opt-layering', (v) => { settings.opts.layering = v as VectorizeOptions['layering']; changed(); });
$<HTMLInputElement>('opt-denoise').addEventListener('change', (e) => { settings.opts.denoise = (e.target as HTMLInputElement).checked; changed(); });
$<HTMLInputElement>('opt-bg').addEventListener('change', (e) => { settings.opts.removeBackground = (e.target as HTMLInputElement).checked; changed(); });
$<HTMLInputElement>('opt-gap').addEventListener('change', (e) => {
  settings.gapFiller = (e.target as HTMLInputElement).checked;
  saveSettings();
  if (result) showResult(result.vector, result.working);
});
colorsSel.addEventListener('change', () => { settings.opts.colors = Number(colorsSel.value); changed(); });
speckleIn.addEventListener('input', () => { settings.opts.speckle = Number(speckleIn.value); changed(); });
smoothIn.addEventListener('input', () => { settings.opts.smoothness = Number(smoothIn.value); changed(); });
cornerIn.addEventListener('input', () => { settings.opts.cornerAngle = Number(cornerIn.value); changed(); });
$('btn-reset').addEventListener('click', () => {
  const keep = { format: settings.format, rasterScale: settings.rasterScale, bg: settings.bg };
  Object.assign(settings, structuredClone(DEFAULT_SETTINGS), keep);
  syncControls();
  saveSettings();
  run();
  toast('Settings reset to defaults');
});

bindRadio('theme', (v) => applyTheme(v as Theme));
bindRadio('view-mode', (v) => viewer.setMode(v as ViewMode));
bindRadio('bg-mode', (v) => { settings.bg = v; viewer.setBackground(v); saveSettings(); });
$('zoom-in').addEventListener('click', () => viewer.zoomBy(1.25));
$('zoom-out').addEventListener('click', () => viewer.zoomBy(0.8));
$('zoom-fit').addEventListener('click', () => viewer.fit());
$('zoom-label').addEventListener('click', () => viewer.setZoom(1));

// =============================================================================================
// Loading images

function setHeroLoading(text: string | null) {
  $('dz-loading').hidden = text === null;
  if (text) $('dz-loading-text').textContent = text;
}

async function loadFile(file: File) {
  if (source) showProgress('Reading image…', 0.05);
  else setHeroLoading('Reading image…');
  try {
    const decoded = await decodeFile(file, (msg) => (source ? showProgress(msg, 0.05) : setHeroLoading(msg)));
    const blob = await encodePng(decoded.image);
    setSource({
      image: decoded.image,
      name: file.name || 'pasted-image.png',
      url: URL.createObjectURL(blob),
      via: decoded.via === 'imagemagick' ? (/\.([a-z0-9]+)$/i.exec(file.name)?.[1] ?? 'file').toUpperCase() : (file.type.split('/')[1] || 'image').toUpperCase().replace('SVG+XML', 'SVG').replace('JPEG', 'JPG'),
      originalSize: decoded.originalSize,
    });
  } catch (e) {
    hideProgress();
    toast(e instanceof Error ? e.message : 'Could not read that file.', 'error', 6000);
  } finally {
    setHeroLoading(null);
  }
}

function setSource(s: Source) {
  if (source) URL.revokeObjectURL(source.url);
  source = s;
  aiCache.clear();
  clearResult();
  app.dataset.state = 'loaded';
  $('btn-new').hidden = false;
  $('file-chip').hidden = false;
  $('file-name').textContent = s.name;
  $('file-chip').title = s.name;
  $('file-meta').textContent = `${s.via} · ${s.image.width}×${s.image.height}`;
  viewer.setOriginal(s.url, s.image.width, s.image.height);
  renderStats();
  if (s.originalSize) toast(`Large image reduced from ${s.originalSize.width}×${s.originalSize.height} to ${s.image.width}×${s.image.height}.`, 'info', 5000);
  run(true);
}

function clearResult() {
  if (result) for (const u of result.urls) URL.revokeObjectURL(u);
  result = null;
  viewer.clearVector();
  $('palette').replaceChildren();
  updateLabels();
}

const openPicker = () => fileInput.click();
fileInput.addEventListener('change', () => {
  const f = fileInput.files?.[0];
  if (f) loadFile(f);
  fileInput.value = '';
});
$('btn-upload').addEventListener('click', (e) => { e.stopPropagation(); openPicker(); });
$('btn-new').addEventListener('click', openPicker);
$('dropzone').addEventListener('click', (e) => { if (!(e.target as HTMLElement).closest('button')) openPicker(); });
$('dropzone').addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target === e.currentTarget) { e.preventDefault(); openPicker(); }
});
$('btn-sample').addEventListener('click', async (e) => {
  e.stopPropagation();
  const img = makeSample();
  const blob = await encodePng(img);
  setSource({ image: img, name: 'sample.png', url: URL.createObjectURL(blob), via: 'PNG' });
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

// =============================================================================================
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
  else debounce = window.setTimeout(() => void process(), 280);
}

function aiUpscaled(src: Source, f: 2 | 4, onProgress: (p: number) => void): Promise<RGBAImage> {
  let p = aiCache.get(f);
  if (!p) {
    p = aiUpscale(src.image, f, onProgress);
    p.catch(() => aiCache.delete(f));
    aiCache.set(f, p);
  }
  return p;
}

async function process() {
  if (!source) return;
  const src = source;
  const id = ++jobCounter;
  const opts = { ...settings.opts };
  // A previous job still running is outdated: restart the worker instead of waiting.
  if (busyJob && worker) { worker.terminate(); worker = null; busyJob = 0; }

  let input = src.image;
  const w = src.image.width, h = src.image.height;
  if (settings.method === 'ai') {
    const wanted = opts.upscale || autoUpscale(w, h);
    const f = wanted > 1 ? aiFactorFor(w, h, wanted) : 0;
    if (f) {
      try {
        showProgress(`AI upscaling ${f}×…`, 0.02);
        const up = await aiUpscaled(src, f, (p) => { if (id === jobCounter) showProgress(`AI upscaling ${f}×…`, p * 0.5); });
        if (id !== jobCounter || src !== source) return;
        input = up;
      } catch (e) {
        console.error(e);
        if (id !== jobCounter) return;
        toast('AI upscaling is not available in this browser. Using standard upscaling.', 'error', 5000);
        settings.method = 'classic';
        setRadio('opt-method', 'classic');
        updateLabels();
        saveSettings();
      }
    } else if (wanted > 1) {
      toast('Image is already large, so AI upscaling was skipped.');
    }
  }
  if (id !== jobCounter || src !== source) return;

  const aiPart = input !== src.image ? 0.5 : 0;
  const req: JobRequest = {
    id,
    data: input.data.slice().buffer,
    width: input.width,
    height: input.height,
    srcW: w,
    srcH: h,
    opts: { ...opts, upscale: aiPart ? Math.max(opts.upscale, input.width / w) : opts.upscale },
  };
  busyJob = id;
  const wk = getWorker();
  showProgress('Vectorizing…', aiPart || 0.03);
  wk.onmessage = (e: MessageEvent<JobMessage>) => {
    const m = e.data;
    if (m.id !== jobCounter) return;
    if (m.type === 'progress') {
      showProgress(`${m.stage}…`, aiPart + m.fraction * (1 - aiPart));
    } else if (m.type === 'done') {
      busyJob = 0;
      hideProgress();
      showResult(m.vector, { data: new Uint8ClampedArray(m.working.data), width: m.working.width, height: m.working.height });
    } else {
      busyJob = 0;
      hideProgress();
      toast(`Vectorization failed: ${m.message}`, 'error', 6000);
    }
  };
  wk.onerror = (e) => {
    busyJob = 0;
    hideProgress();
    toast(`Vectorization failed: ${e.message || 'worker error'}`, 'error', 6000);
    worker = null;
  };
  wk.postMessage(req, [req.data]);
}

function showResult(vector: VectorImage, working: RGBAImage) {
  if (result) for (const u of result.urls) URL.revokeObjectURL(u);
  const svg = toSVG(vector, { gapFiller: settings.gapFiller });
  const svgUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
  const outlineUrl = URL.createObjectURL(new Blob([toOutlineSVG(vector)], { type: 'image/svg+xml' }));
  result = { vector, working, svg, urls: [svgUrl, outlineUrl] };
  viewer.setVector(svgUrl, outlineUrl);
  renderPalette(vector);
  renderStats();
  updateLabels();
}

// =============================================================================================
// Info

function renderStats() {
  const el = $('stats');
  if (!source) { el.replaceChildren(); return; }
  const s = source.image;
  const parts: string[] = [];
  if (result) {
    const v = result.vector;
    const scale = v.scale % 1 ? v.scale.toFixed(2) : String(v.scale);
    parts.push(
      `<span class="opt">Traced at <b>${result.working.width}×${result.working.height}</b> (${scale}×)</span>`,
      `<span><b>${v.palette.length}</b> colors</span>`,
      `<span><b>${v.shapes.length.toLocaleString()}</b> shapes</span>`,
      `<span class="opt"><b>${v.stats.nodes.toLocaleString()}</b> nodes</span>`,
      `<span>SVG <b>${fmtBytes(result.svg.length)}</b></span>`,
      `<span class="opt"><b>${(v.stats.ms / 1000).toFixed(2)}</b> s</span>`,
    );
  } else {
    parts.push(`<span><b>${s.width}×${s.height}</b></span>`, '<span>Vectorizing…</span>');
  }
  el.innerHTML = parts.join('<span class="sep opt" aria-hidden="true"></span>');
}

function renderPalette(v: VectorImage) {
  $('palette').replaceChildren(
    ...v.palette.map((p) => {
      const hex = '#' + [p.r, p.g, p.b].map((x) => x.toString(16).padStart(2, '0')).join('');
      const share = `${(p.share * 100).toFixed(p.share < 0.01 ? 2 : 1)}%`;
      const b = document.createElement('button');
      b.className = 'swatch';
      b.style.background = hex;
      b.dataset.tip = `${hex} · ${share}`;
      b.setAttribute('aria-label', `${hex}, ${share} of the image. Click to copy.`);
      b.addEventListener('click', () => navigator.clipboard?.writeText(hex).then(() => toast(`Copied ${hex}`), () => {}));
      return b;
    }),
  );
}

// =============================================================================================
// Export

const FORMAT_HINTS: Record<Format, string> = {
  svg: 'Scalable vector. Opens in Illustrator, Inkscape, Figma and browsers.',
  pdf: 'Vector PDF. Opens in Illustrator, Affinity and any PDF viewer.',
  eps: 'Encapsulated PostScript for print shops and older tools.',
  dxf: 'Closed outlines, one layer per color, for CAD, laser and CNC.',
  png: '',
  jpg: '',
  webp: '',
  upscaled: '',
};
const isRaster = (f: Format) => f === 'png' || f === 'jpg' || f === 'webp';

bindRadio('dl-format', (v) => { settings.format = v as Format; saveSettings(); updateExportUi(); });
$<HTMLSelectElement>('dl-scale').addEventListener('change', (e) => {
  settings.rasterScale = Number((e.target as HTMLSelectElement).value);
  saveSettings();
  updateExportUi();
});

function updateExportUi() {
  const f = settings.format;
  $('dl-size-row').hidden = !isRaster(f);
  $('btn-download-label').textContent = f === 'upscaled' ? 'Download upscaled PNG' : `Download ${f.toUpperCase()}`;
  $<HTMLButtonElement>('btn-download').disabled = !result;
  $<HTMLButtonElement>('btn-copy').disabled = !result;
  let hint = FORMAT_HINTS[f];
  if (result && isRaster(f)) {
    const r = rasterSize(result.vector, settings.rasterScale);
    hint = `${r.w}×${r.h} px, rendered from the vector.`;
  } else if (result && f === 'upscaled') {
    hint = `${result.working.width}×${result.working.height} px: the upscaled image used for tracing.`;
  }
  $('dl-hint').textContent = hint;
}

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

async function download() {
  if (!result || !source) return;
  const f = settings.format;
  const v = result.vector;
  const base = `${source.name.replace(/\.[^.]+$/, '') || 'image'}-vector`;
  const btn = $<HTMLButtonElement>('btn-download');
  btn.disabled = true;
  try {
    switch (f) {
      case 'svg': save(new Blob([result.svg], { type: 'image/svg+xml' }), `${base}.svg`); break;
      case 'pdf': save(new Blob([(await toPDF(v, { gapFiller: settings.gapFiller })) as BlobPart], { type: 'application/pdf' }), `${base}.pdf`); break;
      case 'eps': save(new Blob([toEPS(v, { gapFiller: settings.gapFiller })], { type: 'application/postscript' }), `${base}.eps`); break;
      case 'dxf': save(new Blob([toDXF(v)], { type: 'application/dxf' }), `${base}.dxf`); break;
      case 'png': case 'jpg': case 'webp': {
        const type = f === 'jpg' ? 'image/jpeg' : (`image/${f}` as 'image/png' | 'image/webp');
        save(await toRaster(v, settings.rasterScale, type, settings.gapFiller), `${base}.${f}`);
        break;
      }
      case 'upscaled': save(await encodePng(result.working), `${base.replace(/-vector$/, '')}-upscaled.png`); break;
    }
  } catch (e) {
    toast(`Export failed: ${e instanceof Error ? e.message : e}`, 'error');
  } finally {
    btn.disabled = !result;
  }
}

$('btn-download').addEventListener('click', () => void download());
$('btn-copy').addEventListener('click', async () => {
  if (!result) return;
  try {
    await navigator.clipboard.writeText(result.svg);
    toast('SVG code copied to clipboard');
  } catch {
    toast('Clipboard is not available here', 'error');
  }
});

// =============================================================================================
// Keyboard shortcuts

window.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  const typing = t.closest('input, select, textarea, [contenteditable]') !== null;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && e.key.toLowerCase() === 'o') { e.preventDefault(); openPicker(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void download(); return; }
  if (typing || mod || e.altKey || !source) return;
  const modes: ViewMode[] = ['compare', 'original', 'vector', 'outlines'];
  if (e.key >= '1' && e.key <= '4') {
    const m = modes[Number(e.key) - 1];
    setRadio('view-mode', m);
    viewer.setMode(m);
  } else if (e.key === '0') viewer.fit();
  else if (e.key === '+' || e.key === '=') viewer.zoomBy(1.25);
  else if (e.key === '-' || e.key === '_') viewer.zoomBy(0.8);
  else return;
  e.preventDefault();
});

// =============================================================================================

setRadio('theme', savedTheme);
setRadio('view-mode', 'compare');
syncControls();

export type ViewMode = 'compare' | 'original' | 'vector' | 'outlines';

/** Keeps the compare handle this many pixels inside the viewport edges. */
const HANDLE_MARGIN = 22;

/**
 * Before/after viewer with a draggable split, wheel/pinch zoom and drag-to-pan.
 * Layers are sized with real width/height (not CSS transforms) so the SVG stays razor sharp
 * at any zoom level.
 */
export class Viewer {
  private z = 1;
  private tx = 0;
  private ty = 0;
  private split = 0.5;
  private w = 0;
  private h = 0;
  private fitted = true;
  private mode: ViewMode = 'compare';
  private vectorUrl = '';
  private outlineUrl = '';
  private pointers = new Map<number, { x: number; y: number }>();
  private pinch: { dist: number; z: number } | null = null;
  private dragSplit = false;
  private viewport: HTMLElement;
  private orig: HTMLImageElement;
  private vec: HTMLImageElement;
  private clip: HTMLElement;
  private divider: HTMLElement;
  onZoom: (z: number) => void = () => {};

  constructor(viewport: HTMLElement, orig: HTMLImageElement, vec: HTMLImageElement, clip: HTMLElement, divider: HTMLElement) {
    this.viewport = viewport;
    this.orig = orig;
    this.vec = vec;
    this.clip = clip;
    this.divider = divider;
    viewport.dataset.mode = this.mode;
    viewport.classList.add('no-vector');

    viewport.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    viewport.addEventListener('pointerdown', (e) => this.onDown(e));
    viewport.addEventListener('pointermove', (e) => this.onMove(e));
    viewport.addEventListener('pointerup', (e) => this.onUp(e));
    viewport.addEventListener('pointercancel', (e) => this.onUp(e));
    viewport.addEventListener('dblclick', (e) => { if (!(e.target as HTMLElement).closest('.divider')) this.fit(); });
    divider.addEventListener('keydown', (e) => {
      const step = e.shiftKey ? 0.1 : 0.02;
      if (e.key === 'ArrowLeft') this.setSplit(this.split - step);
      else if (e.key === 'ArrowRight') this.setSplit(this.split + step);
      else if (e.key === 'Home') this.setSplit(0);
      else if (e.key === 'End') this.setSplit(1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    });
    new ResizeObserver(() => (this.fitted ? this.fit() : this.apply())).observe(viewport);
  }

  get hasImage(): boolean {
    return this.w > 0;
  }

  setOriginal(url: string, w: number, h: number): void {
    this.orig.src = url;
    this.w = w;
    this.h = h;
    this.split = 0.5;
    this.fit();
  }

  setVector(vectorUrl: string, outlineUrl: string): void {
    this.vectorUrl = vectorUrl;
    this.outlineUrl = outlineUrl;
    this.viewport.classList.remove('no-vector');
    this.updateVecSrc();
    this.apply();
  }

  clearVector(): void {
    this.vectorUrl = this.outlineUrl = '';
    this.viewport.classList.add('no-vector');
    this.vec.removeAttribute('src');
  }

  setMode(mode: ViewMode): void {
    this.mode = mode;
    this.viewport.dataset.mode = mode;
    this.updateVecSrc();
    this.apply();
  }

  setBackground(bg: string): void {
    this.viewport.dataset.bg = bg;
  }

  setSplit(f: number): void {
    this.split = Math.max(0, Math.min(1, f));
    this.apply();
  }

  private updateVecSrc() {
    const url = this.mode === 'outlines' ? this.outlineUrl : this.vectorUrl;
    if (url) { if (this.vec.getAttribute('src') !== url) this.vec.src = url; }
    else this.vec.removeAttribute('src');
  }

  fit(): void {
    const r = this.viewport.getBoundingClientRect();
    if (!this.w || !r.width || !r.height) return;
    // leave room for the floating toolbars
    const padX = 32, padTop = 64, padBottom = 64;
    const z = Math.min((r.width - padX * 2) / this.w, (r.height - padTop - padBottom) / this.h, 8);
    this.z = Math.max(z, 0.01);
    this.tx = (r.width - this.w * this.z) / 2;
    this.ty = padTop + (r.height - padTop - padBottom - this.h * this.z) / 2;
    this.fitted = true;
    this.apply();
  }

  zoomBy(f: number, cx?: number, cy?: number): void {
    this.setZoom(this.z * f, cx, cy);
  }

  setZoom(z: number, cx?: number, cy?: number): void {
    if (!this.w) return;
    const r = this.viewport.getBoundingClientRect();
    cx ??= r.width / 2;
    cy ??= r.height / 2;
    const minZ = Math.min(0.05, (r.width / this.w) * 0.25);
    z = Math.max(minZ, Math.min(64, z));
    // keep the image point under the cursor fixed
    this.tx = cx - ((cx - this.tx) * z) / this.z;
    this.ty = cy - ((cy - this.ty) * z) / this.z;
    this.z = z;
    this.fitted = false;
    this.apply();
  }

  private apply(): void {
    const W = this.w * this.z, H = this.h * this.z;
    for (const el of [this.orig, this.vec]) {
      el.style.width = `${W}px`;
      el.style.height = `${H}px`;
      el.style.transform = `translate(${this.tx}px, ${this.ty}px)`;
    }
    this.orig.classList.toggle('pixelated', this.z >= 2);
    const vw = this.viewport.clientWidth;
    // The split follows the pointer, but the handle never leaves the viewport.
    const x = Math.max(HANDLE_MARGIN, Math.min(vw - HANDLE_MARGIN, this.split * vw));
    const compare = this.mode === 'compare' && !this.viewport.classList.contains('no-vector');
    this.clip.style.clipPath = compare ? `inset(0 0 0 ${x}px)` : 'none';
    this.divider.style.left = `${x}px`;
    this.divider.setAttribute('aria-valuenow', String(Math.round(this.split * 100)));
    this.onZoom(this.z);
  }

  private local(e: PointerEvent | WheelEvent) {
    const r = this.viewport.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  private onWheel(e: WheelEvent) {
    e.preventDefault();
    const p = this.local(e);
    const delta = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
    this.zoomBy(Math.exp(-delta * (e.ctrlKey ? 0.01 : 0.0018)), p.x, p.y);
  }

  private onDown(e: PointerEvent) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    const onDivider = (e.target as HTMLElement).closest('.divider') !== null;
    if (!onDivider) this.viewport.focus({ preventScroll: true });
    this.viewport.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, this.local(e));
    this.dragSplit = this.mode === 'compare' && this.pointers.size === 1 && onDivider;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), z: this.z };
      this.dragSplit = false;
    }
    this.divider.classList.toggle('dragging', this.dragSplit);
    if (!this.dragSplit) this.viewport.classList.add('panning');
  }

  private onMove(e: PointerEvent) {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.dragSplit) {
      this.setSplit(p.x / this.viewport.clientWidth);
      return;
    }
    if (this.pinch && this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      this.setZoom((this.pinch.z * d) / this.pinch.dist, (a.x + b.x) / 2, (a.y + b.y) / 2);
      return;
    }
    this.tx += p.x - prev.x;
    this.ty += p.y - prev.y;
    this.fitted = false;
    this.apply();
  }

  private onUp(e: PointerEvent) {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size < 2) this.pinch = null;
    if (this.pointers.size === 0) {
      this.dragSplit = false;
      this.divider.classList.remove('dragging');
      this.viewport.classList.remove('panning');
    }
  }
}

export type ViewMode = 'compare' | 'original' | 'vector' | 'outlines';

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
  onZoom: (z: number) => void = () => {};

  constructor(
    private viewport: HTMLElement,
    private orig: HTMLImageElement,
    private vec: HTMLImageElement,
    private clip: HTMLElement,
    private divider: HTMLElement,
  ) {
    viewport.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    viewport.addEventListener('pointerdown', (e) => this.onDown(e));
    viewport.addEventListener('pointermove', (e) => this.onMove(e));
    viewport.addEventListener('pointerup', (e) => this.onUp(e));
    viewport.addEventListener('pointercancel', (e) => this.onUp(e));
    viewport.addEventListener('dblclick', () => this.fit());
    viewport.addEventListener('keydown', (e) => {
      if (e.key === '+' || e.key === '=') this.zoomBy(1.25);
      else if (e.key === '-') this.zoomBy(0.8);
      else if (e.key === '0') this.fit();
      else if (e.key === '1') this.setZoom(1);
      else return;
      e.preventDefault();
    });
    new ResizeObserver(() => (this.fitted ? this.fit() : this.apply())).observe(viewport);
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
    this.updateVecSrc();
  }

  clearVector(): void {
    this.vectorUrl = this.outlineUrl = '';
    this.vec.removeAttribute('src');
  }

  setMode(mode: ViewMode): void {
    this.mode = mode;
    this.viewport.dataset.mode = mode;
    this.updateVecSrc();
    this.apply();
  }

  private updateVecSrc() {
    const url = this.mode === 'outlines' ? this.outlineUrl : this.vectorUrl;
    if (url) { if (this.vec.src !== url) this.vec.src = url; }
    else this.vec.removeAttribute('src');
  }

  fit(): void {
    const r = this.viewport.getBoundingClientRect();
    if (!this.w || !r.width) return;
    const pad = 24;
    this.z = Math.min((r.width - pad * 2) / this.w, (r.height - pad * 2) / this.h, 8);
    this.tx = (r.width - this.w * this.z) / 2;
    this.ty = (r.height - this.h * this.z) / 2;
    this.fitted = true;
    this.apply();
  }

  zoomBy(f: number, cx?: number, cy?: number): void {
    this.setZoom(this.z * f, cx, cy);
  }

  setZoom(z: number, cx?: number, cy?: number): void {
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
    const x = this.split * vw;
    this.clip.style.clipPath = this.mode === 'compare' ? `inset(0 0 0 ${x}px)` : 'none';
    this.divider.style.left = `${x - 1}px`;
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
    this.viewport.focus({ preventScroll: true });
    this.viewport.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, this.local(e));
    this.dragSplit = this.mode === 'compare' && this.pointers.size === 1 && (e.target as HTMLElement).closest('.divider') !== null;
    if (this.pointers.size === 2) {
      const [a, b] = [...this.pointers.values()];
      this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), z: this.z };
      this.dragSplit = false;
    }
    if (!this.dragSplit) this.viewport.classList.add('panning');
  }

  private onMove(e: PointerEvent) {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const p = this.local(e);
    this.pointers.set(e.pointerId, p);
    if (this.dragSplit) {
      this.split = Math.max(0, Math.min(1, p.x / this.viewport.clientWidth));
      this.apply();
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
      this.viewport.classList.remove('panning');
    }
  }
}

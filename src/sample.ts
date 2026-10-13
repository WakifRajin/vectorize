import type { RGBAImage } from './core/types.ts';

/** A small, slightly soft raster logo — the kind of image people typically want vectorized. */
export function makeSample(): RGBAImage {
  const w = 360, h = 240;
  const c = new OffscreenCanvas(w, h);
  const g = c.getContext('2d')!;

  g.fillStyle = '#fbf3e4';
  g.fillRect(0, 0, w, h);

  // sun
  g.fillStyle = '#f2a03d';
  g.beginPath();
  g.arc(250, 92, 46, 0, Math.PI * 2);
  g.fill();

  // mountains
  g.fillStyle = '#2f4a6d';
  g.beginPath();
  g.moveTo(20, 196);
  g.lineTo(118, 70);
  g.lineTo(170, 132);
  g.lineTo(208, 96);
  g.lineTo(300, 196);
  g.closePath();
  g.fill();
  g.fillStyle = '#ffffff';
  g.beginPath();
  g.moveTo(118, 70);
  g.lineTo(140, 98);
  g.lineTo(128, 94);
  g.lineTo(116, 106);
  g.lineTo(106, 92);
  g.lineTo(96, 98);
  g.closePath();
  g.fill();

  // lake ripples
  g.strokeStyle = '#4f8fbf';
  g.lineWidth = 6;
  g.lineCap = 'round';
  for (const [x0, x1, y] of [[60, 160, 212], [190, 300, 212], [110, 240, 226]]) {
    g.beginPath();
    g.moveTo(x0, y);
    g.lineTo(x1, y);
    g.stroke();
  }

  // ring badge
  g.strokeStyle = '#c4473a';
  g.lineWidth = 9;
  g.beginPath();
  g.arc(318, 196, 22, 0, Math.PI * 2);
  g.stroke();

  // a little blur + JPEG-like softness, as from a screenshot or resized web image
  const soft = new OffscreenCanvas(w, h);
  const sg = soft.getContext('2d')!;
  sg.filter = 'blur(0.6px)';
  sg.drawImage(c, 0, 0);
  const d = sg.getImageData(0, 0, w, h);
  return { data: d.data, width: w, height: h };
}

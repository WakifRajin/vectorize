# Vectorize

Upscale and convert any raster image into a clean vector — entirely in the browser. A static site (no server, no uploads) that you can host for free on GitHub Pages.

**Input:** PNG, JPG, WebP, GIF, BMP, AVIF, SVG natively, plus HEIC/HEIF, TIFF, PSD, XCF, TGA, DDS, PCX, QOI, EXR, HDR, JPEG 2000, JPEG XL, camera RAW (DNG, CR2, NEF, ARW, …) and 100+ other formats via ImageMagick compiled to WebAssembly. You can also paste from the clipboard.

**Output:** SVG, PDF, EPS, DXF (CAD/laser), plus PNG/JPG/WebP renders at any scale and the upscaled raster itself.

## Features

- **Upscaling** – fast Mitchell–Netravali resampling, or AI super-resolution (ESRGAN via TensorFlow.js on the GPU). Model weights are self-hosted in `public/models`, so nothing depends on a CDN.
- **Accurate colour reduction** – k-means in the perceptual OKLab colour space, learned from flat areas only, so anti-aliased edges don't create halo colours. Automatic or fixed palette (2–64 colours).
- **Gap-free shapes** – boundaries are traced on a shared edge graph: every border between two colours is fitted once and used by both shapes, so they fit together exactly. Junctions where three colours meet are moved to where the edges really intersect.
- **Clean curves** – Taubin-smoothed pixel staircases, sharp-corner and obtuse-corner detection with sub-pixel corner placement, straight-line detection, and least-squares Bézier fitting (Schneider's algorithm).
- **Stacked or cutout layering**, gap filler, background removal, speckle filter, smoothness and corner controls.
- **Viewer** with before/after split, zoom (wheel/pinch), pan, and an outline view to inspect the geometry.
- Heavy work runs in a Web Worker; ImageMagick (~15 MB) and TensorFlow (~1 MB) load only when needed.

## Develop

```bash
npm install
npm run dev
```

Open http://localhost:5173.

```bash
npm test        # pipeline accuracy tests (Node 22.6+)
npm run build   # type-check and build to dist/
```

## Deploy to GitHub Pages

1. Push this folder to a GitHub repository (default branch `main`).
2. In the repository go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Push to `main` (or run the workflow manually). `.github/workflows/deploy.yml` tests, builds and publishes `dist/`.

The site will be at `https://<user>.github.io/<repo>/`. The build uses relative paths, so it works under any sub-path.

## How it works

```
decode (browser / ImageMagick WASM)
  → optional denoise (bilateral) → upscale (Mitchell or ESRGAN)
  → palette (OKLab k-means on flat pixels) → per-pixel mapping, edge pixels restricted to nearby colours
  → speckle merge → anti-alias sliver removal → region labelling
  → boundary graph (chains between junctions) → junction refinement
  → per chain: corners → smoothing → lines / Bézier fitting
  → assemble shapes (stacked or cutouts) → SVG / PDF / EPS / DXF / raster
```

Source layout:

| Path | What |
| --- | --- |
| `src/core/` | Vectorization engine (pure TypeScript, runs in a worker and in Node tests) |
| `src/export/` | SVG, PDF, EPS, DXF and raster writers |
| `src/decode.ts` | File decoding (native + ImageMagick fallback) |
| `src/ai-upscale.ts` | ESRGAN upscaling via UpscalerJS / TensorFlow.js |
| `src/viewer.ts` | Zoom / pan / compare viewer |
| `src/main.ts` | UI wiring |
| `tests/` | Accuracy tests on synthetic anti-aliased shapes |

## License

MIT. Third-party: ImageMagick (Apache-2.0 style ImageMagick license) via `@imagemagick/magick-wasm`, TensorFlow.js (Apache-2.0), UpscalerJS and ESRGAN-slim models (MIT).

# ClearPixel.ai — Step-Wise Engineering Development Plan (`development.plan.md`)

**Objective:** Build a 100% client-side, ₹0-cost, MIT-licensed AI background removal web platform that beats Remove.bg in speed, privacy, and full-resolution quality across Desktop, Android, and iPhone Safari.

---

## Engineering Execution Rules
1. **UI-First Delivery:** Build the interactive studio UI first so every subsequent engine upgrade is immediately testable in a live browser.
2. **Verification Gates:** No step is marked complete until its automated build/test/performance gate passes.
3. **Zero Backend / ₹0 Cost:** Pure static Next.js export (`output: 'export'`) deployed on Cloudflare Pages (Unlimited Bandwidth, Commercial Allowed).
4. **100% Commercial-Safe:** Only MIT/Apache-2.0 models (**BiRefNet-Lite MIT**). Zero non-commercial dependencies.
5. **Off-Main-Thread:** Never block the 60fps UI thread with AI or pixel math.

---

## Master Progress Tracker

| Step | Phase | Status | Target Deliverable |
| :--- | :--- | :--- | :--- |
| **Step 1** | **High-Speed Studio UI & Design System** | ✅ Done | `packages/clearpixel-web` (Next.js, DropZone, Split Canvas, Background Studio, Export UI) |
| **Step 2** | **Web Worker & Zero-Wait Model Cache** | ✅ Done | `pipeline.worker.ts`, Hardware Detector (WebGPU/WASM), Parallel Chunk Loader + Cache API |
| **Step 3** | **BiRefNet-Lite (MIT) AI Inference** | ✅ Done | `onnxruntime-web` integration, Tensor preprocessing, Live client-side cutout |
| **Step 4** | **Rust + WASM Matting Core** | ✅ Code Ready | `packages/clearpixel-core` (Guided Filter, Tri-Map, Color Decontamination, PNG Encoder) + `wasm-bridge.ts` |
| **Step 5** | **High-MP (24MP–100MP) Tiling + Brush** | ✅ Done | Boundary Tile Classifier (<65MB heap for iPhone/8GB RAM) + Keep/Erase Brush + Undo/Redo |
| **Step 6** | **Cross-Device QA & Cloudflare Launch** | 🟡 Next Up | `_headers` (`COOP`/`COEP`), iOS/Android/PC benchmarks, Cloudflare Pages production deploy |

---

## Step 1: High-Speed Studio UI & Design System (Start Here)

### Goal
Deliver a blazing-fast, responsive, studio-grade frontend where users can drop/paste images, preview cutouts with a 60fps Before/After slider, customize backgrounds, and export.

### Deliverables & Files (`packages/clearpixel-web/`)
- `next.config.mjs` — Configured with `output: 'export'` and `images: { unoptimized: true }` for static Cloudflare Pages hosting.
- `src/app/layout.tsx` & `globals.css` — Modern dark/light studio theme, clean typography, zero layout shift.
- `src/components/Header.tsx` — Brand header, privacy badge ("100% On-Device"), and hardware status pill (`DeviceBadge.tsx`).
- `src/components/DropZone.tsx` — Drag-and-drop, file picker, `Ctrl+V` clipboard paste, EXIF auto-orientation, plus instant demo sample images.
- `src/components/ComparisonCanvas.tsx` — 60fps interactive Before/After split slider, zoom/pan controls, and checkerboard transparency grid.
- `src/components/BackgroundPalette.tsx` — Transparent, Studio Solid Colors, Gradients, Background Blur (Bokeh), and Custom Image upload.
- `src/components/ExportDialog.tsx` — Format selector (PNG 32-bit, WebP, JPG) and resolution preview.

### Engineering Verification Gate
- [ ] `npm run build` succeeds with zero TypeScript or ESLint errors and outputs static `out/` folder.
- [ ] Responsive layout verified on Desktop (1440px) and Mobile (375px).
- [ ] Image upload, split-slider drag, and background color/blur preview work smoothly at 60fps.

---

## Step 2: Off-Main-Thread Web Worker & Zero-Wait Cache Engine

### Goal
Isolate all heavy computation from the UI thread and eliminate perceived model download wait times.

### Deliverables & Files
- `src/workers/pipeline.worker.ts` — Comlink-wrapped Web Worker managing inference and Rust WASM calls.
- `src/lib/hardware-detect.ts` — Runtime probe for `navigator.gpu` (WebGPU + `shader-f16`) vs `WASM SIMD` (iOS Safari / low-end fallback).
- `src/lib/model-cache.ts` —
  - **Silent Background Pre-Fetcher:** Starts fetching model chunks as soon as the landing page opens.
  - **Parallel Chunk Fetcher:** Fetches `< 20MB` chunks (`model.part1`, `model.part2`, ...) via `Promise.all()` to saturate bandwidth and stay under Cloudflare Pages' 25 MiB file limit.
  - **Lifetime Persistence:** Stores assembled model in `Cache API` / `IndexedDB` (0 MB downloaded on 2nd photo and all future visits).

### Engineering Verification Gate
- [ ] Main thread stays responsive (60fps) while worker initializes and fetches chunks.
- [ ] Browser DevTools confirms model chunks load from `CacheStorage` / `IndexedDB` in `< 100ms` on page reload.

---

## Step 3: BiRefNet-Lite (MIT) AI Inference Integration

### Goal
Run real, 100% commercial-safe AI background removal directly in the browser.

### Deliverables & Files
- `public/models/` — Self-hosted chunked **BiRefNet-Lite (MIT License)** ONNX models:
  - FP16 WebGPU-patched variant (~45–60MB total, split into `< 20MB` chunks) for Desktop/Android WebGPU.
  - INT8 / 512px compact variant (~18–25MB) for iPhone Safari and fast first-load.
- `src/workers/ort-engine.ts` — `onnxruntime-web` session manager (`webgpu` primary, `wasm` fallback).
- `src/lib/tensor-utils.ts` — Fast image resize (`1024×1024` / `512×512`), RGB normalization, and sigmoid mask extraction.

### Engineering Verification Gate
- [ ] End-to-end cutout works on real portrait, hair, and product images with zero server calls.
- [ ] Inference latency target: `< 600ms` on Desktop WebGPU, `< 2.5s` on CPU/WASM fallback.

---

## Step 4: Rust + WASM Studio Matting Core (`clearpixel-core`)

### Goal
Upgrade raw AI masks to **Zero-Edge, Zero-Halo** studio quality that preserves fine hair strands and removes background color bleed.

### Deliverables & Files (`packages/clearpixel-core/`)
- `Cargo.toml` — Configured for `wasm32-unknown-unknown`, `wasm-bindgen`, and `simd128` optimization (`opt-level = 3`, `lto = true`).
- `src/buffer.rs` — Zero-copy RGBA memory views between JS and WASM.
- `src/guided_filter.rs` — $O(N)$ Fast Guided Filter (SIMD128) transferring crisp high-res edges from original RGB to the coarse AI mask.
- `src/alpha_matting.rs` — Adaptive Tri-Map (Definite FG / Definite BG / Unknown Transition Band) for hair and fur.
- `src/color_decontamination.rs` — Removes ambient background color spill/halos from hair strands.
- `src/png_encoder.rs` — Fast native 32-bit transparent PNG encoder.

### Engineering Verification Gate
- [ ] `cargo test` passes unit tests for Guided Filter, Tri-Map, and Color Decontamination.
- [ ] `wasm-pack build --target web` compiles cleanly into `packages/clearpixel-web/public/wasm/`.
- [ ] Visual side-by-side confirms elimination of white/green edge halos on dark hair.

---

## Step 5: High-Megapixel (24MP–100MP) Tiling + Manual Retouch Brush

### Goal
Process 24MP–100MP DSLR photos without crashing 8GB RAM laptops or iPhone Safari, and give users manual Keep/Erase control.

### Deliverables & Files
- `packages/clearpixel-core/src/tiling.rs` — Boundary-Selective Tile Classifier:
  - Skips solid foreground ($\alpha = 1.0$) and solid background ($\alpha = 0.0$) tiles.
  - Processes only edge/border tiles sequentially with 32px feathered overlap.
  - Keeps peak WASM heap strictly `< 65MB` (safe for iOS Safari's ~512MB tab limit).
- `src/components/RetouchToolbar.tsx` — Keep Brush, Erase Brush, Brush Size, and Edge Feather sliders wired directly to the alpha mask buffer.

### Engineering Verification Gate
- [ ] 24MP/48MP test image processes and exports at full original resolution without tab crash.
- [ ] Manual Keep/Erase brush updates preview at 60fps and reflects in final PNG export.

---

## Step 6: Cross-Device QA, Performance Tuning & Cloudflare Pages Launch

### Goal
Verify stability across all target devices and deploy globally at ₹0 cost with Unlimited Bandwidth.

### Deliverables & Files
- `packages/clearpixel-web/public/_headers` — Configures `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp` (for WASM SIMD multithreading) + aggressive `Cache-Control` for `.onnx` chunks and `.wasm`.
- `.github/workflows/deploy.yml` — Automated build (`wasm-pack` + `next build`) and Cloudflare Pages deployment.

### Engineering Verification Gate
- [ ] Cross-device QA passed on:
  - Windows Chrome/Edge (WebGPU)
  - macOS Chrome/Safari
  - Android Chrome
  - iPhone Safari (WASM fallback, zero memory reload)
- [ ] Lighthouse Performance score $\ge 95$.
- [ ] Live on Cloudflare Pages with ₹0 cost and Unlimited Bandwidth.

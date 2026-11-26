import * as Comlink from 'comlink';
import {
  AutoModel,
  AutoModelForImageMatting,
  AutoProcessor,
  RawImage,
  env,
  pipeline,
} from '@huggingface/transformers';
import { detectHardware, HardwareCapabilities } from '../lib/hardware-detect';
import { runStudioMatting } from '../lib/wasm-bridge';
import type { SubjectMode } from '../lib/edge-refiner';
import type { UpscaleScale } from '../types/studio';

// Configure browser-only caching and self-hosted WebGPU+WASM runtime (/public/ort/, 16MB)
env.allowLocalModels = false;
env.useBrowserCache = true;
const isLocalhost =
  typeof self !== 'undefined' &&
  (self.location.hostname === 'localhost' || self.location.hostname === '127.0.0.1');
env.remoteHost = isLocalhost ? 'https://huggingface.co/' : `${self.location.origin}/hf/`;
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = {
    mjs: '/ort/ort-wasm-simd-threaded.jspi.mjs',
    wasm: '/ort/ort-wasm-simd-threaded.jspi.wasm',
  };
}

// Diagnostic wrapper so any network/CORS failure reports the exact failing URL
const origFetch = self.fetch.bind(self);
self.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  try {
    return await origFetch(input, init);
  } catch (err) {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof Request
        ? input.url
        : String(input);
    throw new Error(
      `Failed to fetch (${url.slice(0, 90)}): ${err instanceof Error ? err.message : String(err)}`
    );
  }
};

// Primary Fast Engine: BRIA RMBG-1.4 (CC BY-NC 4.0 for open-source/non-commercial;
// WebGPU-native IS-Net CNN, ~44MB q8, zero 17-buffer shader limits, great for both Portraits & Products)
const RMBG_MODEL_ID = 'briaai/RMBG-1.4';
// Secondary Ultra HD Engine: MIT-licensed BiRefNet-Lite 1024px
const WEBGPU_1024_MODEL_ID = 'jiabins0303/birefnet-lite-1024-webgpu';
const ULTRA_1024_MODEL_ID = 'onnx-community/BiRefNet_lite-ONNX';
// Neural Trimap Hair Matting Engine (27.5 MB INT8 q8, Apache-2.0 / MIT)
const VITMATTE_MODEL_ID = 'Xenova/vitmatte-small-composition-1k';
// Apache-2.0 Super-Resolution Upscaler models (Swin2SR)
const UPSCALE_2X_MODEL_ID = 'Xenova/swin2SR-classical-sr-x2-64';
const UPSCALE_4X_MODEL_ID = 'Xenova/swin2SR-realworld-sr-x4-64-bsrgan-psnr';

export type QualityMode = 'fast' | 'ultra';

export interface ProgressPayload {
  stage: 'init' | 'downloading' | 'inferring' | 'compositing' | 'ready';
  progress: number; // 0 - 100
  message: string;
}

export interface CutoutResult {
  cutoutBlob: Blob;
  width: number;
  height: number;
  latencyMs: number;
  backendLabel: string;
}

interface EngineInstance {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  model: any;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  processor: any;
  hw: HardwareCapabilities;
  modelId: string;
}

const engineCache = new Map<string, Promise<EngineInstance>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const upscalerCache = new Map<string, Promise<any>>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let vitmattePromise: Promise<{ model: any; processor: any }> | null = null;

async function getVitMatte(onProgress?: (p: ProgressPayload) => void) {
  if (vitmattePromise) return vitmattePromise;

  vitmattePromise = (async () => {
    try {
      onProgress?.({
        stage: 'downloading',
        progress: 84,
        message: 'Loading Studio Hair Matte…',
      });
      const processor = await AutoProcessor.from_pretrained(VITMATTE_MODEL_ID);
      const model = await AutoModelForImageMatting.from_pretrained(VITMATTE_MODEL_ID, {
        device: 'wasm',
        dtype: 'q8',
      });
      return { model, processor };
    } catch (err) {
      vitmattePromise = null;
      throw err;
    }
  })();

  return vitmattePromise;
}

/**
 * O(N) Separable 1D Erosion + Dilation to build an Auto-Trimap (0=bg, 128=unknown hair band, 255=fg).
 */
function buildAutoTrimap(
  mask: Uint8Array,
  w: number,
  h: number,
  erodeRadius: number,
  dilateRadius: number
): Uint8Array {
  const n = w * h;
  const fgTemp = new Uint8Array(n);
  const fgEroded = new Uint8Array(n);
  const bgTemp = new Uint8Array(n);
  const bgDilated = new Uint8Array(n);

  // Horizontal pass
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      let minV = 255;
      const ex0 = Math.max(0, x - erodeRadius);
      const ex1 = Math.min(w - 1, x + erodeRadius);
      for (let kx = ex0; kx <= ex1; kx++) {
        const v = mask[row + kx];
        if (v < minV) minV = v;
      }
      fgTemp[row + x] = minV;

      let maxV = 0;
      const dx0 = Math.max(0, x - dilateRadius);
      const dx1 = Math.min(w - 1, x + dilateRadius);
      for (let kx = dx0; kx <= dx1; kx++) {
        const v = mask[row + kx];
        if (v > maxV) maxV = v;
      }
      bgTemp[row + x] = maxV;
    }
  }

  // Vertical pass
  for (let y = 0; y < h; y++) {
    const row = y * w;
    const ey0 = Math.max(0, y - erodeRadius);
    const ey1 = Math.min(h - 1, y + erodeRadius);
    const dy0 = Math.max(0, y - dilateRadius);
    const dy1 = Math.min(h - 1, y + dilateRadius);

    for (let x = 0; x < w; x++) {
      let minV = 255;
      for (let ky = ey0; ky <= ey1; ky++) {
        const v = fgTemp[ky * w + x];
        if (v < minV) minV = v;
      }
      fgEroded[row + x] = minV;

      let maxV = 0;
      for (let ky = dy0; ky <= dy1; ky++) {
        const v = bgTemp[ky * w + x];
        if (v > maxV) maxV = v;
      }
      bgDilated[row + x] = maxV;
    }
  }

  const trimap = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (fgEroded[i] >= 235) {
      trimap[i] = 255;
    } else if (bgDilated[i] <= 18) {
      trimap[i] = 0;
    } else {
      trimap[i] = 128;
    }
  }
  return trimap;
}

async function refinePortraitWithVitMatte(
  image: RawImage,
  coarseMask: Uint8Array,
  onProgress?: (p: ProgressPayload) => void
): Promise<Uint8Array> {
  const { model, processor } = await getVitMatte(onProgress);

  onProgress?.({
    stage: 'compositing',
    progress: 89,
    message: 'Refining fine hair strands…',
  });

  // Find foreground bounding box + 32px padding so ViTMatte focuses 100% of its resolution on the subject
  let minX = image.width;
  let minY = image.height;
  let maxX = 0;
  let maxY = 0;
  for (let y = 0; y < image.height; y++) {
    const row = y * image.width;
    for (let x = 0; x < image.width; x++) {
      if (coarseMask[row + x] > 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX <= minX || maxY <= minY) {
    return coarseMask;
  }

  const pad = 32;
  const cx0 = Math.max(0, minX - pad);
  const cy0 = Math.max(0, minY - pad);
  const cx1 = Math.min(image.width, maxX + pad + 1);
  const cy1 = Math.min(image.height, maxY + pad + 1);
  const cw = cx1 - cx0;
  const ch = cy1 - cy0;

  const srcRgba = image.rgba().data as unknown as Uint8ClampedArray;
  const cropRgba = new Uint8ClampedArray(cw * ch * 4);
  const cropMask = new Uint8Array(cw * ch);
  for (let ty = 0; ty < ch; ty++) {
    const srcIdx = (cy0 + ty) * image.width + cx0;
    const dstIdx = ty * cw;
    cropRgba.set(srcRgba.subarray(srcIdx * 4, (srcIdx + cw) * 4), dstIdx * 4);
    cropMask.set(coarseMask.subarray(srcIdx, srcIdx + cw), dstIdx);
  }

  const isMobile =
    typeof navigator !== 'undefined' && /Mobi|Android|iPhone|iPad/i.test(navigator.userAgent);
  const maxDim = isMobile ? 640 : 1024;
  const scale = Math.min(1, maxDim / Math.max(cw, ch));
  const matW = Math.max(32, Math.round((cw * scale) / 32) * 32);
  const matH = Math.max(32, Math.round((ch * scale) / 32) * 32);

  const cropImg = new RawImage(new Uint8Array(cropRgba.buffer), cw, ch, 4).rgb();
  const smallImg = await cropImg.resize(matW, matH);
  const smallMaskImg = await new RawImage(cropMask, cw, ch, 1).resize(matW, matH);
  const smallMask = smallMaskImg.data as unknown as Uint8Array;
  // Wide outward dilation (26px) ensures outer flyaway hair tips fall inside the ViTMatte unknown band
  const trimapBytes = buildAutoTrimap(smallMask, matW, matH, 3, 26);
  const trimapImg = new RawImage(trimapBytes, matW, matH, 1);

  const inputs = await processor(smallImg, trimapImg);
  const out = await model(inputs);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const alphas = out.alphas ?? (Object.values(out)[0] as any);
  const alphaData = alphas.data as Float32Array;

  const matteSmallBytes = new Uint8Array(matW * matH);
  for (let i = 0; i < matteSmallBytes.length; i++) {
    matteSmallBytes[i] = Math.max(0, Math.min(255, Math.round(alphaData[i] * 255)));
  }

  const matteResized = await new RawImage(matteSmallBytes, matW, matH, 1).resize(cw, ch);
  const cropTrimapResized = await trimapImg.resize(cw, ch);
  const matteCrop = matteResized.data as unknown as Uint8Array;
  const trimapCrop = cropTrimapResized.data as unknown as Uint8Array;

  // Merge ViTMatte predictions inside the unknown trimap band while keeping solid core & far bg crisp
  const merged = new Uint8Array(coarseMask);
  for (let ty = 0; ty < ch; ty++) {
    const dstRow = (cy0 + ty) * image.width + cx0;
    const srcRow = ty * cw;
    for (let tx = 0; tx < cw; tx++) {
      const t = trimapCrop[srcRow + tx];
      if (t > 12 && t < 242) {
        merged[dstRow + tx] = matteCrop[srcRow + tx];
      }
    }
  }
  return merged;
}

async function getUpscaler(scale: UpscaleScale, onProgress?: (p: ProgressPayload) => void) {
  const key = `upscale-${scale}`;
  const existing = upscalerCache.get(key);
  if (existing) return existing;

  const modelId = scale === 4 ? UPSCALE_4X_MODEL_ID : UPSCALE_2X_MODEL_ID;
  const loader = (async () => {
    const hw = await detectHardware();
    const useWebGpu = hw.device === 'webgpu';
    onProgress?.({
      stage: 'init',
      progress: 10,
      message: 'Preparing upscaler…',
    });

    const loadPipe = (device: 'webgpu' | 'wasm', dtype: 'fp16' | 'fp32') =>
      pipeline('image-to-image', modelId, {
        device,
        dtype,
        session_options: {
          enableMemPattern: false,
          enableCpuMemArena: false,
          graphOptimizationLevel: 'disabled',
        },
        progress_callback: (info: { status?: string; progress?: number }) => {
          if (info.status === 'progress' && typeof info.progress === 'number') {
            onProgress?.({
              stage: 'downloading',
              progress: Math.min(45, Math.round(info.progress * 0.45)),
              message: `Upscaling image (${scale}×)…`,
            });
          }
        },
      });

    try {
      return await loadPipe(useWebGpu ? 'webgpu' : 'wasm', useWebGpu && hw.f16 ? 'fp16' : 'fp32');
    } catch {
      return await loadPipe('wasm', 'fp32');
    }
  })();

  upscalerCache.set(key, loader);
  return loader;
}

async function buildEngine(
  forceWasm: boolean,
  quality: QualityMode,
  onProgress?: (p: ProgressPayload) => void
): Promise<EngineInstance> {
  const detected = await detectHardware();
  const useWebGpu = !forceWasm && detected.device === 'webgpu';

  let modelId: string;
  let dtype: 'fp16' | 'fp32' | 'q8';

  if (quality === 'fast') {
    modelId = RMBG_MODEL_ID;
    dtype = useWebGpu ? (detected.f16 ? 'fp16' : 'fp32') : 'q8';
  } else {
    modelId = useWebGpu && detected.f16 ? WEBGPU_1024_MODEL_ID : ULTRA_1024_MODEL_ID;
    dtype = useWebGpu && detected.f16 ? 'fp16' : 'fp32';
  }

  const device = useWebGpu ? 'webgpu' : 'wasm';
  const modeTag = quality === 'ultra' ? '1024px Ultra' : 'RMBG-1.4 Fast';

  const hw: HardwareCapabilities =
    device === 'webgpu'
      ? {
          ...detected,
          label: `WebGPU · ${modeTag}`,
        }
      : {
          device: 'wasm',
          f16: false,
          simd: detected.simd,
          label: `${detected.simd ? 'WASM SIMD' : 'WASM CPU'} · ${modeTag}`,
        };

  onProgress?.({
    stage: 'init',
    progress: 10,
    message: 'Preparing studio…',
  });

  const processor = await AutoProcessor.from_pretrained(modelId);
  const model = await AutoModel.from_pretrained(modelId, {
    device,
    dtype,
    progress_callback: (info: { status?: string; progress?: number }) => {
      if (info.status === 'progress' && typeof info.progress === 'number') {
        onProgress?.({
          stage: 'downloading',
          progress: Math.min(85, Math.round(info.progress)),
          message: 'Removing background…',
        });
      }
    },
  });

  onProgress?.({
    stage: 'ready',
    progress: 100,
    message: 'Ready',
  });

  return { model, processor, hw, modelId };
}

async function getEngine(
  forceWasm: boolean,
  quality: QualityMode,
  onProgress?: (p: ProgressPayload) => void
): Promise<EngineInstance> {
  const key = `${forceWasm ? 'wasm' : 'auto'}-${quality}`;
  const existing = engineCache.get(key);
  if (existing) return existing;

  const p = buildEngine(forceWasm, quality, onProgress).catch(() => {
    const fallback = buildEngine(true, quality, onProgress);
    engineCache.set(key, fallback);
    return fallback;
  });
  engineCache.set(key, p);
  return p;
}

async function runInferenceWithFallback(
  image: RawImage,
  quality: QualityMode,
  onProgress?: (p: ProgressPayload) => void
) {
  let engine = await getEngine(false, quality, onProgress);

  const invokeModel = async (eng: EngineInstance) => {
    const { pixel_values } = await eng.processor(image);
    if (eng.modelId === RMBG_MODEL_ID) {
      return eng.model({ input: pixel_values });
    }
    return eng.model({ input_image: pixel_values });
  };

  try {
    onProgress?.({
      stage: 'inferring',
      progress: 60,
      message: 'Removing background…',
    });
    const outputs = await invokeModel(engine);
    return { outputs, hw: engine.hw };
  } catch (err) {
    if (engine.hw.device === 'webgpu') {
      onProgress?.({
        stage: 'init',
        progress: 35,
        message: 'Removing background…',
      });
      engine = await getEngine(true, quality, onProgress);

      onProgress?.({
        stage: 'inferring',
        progress: 65,
        message: 'Removing background…',
      });
      const outputs = await invokeModel(engine);
      return { outputs, hw: engine.hw };
    }
    throw err;
  }
}

function extractMaskBytes(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  outputs: any
): { maskBytes: Uint8Array; maskW: number; maskH: number } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const rawTensor: any =
    outputs.output ?? outputs.output_image ?? outputs.logits ?? Object.values(outputs)[0];
  const slice = rawTensor[0];
  const rawData = slice.data as Float32Array;

  let minVal = Infinity;
  let maxVal = -Infinity;
  for (let i = 0; i < rawData.length; i++) {
    const v = rawData[i];
    if (v < minVal) minVal = v;
    if (v > maxVal) maxVal = v;
  }

  const needsSigmoid = minVal < -0.01 || maxVal > 1.01;
  const maskH = slice.dims[slice.dims.length - 2];
  const maskW = slice.dims[slice.dims.length - 1];
  const maskBytes = new Uint8Array(maskW * maskH);

  for (let i = 0; i < maskBytes.length; i++) {
    const prob = needsSigmoid ? 1 / (1 + Math.exp(-rawData[i])) : rawData[i];
    maskBytes[i] = Math.max(0, Math.min(255, Math.round(prob * 255)));
  }

  return { maskBytes, maskW, maskH };
}

const workerApi = {
  async preload(
    quality: QualityMode = 'fast',
    _subject: SubjectMode = 'portrait',
    onProgress?: (p: ProgressPayload) => void
  ): Promise<string> {
    const { hw } = await getEngine(false, quality, onProgress);
    return hw.label;
  },

  async removeBackground(
    imageUrl: string,
    quality: QualityMode = 'fast',
    subject: SubjectMode = 'portrait',
    onProgress?: (p: ProgressPayload) => void
  ): Promise<CutoutResult> {
    const start = performance.now();
    const image = await RawImage.fromURL(imageUrl);

    const { outputs, hw } = await runInferenceWithFallback(image, quality, onProgress);

    onProgress?.({
      stage: 'compositing',
      progress: 82,
      message: 'Refining edges…',
    });

    const full = extractMaskBytes(outputs);
    const maskImage = await new RawImage(full.maskBytes, full.maskW, full.maskH, 1).resize(
      image.width,
      image.height
    );
    const finalMask = maskImage.data as unknown as Uint8Array;

    // Aspect-Aware Overlapping Multi-Crop Inference for wide/tall multi-subject scenes (e.g. 16:9 group shots):
    // Prevents side/background people from being squished into 1024x1024 or dropped by center saliency bias.
    const aspect = image.width / image.height;
    if (aspect > 1.35 || aspect < 0.74) {
      const isWide = aspect > 1.35;
      const tileSize = isWide ? image.height : image.width;
      const span = isWide ? image.width : image.height;
      const midOffset = Math.max(0, Math.round((span - tileSize) * 0.5));
      const endOffset = Math.max(0, span - tileSize);
      const offsets = Array.from(new Set([0, midOffset, endOffset]));

      const srcRgba = image.rgba().data as unknown as Uint8ClampedArray;

      for (const offset of offsets) {
        const x0 = isWide ? offset : 0;
        const y0 = isWide ? 0 : offset;
        const tw = isWide ? tileSize : image.width;
        const th = isWide ? image.height : tileSize;

        const tileData = new Uint8ClampedArray(tw * th * 4);
        for (let ty = 0; ty < th; ty++) {
          const srcStart = ((y0 + ty) * image.width + x0) * 4;
          const dstStart = ty * tw * 4;
          tileData.set(srcRgba.subarray(srcStart, srcStart + tw * 4), dstStart);
        }

        const tileImg = new RawImage(new Uint8Array(tileData.buffer), tw, th, 4).rgb();
        const { outputs: tileOut } = await runInferenceWithFallback(tileImg, quality);
        const tileExtracted = extractMaskBytes(tileOut);
        const tileResized = await new RawImage(
          tileExtracted.maskBytes,
          tileExtracted.maskW,
          tileExtracted.maskH,
          1
        ).resize(tw, th);
        const tileMask = tileResized.data as unknown as Uint8Array;

        // Smoothly merge confident subject detections from the un-squished crop into finalMask
        for (let ty = 0; ty < th; ty++) {
          const dstRow = (y0 + ty) * image.width + x0;
          const srcRow = ty * tw;
          // Feather tile borders by 24px to avoid any hard seam
          const wy = Math.min(1, ty / 24, (th - 1 - ty) / 24);
          for (let tx = 0; tx < tw; tx++) {
            const wx = Math.min(1, tx / 24, (tw - 1 - tx) / 24);
            const w = Math.min(wx, wy);
            const tVal = tileMask[srcRow + tx];
            const fIdx = dstRow + tx;
            const fVal = finalMask[fIdx];

            if (tVal > fVal && tVal >= 135) {
              finalMask[fIdx] = Math.round(fVal * (1 - w) + tVal * w);
            } else if (tVal < 25 && fVal < 110) {
              // Suppress faint background mist in wide shots when local crop is confident it's background
              finalMask[fIdx] = Math.round(fVal * (1 - 0.5 * w) + tVal * (0.5 * w));
            }
          }
        }
      }
    }

    let effectiveMask = finalMask;
    let vitmatteUsed = false;
    if (quality === 'ultra' && subject === 'portrait') {
      try {
        effectiveMask = await refinePortraitWithVitMatte(image, finalMask, onProgress);
        vitmatteUsed = true;
      } catch (err) {
        console.warn('ViTMatte hair refinement skipped, falling back to Guided Filter:', err);
      }
    }

    onProgress?.({
      stage: 'compositing',
      progress: 93,
      message: 'Refining edges…',
    });

    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');

    const rgbaImage = image.rgba();
    const matting = await runStudioMatting(
      rgbaImage.data as unknown as Uint8ClampedArray,
      effectiveMask,
      image.width,
      image.height,
      subject
    );

    let cutoutBlob: Blob;
    if (matting.pngBytes) {
      cutoutBlob = new Blob([new Uint8Array(matting.pngBytes)], { type: 'image/png' });
    } else {
      const outData = new ImageData(
        new Uint8ClampedArray(matting.rgba),
        image.width,
        image.height
      );
      ctx.putImageData(outData, 0, 0);
      cutoutBlob = await canvas.convertToBlob({ type: 'image/png' });
    }

    const latencyMs = Math.round(performance.now() - start);
    const engineSuffix = `${vitmatteUsed ? ' + ViTMatte' : ''}${
      matting.usedRustWasm ? ' + Rust WASM' : ''
    }`;

    onProgress?.({
      stage: 'ready',
      progress: 100,
      message: 'Done',
    });

    return {
      cutoutBlob,
      width: image.width,
      height: image.height,
      latencyMs,
      backendLabel: `${hw.label}${engineSuffix}`,
    };
  },

  async upscaleImage(
    imageUrl: string,
    scale: UpscaleScale = 2,
    onProgress?: (p: ProgressPayload) => void
  ): Promise<CutoutResult> {
    const start = performance.now();
    const image = await RawImage.fromURL(imageUrl);
    const upscaler = await getUpscaler(scale, onProgress);

    const outW = image.width * scale;
    const outH = image.height * scale;

    // Check if input image has any transparency so we can preserve alpha channel cleanly
    const rgba = image.rgba();
    let hasTransparency = false;
    for (let i = 3; i < rgba.data.length; i += 4) {
      if (rgba.data[i] < 250) {
        hasTransparency = true;
        break;
      }
    }

    const TILE = 128;
    const OVERLAP = 8;
    const STEP = TILE - OVERLAP * 2;

    const cols = Math.max(1, Math.ceil((image.width - OVERLAP * 2) / STEP));
    const rows = Math.max(1, Math.ceil((image.height - OVERLAP * 2) / STEP));
    const totalTiles = cols * rows;

    const accumR = new Float32Array(outW * outH);
    const accumG = new Float32Array(outW * outH);
    const accumB = new Float32Array(outW * outH);
    const accumW = new Float32Array(outW * outH);

    // Source RGB canvas for clean tile cropping
    const srcCanvas = new OffscreenCanvas(image.width, image.height);
    const srcCtx = srcCanvas.getContext('2d');
    if (!srcCtx) throw new Error('OffscreenCanvas 2D context unavailable');
    const srcImgData = new ImageData(
      new Uint8ClampedArray(rgba.data as unknown as Uint8ClampedArray),
      image.width,
      image.height
    );
    srcCtx.putImageData(srcImgData, 0, 0);

    let doneTiles = 0;
    for (let ry = 0; ry < rows; ry++) {
      const y0 = Math.min(ry * STEP, Math.max(0, image.height - TILE));
      const th = Math.min(TILE, image.height - y0);

      for (let rx = 0; rx < cols; rx++) {
        const x0 = Math.min(rx * STEP, Math.max(0, image.width - TILE));
        const tw = Math.min(TILE, image.width - x0);

        const tileData = srcCtx.getImageData(x0, y0, tw, th);
        const tileRaw = new RawImage(
          new Uint8ClampedArray(tileData.data),
          tw,
          th,
          4
        ).rgb();

        let srRgb: RawImage;
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const srResult: any = await upscaler(tileRaw);
          const srImg: RawImage = Array.isArray(srResult) ? srResult[0] : srResult;
          srRgb = srImg.rgb();
        } catch {
          // Safe high-quality bicubic + micro-sharpen fallback if ONNX node fails on device
          const fbCanvas = new OffscreenCanvas(tw * scale, th * scale);
          const fbCtx = fbCanvas.getContext('2d')!;
          fbCtx.imageSmoothingEnabled = true;
          fbCtx.imageSmoothingQuality = 'high';
          const tmp = new OffscreenCanvas(tw, th);
          tmp.getContext('2d')!.putImageData(tileData, 0, 0);
          fbCtx.drawImage(tmp, 0, 0, tw * scale, th * scale);
          const fbData = fbCtx.getImageData(0, 0, tw * scale, th * scale);
          srRgb = new RawImage(
            new Uint8ClampedArray(fbData.data),
            tw * scale,
            th * scale,
            4
          ).rgb();
        }
        const srW = srRgb.width;
        const srH = srRgb.height;

        const outX0 = x0 * scale;
        const outY0 = y0 * scale;
        const pad = OVERLAP * scale;

        for (let ty = 0; ty < srH; ty++) {
          const gy = outY0 + ty;
          if (gy >= outH) continue;
          const wy =
            ry > 0 && ty < pad
              ? (ty + 1) / (pad + 1)
              : ry < rows - 1 && ty >= srH - pad
              ? (srH - ty) / (pad + 1)
              : 1;

          for (let tx = 0; tx < srW; tx++) {
            const gx = outX0 + tx;
            if (gx >= outW) continue;
            const wx =
              rx > 0 && tx < pad
                ? (tx + 1) / (pad + 1)
                : rx < cols - 1 && tx >= srW - pad
                ? (srW - tx) / (pad + 1)
                : 1;

            const w = wx * wy;
            const sIdx = (ty * srW + tx) * 3;
            const dIdx = gy * outW + gx;
            accumR[dIdx] += srRgb.data[sIdx] * w;
            accumG[dIdx] += srRgb.data[sIdx + 1] * w;
            accumB[dIdx] += srRgb.data[sIdx + 2] * w;
            accumW[dIdx] += w;
          }
        }

        doneTiles++;
        const pct = 45 + Math.round((doneTiles / totalTiles) * 48);
        onProgress?.({
          stage: 'inferring',
          progress: pct,
          message: `Upscaling image (${scale}×)…`,
        });
      }
    }

    onProgress?.({
      stage: 'compositing',
      progress: 95,
      message: 'Finalizing crisp details…',
    });

    // Upscale alpha channel smoothly if original image had transparency
    let upscaledAlpha: Uint8ClampedArray | null = null;
    if (hasTransparency) {
      const aCanvas = new OffscreenCanvas(outW, outH);
      const aCtx = aCanvas.getContext('2d');
      if (aCtx) {
        aCtx.imageSmoothingEnabled = true;
        aCtx.imageSmoothingQuality = 'high';
        aCtx.drawImage(srcCanvas, 0, 0, outW, outH);
        upscaledAlpha = aCtx.getImageData(0, 0, outW, outH).data;
      }
    }

    const outCanvas = new OffscreenCanvas(outW, outH);
    const outCtx = outCanvas.getContext('2d');
    if (!outCtx) throw new Error('OffscreenCanvas 2D context unavailable');
    const outImgData = new ImageData(outW, outH);
    const dst = outImgData.data;

    for (let i = 0; i < outW * outH; i++) {
      const w = accumW[i] || 1;
      const p4 = i * 4;
      dst[p4] = Math.max(0, Math.min(255, Math.round(accumR[i] / w)));
      dst[p4 + 1] = Math.max(0, Math.min(255, Math.round(accumG[i] / w)));
      dst[p4 + 2] = Math.max(0, Math.min(255, Math.round(accumB[i] / w)));
      dst[p4 + 3] = upscaledAlpha ? upscaledAlpha[p4 + 3] : 255;
    }

    outCtx.putImageData(outImgData, 0, 0);
    const cutoutBlob = await outCanvas.convertToBlob({ type: 'image/png' });
    const latencyMs = Math.round(performance.now() - start);

    onProgress?.({
      stage: 'ready',
      progress: 100,
      message: 'Done',
    });

    return {
      cutoutBlob,
      width: outW,
      height: outH,
      latencyMs,
      backendLabel: `AI Upscale ${scale}×`,
    };
  },
};

export type PipelineWorkerApi = typeof workerApi;

Comlink.expose(workerApi);

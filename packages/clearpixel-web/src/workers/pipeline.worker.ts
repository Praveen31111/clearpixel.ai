import * as Comlink from 'comlink';
import {
  AutoModel,
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

    const loadPipe = (device: 'webgpu' | 'wasm', dtype: 'fp16' | 'fp32' | 'q8') =>
      pipeline('image-to-image', modelId, {
        device,
        dtype,
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
      return await loadPipe(useWebGpu ? 'webgpu' : 'wasm', useWebGpu && hw.f16 ? 'fp16' : useWebGpu ? 'fp32' : 'q8');
    } catch {
      return await loadPipe('wasm', 'q8');
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
      progress: 90,
      message: 'Refining edges…',
    });

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

    const maskImage = await new RawImage(maskBytes, maskW, maskH, 1).resize(
      image.width,
      image.height
    );

    const canvas = new OffscreenCanvas(image.width, image.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('OffscreenCanvas 2D context unavailable');

    const rgbaImage = image.rgba();
    const matting = await runStudioMatting(
      rgbaImage.data as unknown as Uint8ClampedArray,
      maskImage.data as unknown as Uint8Array,
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
    const engineSuffix = matting.usedRustWasm ? ' + Rust WASM' : '';

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

    const TILE = 256;
    const OVERLAP = 16;
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

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const srResult: any = await upscaler(tileRaw);
        const srImg: RawImage = Array.isArray(srResult) ? srResult[0] : srResult;
        const srRgb = srImg.rgb();
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

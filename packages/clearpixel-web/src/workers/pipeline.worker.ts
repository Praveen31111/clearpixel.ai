import * as Comlink from 'comlink';
import {
  AutoModel,
  AutoProcessor,
  RawImage,
  env,
} from '@huggingface/transformers';
import { detectHardware, HardwareCapabilities } from '../lib/hardware-detect';
import { runStudioMatting } from '../lib/wasm-bridge';
import type { SubjectMode } from '../lib/edge-refiner';

// Configure browser-only caching and self-hosted fallback
// (Leave wasmPaths unset so transformers.js automatically loads ort-wasm from onnxruntime-web jsDelivr CDN)
env.allowLocalModels = true;
env.localModelPath = '/models/';
env.useBrowserCache = true;

// Primary Fast Engine: BRIA RMBG-1.4 (CC BY-NC 4.0 for open-source/non-commercial;
// WebGPU-native IS-Net CNN, ~44MB q8, zero 17-buffer shader limits, great for both Portraits & Products)
const RMBG_MODEL_ID = 'briaai/RMBG-1.4';
// Secondary Ultra HD Engine: MIT-licensed BiRefNet-Lite 1024px
const WEBGPU_1024_MODEL_ID = 'jiabins0303/birefnet-lite-1024-webgpu';
const ULTRA_1024_MODEL_ID = 'onnx-community/BiRefNet_lite-ONNX';

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
    progress: 5,
    message: `Initializing ${hw.label}…`,
  });

  const processor = await AutoProcessor.from_pretrained(modelId);
  const model = await AutoModel.from_pretrained(modelId, {
    device,
    dtype,
    progress_callback: (info: { status?: string; progress?: number }) => {
      if (info.status === 'progress' && typeof info.progress === 'number') {
        onProgress?.({
          stage: 'downloading',
          progress: Math.min(90, Math.round(info.progress)),
          message: `Caching AI model (${Math.round(info.progress)}%)…`,
        });
      }
    },
  });

  onProgress?.({
    stage: 'ready',
    progress: 100,
    message: 'Engine ready',
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
      message: `Removing background (${engine.hw.label})…`,
    });
    const outputs = await invokeModel(engine);
    return { outputs, hw: engine.hw };
  } catch (err) {
    if (engine.hw.device === 'webgpu') {
      onProgress?.({
        stage: 'init',
        progress: 25,
        message: 'Switching to WASM SIMD fallback…',
      });
      engine = await getEngine(true, quality, onProgress);

      onProgress?.({
        stage: 'inferring',
        progress: 65,
        message: `Removing background (${engine.hw.label})…`,
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
      progress: 88,
      message:
        subject === 'portrait'
          ? 'Refining hair strands & removing halos…'
          : 'Sharpening product edges…',
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
};

export type PipelineWorkerApi = typeof workerApi;

Comlink.expose(workerApi);

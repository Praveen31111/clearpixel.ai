import * as Comlink from 'comlink';
import type {
  CutoutResult,
  PipelineWorkerApi,
  ProgressPayload,
  QualityMode,
} from '@/workers/pipeline.worker';
import type { SubjectMode } from '@/lib/edge-refiner';
import type { UpscaleScale } from '@/types/studio';

let workerInstance: Worker | null = null;
let workerProxy: Comlink.Remote<PipelineWorkerApi> | null = null;

function getWorker(): Comlink.Remote<PipelineWorkerApi> {
  if (workerProxy) return workerProxy;

  workerInstance = new Worker(
    new URL('../workers/pipeline.worker.ts', import.meta.url),
    { type: 'module' }
  );
  workerProxy = Comlink.wrap<PipelineWorkerApi>(workerInstance);
  return workerProxy;
}

/**
 * Silently warms up and caches the WebGPU-ready model in the background.
 */
export async function preloadAiEngine(
  quality: QualityMode = 'fast',
  subject: SubjectMode = 'portrait',
  onProgress?: (p: ProgressPayload) => void
): Promise<string> {
  if (typeof window === 'undefined') return 'SSR';
  const api = getWorker();
  return api.preload(quality, subject, onProgress ? Comlink.proxy(onProgress) : undefined);
}

/**
 * Runs 100% on-device AI background removal + edge refinement inside the Web Worker.
 */
export async function runBackgroundRemoval(
  imageUrl: string,
  quality: QualityMode = 'fast',
  subject: SubjectMode = 'portrait',
  onProgress?: (p: ProgressPayload) => void
): Promise<CutoutResult> {
  const api = getWorker();
  return api.removeBackground(
    imageUrl,
    quality,
    subject,
    onProgress ? Comlink.proxy(onProgress) : undefined
  );
}

/**
 * Runs 100% on-device Tiled AI Super-Resolution (2x / 4x) inside the Web Worker.
 */
export async function runImageUpscale(
  imageUrl: string,
  scale: UpscaleScale = 2,
  onProgress?: (p: ProgressPayload) => void
): Promise<CutoutResult> {
  const api = getWorker();
  return api.upscaleImage(
    imageUrl,
    scale,
    onProgress ? Comlink.proxy(onProgress) : undefined
  );
}

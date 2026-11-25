import { refineCutoutEdges, SubjectMode } from './edge-refiner';

interface ClearPixelWasmModule {
  default: (input?: RequestInfo | URL) => Promise<unknown>;
  core_version: () => string;
  refine_cutout: (
    rgba: Uint8Array,
    alphaMask: Uint8Array,
    width: number,
    height: number
  ) => Uint8Array;
  encode_png: (rgba: Uint8Array, width: number, height: number) => Uint8Array;
}

let wasmModulePromise: Promise<ClearPixelWasmModule | null> | null = null;

/**
 * Lazily loads the compiled Rust WASM core from /wasm/clearpixel_core.js if present.
 * Returns null gracefully if Rust WASM has not been compiled yet (falls back to TS refiner).
 */
async function loadRustCore(): Promise<ClearPixelWasmModule | null> {
  if (wasmModulePromise) return wasmModulePromise;

  wasmModulePromise = (async () => {
    try {
      const wasmJsUrl = '/wasm/clearpixel_core.js';
      const probe = await fetch(wasmJsUrl, { method: 'HEAD' });
      if (!probe.ok) return null;

      // Dynamic runtime import bypassing Webpack static bundling
      const mod = (await import(/* webpackIgnore: true */ wasmJsUrl)) as ClearPixelWasmModule;
      await mod.default('/wasm/clearpixel_core_bg.wasm');
      return mod;
    } catch {
      return null;
    }
  })();

  return wasmModulePromise;
}

export interface RefinedCutoutBuffer {
  rgba: Uint8ClampedArray;
  pngBytes?: Uint8Array;
  usedRustWasm: boolean;
}

/**
 * Runs Studio Matting (O(N) Guided Filter + Tri-Map + Color Decontamination).
 * Uses Rust WASM when compiled into /public/wasm/, otherwise falls back to TS refiner.
 */
export async function runStudioMatting(
  rgba: Uint8ClampedArray,
  alphaMask: Uint8Array,
  width: number,
  height: number,
  subject: SubjectMode = 'portrait'
): Promise<RefinedCutoutBuffer> {
  const rust = await loadRustCore();

  if (rust) {
    const refinedBytes = rust.refine_cutout(
      new Uint8Array(rgba.buffer, rgba.byteOffset, rgba.byteLength),
      alphaMask,
      width,
      height
    );
    const pngBytes = rust.encode_png(refinedBytes, width, height);
    return {
      rgba: new Uint8ClampedArray(refinedBytes),
      pngBytes,
      usedRustWasm: true,
    };
  }

  const tsRefined = refineCutoutEdges(rgba, alphaMask, width, height, subject);
  return {
    rgba: tsRefined,
    usedRustWasm: false,
  };
}

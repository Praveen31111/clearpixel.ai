export interface HardwareCapabilities {
  device: 'webgpu' | 'wasm';
  f16: boolean;
  simd: boolean;
  label: string;
}

/**
 * Probes client browser for WebGPU (with fp16 support) and WASM SIMD.
 * Automatically selects the fastest safe execution path for Desktop, Android, and iPhone Safari.
 */
export async function detectHardware(): Promise<HardwareCapabilities> {
  const simd = checkWasmSimd();

  if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const gpu = (navigator as any).gpu;
      const adapter = await gpu?.requestAdapter();
      if (adapter) {
        const f16 = adapter.features?.has('shader-f16') ?? false;
        return {
          device: 'webgpu',
          f16,
          simd,
          label: 'WebGPU Accelerated',
        };
      }
    } catch {
      // Fall through to WASM SIMD
    }
  }

  return {
    device: 'wasm',
    f16: false,
    simd,
    label: simd ? 'WASM SIMD Accelerated' : 'WASM CPU Mode',
  };
}

function checkWasmSimd(): boolean {
  try {
    // Minimal valid WASM module containing a v128.const instruction
    return WebAssembly.validate(
      new Uint8Array([
        0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0,
        253, 15, 253, 98, 11,
      ])
    );
  } catch {
    return false;
  }
}

const CACHE_NAME = 'clearpixel-models-v1';

export interface ModelManifest {
  modelId: string;
  version: string;
  totalBytes: number;
  chunks: string[]; // e.g. ['/models/birefnet-lite-fp16.part1', ...]
}

export interface CacheStatus {
  cached: boolean;
  engineLabel: string;
}

/**
 * Checks whether the AI model weights are already persisted in the browser Cache API
 * so repeat visits load in < 100ms with 0 MB downloaded.
 */
export async function getModelCacheStatus(): Promise<CacheStatus> {
  if (typeof window === 'undefined' || !('caches' in window)) {
    return { cached: false, engineLabel: 'Online Model' };
  }

  try {
    const cacheNames = await caches.keys();
    for (const name of cacheNames) {
      if (name === CACHE_NAME || name.includes('transformers-cache')) {
        const cache = await caches.open(name);
        const keys = await cache.keys();
        if (keys.some((req) => req.url.includes('.onnx') || req.url.includes('.part'))) {
          return { cached: true, engineLabel: 'Cached Locally · Instant' };
        }
      }
    }
  } catch {
    // Ignore CacheStorage permission errors in restricted private tabs
  }

  return { cached: false, engineLabel: 'First-time Preload' };
}

/**
 * Fetches a self-hosted chunked ONNX model (<20MB parts for Cloudflare Pages 25MiB limit)
 * in parallel, merges into a single ArrayBuffer, and caches it permanently in CacheStorage.
 */
export async function fetchSelfHostedChunkedModel(
  manifestUrl: string,
  onProgress?: (pct: number) => void
): Promise<ArrayBuffer | null> {
  if (typeof window === 'undefined' || !('caches' in window)) return null;

  try {
    const manifestRes = await fetch(manifestUrl);
    if (!manifestRes.ok) return null;

    const manifest = (await manifestRes.json()) as ModelManifest;
    const cache = await caches.open(CACHE_NAME);
    const cacheKey = `/models/${manifest.modelId}-${manifest.version}.onnx`;

    // 1. Return immediately if already cached
    const cached = await cache.match(cacheKey);
    if (cached) {
      onProgress?.(100);
      return cached.arrayBuffer();
    }

    // 2. Parallel download all <20MB chunks
    let loadedBytes = 0;
    const chunkBuffers = await Promise.all(
      manifest.chunks.map(async (chunkUrl) => {
        const res = await fetch(chunkUrl);
        if (!res.ok) throw new Error(`Failed to fetch chunk: ${chunkUrl}`);
        const buf = await res.arrayBuffer();
        loadedBytes += buf.byteLength;
        if (manifest.totalBytes > 0) {
          onProgress?.(Math.min(99, Math.round((loadedBytes / manifest.totalBytes) * 100)));
        }
        return new Uint8Array(buf);
      })
    );

    // 3. Assemble into single contiguous ArrayBuffer
    const totalLength = chunkBuffers.reduce((sum, c) => sum + c.byteLength, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of chunkBuffers) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }

    // 4. Persist assembled model in Cache API for lifetime 0 MB re-loads
    await cache.put(
      cacheKey,
      new Response(merged.buffer, {
        headers: { 'Content-Type': 'application/octet-stream' },
      })
    );

    onProgress?.(100);
    return merged.buffer;
  } catch {
    return null;
  }
}

/**
 * Clears cached AI models if user wants to free browser storage.
 */
export async function clearModelCache(): Promise<void> {
  if (typeof window === 'undefined' || !('caches' in window)) return;
  const names = await caches.keys();
  await Promise.all(
    names
      .filter((n) => n === CACHE_NAME || n.includes('transformers-cache'))
      .map((n) => caches.delete(n))
  );
}

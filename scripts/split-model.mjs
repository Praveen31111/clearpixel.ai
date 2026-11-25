#!/usr/bin/env node
/**
 * Splits any large .onnx model into <20MB chunks inside packages/clearpixel-web/public/models/
 * so it deploys cleanly on Cloudflare Pages (25 MiB single-file limit) & GitHub.
 *
 * Usage:
 *   node scripts/split-model.mjs path/to/birefnet-lite.onnx birefnet-lite-fp16
 */

import fs from 'node:fs';
import path from 'node:path';

const CHUNK_SIZE = 18 * 1024 * 1024; // 18 MiB (safely under Cloudflare's 25 MiB cap)

const [, , inputPath, modelId = 'birefnet-lite'] = process.argv;

if (!inputPath || !fs.existsSync(inputPath)) {
  console.error('Usage: node scripts/split-model.mjs <path-to-model.onnx> [model-id]');
  process.exit(1);
}

const outDir = path.resolve('packages/clearpixel-web/public/models', modelId);
fs.mkdirSync(outDir, { recursive: true });

const data = fs.readFileSync(inputPath);
const totalBytes = data.byteLength;
const chunks = [];

for (let offset = 0, idx = 1; offset < totalBytes; offset += CHUNK_SIZE, idx++) {
  const end = Math.min(offset + CHUNK_SIZE, totalBytes);
  const chunkName = `model.part${idx}`;
  fs.writeFileSync(path.join(outDir, chunkName), data.subarray(offset, end));
  chunks.push(`/models/${modelId}/${chunkName}`);
}

const manifest = {
  modelId,
  version: '1.0.0',
  totalBytes,
  chunks,
};

fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`Split ${(totalBytes / 1024 / 1024).toFixed(2)} MB into ${chunks.length} chunks at ${outDir}`);

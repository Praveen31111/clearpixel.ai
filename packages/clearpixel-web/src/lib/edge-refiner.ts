/**
 * High-Speed Boundary-Block Studio Edge Refiner & Color Decontamination.
 *
 * Supports two tuned modes:
 * - 'portrait': Preserves faint hair tips & wispy edges even on dark/black backgrounds (cutoff <= 3).
 * - 'product': Steep S-curve contrast for razor-sharp e-commerce product cutouts (bottles, shoes, boxes).
 */

export type SubjectMode = 'portrait' | 'product';

const BLOCK_SIZE = 64;
const LUT_SIZE = 3072;
const EXP_LUT = new Float32Array(LUT_SIZE);
for (let i = 0; i < LUT_SIZE; i++) {
  EXP_LUT[i] = Math.exp(-(i * 64) / 1600);
}

export function refineCutoutEdges(
  rgba: Uint8ClampedArray,
  alphaMask: Uint8Array,
  width: number,
  height: number,
  subject: SubjectMode = 'portrait'
): Uint8ClampedArray {
  const totalPixels = width * height;
  const out = new Uint8ClampedArray(totalPixels * 4);
  const refinedAlpha = new Uint8Array(totalPixels);

  // Portrait mode preserves faint hair strands (low=3); Product mode enforces sharp edges (low=22)
  const lowCut = subject === 'portrait' ? 3 : 22;
  const highCut = subject === 'portrait' ? 245 : 230;
  const span = highCut - lowCut;

  // Pass 1: Mode-specific alpha contrast & hair-tip preservation
  for (let i = 0; i < totalPixels; i++) {
    const a = alphaMask[i];
    if (a <= lowCut) {
      refinedAlpha[i] = 0;
    } else if (a >= highCut) {
      refinedAlpha[i] = 255;
    } else {
      const t = (a - lowCut) / span;
      if (subject === 'portrait') {
        // Gentle gamma lift (pow 0.85) so dark hair tips on black backgrounds aren't crushed
        refinedAlpha[i] = Math.round(Math.pow(t, 0.85) * 255);
      } else {
        // Crisp S-curve for hard product edges
        refinedAlpha[i] = Math.round(t * t * (3 - 2 * t) * 255);
      }
    }
  }

  // Pass 2: Boundary-Selective 64x64 Block Processing
  for (let by = 0; by < height; by += BLOCK_SIZE) {
    const bh = Math.min(BLOCK_SIZE, height - by);
    for (let bx = 0; bx < width; bx += BLOCK_SIZE) {
      const bw = Math.min(BLOCK_SIZE, width - bx);

      let hasFg = false;
      let hasBg = false;
      let isEdge = false;

      for (let ty = 0; ty < bh && !isEdge; ty++) {
        const row = (by + ty) * width + bx;
        for (let tx = 0; tx < bw; tx++) {
          const a = refinedAlpha[row + tx];
          if (a === 0) hasBg = true;
          else if (a === 255) hasFg = true;
          else {
            isEdge = true;
            break;
          }
          if (hasFg && hasBg) {
            isEdge = true;
            break;
          }
        }
      }

      if (!isEdge && !hasFg) {
        continue;
      }

      if (!isEdge && hasFg) {
        for (let ty = 0; ty < bh; ty++) {
          const rowStart = ((by + ty) * width + bx) * 4;
          for (let tx = 0; tx < bw; tx++) {
            const p4 = rowStart + tx * 4;
            out[p4] = rgba[p4];
            out[p4 + 1] = rgba[p4 + 1];
            out[p4 + 2] = rgba[p4 + 2];
            out[p4 + 3] = 255;
          }
        }
        continue;
      }

      // Boundary edge block: RGB-guided snapping + Halo Color Decontamination
      for (let ty = 0; ty < bh; ty++) {
        const y = by + ty;
        const rowOffset = y * width;
        const yMin = y > 0 ? y - 1 : 0;
        const yMax = y < height - 1 ? y + 1 : height - 1;

        for (let tx = 0; tx < bw; tx++) {
          const x = bx + tx;
          const idx = rowOffset + x;
          const p4 = idx * 4;
          const a = refinedAlpha[idx];

          if (a === 0) continue;

          if (a === 255) {
            out[p4] = rgba[p4];
            out[p4 + 1] = rgba[p4 + 1];
            out[p4 + 2] = rgba[p4 + 2];
            out[p4 + 3] = 255;
            continue;
          }

          const r0 = rgba[p4];
          const g0 = rgba[p4 + 1];
          const b0 = rgba[p4 + 2];

          let fgR = 0;
          let fgG = 0;
          let fgB = 0;
          let fgWeightSum = 0;
          let alphaSum = 0;
          let alphaWeightSum = 0;

          const xMin = x > 0 ? x - 1 : 0;
          const xMax = x < width - 1 ? x + 1 : width - 1;

          for (let ny = yMin; ny <= yMax; ny++) {
            const nRow = ny * width;
            for (let nx = xMin; nx <= xMax; nx++) {
              const nIdx = nRow + nx;
              const np4 = nIdx * 4;
              const na = refinedAlpha[nIdx];

              const dr = rgba[np4] - r0;
              const dg = rgba[np4 + 1] - g0;
              const db = rgba[np4 + 2] - b0;
              const lutIdx = (dr * dr + dg * dg + db * db) >> 6;
              const w = lutIdx < LUT_SIZE ? EXP_LUT[lutIdx] : 0;

              alphaSum += na * w;
              alphaWeightSum += w;

              if (na >= 210) {
                const fgW = w * (na * 0.0039215686);
                fgR += rgba[np4] * fgW;
                fgG += rgba[np4 + 1] * fgW;
                fgB += rgba[np4 + 2] * fgW;
                fgWeightSum += fgW;
              }
            }
          }

          const finalAlpha = alphaWeightSum > 0 ? Math.round(alphaSum / alphaWeightSum) : a;

          if (fgWeightSum > 0.01 && finalAlpha < 235) {
            const cleanR = fgR / fgWeightSum;
            const cleanG = fgG / fgWeightSum;
            const cleanB = fgB / fgWeightSum;
            const blend = Math.min(0.82, (255 - finalAlpha) * 0.0039215686);
            out[p4] = Math.round(r0 * (1 - blend) + cleanR * blend);
            out[p4 + 1] = Math.round(g0 * (1 - blend) + cleanG * blend);
            out[p4 + 2] = Math.round(b0 * (1 - blend) + cleanB * blend);
          } else {
            out[p4] = r0;
            out[p4 + 1] = g0;
            out[p4 + 2] = b0;
          }

          out[p4 + 3] = finalAlpha;
        }
      }
    }
  }

  return out;
}

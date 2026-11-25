/**
 * High-Speed Boundary-Block Studio Edge Refiner & Closed-Form Alpha Unmixing.
 *
 * Phase A Upgrades:
 * 1. Auto Background Color Estimator: Samples pure background pixels (alpha <= 8) to detect
 *    White (#FFF), Black (#000), or Colored studio backgrounds.
 * 2. Closed-Form Alpha Unmixing:
 *      F_clean = clamp((C - (1 - a) * B_est) / max(a, 0.12), 0, 255)
 *    Mathematically strips white light wrap and black fringes from hair strands.
 * 3. Dark-BG Hair Fringe Cleanup + 64x64 Boundary-Selective Block Processing.
 */

export type SubjectMode = 'portrait' | 'product';

const BLOCK_SIZE = 64;
const LUT_SIZE = 3072;
const EXP_LUT = new Float32Array(LUT_SIZE);
for (let i = 0; i < LUT_SIZE; i++) {
  EXP_LUT[i] = Math.exp(-(i * 64) / 1600);
}

function estimateBackgroundColor(
  rgba: Uint8ClampedArray,
  alphaMask: Uint8Array,
  totalPixels: number
): { r: number; g: number; b: number; luma: number } {
  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;
  const stride = Math.max(1, Math.floor(totalPixels / 15000));

  for (let i = 0; i < totalPixels; i += stride) {
    if (alphaMask[i] <= 8) {
      const p4 = i * 4;
      sumR += rgba[p4];
      sumG += rgba[p4 + 1];
      sumB += rgba[p4 + 2];
      count++;
    }
  }

  if (count === 0) {
    return { r: 128, g: 128, b: 128, luma: 128 };
  }

  const r = sumR / count;
  const g = sumG / count;
  const b = sumB / count;
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return { r, g, b, luma };
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

  // Stage 1: Estimate dominant background color (White / Black / Colored)
  const bg = estimateBackgroundColor(rgba, alphaMask, totalPixels);
  const isDarkBg = bg.luma < 45;
  const isWhiteBg = bg.luma > 210;

  const lowCut = subject === 'portrait' ? 4 : 22;
  const highCut = subject === 'portrait' ? 245 : 230;
  const span = highCut - lowCut;

  // Pass 1: Mode-specific alpha contrast & dark-background fringe suppression
  for (let i = 0; i < totalPixels; i++) {
    const a = alphaMask[i];
    if (a <= lowCut) {
      refinedAlpha[i] = 0;
    } else if (a >= highCut) {
      refinedAlpha[i] = 255;
    } else {
      const t = (a - lowCut) / span;
      if (subject === 'portrait') {
        let lifted = Math.pow(t, 0.85) * 255;
        // On pure black/dark backgrounds, suppress muddy empty border pixels matching bg luminance
        if (isDarkBg && a < 42) {
          const p4 = i * 4;
          const pxLuma = 0.2126 * rgba[p4] + 0.7152 * rgba[p4 + 1] + 0.0722 * rgba[p4 + 2];
          if (Math.abs(pxLuma - bg.luma) < 16) {
            lifted *= 0.35;
          }
        }
        refinedAlpha[i] = Math.round(lifted);
      } else {
        refinedAlpha[i] = Math.round(t * t * (3 - 2 * t) * 255);
      }
    }
  }

  // Pass 2: Boundary-Selective 64x64 Block Processing + Closed-Form Alpha Unmixing
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

      if (!isEdge && !hasFg) continue;

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

          let finalAlpha = alphaWeightSum > 0 ? Math.round(alphaSum / alphaWeightSum) : a;
          // On pure white backgrounds, slightly tighten very faint outer glow
          if (isWhiteBg && finalAlpha < 24) {
            finalAlpha = Math.max(0, finalAlpha - 6);
          }

          if (finalAlpha === 0) continue;

          // Closed-Form Alpha Unmixing: F = (C - (1 - a) * B_est) / max(a, 0.12)
          const alphaNorm = finalAlpha / 255;
          const denom = Math.max(alphaNorm, 0.12);
          const unmixR = Math.max(0, Math.min(255, (r0 - (1 - alphaNorm) * bg.r) / denom));
          const unmixG = Math.max(0, Math.min(255, (g0 - (1 - alphaNorm) * bg.g) / denom));
          const unmixB = Math.max(0, Math.min(255, (b0 - (1 - alphaNorm) * bg.b) / denom));

          if (fgWeightSum > 0.01 && finalAlpha < 235) {
            const cleanR = fgR / fgWeightSum;
            const cleanG = fgG / fgWeightSum;
            const cleanB = fgB / fgWeightSum;
            // Combine Closed-Form Unmixing (65%) + Nearby Foreground Pigment (35%)
            const targetR = unmixR * 0.65 + cleanR * 0.35;
            const targetG = unmixG * 0.65 + cleanG * 0.35;
            const targetB = unmixB * 0.65 + cleanB * 0.35;
            const blend = Math.min(0.88, (255 - finalAlpha) * 0.0039215686);

            out[p4] = Math.round(r0 * (1 - blend) + targetR * blend);
            out[p4 + 1] = Math.round(g0 * (1 - blend) + targetG * blend);
            out[p4 + 2] = Math.round(b0 * (1 - blend) + targetB * blend);
          } else {
            out[p4] = Math.round(unmixR);
            out[p4 + 1] = Math.round(unmixG);
            out[p4 + 2] = Math.round(unmixB);
          }

          out[p4 + 3] = finalAlpha;
        }
      }
    }
  }

  return out;
}

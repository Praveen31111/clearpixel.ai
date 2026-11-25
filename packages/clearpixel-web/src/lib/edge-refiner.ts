/**
 * High-Speed Boundary-Block Studio Edge Refiner:
 * 1. O(N) Fast Guided Filter (per padded 64x64 boundary block, zero GC pressure):
 *    Snaps coarse AI masks onto full-resolution RGB/Luma hair strands & eyelashes.
 * 2. Local Spatial Background Field B(x,y):
 *    Estimates background color & light locally per 64x64 block (+16px pad)
 *    instead of a single global average, eliminating shadow/sunlight halos.
 * 3. Closed-Form Alpha Unmixing + 5x5 Foreground Propagation + Light-Wrap Guard:
 *    Mathematically strips white/black/colored fringes from semi-transparent hair.
 */

export type SubjectMode = 'portrait' | 'product';

const BLOCK_SIZE = 64;
const GF_PAD = 8;
const MAX_GF_DIM = BLOCK_SIZE + GF_PAD * 2; // 80
const MAX_GF_PIXELS = MAX_GF_DIM * MAX_GF_DIM; // 6400
const LUT_SIZE = 3072;

const EXP_LUT = new Float32Array(LUT_SIZE);
for (let i = 0; i < LUT_SIZE; i++) {
  EXP_LUT[i] = Math.exp(-(i * 64) / 1600);
}

// Reusable scratch buffers for zero-allocation block Fast Guided Filter
const gfGuide = new Float32Array(MAX_GF_PIXELS);
const gfAlpha = new Float32Array(MAX_GF_PIXELS);
const gfGuideSq = new Float32Array(MAX_GF_PIXELS);
const gfGuideAlpha = new Float32Array(MAX_GF_PIXELS);
const gfMeanI = new Float32Array(MAX_GF_PIXELS);
const gfMeanP = new Float32Array(MAX_GF_PIXELS);
const gfMeanII = new Float32Array(MAX_GF_PIXELS);
const gfMeanIP = new Float32Array(MAX_GF_PIXELS);
const gfAk = new Float32Array(MAX_GF_PIXELS);
const gfBk = new Float32Array(MAX_GF_PIXELS);
const gfMeanA = new Float32Array(MAX_GF_PIXELS);
const gfMeanB = new Float32Array(MAX_GF_PIXELS);
const gfIntegral = new Float64Array((MAX_GF_DIM + 1) * (MAX_GF_DIM + 1));

function boxMeanInPlace(
  src: Float32Array,
  dst: Float32Array,
  w: number,
  h: number,
  radius: number
): void {
  const stride = w + 1;
  gfIntegral.fill(0, 0, stride);

  for (let y = 0; y < h; y++) {
    let rowSum = 0;
    const rowOff = y * w;
    const intPrev = y * stride;
    const intCurr = (y + 1) * stride;
    gfIntegral[intCurr] = 0;
    for (let x = 0; x < w; x++) {
      rowSum += src[rowOff + x];
      gfIntegral[intCurr + x + 1] = gfIntegral[intPrev + x + 1] + rowSum;
    }
  }

  for (let y = 0; y < h; y++) {
    const y0 = y > radius ? y - radius : 0;
    const y1 = y + radius < h ? y + radius : h - 1;
    const rowOff = y * w;
    const intY0 = y0 * stride;
    const intY1 = (y1 + 1) * stride;

    for (let x = 0; x < w; x++) {
      const x0 = x > radius ? x - radius : 0;
      const x1 = x + radius < w ? x + radius : w - 1;
      const area = (x1 - x0 + 1) * (y1 - y0 + 1);
      const sum =
        gfIntegral[intY1 + x1 + 1] -
        gfIntegral[intY0 + x1 + 1] -
        gfIntegral[intY1 + x0] +
        gfIntegral[intY0 + x0];
      dst[rowOff + x] = sum / area;
    }
  }
}

function estimateGlobalBackground(
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
  return { r, g, b, luma: 0.2126 * r + 0.7152 * g + 0.0722 * b };
}

function estimateLocalBackground(
  rgba: Uint8ClampedArray,
  alphaMask: Uint8Array,
  width: number,
  height: number,
  bx: number,
  by: number,
  bw: number,
  bh: number,
  globalBg: { r: number; g: number; b: number; luma: number }
): { r: number; g: number; b: number; luma: number } {
  const pad = 16;
  const x0 = Math.max(0, bx - pad);
  const y0 = Math.max(0, by - pad);
  const x1 = Math.min(width, bx + bw + pad);
  const y1 = Math.min(height, by + bh + pad);

  let sumR = 0;
  let sumG = 0;
  let sumB = 0;
  let count = 0;

  for (let y = y0; y < y1; y += 2) {
    const row = y * width;
    for (let x = x0; x < x1; x += 2) {
      const idx = row + x;
      if (alphaMask[idx] <= 8) {
        const p4 = idx * 4;
        sumR += rgba[p4];
        sumG += rgba[p4 + 1];
        sumB += rgba[p4 + 2];
        count++;
      }
    }
  }

  if (count < 6) {
    return globalBg;
  }

  const r = sumR / count;
  const g = sumG / count;
  const b = sumB / count;
  return { r, g, b, luma: 0.2126 * r + 0.7152 * g + 0.0722 * b };
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
  const baseAlpha = new Uint8Array(totalPixels);
  const guidedAlpha = new Uint8Array(totalPixels);

  const globalBg = estimateGlobalBackground(rgba, alphaMask, totalPixels);

  const lowCut = subject === 'portrait' ? 10 : 22;
  const highCut = subject === 'portrait' ? 232 : 225;
  const span = highCut - lowCut;

  // Pass 1: Mode-specific alpha contrast shaping
  for (let i = 0; i < totalPixels; i++) {
    const a = alphaMask[i];
    if (a <= lowCut) {
      baseAlpha[i] = 0;
    } else if (a >= highCut) {
      baseAlpha[i] = 255;
    } else {
      const t = (a - lowCut) / span;
      if (subject === 'portrait') {
        baseAlpha[i] = Math.round(Math.pow(t, 0.85) * 255);
      } else {
        baseAlpha[i] = Math.round(t * t * (3 - 2 * t) * 255);
      }
    }
  }
  guidedAlpha.set(baseAlpha);

  const gfRadius = subject === 'portrait' ? 3 : 2;
  const gfEps = subject === 'portrait' ? 0.0008 : 0.0015;
  const gfBlend = subject === 'portrait' ? 0.75 : 0.55;

  // Pass 2: Boundary-Selective 64x64 Block Processing
  // (Fast Guided Filter -> Local B(x,y) -> 5x5 Foreground Propagation -> Alpha Unmixing)
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
          const a = baseAlpha[row + tx];
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

      // 2a. Fast Guided Filter on padded boundary block (snaps alpha to full-res hair edges)
      const px0 = Math.max(0, bx - GF_PAD);
      const py0 = Math.max(0, by - GF_PAD);
      const px1 = Math.min(width, bx + bw + GF_PAD);
      const py1 = Math.min(height, by + bh + GF_PAD);
      const pw = px1 - px0;
      const ph = py1 - py0;
      const pn = pw * ph;

      for (let gy = 0; gy < ph; gy++) {
        const imgRow = (py0 + gy) * width + px0;
        const gRow = gy * pw;
        for (let gx = 0; gx < pw; gx++) {
          const idx = imgRow + gx;
          const p4 = idx * 4;
          const luma =
            (0.2126 * rgba[p4] + 0.7152 * rgba[p4 + 1] + 0.0722 * rgba[p4 + 2]) *
            0.0039215686;
          const aNorm = baseAlpha[idx] * 0.0039215686;
          const gi = gRow + gx;
          gfGuide[gi] = luma;
          gfAlpha[gi] = aNorm;
          gfGuideSq[gi] = luma * luma;
          gfGuideAlpha[gi] = luma * aNorm;
        }
      }

      boxMeanInPlace(gfGuide, gfMeanI, pw, ph, gfRadius);
      boxMeanInPlace(gfAlpha, gfMeanP, pw, ph, gfRadius);
      boxMeanInPlace(gfGuideSq, gfMeanII, pw, ph, gfRadius);
      boxMeanInPlace(gfGuideAlpha, gfMeanIP, pw, ph, gfRadius);

      for (let i = 0; i < pn; i++) {
        const varI = Math.max(0, gfMeanII[i] - gfMeanI[i] * gfMeanI[i]);
        const covIp = gfMeanIP[i] - gfMeanI[i] * gfMeanP[i];
        const ak = covIp / (varI + gfEps);
        gfAk[i] = ak;
        gfBk[i] = gfMeanP[i] - ak * gfMeanI[i];
      }

      boxMeanInPlace(gfAk, gfMeanA, pw, ph, gfRadius);
      boxMeanInPlace(gfBk, gfMeanB, pw, ph, gfRadius);

      for (let ty = 0; ty < bh; ty++) {
        const y = by + ty;
        const gy = y - py0;
        const imgRow = y * width;
        const gRow = gy * pw;
        for (let tx = 0; tx < bw; tx++) {
          const x = bx + tx;
          const idx = imgRow + x;
          const gi = gRow + (x - px0);
          const q = Math.max(0, Math.min(1, gfMeanA[gi] * gfGuide[gi] + gfMeanB[gi]));
          const orig = gfAlpha[gi];
          const blended = q * gfBlend + orig * (1 - gfBlend);
          guidedAlpha[idx] = Math.round(blended * 255);
        }
      }

      // 2b. Local Spatial Background Estimation B(x,y) for this block
      const localBg = estimateLocalBackground(
        rgba,
        alphaMask,
        width,
        height,
        bx,
        by,
        bw,
        bh,
        globalBg
      );
      const isDarkLocalBg = localBg.luma < 45;
      const isWhiteLocalBg = localBg.luma > 210;

      // 2c. Per-pixel 5x5 Foreground Propagation + Closed-Form Unmixing + Light-Wrap Guard
      for (let ty = 0; ty < bh; ty++) {
        const y = by + ty;
        const rowOffset = y * width;
        const yMin = Math.max(0, y - 2);
        const yMax = Math.min(height - 1, y + 2);

        for (let tx = 0; tx < bw; tx++) {
          const x = bx + tx;
          const idx = rowOffset + x;
          const p4 = idx * 4;
          let a = guidedAlpha[idx];

          if (a <= 5) continue;

          // Zero-Quality-Loss Guarantee: never alter RGB on confident foreground (faces, skin, suits)
          if (a >= 225) {
            out[p4] = rgba[p4];
            out[p4 + 1] = rgba[p4 + 1];
            out[p4 + 2] = rgba[p4 + 2];
            out[p4 + 3] = 255;
            continue;
          }

          const r0 = rgba[p4];
          const g0 = rgba[p4 + 1];
          const b0 = rgba[p4 + 2];

          // Suppress muddy empty border pixels matching dark local background luminance
          if (subject === 'portrait' && isDarkLocalBg && a < 40) {
            const pxLuma = 0.2126 * r0 + 0.7152 * g0 + 0.0722 * b0;
            if (Math.abs(pxLuma - localBg.luma) < 15) {
              a = Math.round(a * 0.35);
            }
          }
          if (isWhiteLocalBg && a < 22) {
            a = Math.max(0, a - 6);
          }
          if (a <= 2) continue;

          let fgR = 0;
          let fgG = 0;
          let fgB = 0;
          let fgWeightSum = 0;

          const xMin = Math.max(0, x - 2);
          const xMax = Math.min(width - 1, x + 2);

          for (let ny = yMin; ny <= yMax; ny++) {
            const nRow = ny * width;
            for (let nx = xMin; nx <= xMax; nx++) {
              const nIdx = nRow + nx;
              const na = guidedAlpha[nIdx];
              if (na >= 205) {
                const np4 = nIdx * 4;
                const dr = rgba[np4] - r0;
                const dg = rgba[np4 + 1] - g0;
                const db = rgba[np4 + 2] - b0;
                const lutIdx = (dr * dr + dg * dg + db * db) >> 6;
                const w = (lutIdx < LUT_SIZE ? EXP_LUT[lutIdx] : 0) * (na * 0.0039215686);
                fgR += rgba[np4] * w;
                fgG += rgba[np4 + 1] * w;
                fgB += rgba[np4 + 2] * w;
                fgWeightSum += w;
              }
            }
          }

          // Closed-Form Alpha Unmixing against LOCAL B(x,y)
          const alphaNorm = a * 0.0039215686;
          const denom = Math.max(alphaNorm, 0.14);
          const unmixR = Math.max(0, Math.min(255, (r0 - (1 - alphaNorm) * localBg.r) / denom));
          const unmixG = Math.max(0, Math.min(255, (g0 - (1 - alphaNorm) * localBg.g) / denom));
          const unmixB = Math.max(0, Math.min(255, (b0 - (1 - alphaNorm) * localBg.b) / denom));

          if (fgWeightSum > 0.01 && a < 235) {
            const cleanR = fgR / fgWeightSum;
            const cleanG = fgG / fgWeightSum;
            const cleanB = fgB / fgWeightSum;

            // Light-Wrap / Specular Spill Guard: if semi-transparent pixel is closer to localBg than cleanFg,
            // shift weight heavily toward clean foreground pigment to eliminate colored/white glow
            const distBg =
              Math.abs(r0 - localBg.r) + Math.abs(g0 - localBg.g) + Math.abs(b0 - localBg.b);
            const distFg =
              Math.abs(r0 - cleanR) + Math.abs(g0 - cleanG) + Math.abs(b0 - cleanB);
            const isLightWrap = a < 155 && distBg < distFg * 0.85;

            const fgMix = isLightWrap ? 0.65 : 0.38;
            const targetR = unmixR * (1 - fgMix) + cleanR * fgMix;
            const targetG = unmixG * (1 - fgMix) + cleanG * fgMix;
            const targetB = unmixB * (1 - fgMix) + cleanB * fgMix;
            const blend = Math.min(isLightWrap ? 0.94 : 0.88, (255 - a) * 0.0039215686);

            out[p4] = Math.round(r0 * (1 - blend) + targetR * blend);
            out[p4 + 1] = Math.round(g0 * (1 - blend) + targetG * blend);
            out[p4 + 2] = Math.round(b0 * (1 - blend) + targetB * blend);
          } else {
            out[p4] = Math.round(unmixR);
            out[p4 + 1] = Math.round(unmixG);
            out[p4 + 2] = Math.round(unmixB);
          }

          out[p4 + 3] = a;
        }
      }
    }
  }

  return out;
}

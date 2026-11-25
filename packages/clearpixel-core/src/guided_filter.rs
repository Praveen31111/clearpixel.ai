//! Fast O(N) Guided Filter using Summed-Area Tables (Integral Images).
//! Transfers sharp high-resolution RGB luminance edges onto the upscaled AI alpha mask.

/// Computes an O(N) box mean over `src` (width x height) with window `radius`.
fn box_mean(src: &[f32], width: usize, height: usize, radius: usize) -> Vec<f32> {
    let mut integral = vec![0.0f64; (width + 1) * (height + 1)];
    let stride = width + 1;

    for y in 0..height {
        let mut row_sum = 0.0f64;
        for x in 0..width {
            row_sum += src[y * width + x] as f64;
            integral[(y + 1) * stride + (x + 1)] = integral[y * stride + (x + 1)] + row_sum;
        }
    }

    let mut dst = vec![0.0f32; width * height];
    for y in 0..height {
        let y0 = y.saturating_sub(radius);
        let y1 = (y + radius).min(height - 1);
        for x in 0..width {
            let x0 = x.saturating_sub(radius);
            let x1 = (x + radius).min(width - 1);

            let area = ((x1 - x0 + 1) * (y1 - y0 + 1)) as f64;
            let sum = integral[(y1 + 1) * stride + (x1 + 1)]
                - integral[y0 * stride + (x1 + 1)]
                - integral[(y1 + 1) * stride + x0]
                + integral[y0 * stride + x0];

            dst[y * width + x] = (sum / area) as f32;
        }
    }
    dst
}

/// Applies a fast O(N) grayscale Guided Filter using the original RGBA image luminance as guidance.
/// `alpha` values are in [0.0, 1.0].
pub fn fast_guided_filter(
    rgba: &[u8],
    alpha: &[f32],
    width: usize,
    height: usize,
    radius: usize,
    eps: f32,
) -> Vec<f32> {
    let n = width * height;
    if n == 0 || rgba.len() < n * 4 || alpha.len() < n {
        return alpha.to_vec();
    }

    // 1. Extract normalized Rec.709 luminance guidance image I in [0, 1]
    let mut guide = vec![0.0f32; n];
    let mut guide_sq = vec![0.0f32; n];
    let mut guide_alpha = vec![0.0f32; n];

    for i in 0..n {
        let p4 = i * 4;
        let luma = (0.2126 * rgba[p4] as f32
            + 0.7152 * rgba[p4 + 1] as f32
            + 0.0722 * rgba[p4 + 2] as f32)
            / 255.0;
        let a = alpha[i];
        guide[i] = luma;
        guide_sq[i] = luma * luma;
        guide_alpha[i] = luma * a;
    }

    // 2. Local statistics via O(N) integral box filters
    let mean_i = box_mean(&guide, width, height, radius);
    let mean_p = box_mean(alpha, width, height, radius);
    let mean_ii = box_mean(&guide_sq, width, height, radius);
    let mean_ip = box_mean(&guide_alpha, width, height, radius);

    // 3. Linear coefficients a_k and b_k
    let mut a_k = vec![0.0f32; n];
    let mut b_k = vec![0.0f32; n];
    for i in 0..n {
        let var_i = (mean_ii[i] - mean_i[i] * mean_i[i]).max(0.0);
        let cov_ip = mean_ip[i] - mean_i[i] * mean_p[i];
        let ak = cov_ip / (var_i + eps);
        a_k[i] = ak;
        b_k[i] = mean_p[i] - ak * mean_i[i];
    }

    // 4. Average coefficients and reconstruct refined alpha q = mean_a * I + mean_b
    let mean_a = box_mean(&a_k, width, height, radius);
    let mean_b = box_mean(&b_k, width, height, radius);

    let mut out = vec![0.0f32; n];
    for i in 0..n {
        out[i] = (mean_a[i] * guide[i] + mean_b[i]).clamp(0.0, 1.0);
    }
    out
}

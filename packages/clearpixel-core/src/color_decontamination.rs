//! Closed-Form Alpha Unmixing & Halo Decontamination in Rust.
//! Estimates outer background color B_est and applies:
//!   F_clean = clamp((C - (1 - a) * B_est) / max(a, 0.12), 0, 255)

fn estimate_bg(rgba: &[u8], alpha: &[f32]) -> (f32, f32, f32) {
    let mut sum_r = 0.0f32;
    let mut sum_g = 0.0f32;
    let mut sum_b = 0.0f32;
    let mut count = 0usize;
    let step = (alpha.len() / 10_000).max(1);

    for i in (0..alpha.len()).step_by(step) {
        if alpha[i] <= 0.03 {
            let p4 = i * 4;
            sum_r += rgba[p4] as f32;
            sum_g += rgba[p4 + 1] as f32;
            sum_b += rgba[p4 + 2] as f32;
            count += 1;
        }
    }

    if count == 0 {
        (128.0, 128.0, 128.0)
    } else {
        let c = count as f32;
        (sum_r / c, sum_g / c, sum_b / c)
    }
}

fn estimate_local_bg(
    rgba: &[u8],
    alpha: &[f32],
    width: usize,
    height: usize,
    cx: usize,
    cy: usize,
    global_bg: (f32, f32, f32),
) -> (f32, f32, f32) {
    let radius: isize = 24;
    let x0 = (cx as isize - radius).max(0) as usize;
    let y0 = (cy as isize - radius).max(0) as usize;
    let x1 = (cx + radius as usize).min(width);
    let y1 = (cy + radius as usize).min(height);

    let mut sum_r = 0.0f32;
    let mut sum_g = 0.0f32;
    let mut sum_b = 0.0f32;
    let mut count = 0usize;

    for y in (y0..y1).step_by(2) {
        let row = y * width;
        for x in (x0..x1).step_by(2) {
            let idx = row + x;
            if alpha[idx] <= 0.03 {
                let p4 = idx * 4;
                sum_r += rgba[p4] as f32;
                sum_g += rgba[p4 + 1] as f32;
                sum_b += rgba[p4 + 2] as f32;
                count += 1;
            }
        }
    }

    if count < 6 {
        global_bg
    } else {
        let c = count as f32;
        (sum_r / c, sum_g / c, sum_b / c)
    }
}

pub fn decontaminate_edges(
    rgba: &[u8],
    alpha: &[f32],
    width: usize,
    height: usize,
) -> Vec<u8> {
    let n = width * height;
    let mut out = vec![0u8; n * 4];
    let global_bg = estimate_bg(rgba, alpha);
    let radius: isize = 2;

    for y in 0..height {
        for x in 0..width {
            let idx = y * width + x;
            let p4 = idx * 4;
            let a = alpha[idx];

            if a <= 0.004 {
                continue;
            }

            if a >= 0.98 {
                out[p4] = rgba[p4];
                out[p4 + 1] = rgba[p4 + 1];
                out[p4 + 2] = rgba[p4 + 2];
                out[p4 + 3] = 255;
                continue;
            }

            let r0 = rgba[p4] as f32;
            let g0 = rgba[p4 + 1] as f32;
            let b0 = rgba[p4 + 2] as f32;
            let (bg_r, bg_g, bg_b) = estimate_local_bg(rgba, alpha, width, height, x, y, global_bg);

            // Closed-Form Alpha Unmixing against local B(x,y)
            let denom = a.max(0.14);
            let unmix_r = ((r0 - (1.0 - a) * bg_r) / denom).clamp(0.0, 255.0);
            let unmix_g = ((g0 - (1.0 - a) * bg_g) / denom).clamp(0.0, 255.0);
            let unmix_b = ((b0 - (1.0 - a) * bg_b) / denom).clamp(0.0, 255.0);

            let mut fg_r = 0.0f32;
            let mut fg_g = 0.0f32;
            let mut fg_b = 0.0f32;
            let mut fg_weight = 0.0f32;

            for dy in -radius..=radius {
                let ny = y as isize + dy;
                if ny < 0 || ny >= height as isize {
                    continue;
                }
                for dx in -radius..=radius {
                    let nx = x as isize + dx;
                    if nx < 0 || nx >= width as isize {
                        continue;
                    }
                    let n_idx = (ny as usize) * width + (nx as usize);
                    let na = alpha[n_idx];
                    if na >= 0.88 {
                        let np4 = n_idx * 4;
                        let dr = rgba[np4] as f32 - r0;
                        let dg = rgba[np4 + 1] as f32 - g0;
                        let db = rgba[np4 + 2] as f32 - b0;
                        let dist_sq = dr * dr + dg * dg + db * db;
                        let w = (-dist_sq / 2000.0).exp() * na;

                        fg_r += rgba[np4] as f32 * w;
                        fg_g += rgba[np4 + 1] as f32 * w;
                        fg_b += rgba[np4 + 2] as f32 * w;
                        fg_weight += w;
                    }
                }
            }

            if fg_weight > 0.01 && a < 0.90 {
                let clean_r = fg_r / fg_weight;
                let clean_g = fg_g / fg_weight;
                let clean_b = fg_b / fg_weight;
                let target_r = unmix_r * 0.65 + clean_r * 0.35;
                let target_g = unmix_g * 0.65 + clean_g * 0.35;
                let target_b = unmix_b * 0.65 + clean_b * 0.35;
                let blend = (1.0 - a).min(0.85);

                out[p4] = (r0 * (1.0 - blend) + target_r * blend).round().clamp(0.0, 255.0) as u8;
                out[p4 + 1] = (g0 * (1.0 - blend) + target_g * blend).round().clamp(0.0, 255.0) as u8;
                out[p4 + 2] = (b0 * (1.0 - blend) + target_b * blend).round().clamp(0.0, 255.0) as u8;
            } else {
                out[p4] = unmix_r.round() as u8;
                out[p4 + 1] = unmix_g.round() as u8;
                out[p4 + 2] = unmix_b.round() as u8;
            }

            out[p4 + 3] = (a * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }

    out
}

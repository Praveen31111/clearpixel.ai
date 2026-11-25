//! Color Decontamination (Halo & Background Spill Removal).
//! Estimates clean foreground RGB from nearby definite-foreground pixels and strips
//! ambient background color bleed from semi-transparent hair and edge pixels.

pub fn decontaminate_edges(
    rgba: &[u8],
    alpha: &[f32],
    width: usize,
    height: usize,
) -> Vec<u8> {
    let n = width * height;
    let mut out = vec![0u8; n * 4];
    let radius: isize = 2;

    for y in 0..height {
        for x in 0..width {
            let idx = y * width + x;
            let p4 = idx * 4;
            let a = alpha[idx];

            if a <= 0.004 {
                // Transparent pixel
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
                let blend = (1.0 - a).min(0.75);

                out[p4] = (r0 * (1.0 - blend) + clean_r * blend).round().clamp(0.0, 255.0) as u8;
                out[p4 + 1] = (g0 * (1.0 - blend) + clean_g * blend).round().clamp(0.0, 255.0) as u8;
                out[p4 + 2] = (b0 * (1.0 - blend) + clean_b * blend).round().clamp(0.0, 255.0) as u8;
            } else {
                out[p4] = rgba[p4];
                out[p4 + 1] = rgba[p4 + 1];
                out[p4 + 2] = rgba[p4 + 2];
            }

            out[p4 + 3] = (a * 255.0).round().clamp(0.0, 255.0) as u8;
        }
    }

    out
}

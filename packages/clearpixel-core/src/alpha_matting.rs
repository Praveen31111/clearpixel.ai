//! Adaptive Tri-Map & Alpha Matting Refinement.
//! Eliminates faint background ghosting and sharpens the hair/fur transition band.

/// Applies adaptive tri-map thresholding and smoothstep contrast enhancement.
/// Definite background (<= 0.04) -> 0.0
/// Definite foreground (>= 0.96) -> 1.0
/// Unknown transition band -> smooth S-curve preserving fine hair/fur gradients.
pub fn refine_trimap_alpha(alpha: &[f32]) -> Vec<f32> {
    let low = 0.04f32;
    let high = 0.96f32;
    let span = high - low;

    alpha
        .iter()
        .map(|&a| {
            if a <= low {
                0.0
            } else if a >= high {
                1.0
            } else {
                let t = ((a - low) / span).clamp(0.0, 1.0);
                // S-curve contrast boost
                t * t * (3.0 - 2.0 * t)
            }
        })
        .collect()
}

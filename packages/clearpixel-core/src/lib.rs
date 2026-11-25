//! ClearPixel Core — Rust + WebAssembly Studio Matting Engine
//!
//! Pipeline:
//! 1. Adaptive Tri-Map & Alpha Matting (`alpha_matting.rs`)
//! 2. Fast O(N) Guided Filter (`guided_filter.rs`)
//! 3. Halo Removal & Color Decontamination (`color_decontamination.rs`)
//! 4. Native Fast PNG Encoder (`png_encoder.rs`)

pub mod alpha_matting;
pub mod color_decontamination;
pub mod guided_filter;
pub mod png_encoder;
pub mod tiling;

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub fn core_version() -> String {
    "clearpixel-core 0.2.0 (Rust WASM Tiled)".to_string()
}

/// Runs the memory-capped Boundary-Tiled Studio Matting Pipeline (supports 24MP - 100MP).
#[wasm_bindgen]
pub fn refine_cutout(
    rgba: &[u8],
    alpha_mask: &[u8],
    width: usize,
    height: usize,
) -> Vec<u8> {
    if width * height > 512 * 512 {
        return tiling::refine_cutout_tiled(rgba, alpha_mask, width, height);
    }

    let alpha_f32: Vec<f32> = alpha_mask.iter().map(|&a| a as f32 / 255.0).collect();

    // 1. O(N) Guided Filter aligns mask edges with high-res RGB luminance gradients
    let guided = guided_filter::fast_guided_filter(rgba, &alpha_f32, width, height, 3, 1e-3);

    // 2. Adaptive Tri-Map sharpens transition band and removes faint ghosting
    let refined_alpha = alpha_matting::refine_trimap_alpha(&guided);

    // 3. Color Decontamination strips old background halo from semi-transparent edges
    color_decontamination::decontaminate_edges(rgba, &refined_alpha, width, height)
}

/// Encodes an RGBA pixel buffer directly into a 32-bit transparent PNG byte vector.
#[wasm_bindgen]
pub fn encode_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, JsValue> {
    png_encoder::encode_rgba_png(rgba, width, height)
        .map_err(|e| JsValue::from_str(&e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_trimap_removes_ghosting_and_keeps_solid() {
        let input = vec![0.01, 0.5, 0.99];
        let out = alpha_matting::refine_trimap_alpha(&input);
        assert_eq!(out[0], 0.0);
        assert!((out[1] - 0.5).abs() < 0.01);
        assert_eq!(out[2], 1.0);
    }

    #[test]
    fn test_guided_filter_preserves_dimensions() {
        let w = 8;
        let h = 8;
        let rgba = vec![128u8; w * h * 4];
        let alpha = vec![0.5f32; w * h];
        let out = guided_filter::fast_guided_filter(&rgba, &alpha, w, h, 2, 1e-3);
        assert_eq!(out.len(), w * h);
    }

    #[test]
    fn test_refine_cutout_end_to_end() {
        let w = 4;
        let h = 4;
        let mut rgba = vec![0u8; w * h * 4];
        let mut mask = vec![0u8; w * h];
        // Center 2x2 solid foreground
        for y in 1..3 {
            for x in 1..3 {
                let idx = y * w + x;
                rgba[idx * 4] = 200;
                rgba[idx * 4 + 1] = 50;
                rgba[idx * 4 + 2] = 50;
                rgba[idx * 4 + 3] = 255;
                mask[idx] = 255;
            }
        }
        let out = refine_cutout(&rgba, &mask, w, h);
        assert_eq!(out.len(), w * h * 4);
    }

    #[test]
    fn test_png_encoder_produces_valid_signature() {
        let rgba = vec![255u8; 4 * 4 * 4];
        let bytes = png_encoder::encode_rgba_png(&rgba, 4, 4).unwrap();
        // PNG magic header: 137 80 78 71 13 10 26 10
        assert_eq!(&bytes[0..8], &[137, 80, 78, 71, 13, 10, 26, 10]);
    }
}

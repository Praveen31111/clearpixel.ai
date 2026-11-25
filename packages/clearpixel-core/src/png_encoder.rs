//! Native Fast 32-bit Transparent PNG Encoder in Rust.

use std::io::BufWriter;

pub fn encode_rgba_png(rgba: &[u8], width: u32, height: u32) -> Result<Vec<u8>, String> {
    let mut out = Vec::with_capacity((width * height) as usize);
    {
        let writer = BufWriter::new(&mut out);
        let mut encoder = png::Encoder::new(writer, width, height);
        encoder.set_color(png::ColorType::Rgba);
        encoder.set_depth(png::BitDepth::Eight);
        encoder.set_compression(png::Compression::Fast);
        let mut png_writer = encoder.write_header().map_err(|e| e.to_string())?;
        png_writer.write_image_data(rgba).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

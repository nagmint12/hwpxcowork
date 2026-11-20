//! [hwpx-cowork] Prepare picture alpha once for SVG, Canvas and CanvasKit.
//! The HWPX model retains the original picture and effect parameters.

use std::collections::VecDeque;
use std::io::Cursor;

use super::{
    canvaskit_encoded_image_header, decode_image_with_format_limited, memoized, Conversion,
};
use crate::renderer::render_tree::{BoundingBox, ImageNode};

const MAX_WORK_PIXELS: f64 = 2_000_000.0;

#[derive(Clone, Copy, Hash)]
pub(super) enum AlphaKey {
    SoftEdge(u32),
    Reflection {
        mirror: [bool; 2],
        angle: u64,
        alpha: [u64; 2],
        range: [u64; 2],
    },
}

pub(crate) fn soft_edge(source: &mut ImageNode, frame: BoundingBox, radius_hu: f64, dpi: f64) {
    if radius_hu <= 0.0 {
        return;
    }
    // Hancom 2022 96-DPI centerline: alpha is approximately half at 8
    // samples for a radius of 1000 HU. Scale the work surface for large radii.
    let radius = radius_hu / 120.0;
    let resolution = (32.0 / radius).min(1.0);
    if let Some(bytes) = raster(source, frame, dpi, resolution, |scale| {
        AlphaKey::SoftEdge((radius * scale).round().max(1.0) as u32)
    }) {
        install(source, bytes);
    }
}

pub(crate) fn reflection(
    source: &ImageNode,
    frame: BoundingBox,
    dpi: f64,
    mirror: [bool; 2],
    fade_degrees: f64,
    alpha: [f64; 2],
    range: [f64; 2],
) -> Option<ImageNode> {
    let bytes = raster(source, frame, dpi, 1.0, |_| AlphaKey::Reflection {
        mirror,
        angle: fade_degrees.to_radians().to_bits(),
        alpha: alpha.map(f64::to_bits),
        range: range.map(f64::to_bits),
    })?;
    let mut result = source.clone();
    install(&mut result, bytes);
    result.bin_data_id = 0;
    result.section_index = None;
    result.para_index = None;
    result.control_index = None;
    result.cell_index = None;
    result.cell_para_index = None;
    result.outer_table_control_index = None;
    result.cell_context = None;
    result.header_footer_ref = None;
    result.content_inset = None;
    result.hancom2024_print_bitmap = false;
    Some(result)
}

fn install(target: &mut ImageNode, bytes: Vec<u8>) {
    target.data = Some(bytes);
    target.crop = None;
    target.original_size_hu = None;
    target.source_rect = None;
}

fn raster(
    source: &ImageNode,
    frame: BoundingBox,
    dpi: f64,
    resolution: f64,
    effect: impl FnOnce(f64) -> AlphaKey,
) -> Option<Vec<u8>> {
    if source.fill_mode.is_some() || source.source_rect.is_some() || dpi <= 0.0 {
        return None;
    }
    let original = source.data.as_deref()?;
    let format = image::guess_format(original).ok()?;
    let header =
        canvaskit_encoded_image_header(original).filter(|h| h.is_within_decode_limits())?;
    let dimensions = [frame.width * 96.0 / dpi, frame.height * 96.0 / dpi];
    if dimensions.iter().any(|v| !v.is_finite() || *v <= 0.0) {
        return None;
    }
    let scale = resolution
        .min((MAX_WORK_PIXELS / (dimensions[0] * dimensions[1])).sqrt())
        .min(4096.0 / dimensions[0].max(dimensions[1]));
    let size = dimensions.map(|v| (v * scale).round().max(1.0) as u32);
    let (w, h) = (f64::from(header.width), f64::from(header.height));
    let crop = source.crop.map_or((0.0, 0.0, w, h), |crop| {
        crate::renderer::svg::compute_image_crop_src(
            crop,
            super::image_crop_reference(source),
            w,
            h,
        )
    });
    if crop.2 <= 0.0 || crop.3 <= 0.0 {
        return None;
    }
    let crop = [crop.0, crop.1, crop.2, crop.3];
    let effect = effect(scale);
    memoized(
        Conversion::PictureEffectAlpha {
            effect,
            crop: crop.map(f64::to_bits),
            size,
        },
        original,
        || {
            let source = decode_image_with_format_limited(original, format)?.to_rgba8();
            let mut pixels = sample_window(&source, crop, size);
            match effect {
                AlphaKey::SoftEdge(radius) => {
                    let alpha: Vec<f64> =
                        pixels.pixels().map(|pixel| f64::from(pixel[3])).collect();
                    let faded =
                        feather(&alpha, size[0] as usize, size[1] as usize, radius as usize);
                    for (pixel, opacity) in pixels.pixels_mut().zip(faded) {
                        pixel[3] = pixel[3].min(opacity.round() as u8);
                    }
                }
                AlphaKey::Reflection {
                    mirror,
                    angle,
                    alpha,
                    range,
                } => {
                    if mirror[0] {
                        image::imageops::flip_horizontal_in_place(&mut pixels);
                    }
                    if mirror[1] {
                        image::imageops::flip_vertical_in_place(&mut pixels);
                    }
                    let (dy, dx) = f64::from_bits(angle).sin_cos();
                    let span = dx.abs() + dy.abs();
                    let low = dx.min(0.0) + dy.min(0.0);
                    let [start, end] = range.map(f64::from_bits);
                    let [a0, a1] = alpha.map(f64::from_bits);
                    for (x, y, pixel) in pixels.enumerate_pixels_mut() {
                        let position = ((f64::from(x) + 0.5) / f64::from(size[0]) * dx
                            + (f64::from(y) + 0.5) / f64::from(size[1]) * dy
                            - low)
                            / span;
                        let t = if end > start {
                            ((position - start) / (end - start)).clamp(0.0, 1.0)
                        } else if position >= end {
                            1.0
                        } else {
                            0.0
                        };
                        pixel[3] =
                            (f64::from(pixel[3]) * (1.0 - (a0 + (a1 - a0) * t))).round() as u8;
                    }
                }
            }
            let mut output = Cursor::new(Vec::new());
            pixels.write_to(&mut output, image::ImageFormat::Png).ok()?;
            Some(output.into_inner())
        },
    )
}

fn sample_window(
    source: &image::RgbaImage,
    crop: [f64; 4],
    [width, height]: [u32; 2],
) -> image::RgbaImage {
    image::RgbaImage::from_fn(width, height, |x, y| {
        let sx = crop[0] + (f64::from(x) + 0.5) * crop[2] / f64::from(width) - 0.5;
        let sy = crop[1] + (f64::from(y) + 0.5) * crop[3] / f64::from(height) - 0.5;
        let (ix, iy) = (sx.floor(), sy.floor());
        let (fx, fy) = (sx - ix, sy - iy);
        let mut result = [0.0; 4];
        for (dy, wy) in [(0.0, 1.0 - fy), (1.0, fy)] {
            for (dx, wx) in [(0.0, 1.0 - fx), (1.0, fx)] {
                let px = (ix + dx).clamp(0.0, f64::from(source.width() - 1)) as u32;
                let py = (iy + dy).clamp(0.0, f64::from(source.height() - 1)) as u32;
                for (out, channel) in result.iter_mut().zip(source.get_pixel(px, py).0) {
                    *out += f64::from(channel) * wx * wy;
                }
            }
        }
        image::Rgba(result.map(|c| c.round() as u8))
    })
}

fn feather(alpha: &[f64], width: usize, height: usize, radius: usize) -> Vec<f64> {
    if radius * 2 >= width.min(height) {
        return vec![0.0; alpha.len()];
    }
    let mut horizontal = vec![0.0; alpha.len()];
    for y in 0..height {
        erode_line(
            &alpha[y * width..(y + 1) * width],
            &mut horizontal[y * width..(y + 1) * width],
            radius,
        );
    }
    let mut eroded = vec![0.0; alpha.len()];
    let mut input = vec![0.0; height];
    let mut output = input.clone();
    for x in 0..width {
        for y in 0..height {
            input[y] = horizontal[y * width + x];
        }
        erode_line(&input, &mut output, radius);
        for y in 0..height {
            eroded[y * width + x] = output[y];
        }
    }
    let sigma = radius as f64 / 2.0;
    let mut kernel: Vec<f64> = (0..=radius * 2)
        .map(|i| {
            let x = i as f64 - radius as f64;
            (-x * x / (2.0 * sigma * sigma)).exp()
        })
        .collect();
    let sum: f64 = kernel.iter().sum();
    for k in &mut kernel {
        *k /= sum;
    }
    horizontal.fill(0.0);
    for y in 0..height {
        for x in 0..width {
            for (i, k) in kernel.iter().enumerate() {
                let sx = x as isize + i as isize - radius as isize;
                if sx >= 0 && sx < width as isize {
                    horizontal[y * width + x] += eroded[y * width + sx as usize] * k;
                }
            }
        }
    }
    let mut result = vec![0.0; alpha.len()];
    for y in 0..height {
        for x in 0..width {
            for (i, k) in kernel.iter().enumerate() {
                let sy = y as isize + i as isize - radius as isize;
                if sy >= 0 && sy < height as isize {
                    result[y * width + x] += horizontal[sy as usize * width + x] * k;
                }
            }
        }
    }
    result
}

fn erode_line(input: &[f64], output: &mut [f64], radius: usize) {
    let mut queue: VecDeque<usize> = VecDeque::new();
    for end in 0..input.len() {
        while queue.back().is_some_and(|&i| input[i] >= input[end]) {
            queue.pop_back();
        }
        queue.push_back(end);
        if end >= radius * 2 {
            let start = end - radius * 2;
            while queue.front().is_some_and(|&i| i < start) {
                queue.pop_front();
            }
            output[end - radius] = input[*queue.front().unwrap()];
        }
    }
}

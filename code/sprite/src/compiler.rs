//! Design-time image rasterization and ANSI terminal previews.

use crate::SpriteCell;
use crate::TerminalSprite;
use anyhow::Context;
use anyhow::Result;
use anyhow::bail;
use resvg::tiny_skia::Pixmap;
use resvg::tiny_skia::Transform;
use resvg::usvg;
use std::collections::BTreeMap;
use std::fmt::Write;
use std::path::Path;

pub struct RasterizedImage {
    pub width: u32,
    pub height: u32,
    pub pixels: Vec<[u8; 4]>,
}

pub fn source_dimensions(path: &Path) -> Result<(u32, u32)> {
    let extension = extension(path)?;
    match extension.as_str() {
        "svg" => {
            let bytes = std::fs::read(path)
                .with_context(|| format!("read SVG source {}", path.display()))?;
            let tree = usvg::Tree::from_data(&bytes, &usvg::Options::default())
                .with_context(|| format!("parse SVG source {}", path.display()))?;
            Ok((
                tree.size().width().ceil().max(1.0) as u32,
                tree.size().height().ceil().max(1.0) as u32,
            ))
        }
        "png" => image::image_dimensions(path)
            .with_context(|| format!("read PNG dimensions {}", path.display())),
        value => bail!("unsupported image extension '.{value}'; expected .svg or .png"),
    }
}

pub fn rasterize(path: &Path, width: u32, height: u32) -> Result<RasterizedImage> {
    if width == 0 || height == 0 {
        bail!("target raster dimensions must be non-zero");
    }
    let extension = extension(path)?;
    let pixels = match extension.as_str() {
        "svg" => rasterize_svg(path, width, height)?,
        "png" => rasterize_png(path, width, height)?,
        value => bail!("unsupported image extension '.{value}'; expected .svg or .png"),
    };
    Ok(RasterizedImage {
        width,
        height,
        pixels,
    })
}

pub fn ansi_preview(sprite: TerminalSprite<'_>) -> String {
    let mut output = String::new();
    for (index, cell) in sprite.cells().iter().copied().enumerate() {
        write_ansi_cell(&mut output, cell);
        if (index + 1) % usize::from(sprite.width()) == 0 {
            output.push_str("\x1b[0m\n");
        }
    }
    output
}

fn rasterize_svg(path: &Path, width: u32, height: u32) -> Result<Vec<[u8; 4]>> {
    let bytes =
        std::fs::read(path).with_context(|| format!("read SVG source {}", path.display()))?;
    let tree = usvg::Tree::from_data(&bytes, &usvg::Options::default())
        .with_context(|| format!("parse SVG source {}", path.display()))?;
    let source = tree.size();
    let source_width = source.width().ceil().max(1.0) as u32;
    let source_height = source.height().ceil().max(1.0) as u32;
    if source_width > 4096 || source_height > 4096 {
        bail!(
            "SVG intrinsic dimensions {source_width}x{source_height} exceed the 4096-pixel compiler limit"
        );
    }
    let scale = width
        .div_ceil(source_width)
        .max(height.div_ceil(source_height))
        .max(1);
    let raster_width = source_width
        .checked_mul(scale)
        .context("SVG raster width is too large")?;
    let raster_height = source_height
        .checked_mul(scale)
        .context("SVG raster height is too large")?;
    let mut pixmap = Pixmap::new(raster_width, raster_height)
        .with_context(|| format!("allocate {raster_width}x{raster_height} SVG raster"))?;
    let transform = Transform::from_scale(
        raster_width as f32 / source.width(),
        raster_height as f32 / source.height(),
    );
    resvg::render(&tree, transform, &mut pixmap.as_mut());
    let source_pixels = pixmap
        .pixels()
        .iter()
        .map(|pixel| {
            let pixel = pixel.demultiply();
            [pixel.red(), pixel.green(), pixel.blue(), pixel.alpha()]
        })
        .collect::<Vec<_>>();
    let source_image = image::RgbaImage::from_raw(
        raster_width,
        raster_height,
        source_pixels.into_iter().flatten().collect(),
    )
    .context("SVG raster pixel count did not match its dimensions")?;
    let image = resize_pixel_art(&source_image, width, height);
    Ok(image.pixels().map(|pixel| pixel.0).collect())
}

fn rasterize_png(path: &Path, width: u32, height: u32) -> Result<Vec<[u8; 4]>> {
    let source = image::open(path)
        .with_context(|| format!("decode PNG source {}", path.display()))?
        .into_rgba8();
    let image = resize_pixel_art(&source, width, height);
    Ok(image.pixels().map(|pixel| pixel.0).collect())
}

fn resize_pixel_art(source: &image::RgbaImage, width: u32, height: u32) -> image::RgbaImage {
    let source_width = source.width();
    let source_height = source.height();
    let frequencies = source.pixels().fold(BTreeMap::new(), |mut counts, pixel| {
        *counts.entry(pixel.0).or_insert(0usize) += 1;
        counts
    });
    image::RgbaImage::from_fn(width, height, |target_x, target_y| {
        let source_x_start = u64::from(target_x) * u64::from(source_width) / u64::from(width);
        let source_x_end =
            ((u64::from(target_x) + 1) * u64::from(source_width)).div_ceil(u64::from(width));
        let source_y_start = u64::from(target_y) * u64::from(source_height) / u64::from(height);
        let source_y_end =
            ((u64::from(target_y) + 1) * u64::from(source_height)).div_ceil(u64::from(height));
        let mut coverage = BTreeMap::<[u8; 4], u64>::new();
        for source_y in source_y_start..source_y_end {
            let overlap_y = overlap(
                u64::from(target_y) * u64::from(source_height),
                (u64::from(target_y) + 1) * u64::from(source_height),
                source_y * u64::from(height),
                (source_y + 1) * u64::from(height),
            );
            for source_x in source_x_start..source_x_end {
                let overlap_x = overlap(
                    u64::from(target_x) * u64::from(source_width),
                    (u64::from(target_x) + 1) * u64::from(source_width),
                    source_x * u64::from(width),
                    (source_x + 1) * u64::from(width),
                );
                *coverage
                    .entry(source[(source_x as u32, source_y as u32)].0)
                    .or_default() += overlap_x * overlap_y;
            }
        }
        let total_coverage = coverage.values().sum::<u64>();
        let dominant = coverage
            .iter()
            .max_by(
                |(left_color, left_coverage), (right_color, right_coverage)| {
                    left_coverage
                        .cmp(right_coverage)
                        .then_with(|| left_color[3].cmp(&right_color[3]))
                        .then_with(|| frequencies[*right_color].cmp(&frequencies[*left_color]))
                        .then_with(|| right_color.cmp(left_color))
                },
            )
            .map(|(color, _)| *color);
        let color = dominant
            .and_then(|dominant| {
                let dominant_frequency = frequencies[&dominant];
                coverage
                    .iter()
                    .filter(|(color, weight)| {
                        color[3] > 0
                            && **weight * 4 >= total_coverage
                            && frequencies[*color] * 4 <= dominant_frequency
                    })
                    .min_by(
                        |(left_color, left_coverage), (right_color, right_coverage)| {
                            frequencies[*left_color]
                                .cmp(&frequencies[*right_color])
                                .then_with(|| right_coverage.cmp(left_coverage))
                                .then_with(|| left_color.cmp(right_color))
                        },
                    )
                    .map(|(color, _)| *color)
                    .or(Some(dominant))
            })
            .unwrap_or([0, 0, 0, 0]);
        image::Rgba(color)
    })
}

fn overlap(left_start: u64, left_end: u64, right_start: u64, right_end: u64) -> u64 {
    left_end
        .min(right_end)
        .saturating_sub(left_start.max(right_start))
}

fn extension(path: &Path) -> Result<String> {
    path.extension()
        .and_then(|value| value.to_str())
        .map(|value| value.to_ascii_lowercase())
        .with_context(|| format!("image path {} has no UTF-8 extension", path.display()))
}

fn write_ansi_cell(output: &mut String, cell: SpriteCell) {
    output.push_str("\x1b[0m");
    if let Some(color) = cell.foreground() {
        let [red, green, blue] = color.components();
        write!(output, "\x1b[38;2;{red};{green};{blue}m").expect("write to String");
    }
    if let Some(color) = cell.background() {
        let [red, green, blue] = color.components();
        write!(output, "\x1b[48;2;{red};{green};{blue}m").expect("write to String");
    }
    output.push(cell.symbol());
}

#[cfg(test)]
#[path = "compiler_tests.rs"]
mod tests;

use std::collections::HashMap;

use ratex_layout::{LayoutOptions, layout, to_display_list};
use ratex_svg::{SvgOptions, render_to_svg};
use ratex_types::math_style::MathStyle;
use resvg::tiny_skia::{Pixmap, Transform};
use resvg::usvg;
use sha2::{Digest, Sha256};
use thiserror::Error;
use zui::ui::{Color, ImageData, ImageId};

use crate::document::{InlineRun, MarkdownBlockKind};
use crate::{MarkdownDocument, MarkdownStyle};

const MAX_MATH_SOURCE_BYTES: usize = 64 * 1024;
const MAX_MATH_PIXELS: u64 = 4_194_304;

/// Native LaTeX math placement mode.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum MarkdownMathMode {
    Inline,
    Display,
}

/// Failure to parse, lay out, or rasterize one bounded LaTeX expression.
#[derive(Debug, Error)]
pub enum MarkdownMathError {
    #[error("math source exceeds the {limit}-byte limit with {actual} bytes")]
    SourceTooLarge { actual: usize, limit: usize },
    #[error("invalid LaTeX math: {0}")]
    Parse(String),
    #[error("generated math SVG is invalid: {0}")]
    Svg(String),
    #[error("math raster is {width}x{height}, exceeding the {limit}-pixel limit")]
    TooManyPixels { width: u32, height: u32, limit: u64 },
    #[error("math raster dimensions are invalid")]
    InvalidDimensions,
    #[error("math pixels are invalid: {0}")]
    Pixels(zui::ui::ImageDataError),
}

/// Parses and typesets bounded LaTeX with the pure-Rust RaTeX backend.
pub fn render_markdown_math(
    source: &str,
    mode: MarkdownMathMode,
    color: Color,
    font_size: f32,
) -> Result<ImageData, MarkdownMathError> {
    if source.len() > MAX_MATH_SOURCE_BYTES {
        return Err(MarkdownMathError::SourceTooLarge {
            actual: source.len(),
            limit: MAX_MATH_SOURCE_BYTES,
        });
    }
    let ast =
        ratex_parser::parse(source).map_err(|error| MarkdownMathError::Parse(error.to_string()))?;
    let math_style = match mode {
        MarkdownMathMode::Inline => MathStyle::Text,
        MarkdownMathMode::Display => MathStyle::Display,
    };
    let options = LayoutOptions::default().with_style(math_style);
    let display = to_display_list(&layout(&ast, &options));
    let svg = render_to_svg(
        &display,
        &SvgOptions {
            font_size: font_size.max(8.0) as f64,
            padding: 2.0,
            stroke_width: 1.0,
            embed_glyphs: true,
            font_dir: String::new(),
        },
    );
    let tree = usvg::Tree::from_str(&svg, &usvg::Options::default())
        .map_err(|error| MarkdownMathError::Svg(error.to_string()))?;
    let width = tree.size().width().ceil() as u32;
    let height = tree.size().height().ceil() as u32;
    if width == 0 || height == 0 {
        return Err(MarkdownMathError::InvalidDimensions);
    }
    if u64::from(width) * u64::from(height) > MAX_MATH_PIXELS {
        return Err(MarkdownMathError::TooManyPixels {
            width,
            height,
            limit: MAX_MATH_PIXELS,
        });
    }
    let mut pixmap = Pixmap::new(width, height).ok_or(MarkdownMathError::InvalidDimensions)?;
    resvg::render(&tree, Transform::identity(), &mut pixmap.as_mut());
    let [red, green, blue, color_alpha] = color.components();
    let mut pixels = Vec::with_capacity(width as usize * height as usize * 4);
    for pixel in pixmap.pixels() {
        let alpha = u16::from(pixel.alpha()) * u16::from(color_alpha) / 255;
        pixels.extend_from_slice(&[red, green, blue, alpha as u8]);
    }
    ImageData::from_rgba8(
        math_image_id(source, mode, color, font_size),
        width,
        height,
        pixels,
    )
    .map_err(MarkdownMathError::Pixels)
}

pub(crate) struct MarkdownMathCache {
    images: HashMap<MathKey, Option<ImageData>>,
}

pub(crate) type MarkdownMathImages = HashMap<String, ImageData>;

impl MarkdownMathCache {
    pub(crate) fn new() -> Self {
        Self {
            images: HashMap::new(),
        }
    }

    pub(crate) fn render(
        &mut self,
        source: &str,
        mode: MarkdownMathMode,
        color: Color,
        font_size: f32,
    ) -> Option<ImageData> {
        let key = MathKey::new(source, mode, color, font_size);
        self.images
            .entry(key)
            .or_insert_with(|| render_markdown_math(source, mode, color, font_size).ok())
            .clone()
    }

    pub(crate) fn prepare_inline(
        &mut self,
        document: &MarkdownDocument,
        style: &MarkdownStyle,
    ) -> MarkdownMathImages {
        let mut images = MarkdownMathImages::new();
        for block in &document.blocks {
            match &block.kind {
                MarkdownBlockKind::Paragraph(runs) | MarkdownBlockKind::Heading { runs, .. } => {
                    self.prepare_runs(runs, style, &mut images);
                }
                MarkdownBlockKind::Table(table) => {
                    for row in &table.rows {
                        for cell in &row.cells {
                            self.prepare_runs(cell, style, &mut images);
                        }
                    }
                }
                _ => {}
            }
        }
        images
    }

    fn prepare_runs(
        &mut self,
        runs: &[InlineRun],
        style: &MarkdownStyle,
        images: &mut MarkdownMathImages,
    ) {
        for run in runs {
            if run.format.math
                && !images.contains_key(&run.text)
                && let Some(image) = self.render(
                    &run.text,
                    MarkdownMathMode::Inline,
                    style.body().color(),
                    style.body().font_size(),
                )
            {
                images.insert(run.text.clone(), image);
            }
        }
    }
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct MathKey {
    source: String,
    mode: MarkdownMathMode,
    color: [u8; 4],
    font_size_bits: u32,
}

impl MathKey {
    fn new(source: &str, mode: MarkdownMathMode, color: Color, font_size: f32) -> Self {
        Self {
            source: source.to_owned(),
            mode,
            color: color.components(),
            font_size_bits: font_size.to_bits(),
        }
    }
}

fn math_image_id(source: &str, mode: MarkdownMathMode, color: Color, font_size: f32) -> ImageId {
    let mut digest = Sha256::new();
    digest.update(b"ash-markdown-math-v1\0");
    digest.update(source.as_bytes());
    digest.update([match mode {
        MarkdownMathMode::Inline => 0,
        MarkdownMathMode::Display => 1,
    }]);
    digest.update(color.components());
    digest.update(font_size.to_bits().to_le_bytes());
    let bytes: [u8; 8] = digest.finalize()[..8]
        .try_into()
        .expect("fixed digest slice");
    ImageId::new(u64::from_le_bytes(bytes))
}

#[cfg(test)]
#[path = "math_tests.rs"]
mod tests;

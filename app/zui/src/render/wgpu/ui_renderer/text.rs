use crate::render::support::font_family;
use crate::render::support::font_style;
use crate::render::support::font_weight;
use crate::ui::foundation::Color;
use crate::ui::foundation::Rect;
use crate::ui::presentation::TextBlock;
use crate::ui::presentation::TextBlockWrap;
use crate::ui::text::TextStyle;
use glyphon::Attrs;
use glyphon::Buffer;
use glyphon::Color as GlyphColor;
use glyphon::Metrics;
use glyphon::Shaping;
use glyphon::TextBounds;
use glyphon::Wrap;

use super::UiRenderError;

pub(super) struct PreparedArea {
    pub(super) left: f32,
    pub(super) top: f32,
    pub(super) bounds: TextBounds,
    pub(super) color: GlyphColor,
}

pub(super) fn same_text_buffer_layout(left: &TextBlock, right: &TextBlock) -> bool {
    left.text() == right.text()
        && left.spans() == right.spans()
        && left.bounds() == right.bounds()
        && left.wrap() == right.wrap()
        && left.is_text_centered() == right.is_text_centered()
        && same_shaping_style(left.style(), right.style())
}

fn same_shaping_style(left: &TextStyle, right: &TextStyle) -> bool {
    left.family() == right.family()
        && left.font_size().to_bits() == right.font_size().to_bits()
        && left.line_height().to_bits() == right.line_height().to_bits()
        && left.weight() == right.weight()
        && left.style() == right.style()
}

pub(super) fn validate_text_block(index: usize, block: &TextBlock) -> Result<(), UiRenderError> {
    let origin = block.origin();
    let bounds = block.bounds();
    let style = block.style();
    let values = [
        origin.x,
        origin.y,
        bounds.width,
        bounds.height,
        style.font_size(),
        style.line_height(),
    ];
    if values.into_iter().any(|value| !value.is_finite()) {
        return Err(UiRenderError::InvalidTextBlock {
            index,
            reason: "coordinates and metrics must be finite",
        });
    }
    if bounds.width <= 0.0 || bounds.height <= 0.0 {
        return Err(UiRenderError::InvalidTextBlock {
            index,
            reason: "bounds must be positive",
        });
    }
    if style.font_size() <= 0.0 || style.line_height() <= 0.0 {
        return Err(UiRenderError::InvalidTextBlock {
            index,
            reason: "font size and line height must be positive",
        });
    }
    for span in block.spans() {
        let style = span.style();
        if !style.font_size().is_finite()
            || !style.line_height().is_finite()
            || style.font_size() <= 0.0
            || style.line_height() <= 0.0
        {
            return Err(UiRenderError::InvalidTextBlock {
                index,
                reason: "span font size and line height must be finite and positive",
            });
        }
    }
    if let Some(clip) = block.clip_bounds() {
        let values = [
            clip.origin.x,
            clip.origin.y,
            clip.size.width,
            clip.size.height,
        ];
        if values.into_iter().any(|value| !value.is_finite()) {
            return Err(UiRenderError::InvalidTextBlock {
                index,
                reason: "clip bounds must be finite",
            });
        }
        if clip.size.width < 0.0 || clip.size.height < 0.0 {
            return Err(UiRenderError::InvalidTextBlock {
                index,
                reason: "clip bounds must not be negative",
            });
        }
    }
    Ok(())
}

fn attrs_for_style(style: &TextStyle, scale_factor: f32) -> Attrs<'_> {
    Attrs::new()
        .family(font_family(style.family()))
        .weight(font_weight(style.weight()))
        .style(font_style(style.style()))
        .color(glyphon_color(style.color()))
        .metrics(Metrics::new(
            style.font_size() * scale_factor,
            style.line_height() * scale_factor,
        ))
}

pub(super) fn prepare_text_buffer(
    font_system: &mut glyphon::FontSystem,
    block: &TextBlock,
    scale_factor: f32,
) -> Buffer {
    let style = block.style();
    let metrics = Metrics::new(
        style.font_size() * scale_factor,
        style.line_height() * scale_factor,
    );
    let mut buffer = Buffer::new(font_system, metrics);
    buffer.set_wrap(glyphon_wrap(block.wrap()));
    let bounds = block.bounds();
    buffer.set_size(
        Some(bounds.width * scale_factor),
        Some(bounds.height * scale_factor),
    );
    let attrs = Attrs::new()
        .family(font_family(style.family()))
        .weight(font_weight(style.weight()))
        .style(font_style(style.style()));
    let alignment = block
        .is_text_centered()
        .then_some(glyphon::cosmic_text::Align::Center);
    if block.spans().is_empty() {
        buffer.set_text(block.text(), &attrs, Shaping::Advanced, alignment);
    } else {
        buffer.set_rich_text(
            block
                .spans()
                .iter()
                .map(|span| (span.text(), attrs_for_style(span.style(), scale_factor))),
            &attrs,
            Shaping::Advanced,
            alignment,
        );
    }
    buffer.shape_until_scroll(font_system, false);
    buffer
}

pub(super) fn prepared_area(block: &TextBlock, scale_factor: f32, color: Color) -> PreparedArea {
    let origin = block.origin();
    let size = block.bounds();
    let left = origin.x * scale_factor;
    let top = origin.y * scale_factor;
    let block_bounds = Rect::new(origin, size);
    let clip_bounds = block
        .clip_bounds()
        .map(|clip| clip.intersection(block_bounds))
        .unwrap_or(block_bounds);
    PreparedArea {
        left,
        top,
        bounds: TextBounds {
            left: (clip_bounds.origin.x * scale_factor).floor() as i32,
            top: (clip_bounds.origin.y * scale_factor).floor() as i32,
            right: (clip_bounds.right() * scale_factor).ceil() as i32,
            bottom: (clip_bounds.bottom() * scale_factor).ceil() as i32,
        },
        color: glyphon_color(color),
    }
}

pub(super) const fn glyphon_wrap(wrap: TextBlockWrap) -> Wrap {
    match wrap {
        TextBlockWrap::WordOrGlyph => Wrap::WordOrGlyph,
        TextBlockWrap::None => Wrap::None,
    }
}

fn glyphon_color(color: Color) -> GlyphColor {
    let [red, green, blue, alpha] = color.components();
    GlyphColor::rgba(red, green, blue, alpha)
}

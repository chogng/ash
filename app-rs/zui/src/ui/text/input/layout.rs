use cosmic_text::{Attrs, Buffer, Cursor, FontSystem, Metrics, Shaping, Wrap};

use crate::ui::foundation::Point;
use crate::ui::foundation::Rect;
use crate::ui::foundation::Size;
use crate::ui::text::TextStyle;
use crate::ui::text::mapping::shaping_family;
use crate::ui::text::mapping::shaping_style;
use crate::ui::text::mapping::shaping_weight;
use crate::ui::text::new_font_system;

use super::{TextInput, TextInputCompositionCursor};

/// Text metrics used to shape a base text input independently of component chrome.
#[derive(Clone, Debug, PartialEq)]
pub struct TextInputLayoutStyle {
    text_style: TextStyle,
    caret_width: f32,
}

impl TextInputLayoutStyle {
    pub fn new(text_style: TextStyle) -> Self {
        Self {
            text_style,
            caret_width: 1.0,
        }
    }

    pub const fn with_caret_width(mut self, caret_width: f32) -> Self {
        self.caret_width = caret_width;
        self
    }
}

/// Shaped single-line geometry consumed by `InputBox` or another presentation layer.
#[derive(Clone, Debug, PartialEq)]
pub struct TextInputLayout {
    text: String,
    content_bounds: Rect,
    text_origin: Point,
    text_bounds: Size,
    selection_bounds: Vec<Rect>,
    caret_bounds: Option<Rect>,
    preedit_underline_bounds: Vec<Rect>,
}

impl TextInputLayout {
    pub fn text(&self) -> &str {
        &self.text
    }

    pub const fn content_bounds(&self) -> Rect {
        self.content_bounds
    }

    pub const fn text_origin(&self) -> Point {
        self.text_origin
    }

    pub const fn text_bounds(&self) -> Size {
        self.text_bounds
    }

    pub fn selection_bounds(&self) -> &[Rect] {
        &self.selection_bounds
    }

    pub const fn caret_bounds(&self) -> Option<Rect> {
        self.caret_bounds
    }

    pub fn preedit_underline_bounds(&self) -> &[Rect] {
        &self.preedit_underline_bounds
    }
}

/// Owns reusable shaping state for caller-driven single-line text input layout.
///
/// Hosts keep one engine and compute immutable layouts before scene construction. The engine does
/// not own focus, text state, input routing, or IME lifecycle.
pub struct TextInputLayoutEngine {
    font_system: FontSystem,
}

impl TextInputLayoutEngine {
    pub fn new() -> Self {
        Self {
            font_system: new_font_system(),
        }
    }

    /// Measures one unwrapped line with the same shaping and fallback fonts used by UI text.
    pub fn measure_text(&mut self, text: &str, style: &TextStyle) -> Size {
        if text.is_empty() {
            return Size::new(0.0, style.line_height().max(0.0));
        }
        let metrics = Metrics::new(style.font_size(), style.line_height());
        let mut buffer = Buffer::new(&mut self.font_system, metrics);
        buffer.set_wrap(Wrap::None);
        buffer.set_size(None, Some(style.line_height()));
        let attrs = Attrs::new()
            .family(shaping_family(style.family()))
            .weight(shaping_weight(style.weight()))
            .style(shaping_style(style.style()));
        buffer.set_text(text, &attrs, Shaping::Advanced, None);
        buffer.shape_until_scroll(&mut self.font_system, false);
        let width = buffer
            .layout_runs()
            .next()
            .map(|run| run.line_w)
            .unwrap_or(0.0);
        Size::new(width, style.line_height().max(0.0))
    }

    pub fn layout(
        &mut self,
        bounds: Rect,
        input: &TextInput,
        style: &TextInputLayoutStyle,
    ) -> TextInputLayout {
        let projection = DisplayProjection::new(input);
        if bounds.is_empty() || projection.text.is_empty() {
            let caret_bounds = projection.caret.map(|_| {
                caret_rect(
                    bounds.origin.x,
                    bounds,
                    style.text_style.line_height(),
                    style.caret_width,
                )
            });
            return TextInputLayout {
                text: projection.text,
                content_bounds: bounds,
                text_origin: centered_text_origin(bounds, style.text_style.line_height()),
                text_bounds: Size::new(bounds.size.width, style.text_style.line_height()),
                selection_bounds: Vec::new(),
                caret_bounds,
                preedit_underline_bounds: Vec::new(),
            };
        }

        let text_style = &style.text_style;
        let metrics = Metrics::new(text_style.font_size(), text_style.line_height());
        let mut buffer = Buffer::new(&mut self.font_system, metrics);
        buffer.set_wrap(Wrap::None);
        buffer.set_size(None, Some(text_style.line_height()));
        let attrs = Attrs::new()
            .family(shaping_family(text_style.family()))
            .weight(shaping_weight(text_style.weight()))
            .style(shaping_style(text_style.style()));
        buffer.set_text(&projection.text, &attrs, Shaping::Advanced, None);
        buffer.shape_until_scroll(&mut self.font_system, false);

        let caret_x = projection
            .caret
            .and_then(|index| buffer.cursor_position(&Cursor::new(0, index)))
            .map(|(x, _)| x);
        let line_width = buffer
            .layout_runs()
            .next()
            .map(|run| run.line_w)
            .unwrap_or(0.0);
        let scroll_x = caret_x
            .map(|x| (x + style.caret_width - bounds.size.width).max(0.0))
            .unwrap_or(0.0);
        let text_origin = Point::new(
            bounds.origin.x - scroll_x,
            centered_text_origin(bounds, text_style.line_height()).y,
        );
        let selection_bounds = highlight_bounds(
            &buffer,
            projection.selection,
            text_origin,
            text_style.line_height(),
        );
        let preedit_underline_bounds = highlight_bounds(
            &buffer,
            projection.preedit,
            Point::new(
                text_origin.x,
                text_origin.y + text_style.line_height() - 1.0,
            ),
            1.0,
        );
        let caret_bounds = caret_x.map(|x| {
            caret_rect(
                text_origin.x + x,
                bounds,
                text_style.line_height(),
                style.caret_width,
            )
        });

        TextInputLayout {
            text: projection.text,
            content_bounds: bounds,
            text_origin,
            text_bounds: Size::new(
                line_width.max(bounds.size.width) + style.caret_width,
                text_style.line_height(),
            ),
            selection_bounds,
            caret_bounds,
            preedit_underline_bounds,
        }
    }
}

impl Default for TextInputLayoutEngine {
    fn default() -> Self {
        Self::new()
    }
}

struct DisplayProjection {
    text: String,
    selection: std::ops::Range<usize>,
    caret: Option<usize>,
    preedit: std::ops::Range<usize>,
}

impl DisplayProjection {
    fn new(input: &TextInput) -> Self {
        let anchor = clamp_boundary(input.text(), input.anchor());
        let cursor = clamp_boundary(input.text(), input.cursor());
        let selection = anchor.min(cursor)..anchor.max(cursor);
        let Some((preedit, preedit_cursor)) = input.composition() else {
            return Self {
                text: input.text().to_owned(),
                selection,
                caret: Some(cursor),
                preedit: 0..0,
            };
        };

        let insertion = selection.start;
        let mut text = String::with_capacity(input.text().len() - selection.len() + preedit.len());
        text.push_str(&input.text()[..insertion]);
        text.push_str(preedit);
        text.push_str(&input.text()[selection.end..]);
        let caret = match preedit_cursor {
            TextInputCompositionCursor::Visible(range) => {
                Some(insertion + clamp_boundary(preedit, range.end))
            }
            TextInputCompositionCursor::Hidden => None,
        };
        Self {
            text,
            selection: 0..0,
            caret,
            preedit: insertion..insertion + preedit.len(),
        }
    }
}

fn highlight_bounds(
    buffer: &Buffer,
    range: std::ops::Range<usize>,
    origin: Point,
    height: f32,
) -> Vec<Rect> {
    if range.is_empty() {
        return Vec::new();
    }
    buffer
        .layout_runs()
        .flat_map(|run| {
            run.highlight(Cursor::new(0, range.start), Cursor::new(0, range.end))
                .map(move |(x, width)| Rect::from_xywh(origin.x + x, origin.y, width, height))
        })
        .collect()
}

fn centered_text_origin(bounds: Rect, line_height: f32) -> Point {
    Point::new(
        bounds.origin.x,
        bounds.origin.y + (bounds.size.height - line_height).max(0.0) * 0.5,
    )
}

fn caret_rect(x: f32, content_bounds: Rect, line_height: f32, width: f32) -> Rect {
    Rect::from_xywh(
        x,
        centered_text_origin(content_bounds, line_height).y,
        width.max(0.0),
        line_height.min(content_bounds.size.height).max(0.0),
    )
}

fn clamp_boundary(text: &str, requested: usize) -> usize {
    let mut index = requested.min(text.len());
    while !text.is_char_boundary(index) {
        index -= 1;
    }
    index
}

#[cfg(test)]
#[path = "layout_tests.rs"]
mod tests;

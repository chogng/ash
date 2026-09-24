use zui::ui::{Color, FontFamily, FontStyle, FontWeight, TextStyle};

use crate::document::InlineFormat;

const BODY_FONT_SIZE: f32 = 13.0;
const BODY_LINE_HEIGHT: f32 = 20.0;

/// Visual tokens and block geometry owned by the native Markdown component.
#[derive(Clone, Debug, PartialEq)]
pub struct MarkdownStyle {
    body: TextStyle,
    muted: Color,
    link: Color,
    border: Color,
    code_background: Color,
    inline_code_background: Color,
    table_header_background: Color,
    selection_background: Color,
    search_match_background: Color,
    block_gap: f32,
    quote_indent: f32,
    list_indent: f32,
    code_padding: f32,
}

impl MarkdownStyle {
    pub fn new(
        body: TextStyle,
        muted: Color,
        link: Color,
        border: Color,
        code_background: Color,
    ) -> Self {
        Self {
            body,
            muted,
            link,
            border,
            code_background,
            inline_code_background: Color::rgb(244, 231, 236),
            table_header_background: Color::rgba(127, 127, 127, 18),
            selection_background: Color::rgba(65, 125, 205, 92),
            search_match_background: Color::rgba(255, 190, 40, 110),
            block_gap: 10.0,
            quote_indent: 14.0,
            list_indent: 22.0,
            code_padding: 10.0,
        }
    }

    pub fn light() -> Self {
        Self::new(
            TextStyle::new(BODY_FONT_SIZE, Color::rgb(38, 38, 41))
                .with_line_height(BODY_LINE_HEIGHT),
            Color::rgb(102, 102, 110),
            Color::rgb(0, 102, 204),
            Color::rgb(210, 210, 215),
            Color::rgb(245, 245, 247),
        )
    }

    pub fn with_block_gap(mut self, block_gap: f32) -> Self {
        self.block_gap = block_gap;
        self
    }

    pub fn with_table_header_background(mut self, background: Color) -> Self {
        self.table_header_background = background;
        self
    }

    pub fn with_inline_code_background(mut self, background: Color) -> Self {
        self.inline_code_background = background;
        self
    }

    pub fn with_selection_background(mut self, background: Color) -> Self {
        self.selection_background = background;
        self
    }

    pub fn with_search_match_background(mut self, background: Color) -> Self {
        self.search_match_background = background;
        self
    }

    pub const fn body(&self) -> &TextStyle {
        &self.body
    }

    pub(crate) fn heading(&self, level: u8) -> TextStyle {
        let font_size = match level {
            1 => 24.0,
            2 => 20.0,
            3 => 17.0,
            4 => 15.0,
            _ => BODY_FONT_SIZE,
        };
        TextStyle::new(font_size, self.body.color())
            .with_family(self.body.family().clone())
            .with_line_height(font_size * 1.3)
            .with_weight(FontWeight::Bold)
    }

    pub(crate) fn code_block(&self) -> TextStyle {
        TextStyle::new(12.0, self.body.color())
            .with_family(FontFamily::Monospace)
            .with_line_height(18.0)
    }

    pub(crate) fn inline(&self, base: &TextStyle, format: &InlineFormat) -> TextStyle {
        let color = if format.link.is_some() {
            self.link
        } else if format.strikethrough {
            self.muted
        } else {
            base.color()
        };
        TextStyle::new(base.font_size(), color)
            .with_family(if format.code {
                FontFamily::Monospace
            } else if format.math {
                FontFamily::Serif
            } else {
                base.family().clone()
            })
            .with_line_height(base.line_height())
            .with_weight(if format.strong {
                FontWeight::Bold
            } else {
                base.weight()
            })
            .with_style(if format.emphasis || format.math {
                FontStyle::Italic
            } else {
                base.style()
            })
    }

    pub(crate) const fn muted(&self) -> Color {
        self.muted
    }

    pub(crate) const fn border(&self) -> Color {
        self.border
    }

    pub(crate) const fn code_background(&self) -> Color {
        self.code_background
    }

    pub(crate) const fn inline_code_background(&self) -> Color {
        self.inline_code_background
    }

    pub(crate) const fn link(&self) -> Color {
        self.link
    }

    pub(crate) const fn table_header_background(&self) -> Color {
        self.table_header_background
    }

    pub(crate) const fn selection_background(&self) -> Color {
        self.selection_background
    }

    pub(crate) const fn search_match_background(&self) -> Color {
        self.search_match_background
    }

    pub(crate) fn math_block(&self) -> TextStyle {
        TextStyle::new(self.body.font_size() * 1.1, self.body.color())
            .with_family(FontFamily::Serif)
            .with_line_height(self.body.line_height() * 1.25)
            .with_style(FontStyle::Italic)
    }

    pub(crate) fn block_gap(&self) -> f32 {
        self.block_gap.max(0.0)
    }

    pub(crate) fn quote_indent(&self) -> f32 {
        self.quote_indent.max(0.0)
    }

    pub(crate) fn list_indent(&self) -> f32 {
        self.list_indent.max(0.0)
    }

    pub(crate) fn code_padding(&self) -> f32 {
        self.code_padding.max(0.0)
    }
}

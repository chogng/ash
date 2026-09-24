mod highlight;
mod highlight_streaming;
mod interaction;
mod layout;
pub(crate) mod markdown;
mod palette;
mod text;

pub(crate) use highlight::SyntaxPalette;
pub(crate) use highlight::code_within_limits;
pub(crate) use highlight::highlight_code;
pub(crate) use highlight_streaming::StreamingCodeHighlighter;
pub(crate) use interaction::InteractionState;
pub(crate) use interaction::InteractionTarget;
pub(crate) use interaction::action_style;
pub(crate) use interaction::interaction_style;
pub(crate) use interaction::selection_marker;
pub(crate) use layout::bottom_anchored_area;
pub(crate) use layout::horizontal_margin;
pub(crate) use palette::RenderContext;
pub(crate) use palette::RenderTheme;
pub(crate) use palette::ThemePalette;
pub(crate) use palette::ThemeRgb;
#[cfg(test)]
pub(crate) use palette::test_context;
use ratatui::Frame;
use ratatui::layout::Rect;
pub(crate) use text::line_to_borrowed;
pub(crate) use text::prefix_lines;
pub(crate) use text::push_owned_lines;
pub(crate) use text::styled_text_lines;
pub(crate) use text::truncate_with_ellipsis;
pub(crate) use text::wrapped_height;

/// A terminal surface that can measure and draw itself from immutable presentation state.
pub(crate) trait Renderable {
    fn desired_height(&self, width: u16, context: RenderContext<'_>) -> u16;

    fn render(&self, frame: &mut Frame<'_>, area: Rect, context: RenderContext<'_>);
}

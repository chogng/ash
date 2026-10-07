use super::CellView;
use crate::render::InteractionState;
use crate::render::InteractionTarget;
use crate::render::RenderContext;
use crate::render::interaction_style;
use crate::render::prefix_lines;
use crate::render::push_owned_lines;
use crate::render::styled_text_lines;
use ratatui::style::Modifier;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;

pub(in crate::thread::transcript) fn prefixed_body(
    text: &str,
    marker: &str,
    color: ratatui::style::Color,
    view: &CellView<'_>,
    context: RenderContext<'_>,
    width: u16,
) -> Vec<Line<'static>> {
    let body = styled_text_lines(text, selected_style(view.selected, context));
    let prefixed = prefix_lines(
        body,
        Span::styled(
            format!("{marker} "),
            Style::default().fg(color).add_modifier(Modifier::BOLD),
        ),
        Span::raw("  "),
    );
    let mut lines = Vec::new();
    push_owned_lines(&prefixed, &mut lines);
    crate::render::wrap_lines(lines, usize::from(width))
}
pub(super) fn selected_style(selected: bool, context: RenderContext<'_>) -> Style {
    if selected {
        interaction_style(
            context,
            InteractionState {
                target: InteractionTarget::Rest,
                selected: true,
                hovered: false,
                pressed: false,
            },
        )
    } else {
        Style::default()
    }
}

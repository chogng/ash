use super::CellView;
use super::DetailFormat;
use crate::render::InteractionState;
use crate::render::InteractionTarget;
use crate::render::RenderContext;
use crate::render::interaction_style;
use crate::render::prefix_lines;
use crate::render::push_owned_lines;
use crate::render::styled_text_lines;
use ash_ansi_escape::ansi_text;
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
    lines
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

pub(in crate::thread::transcript) fn push_detail_lines(
    lines: &mut Vec<Line<'static>>,
    format: DetailFormat,
    detail: &str,
    context: RenderContext<'_>,
) {
    if matches!(format, DetailFormat::Plain) {
        let detail_lines = prefix_lines(
            styled_text_lines(detail, Style::default().fg(context.muted())),
            Span::styled("└─ ", Style::default().fg(context.muted())),
            Span::raw("   "),
        );
        push_owned_lines(&detail_lines, lines);
        return;
    }

    let mut output = ansi_text(detail).lines;
    if output.is_empty() {
        output.push(Line::default());
    }
    for line in &mut output {
        for span in &mut line.spans {
            if span.style.fg.is_none() {
                span.style.fg = Some(context.muted());
            }
        }
    }
    lines.extend(prefix_lines(
        output,
        Span::styled("└─ ", Style::default().fg(context.muted())),
        Span::raw("   "),
    ));
}

use super::StatusLineModel;
use super::StatusLineRuntime;
use super::model::StatusLineSegment;
use super::model::StatusLineSegmentKind;
use super::model::approval_mode_display;
use super::model::approval_mode_text;
use crate::render::RenderContext;
use crate::thread::TurnApprovalModes;
use ash_protocol::ApprovalMode;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Paragraph;

pub(crate) fn draw(
    frame: &mut Frame<'_>,
    area: Rect,
    status_line: &StatusLineModel,
    approval: TurnApprovalModes,
    runtime: StatusLineRuntime,
    context: RenderContext<'_>,
) {
    if area.is_empty() {
        return;
    }

    let top = status_line.top_segments_for_width(usize::from(area.width), runtime);
    let policy_width = usize::from(area.width);
    let policy = status_line.policy_text_for_width(policy_width, approval);
    let lines = if area.height == 1 {
        if policy.is_empty() {
            vec![top_line(top, context)]
        } else {
            vec![styled_policy_line(policy, approval, context)]
        }
    } else {
        vec![
            top_line(top, context),
            styled_policy_line(policy, approval, context),
        ]
    };
    frame.render_widget(Paragraph::new(lines), area);
}

fn top_line(segments: Vec<StatusLineSegment>, context: RenderContext<'_>) -> Line<'static> {
    styled_segments(segments, context, Style::default())
}

fn styled_segments(
    segments: Vec<StatusLineSegment>,
    context: RenderContext<'_>,
    surface: Style,
) -> Line<'static> {
    Line::from(
        segments
            .into_iter()
            .map(|segment| {
                let (text, kind) = segment.into_parts();
                let color = match kind {
                    StatusLineSegmentKind::Chrome => context.chat_input_chrome(),
                    StatusLineSegmentKind::Inserted => context.inserted_marker(),
                    StatusLineSegmentKind::Removed => context.removed_marker(),
                    StatusLineSegmentKind::Progress => context.accent(),
                };
                Span::styled(text, surface.patch(Style::default().fg(color)))
            })
            .collect::<Vec<_>>(),
    )
}

pub(crate) fn context_header_line(
    status_line: &StatusLineModel,
    progress: bool,
    context: RenderContext<'_>,
    surface: Style,
) -> Line<'static> {
    styled_segments(
        status_line.context_header_segments(progress),
        context,
        surface,
    )
}

pub(crate) fn header_line(
    status_line: &StatusLineModel,
    width: usize,
    runtime: StatusLineRuntime,
    context: RenderContext<'_>,
) -> Line<'static> {
    top_line(
        status_line.header_segments_for_width(width, runtime),
        context,
    )
}

pub(crate) fn policy_line(
    status_line: &StatusLineModel,
    width: usize,
    approval: TurnApprovalModes,
    context: RenderContext<'_>,
) -> Line<'static> {
    styled_policy_line(
        status_line.policy_text_for_width(width, approval),
        approval,
        context,
    )
}

fn styled_policy_line(
    policy: String,
    approval: TurnApprovalModes,
    context: RenderContext<'_>,
) -> Line<'static> {
    let permission_prefix = approval_mode_text(approval);
    if policy != permission_prefix {
        return Line::styled(
            context.localize(&policy).into_owned(),
            Style::default().fg(context.chat_input_chrome()),
        );
    }
    let next = approval_mode_display(approval.next);
    if let Some(current_mode) = approval.current.filter(|current| *current != approval.next) {
        let current = approval_mode_display(current_mode);
        let spans = vec![
            Span::styled(
                current.icon,
                Style::default().fg(mode_color(current_mode, context)),
            ),
            Span::styled(
                format!(
                    " {}: {} · ",
                    context.localize("current"),
                    context.localize(current.label)
                ),
                Style::default().fg(context.chat_input_chrome()),
            ),
            Span::styled(
                next.icon,
                Style::default().fg(mode_color(approval.next, context)),
            ),
            Span::styled(
                format!(
                    " {}: {}",
                    context.localize("next"),
                    context.localize(next.label)
                ),
                Style::default().fg(context.chat_input_chrome()),
            ),
        ];
        return Line::from(spans);
    }

    let spans = vec![
        Span::styled(
            next.icon,
            Style::default().fg(mode_color(approval.next, context)),
        ),
        Span::styled(
            format!(" {}", context.localize(next.label)),
            Style::default().fg(context.chat_input_chrome()),
        ),
    ];
    Line::from(spans)
}

fn mode_color(approval_mode: ApprovalMode, context: RenderContext<'_>) -> ratatui::style::Color {
    match approval_mode {
        ApprovalMode::AskPermissions => context.warning(),
        ApprovalMode::AutoReview => context.accent(),
        ApprovalMode::BypassPermissions => context.danger(),
    }
}

#[cfg(test)]
#[path = "view_tests.rs"]
mod tests;

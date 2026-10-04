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

pub(crate) fn draw_info(
    frame: &mut Frame<'_>,
    area: Rect,
    status_line: &StatusLineModel,
    runtime: StatusLineRuntime,
    context: RenderContext<'_>,
) {
    frame.render_widget(
        Paragraph::new(top_line(
            status_line.top_segments_for_width(area.width.into(), runtime),
            context,
        )),
        area,
    );
}

pub(crate) fn draw_fullscreen_info(
    frame: &mut Frame<'_>,
    area: Rect,
    status_line: &StatusLineModel,
    runtime: StatusLineRuntime,
    context: RenderContext<'_>,
) {
    frame.render_widget(
        Paragraph::new(top_line(
            status_line.fullscreen_footer_segments_for_width(area.width.into(), runtime),
            context,
        )),
        area,
    );
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
                    StatusLineSegmentKind::Mode(mode) => context.mode_color(mode),
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
    let mode = approval.current.unwrap_or(approval.next);
    let permission = approval_mode_display(mode);
    let spans = vec![
        Span::styled(
            permission.icon,
            Style::default().fg(mode_color(mode, context)),
        ),
        Span::styled(
            format!(" {}", context.localize(permission.label)),
            Style::default().fg(context.chat_input_chrome()),
        ),
    ];
    Line::from(spans)
}

fn mode_color(approval_mode: ApprovalMode, context: RenderContext<'_>) -> ratatui::style::Color {
    match approval_mode {
        ApprovalMode::Manual => context.warning(),
        ApprovalMode::Auto => context.accent(),
        ApprovalMode::BypassPermissions => context.danger(),
    }
}

#[cfg(test)]
#[path = "view_tests.rs"]
mod tests;

use super::layout::Layout;
use crate::app::App;
use crate::keymap::bindings;
use crate::status as status_line;
use crate::thread::composer as chat_input;
use crate::widgets::key_hint;
use crate::widgets::key_hint::KeyHints;
use ash_memory_diagnostics::ProcessResourceDemand;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::widgets::Paragraph;

enum BottomContent<'a> {
    Keys(&'a KeyHints),
    Warning(String),
    Muted(&'a str),
    StatusLine,
}

pub(super) fn process_resource_demand(app: &App, areas: &Layout) -> ProcessResourceDemand {
    if app
        .command_panel()
        .is_some_and(|panel| super::panel::process_resources_visible(panel, areas.session.composer))
    {
        return ProcessResourceDemand::Detailed;
    }
    if !matches!(bottom_content(app), BottomContent::StatusLine) {
        return ProcessResourceDemand::Disabled;
    }
    let area = chat_input::content_area(areas.session.bottom);
    if area.is_empty() {
        return ProcessResourceDemand::Disabled;
    }
    let policy = app
        .status_line()
        .policy_text_for_width(usize::from(area.width), app.approval_mode_status());
    if area.height == 1 && !policy.is_empty() {
        return ProcessResourceDemand::Disabled;
    }
    app.status_line()
        .visible_process_resources(usize::from(area.width), app.status_line_runtime())
        .map_or(
            ProcessResourceDemand::Disabled,
            ProcessResourceDemand::Summary,
        )
}

pub(super) fn draw(
    frame: &mut Frame<'_>,
    area: Rect,
    app: &App,
    context: crate::render::RenderContext<'_>,
) {
    match bottom_content(app) {
        BottomContent::Keys(hints) => key_hint::draw(
            frame,
            bottom_row(area),
            hints,
            app.key_hint_style(),
            context,
        ),
        BottomContent::Warning(text) => frame.render_widget(
            Paragraph::new(text).style(Style::default().fg(context.warning())),
            chat_input::content_area(bottom_row(area)),
        ),
        BottomContent::Muted(text) => frame.render_widget(
            Paragraph::new(text).style(Style::default().fg(context.muted())),
            chat_input::content_area(bottom_row(area)),
        ),
        BottomContent::StatusLine => draw_status_line(frame, area, app, context),
    }
}

fn bottom_content(app: &App) -> BottomContent<'_> {
    if let Some(manager) = app.issue_manager() {
        return BottomContent::Keys(manager.key_hints());
    }
    if app.overlay().is_some() || app.session_preview().is_some() {
        return BottomContent::Keys(&bindings::CLOSE_HINTS);
    }
    if let Some(hints) = app.command_panel_key_hints() {
        return BottomContent::Keys(hints);
    }
    if app.session_manager_view().is_some() {
        return BottomContent::Keys(app.session_manager_hint());
    }
    if let Some(approval) = app.approval_view() {
        return if approval.submitting {
            BottomContent::Muted("Waiting for the request result")
        } else {
            BottomContent::Keys(&bindings::APPROVAL_HINTS)
        };
    }
    if let Some(query) = app.query_view() {
        if query.submitting {
            return BottomContent::Muted("Waiting for the request result");
        }
        return BottomContent::Keys(if query.custom_answer.is_some() {
            &bindings::CUSTOM_ANSWER_HINTS
        } else {
            &bindings::ANSWER_HINTS
        });
    }
    if app.queue_focused() {
        return BottomContent::Keys(app.queue_key_hints());
    }
    if app.transcript_selection_active() {
        return BottomContent::Keys(&bindings::TRANSCRIPT_HINTS);
    }
    if app.agent_thread_switcher_focused() {
        return BottomContent::Keys(&bindings::THREAD_HINTS);
    }
    if let Some(prefix) = app.pending_key_chord_label() {
        return BottomContent::Warning(format!(
            "{prefix} … waiting for next key · {}",
            bindings::CANCEL_HINTS.text()
        ));
    }
    if app.viewed_thread_completed() {
        return BottomContent::Muted("completed · choose Main or another Subagent");
    }
    BottomContent::StatusLine
}

fn draw_status_line(
    frame: &mut Frame<'_>,
    area: Rect,
    app: &App,
    context: crate::render::RenderContext<'_>,
) {
    status_line::draw(
        frame,
        chat_input::content_area(area),
        app.status_line(),
        app.approval_mode_status(),
        app.status_line_runtime(),
        context,
    );
}

fn bottom_row(area: Rect) -> Rect {
    Rect {
        y: area.bottom().saturating_sub(1),
        height: area.height.min(1),
        ..area
    }
}

pub(super) fn draw_tip(
    frame: &mut Frame<'_>,
    area: Rect,
    app: &App,
    context: crate::render::RenderContext<'_>,
) {
    if !area.is_empty()
        && let Some(text) = app.top_tip().text(app.screen_navigation_tip())
    {
        key_hint::draw_right(frame, area, text, context);
    }
}

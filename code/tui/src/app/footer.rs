//! Bottom-row allocation, status and hint composition shared by both screen modes.

use crate::app::App;
use crate::keymap::bindings;
use crate::render::RenderContext;
use crate::render::horizontal_margin;
use crate::terminal::ScreenMode;
use crate::widgets::key_hint;
use crate::widgets::key_hint::KeyHints;
use ash_memory_diagnostics::ProcessResourceDemand;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::text::Span;
use ratatui::widgets::Paragraph;

pub(super) fn chat_visible(app: &App) -> bool {
    app.command_panel().is_none()
        && app.overlay().is_none()
        && app.session_preview().is_none()
        && app.session_manager_view().is_none()
        && app.issue_manager().is_none()
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(super) struct Layout {
    pub(super) statusline: Rect,
    pub(super) hintline: Rect,
}

impl Layout {
    /// Pages supply the bottom space; the final row belongs to permissions and actions.
    pub(super) fn new(area: Rect) -> Self {
        Self {
            statusline: Rect {
                height: area.height.saturating_sub(1),
                ..area
            },
            hintline: Rect {
                y: area.bottom().saturating_sub(area.height.min(1)),
                height: area.height.min(1),
                ..area
            },
        }
    }

    /// Panels and modal containers reserve their own space for action hints only.
    pub(super) fn hints(area: Rect) -> Self {
        Self {
            hintline: area,
            ..Self::default()
        }
    }
}

enum BottomContent<'a> {
    Keys(&'a KeyHints),
    Warning(String),
    Muted(&'a str),
    InputHints,
}

pub(super) fn draw(frame: &mut Frame<'_>, areas: Layout, app: &App, context: RenderContext<'_>) {
    if chat_visible(app) {
        let statusline = horizontal_margin(areas.statusline, 2);
        match app.screen_mode() {
            ScreenMode::Fullscreen => crate::status::draw_fullscreen_info(
                frame,
                statusline,
                app.status_line(),
                app.status_line_runtime(),
                context,
            ),
            ScreenMode::Inline => crate::status::draw_info(
                frame,
                statusline,
                app.status_line(),
                app.status_line_runtime(),
                context,
            ),
        }
    }
    let area = areas.hintline;
    let content = horizontal_margin(
        Rect {
            y: area.bottom().saturating_sub(1),
            height: area.height.min(1),
            ..area
        },
        2,
    );
    frame.render_widget(
        Paragraph::new(line(app, content.width.into(), context)),
        content,
    );
}

pub(super) fn line(app: &App, width: usize, context: RenderContext<'_>) -> Line<'static> {
    match bottom_content(app) {
        BottomContent::Keys(hints) => key_hint::line(hints, width, app.key_hint_style(), context),
        BottomContent::InputHints => input_line(app, width, context),
        BottomContent::Warning(text) => Line::styled(text, Style::default().fg(context.warning())),
        BottomContent::Muted(text) => Line::styled(
            context.localize(text).into_owned(),
            Style::default().fg(context.muted()),
        ),
    }
}

fn input_line(app: &App, width: usize, context: RenderContext<'_>) -> Line<'static> {
    let hint = key_hint::line(&input_hints(app), width, app.key_hint_style(), context);
    if !chat_visible(app) || !app.chat_input_focused() {
        return hint;
    }
    // Reserve the available action before shortening permission text on narrow terminals.
    let mut line = crate::status::policy_line(
        app.status_line(),
        width.saturating_sub(hint.width() + usize::from(hint.width() > 0) * 3),
        app.approval_mode_status(),
        context,
    );
    if line.width() > 0 && hint.width() > 0 {
        line.spans
            .push(Span::styled(" · ", Style::default().fg(context.muted())));
    }
    line.spans.extend(hint.spans);
    line
}

/// Sampling follows the same row and width budget as the statistics drawn above.
pub(super) fn process_resource_demand(app: &App, areas: Layout) -> ProcessResourceDemand {
    let statusline = horizontal_margin(areas.statusline, 2);
    if !chat_visible(app) || statusline.is_empty() {
        return ProcessResourceDemand::Disabled;
    }
    let runtime = app.status_line_runtime();
    let resources = match app.screen_mode() {
        ScreenMode::Fullscreen => app
            .status_line()
            .fullscreen_footer_process_resources(statusline.width.into(), runtime),
        ScreenMode::Inline => app
            .status_line()
            .visible_process_resources(statusline.width.into(), runtime),
    };
    resources.map_or(
        ProcessResourceDemand::Disabled,
        ProcessResourceDemand::Summary,
    )
}

pub(super) fn draw_modal(frame: &mut Frame<'_>, area: Rect, app: &App, context: RenderContext<'_>) {
    context.clear_hyperlinks(area);
    frame.render_widget(ratatui::widgets::Clear, area);
    frame.render_widget(
        ratatui::widgets::Block::default().style(
            Style::default()
                .fg(context.foreground())
                .bg(context.background()),
        ),
        area,
    );
    frame.render_widget(
        Paragraph::new(modal_hint_lines(app, area)),
        horizontal_margin(area, 2),
    );
}

pub(super) fn modal_hint_lines(app: &App, available: Rect) -> Vec<ratatui::text::Line<'static>> {
    if available.is_empty() {
        return Vec::new();
    }
    let content = horizontal_margin(available, 2);
    let lines = crate::render::wrap_lines(
        vec![line(app, usize::MAX, app.render_context())],
        content.width.into(),
    );
    // When wrapping would consume the modal's remaining space, keep the exit action
    // through the same action prioritization used by the single-row page hintline.
    if lines.len() > usize::from(available.height) {
        vec![line(app, content.width.into(), app.render_context())]
    } else {
        lines
    }
}

pub(super) fn draw_tip(
    frame: &mut Frame<'_>,
    area: Rect,
    app: &App,
    navigation: Option<&str>,
    context: RenderContext<'_>,
) {
    if let Some(mut status) = app.dictation_status() {
        if let Some(hints) = app.dictation_key_hints() {
            status.push_str(" · ");
            status.push_str(&hints.localized_text(context.language()));
        }
        frame.render_widget(
            Paragraph::new(status).style(Style::default().fg(context.muted())),
            horizontal_margin(area, 2),
        );
        return;
    }
    match app.screen_mode() {
        crate::terminal::ScreenMode::Fullscreen => app
            .top_tip()
            .draw_fullscreen(frame, area, navigation, context),
        crate::terminal::ScreenMode::Inline => {
            if let Some(text) = app.top_tip().localized_text(navigation, context.language()) {
                key_hint::draw_right(frame, area, &text, context);
            }
        }
    }
}

fn input_hints(app: &App) -> KeyHints {
    if app.screen_mode() == ScreenMode::Fullscreen && app.fullscreen.header_focused() {
        let mut hints = KeyHints::new()
            .with_compact_action("←→", "select")
            .with_compact_action("Enter", "open")
            .with_compact_action(
                "Esc",
                if app.session_manager_view().is_some() {
                    "return"
                } else {
                    "input"
                },
            );
        if let Some(target) = app.fullscreen.header.selected() {
            hints = hints.with_note(target.label());
        }
        return hints;
    }
    if app.fullscreen_welcome_visible() && !app.fullscreen.input_focused() {
        return KeyHints::new()
            .with_compact_action("Enter", "select")
            .with_compact_action("↑↓", "actions")
            .with_compact_action("Esc", "input");
    }
    with_dashboard_hint(app, KeyHints::new())
}

fn with_dashboard_hint(app: &App, hints: KeyHints) -> KeyHints {
    if app.can_open_dashboard_from_input() {
        hints.with_compact_action(bindings::DASHBOARD_OPEN.keys(), "Dashboard")
    } else {
        hints
    }
}

fn bottom_content(app: &App) -> BottomContent<'_> {
    if app.overlay().is_some() {
        return BottomContent::Keys(if app.screen_mode() == ScreenMode::Fullscreen {
            &bindings::FULLSCREEN_DETAIL_HINTS
        } else {
            &bindings::CLOSE_HINTS
        });
    }
    if let Some(hints) = app.command_panel_key_hints() {
        return BottomContent::Keys(
            if app.screen_mode() == ScreenMode::Fullscreen && app.fullscreen.modal_alert_active() {
                &bindings::MODAL_EDITING_HINTS
            } else {
                hints
            },
        );
    }
    if let Some(manager) = app.issue_manager() {
        return BottomContent::Keys(manager.key_hints());
    }
    if app.session_preview().is_some() {
        return BottomContent::Keys(&bindings::CLOSE_HINTS);
    }
    if app.screen_mode() == ScreenMode::Fullscreen && app.fullscreen.header_focused() {
        return BottomContent::InputHints;
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
            "{prefix} … {} · {}",
            crate::nls::localize(app.language(), "waiting for next key"),
            bindings::CANCEL_HINTS.localized_text(app.language())
        ));
    }
    if app.viewed_thread_completed() {
        return BottomContent::Muted("completed · choose Main or another Subagent");
    }
    BottomContent::InputHints
}

#[cfg(test)]
#[path = "footer_tests.rs"]
mod tests;

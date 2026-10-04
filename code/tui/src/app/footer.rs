//! Shared hintline and tipline content for both screen modes.

use crate::app::App;
use crate::keymap::bindings;
use crate::render::RenderContext;
use crate::render::horizontal_margin;
use crate::terminal::ScreenMode;
use crate::widgets::key_hint;
use crate::widgets::key_hint::KeyHints;
use ratatui::Frame;
use ratatui::layout::Alignment;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::text::Line;
use ratatui::widgets::Paragraph;

pub(super) fn chat_visible(app: &App) -> bool {
    app.command_panel().is_none()
        && app.overlay().is_none()
        && app.session_preview().is_none()
        && app.session_manager_view().is_none()
        && app.issue_manager().is_none()
}

enum BottomContent<'a> {
    Keys(&'a KeyHints),
    Warning(String),
    Muted(&'a str),
    InputHints,
}

pub(super) fn context_hintline_active(app: &App) -> bool {
    !matches!(bottom_content(app), BottomContent::InputHints)
}

pub(super) fn draw(frame: &mut Frame<'_>, area: Rect, app: &App, context: RenderContext<'_>) {
    let content = horizontal_margin(
        Rect {
            y: area.bottom().saturating_sub(1),
            height: area.height.min(1),
            ..area
        },
        2,
    );
    frame.render_widget(
        Paragraph::new(line(app, content.width.into(), context)).alignment(
            if app.screen_mode() == ScreenMode::Inline && chat_visible(app) {
                Alignment::Right
            } else {
                Alignment::Left
            },
        ),
        content,
    );
}

pub(super) fn line(app: &App, width: usize, context: RenderContext<'_>) -> Line<'static> {
    match bottom_content(app) {
        BottomContent::Keys(hints) => key_hint::line(hints, width, app.key_hint_style(), context),
        BottomContent::InputHints => {
            key_hint::line(&input_hints(app), width, app.key_hint_style(), context)
        }
        BottomContent::Warning(text) => Line::styled(text, Style::default().fg(context.warning())),
        BottomContent::Muted(text) => Line::styled(
            context.localize(text).into_owned(),
            Style::default().fg(context.muted()),
        ),
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
    if app.fullscreen_home_visible() {
        if app.fullscreen_welcome_visible() && !app.fullscreen.input_focused() {
            return KeyHints::new()
                .with_compact_action("Enter", "select")
                .with_compact_action("↑↓", "actions")
                .with_compact_action("Esc", "input");
        }
        let hints = with_dashboard_hint(app, KeyHints::new().with_compact_action("Enter", "send"));
        let hints = if app.fullscreen_welcome_visible() {
            hints
                .with_compact_action("Tab", "actions")
                .with_compact_action("/", "commands")
        } else {
            hints.with_compact_action("/", "commands")
        };
        return hints;
    }
    let mut hints = with_dashboard_hint(
        app,
        KeyHints::new().with_compact_action(
            "Enter",
            if app.active_turn().is_some() {
                "queue"
            } else {
                "send"
            },
        ),
    );
    if let Some(keys) = app.app_keymap.action_hint(
        crate::keymap::AppKeymapAction::CycleCollaborationMode,
        app.app_keymap_context(true),
    ) {
        hints = hints.with_compact_action(keys, "mode");
    }
    let context = app.app_keymap_context(true);
    let lower = app.app_keymap.action_hint(
        crate::keymap::AppKeymapAction::DecreaseReasoningEffort,
        context,
    );
    let raise = app.app_keymap.action_hint(
        crate::keymap::AppKeymapAction::IncreaseReasoningEffort,
        context,
    );
    // Keep the pair together so a narrow terminal does not advertise only one direction.
    match (lower, raise) {
        (Some(lower), Some(raise)) => {
            let keys = match (lower.strip_suffix('↓'), raise.strip_suffix('↑')) {
                (Some(lower_prefix), Some(raise_prefix)) if lower_prefix == raise_prefix => {
                    format!("{lower}/↑")
                }
                _ => format!("{lower}/{raise}"),
            };
            hints = hints.with_compact_action(keys, "effort");
        }
        (Some(lower), None) => hints = hints.with_compact_action(lower, "lower effort"),
        (None, Some(raise)) => hints = hints.with_compact_action(raise, "raise effort"),
        (None, None) => {}
    }
    hints
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

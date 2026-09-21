use crate::app::App;
use crate::keymap::bindings;
use crate::render::horizontal_margin;
use crate::thread::composer as chat_input;
use crate::widgets::key_hint;
use crate::widgets::key_hint::KeyHints;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::widgets::Paragraph;

enum BottomContent<'a> {
    Keys(&'a KeyHints),
    Warning(String),
    Muted(&'a str),
    InputHints,
}

pub(super) fn draw(
    frame: &mut Frame<'_>,
    area: Rect,
    app: &App,
    context: crate::render::RenderContext<'_>,
) {
    if super::modal::is_open(app) {
        return;
    }
    match bottom_content(app) {
        BottomContent::Keys(hints) => {
            key_hint::draw(
                frame,
                bottom_row(area),
                hints,
                app.key_hint_style(),
                context,
            );
        }
        BottomContent::Warning(text) => frame.render_widget(
            Paragraph::new(text).style(Style::default().fg(context.warning())),
            chat_input::content_area(bottom_row(area)),
        ),
        BottomContent::Muted(text) => frame.render_widget(
            Paragraph::new(context.localize(text)).style(Style::default().fg(context.muted())),
            chat_input::content_area(bottom_row(area)),
        ),
        BottomContent::InputHints => {
            let content = horizontal_margin(bottom_row(area), 2);
            let hints = input_hints(app);
            key_hint::draw_content(frame, content, &hints, app.key_hint_style(), context);
        }
    }
}

fn input_hints(app: &App) -> KeyHints {
    if app.fullscreen.header_focused() {
        let hints = KeyHints::new()
            .with_compact_action("←→", "select")
            .with_compact_action("Enter", "open")
            .with_compact_action("Esc", "input");
        return app
            .fullscreen
            .header
            .selected()
            .map_or(hints.clone(), |target| hints.with_note(target.label()));
    }
    if app.fullscreen_home_visible() {
        if app.fullscreen_welcome_visible() && !app.fullscreen.input_focused() {
            return KeyHints::new()
                .with_compact_action("Enter", "select")
                .with_compact_action("↑↓", "actions")
                .with_compact_action("Esc", "input");
        }
        let hints = KeyHints::new().with_compact_action("Enter", "send");
        return if app.fullscreen_welcome_visible() {
            hints
                .with_compact_action("Tab", "actions")
                .with_compact_action("/", "commands")
        } else {
            hints.with_compact_action("/", "commands")
        };
    }
    let mut hints = KeyHints::new().with_compact_action(
        "Enter",
        if app.active_turn().is_some() {
            "queue"
        } else {
            "send"
        },
    );
    if let Some(keys) = app.app_keymap.action_hint(
        crate::keymap::AppKeymapAction::CycleApprovalMode,
        app.app_keymap_context(true),
    ) {
        hints = hints.with_compact_action(keys, "permissions");
    }
    hints.with_note("/home")
}

fn bottom_content(app: &App) -> BottomContent<'_> {
    if let Some(manager) = app.issue_manager() {
        return BottomContent::Keys(manager.key_hints());
    }
    if app.session_preview().is_some() {
        return BottomContent::Keys(&bindings::CLOSE_HINTS);
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
        return BottomContent::Keys(&bindings::QUEUE_HINTS);
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
    let navigation = if app.fullscreen.home_visible() {
        let persistent = if app.sessions.pending_submission.is_some() {
            Some(("Starting session…", context.muted()))
        } else {
            app.sessions
                .creation_error
                .as_deref()
                .map(|error| (error, context.danger()))
        };
        if let Some((text, color)) = persistent {
            frame.render_widget(
                Paragraph::new(context.localize(text)).style(Style::default().fg(color)),
                chat_input::content_area(area),
            );
            return;
        }
        app.fullscreen_welcome_visible()
            .then_some(if app.sessions.active_session_id().is_some() {
                "Type a new task · Tab actions · Esc return"
            } else if area.width < 54 {
                "Type a task · Tab actions"
            } else {
                "Type a task to begin, or use Tab to choose an action."
            })
    } else {
        app.screen_navigation_tip()
    };
    app.top_tip().draw_fullscreen(
        frame,
        area,
        navigation,
        if !super::modal::is_open(app) && matches!(bottom_content(app), BottomContent::InputHints) {
            crate::status::policy_line(
                app.status_line(),
                horizontal_margin(area, 2).width.into(),
                app.approval_mode_status(),
                context,
            )
        } else {
            Default::default()
        },
        context,
    );
}

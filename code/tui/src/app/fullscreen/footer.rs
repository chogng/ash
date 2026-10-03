use crate::app::App;
use crate::thread::composer as chat_input;
use crate::widgets::key_hint::KeyHints;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::widgets::Paragraph;

pub(super) fn draw(
    frame: &mut Frame<'_>,
    areas: &super::layout::Layout,
    app: &App,
    context: crate::render::RenderContext<'_>,
) {
    if !super::modal::is_open(app) {
        if crate::app::footer::chat_visible(app) {
            crate::status::draw_fullscreen_info(
                frame,
                crate::render::horizontal_margin(areas.session.statusline, 2),
                app.status_line(),
                app.approval_mode_status(),
                app.status_line_runtime(),
                context,
            );
        }
        crate::app::footer::draw(
            frame,
            areas.session.hintline,
            app,
            &input_hints(app),
            context,
        );
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
    crate::app::footer::input_hints(app)
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
    if !super::modal::is_open(app) {
        crate::app::footer::draw_tip(frame, area, app, navigation, context);
    }
}

use crate::app::App;
use crate::thread::composer as chat_input;
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
    if super::modal::is_open(app) {
        let area = areas.session.hintline;
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
            crate::render::horizontal_margin(area, 2),
        );
    } else {
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
        crate::app::footer::draw(frame, areas.session.hintline, app, context);
    }
}

pub(super) fn modal_hint_lines(app: &App, available: Rect) -> Vec<ratatui::text::Line<'static>> {
    if available.is_empty() {
        return Vec::new();
    }
    let content = crate::render::horizontal_margin(available, 2);
    let lines = crate::render::wrap_lines(
        vec![crate::app::footer::line(
            app,
            usize::MAX,
            app.render_context(),
        )],
        content.width.into(),
    );
    // When wrapping would consume the modal's remaining space, keep the exit action
    // through the same action prioritization used by the single-row page hintline.
    if lines.len() > usize::from(available.height) {
        vec![crate::app::footer::line(
            app,
            content.width.into(),
            app.render_context(),
        )]
    } else {
        lines
    }
}

pub(super) fn draw_tip(
    frame: &mut Frame<'_>,
    area: Rect,
    app: &App,
    context: crate::render::RenderContext<'_>,
) {
    if app.overlay().is_none()
        && matches!(
            app.command_panel(),
            Some(crate::app::command_panel::CommandPanel::Effort(_))
        )
    {
        crate::app::footer::draw_tip(frame, area, app, None, context);
        return;
    }
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

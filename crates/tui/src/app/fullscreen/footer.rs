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
        crate::app::footer::draw_modal(frame, areas.session.footer.hintline, app, context);
    } else {
        crate::app::footer::draw(frame, areas.session.footer, app, context);
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
        None
    };
    if !super::modal::is_open(app) {
        crate::app::footer::draw_tip(frame, area, app, navigation, context);
    }
}

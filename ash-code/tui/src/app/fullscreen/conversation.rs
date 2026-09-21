//! Conversation, session management and previews within the full-screen body.

use crate::app::App;
use crate::render::RenderContext;
use crate::render::Renderable;
use crate::thread::transcript::ChatHistoryView;
use ratatui::Frame;
use ratatui::style::Style;
use ratatui::widgets::Paragraph;

pub(super) fn draw(
    frame: &mut Frame<'_>,
    areas: &super::layout::Layout,
    app: &App,
    context: RenderContext<'_>,
) {
    if let Some(preview) = app.session_preview() {
        let messages = preview.messages();
        ChatHistoryView {
            jump_label: super::JUMP_LABEL,
            header: None,
            messages: &messages,
            scroll: &app.fullscreen.preview.scroll,
            render_cache: &app.fullscreen.preview.cache,
            pointer: super::pointer::transcript_pointer(app),
        }
        .render(frame, areas.session.transcript, context);
        frame.render_widget(
            Paragraph::new(format!(
                "  {} · {} · {}",
                context.localize("Preview"),
                preview.title,
                context.localize("read only")
            ))
            .style(Style::default().fg(context.muted())),
            areas.session.composer,
        );
        if let Some(notice) = preview.notice() {
            frame.render_widget(
                Paragraph::new(notice).style(Style::default().fg(context.muted())),
                areas.session.top_tip,
            );
        }
        super::footer::draw(frame, areas.session.bottom, app, context);
    } else if let Some(manager) = app.issue_manager() {
        let hovered = match app.fullscreen.pointer.hovered() {
            Some(super::pointer::PointerTarget::Issues(target)) => Some(target),
            _ => None,
        };
        let pressed = match app.fullscreen.pointer.pressed() {
            Some(super::pointer::PointerTarget::Issues(target)) => Some(target),
            _ => None,
        };
        manager.draw(frame, areas.session.transcript, hovered, pressed, context);
    } else if let Some(manager) = app.session_manager_view() {
        let hovered = match app.fullscreen.pointer.hovered() {
            Some(super::pointer::PointerTarget::SessionManager(target)) => Some(target),
            _ => None,
        };
        let pressed = match app.fullscreen.pointer.pressed() {
            Some(super::pointer::PointerTarget::SessionManager(target)) => Some(target),
            _ => None,
        };
        crate::sessions::draw_manager(
            frame,
            areas.session.transcript,
            manager,
            hovered,
            pressed,
            context,
        );
    } else {
        let messages = app.visible_transcript_views();
        ChatHistoryView {
            jump_label: super::JUMP_LABEL,
            header: None,
            messages: &messages,
            scroll: app.transcript_scroll(),
            render_cache: app.transcript_render_cache(),
            pointer: super::pointer::transcript_pointer(app),
        }
        .render(frame, areas.session.transcript, context);
    }
}

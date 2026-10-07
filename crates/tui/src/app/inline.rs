//! Inline page composition over the terminal's main screen.

mod header;
mod layout;
pub(super) mod navigation;
mod output;
mod panel;

pub(super) use layout::layout;

const JUMP_LABEL: &str = "Ctrl+End to jump to bottom ↓";
pub(super) use output::Output;

use crate::app::App;
use crate::render::Renderable;
use crate::sessions;
use crate::thread::composer as chat_composer;
use crate::thread::composer as chat_input;
use crate::thread::transcript::ChatHistoryPointerState;
use crate::thread::transcript::ChatHistoryView;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::widgets::Block;
use ratatui::widgets::Paragraph;

#[derive(Debug)]
pub(super) struct Inline {
    pub(super) sessions: crate::sessions::SessionNavigation,
    pub(super) issues: crate::issues::Manager,
    pub(super) agent_thread_switcher: crate::thread::AgentThreadSwitcher,
    pub(super) preview: crate::thread::transcript::viewport::PreviewViewport,
    pub(super) escape: crate::app::escape::ScreenEscapeSequence,
    pub(super) panels: crate::app::command_panel::Panels,
    pub(super) viewports: crate::thread::transcript::viewport::Viewports,
}

impl Inline {
    pub(super) fn new(thread: ash_protocol::ThreadId) -> Self {
        Self {
            sessions: Default::default(),
            issues: Default::default(),
            agent_thread_switcher: Default::default(),
            preview: Default::default(),
            escape: Default::default(),
            panels: Default::default(),
            viewports: crate::thread::transcript::viewport::Viewports::new(thread),
        }
    }
}

fn browsing(app: &App) -> bool {
    app.session_preview().is_some()
        || app.session_manager_view().is_some()
        || app.issue_manager().is_some()
        || app.transcript_scroll().anchor().is_some()
        || app.transcript_selection_active()
}

enum Transcript<'a> {
    Full,
    Tail(Vec<crate::thread::transcript::CellView<'a>>),
}

pub(super) fn draw(
    frame: &mut Frame<'_>,
    app: &App,
    links: &std::cell::RefCell<crate::render::links::FrameLinks>,
) {
    let transcript = if output::expanded(app) {
        Transcript::Full
    } else {
        Transcript::Tail(output::tail(app))
    };
    draw_content(frame, app, links, transcript);
}

fn draw_content(
    frame: &mut Frame<'_>,
    app: &App,
    links: &std::cell::RefCell<crate::render::links::FrameLinks>,
    transcript: Transcript<'_>,
) {
    let context = app.render_context().with_hyperlinks(links);
    frame.render_widget(
        Block::default().style(
            Style::default()
                .fg(context.foreground())
                .bg(context.background()),
        ),
        frame.area(),
    );
    let areas = layout(app, frame.area());
    crate::app::announcement::draw(frame, app, areas.announcement);
    if let Some(preview) = app.session_preview()
        && app.command_panel().is_none()
    {
        let messages = preview.messages();
        let header = header::history_buffer(
            areas.session.transcript.width,
            areas.session.transcript.height,
            app.welcome(),
            context,
        );
        ChatHistoryView {
            jump_label: JUMP_LABEL,
            header: Some(&header),
            messages: &messages,
            scroll: &app.inline.preview.scroll,
            render_cache: &app.inline.preview.cache,
            pointer: ChatHistoryPointerState::default(),
        }
        .render(frame, areas.session.transcript, context);
        let title = format!(
            "  {} · {} · {}",
            context.localize("Preview"),
            preview.title,
            context.localize("read only")
        );
        frame.render_widget(
            Paragraph::new(title).style(Style::default().fg(context.muted())),
            areas.session.composer,
        );
        if let Some(notice) = preview.notice() {
            frame.render_widget(
                Paragraph::new(notice).style(Style::default().fg(context.muted())),
                areas.session.tipline,
            );
        }
        crate::app::footer::draw(frame, areas.session.footer, app, context);
        if let Some(overlay) = app.overlay() {
            context.clear_hyperlinks(overlay.surface(areas.transient_area()));
            crate::widgets::overlay::draw(frame, areas.transient_area(), overlay, context);
        }
        return;
    }
    if let Some(manager) = app.issue_manager() {
        manager.draw(frame, areas.session.transcript, None, None, context);
    } else if let Some(manager) = app.session_manager_view() {
        sessions::draw_manager(
            frame,
            areas.session.transcript,
            manager,
            None,
            None,
            context,
        );
    } else if matches!(
        app.inline.sessions.screen(),
        Some(crate::sessions::SessionScreen::Home)
    ) {
        header::draw(frame, areas.session.transcript, app.welcome(), context);
    } else {
        let (messages, header) = match transcript {
            Transcript::Full => (
                app.visible_transcript_views(),
                Some(header::history_buffer(
                    areas.session.transcript.width,
                    areas.session.transcript.height,
                    app.welcome(),
                    context,
                )),
            ),
            Transcript::Tail(messages) => (messages, None),
        };
        ChatHistoryView {
            jump_label: JUMP_LABEL,
            header: header.as_ref(),
            messages: &messages,
            scroll: app.transcript_scroll(),
            render_cache: app.transcript_render_cache(),
            pointer: ChatHistoryPointerState::default(),
        }
        .render(frame, areas.session.transcript, context);
    }
    if let Some(panel) = app.command_panel() {
        panel::draw(panel, frame, areas.session.composer, context);
        crate::app::footer::draw(frame, areas.session.footer, app, context);
        if let Some(overlay) = app.overlay() {
            context.clear_hyperlinks(overlay.surface(areas.transient_area()));
            crate::widgets::overlay::draw(frame, areas.transient_area(), overlay, context);
        }
        return;
    }
    if app.session_manager_view().is_none() {
        crate::app::chat_view::draw(
            frame,
            app,
            &areas.session,
            areas.input,
            chat_input::ChatInputChrome::Standard,
            None,
            crate::app::chat_view::Pointer::default(),
            context,
        );
    }
    crate::app::footer::draw(frame, areas.session.footer, app, context);
    crate::app::footer::draw_tip(frame, areas.session.tipline, app, None, context);
    if let Some(overlay) = app.overlay() {
        context.clear_hyperlinks(overlay.surface(areas.transient_area()));
        crate::widgets::overlay::draw(frame, areas.transient_area(), overlay, context);
    } else if app.completion_visible() {
        context.clear_hyperlinks(areas.completion_area());
        chat_composer::draw_completion_layer(
            frame,
            areas.completion_area(),
            &app.chat_composer_view(),
            None,
            None,
            context,
        );
    }
}

#[cfg(test)]
#[path = "inline/frame_tests.rs"]
mod tests;

pub(super) fn process_resource_demand(
    app: &App,
    area: Rect,
) -> ash_memory_diagnostics::ProcessResourceDemand {
    let areas = layout(app, area);
    if app
        .command_panel()
        .is_some_and(|editor| panel::process_resources_visible(editor, areas.session.composer))
    {
        return ash_memory_diagnostics::ProcessResourceDemand::Detailed;
    }
    crate::app::footer::process_resource_demand(app, areas.session.footer)
}

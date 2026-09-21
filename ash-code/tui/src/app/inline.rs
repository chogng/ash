//! Inline page composition over the terminal's main screen.

mod footer;
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
use crate::thread::composer::ChatComposerSurface;
use crate::thread::goal;
use crate::thread::interaction::approval;
use crate::thread::interaction::query;
use crate::thread::plan;
use crate::thread::queue;
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

enum Transcript<'a> {
    Full,
    Tail(Vec<crate::thread::transcript::CellView<'a>>),
}

fn browsing(app: &App) -> bool {
    app.session_preview().is_some()
        || app.session_manager_view().is_some()
        || app.issue_manager().is_some()
        || app.transcript_scroll().anchor().is_some()
        || app.transcript_selection_active()
}

pub(super) fn draw(
    frame: &mut Frame<'_>,
    app: &App,
    links: &std::cell::RefCell<crate::terminal::hyperlinks::FrameLinks>,
) {
    let transcript = if browsing(app) {
        Transcript::Full
    } else {
        Transcript::Tail(output::tail(app))
    };
    draw_content(frame, app, links, transcript);
}

fn draw_content(
    frame: &mut Frame<'_>,
    app: &App,
    links: &std::cell::RefCell<crate::terminal::hyperlinks::FrameLinks>,
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
    if let Some(preview) = app.session_preview() {
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
                areas.session.top_tip,
            );
        }
        footer::draw(frame, areas.session.bottom, app, context);
        if let Some(overlay) = app.overlay() {
            context.clear_hyperlinks(overlay.surface(areas.transient_area()));
            crate::widgets::overlay::draw(frame, areas.transient_area(), overlay, context);
        }
        return;
    }
    if let Some(manager) = app.issue_manager() {
        manager.draw(frame, areas.session.transcript, None, None, context);
    } else if let Some(manager) = app.session_manager_view() {
        let manager_areas = layout::manager_areas(
            areas.session.transcript,
            header::desired_height(areas.session.transcript.width),
        );
        header::draw(frame, manager_areas.welcome, app.welcome(), context);
        sessions::draw_manager(frame, manager_areas.sessions, manager, None, None, context);
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
    let cursor = if app.accepts_input() && app.chat_input_focused() {
        chat_input::ChatInputCursor::Visible
    } else {
        chat_input::ChatInputCursor::Hidden
    };
    let focus = if app.chat_input_focused() {
        chat_input::ChatInputFocus::Focused
    } else {
        chat_input::ChatInputFocus::Blurred
    };
    let input_view = app.chat_composer_view();
    if let Some(approval) = app.approval_view() {
        approval::draw(frame, areas.session.composer, approval, None, None, context);
    } else if let Some(panel) = app.command_panel() {
        panel::draw(panel, frame, areas.session.composer, context);
    } else {
        ChatComposerSurface {
            chrome: chat_input::ChatInputChrome::Rules,
            view: &input_view,
            cursor,
            focus,
        }
        .render(frame, areas.input, context);
    }
    if let Some(query) = app.query_view() {
        query::draw(frame, areas.session.request, query, None, None, context);
    }
    if app.session_manager_view().is_none() {
        goal::draw(frame, areas.session.goal, app.goal_view(), context);
        plan::draw(frame, areas.session.plan, app.plan_view(), context);
        let queue_view = app.queue_view();
        queue::draw(
            frame,
            areas.session.queue,
            &queue_view,
            queue::DEFAULT_MAX_VISIBLE_ITEMS,
            None,
            None,
            context,
        );
    }
    footer::draw(frame, areas.session.bottom, app, context);
    if let Some(agent_thread_switcher) = app.agent_thread_switcher_view() {
        crate::thread::draw_agent_thread_switcher(
            frame,
            chat_input::content_area(areas.session.agent_thread_switcher),
            agent_thread_switcher,
            None,
            None,
            context,
        );
    }
    if let Some(indicator) = app.status_indicator() {
        indicator.draw(frame, areas.session.status_indicator, context);
    }
    footer::draw_tip(frame, areas.session.top_tip, app, context);
    if let Some(overlay) = app.overlay() {
        context.clear_hyperlinks(overlay.surface(areas.transient_area()));
        crate::widgets::overlay::draw(frame, areas.transient_area(), overlay, context);
    } else if app.completion_visible() {
        context.clear_hyperlinks(areas.completion_area());
        chat_composer::draw_completion_layer(
            frame,
            areas.completion_area(),
            &input_view,
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
    footer::process_resource_demand(app, &layout(app, area))
}

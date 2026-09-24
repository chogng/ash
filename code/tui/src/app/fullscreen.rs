//! Full-screen page composition and transient pointer state.

mod composer;
mod conversation;
mod footer;
pub(super) mod header;
mod home;
mod layout;
mod modal;
pub(super) mod navigation;
pub(super) mod pointer;
pub(super) mod selection;

pub(super) use layout::layout;

/// Base focus below temporary surfaces; page features own their focus within `Page`.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum Focus {
    #[default]
    Input,
    Page,
    Header,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(in crate::app) enum Page {
    Home,
    #[default]
    Conversation,
}

const JUMP_LABEL: &str = "Jump to bottom (click) ↓";

use crate::app::App;
use crate::thread::composer as chat_composer;
use pointer::PointerInteraction;
use pointer::PointerTarget;
use ratatui::Frame;
use ratatui::layout::Rect;
use ratatui::style::Style;
use ratatui::widgets::Block;
use selection::ScreenSelection;

/// Owns interaction state that exists only while the full-screen page is active.
#[derive(Debug)]
pub(super) struct Fullscreen {
    pub(super) header: header::State,
    pub(super) sessions: crate::sessions::SessionNavigation,
    pub(super) issues: crate::issues::Manager,
    pub(super) agent_thread_switcher: crate::thread::AgentThreadSwitcher,
    page: Page,
    focus: Focus,
    home: home::Home,
    pub(super) preview: crate::thread::transcript::viewport::PreviewViewport,
    pub(super) escape: crate::app::escape::ScreenEscapeSequence,
    pub(super) panels: crate::app::command_panel::Panels,
    pub(super) viewports: crate::thread::transcript::viewport::Viewports,
    pub(super) pointer: PointerInteraction<PointerTarget>,
    pub(super) selection: ScreenSelection,
    pub(super) modal_alert: bool,
}

impl Fullscreen {
    pub(super) fn new(thread: ash_protocol::ThreadId) -> Self {
        Self {
            header: Default::default(),
            sessions: Default::default(),
            issues: Default::default(),
            agent_thread_switcher: Default::default(),
            page: Page::Conversation,
            focus: Focus::default(),
            home: home::Home::default(),
            preview: Default::default(),
            escape: Default::default(),
            panels: Default::default(),
            viewports: crate::thread::transcript::viewport::Viewports::new(thread),
            pointer: Default::default(),
            selection: Default::default(),
            modal_alert: false,
        }
    }

    pub(super) fn clear(&mut self) {
        self.modal_alert = false;
        self.pointer.clear();
        self.selection.clear();
    }

    pub(in crate::app) fn home_visible(&self) -> bool {
        self.page == Page::Home
    }

    pub(in crate::app) fn welcome_visible(&self) -> bool {
        self.home_visible() && self.home.welcome_visible()
    }

    pub(super) fn dismiss_welcome(&mut self) {
        if self.home_visible() {
            self.home.dismiss_welcome();
        }
    }

    pub(super) fn focus_input(&mut self) {
        self.focus = Focus::Input;
        self.header.clear();
    }

    pub(super) fn focus_page(&mut self) {
        self.focus = Focus::Page;
        self.header.clear();
    }

    pub(super) fn focus_header(&mut self, target: header::Target) {
        self.focus = Focus::Header;
        self.header.select(target);
    }

    pub(super) fn input_focused(&self) -> bool {
        self.focus == Focus::Input
    }

    pub(super) fn header_focused(&self) -> bool {
        self.focus == Focus::Header
    }
}

pub(super) fn draw(
    frame: &mut Frame<'_>,
    app: &App,
    links: &std::cell::RefCell<crate::terminal::hyperlinks::FrameLinks>,
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
    header::draw(frame, areas.header, app, context);
    let hovered = app.fullscreen.pointer.hovered();
    let pressed = app.fullscreen.pointer.pressed();
    if app.fullscreen.welcome_visible() {
        let hovered_action = match hovered {
            Some(PointerTarget::HomeAction(action)) => Some(*action),
            _ => None,
        };
        let pressed_action = match pressed {
            Some(PointerTarget::HomeAction(action)) => Some(*action),
            _ => None,
        };
        home::draw(
            frame,
            areas.session.transcript,
            app,
            hovered_action,
            pressed_action,
            context,
        );
    } else if !app.fullscreen.home_visible() {
        conversation::draw(frame, &areas, app, context);
    }
    if app.session_preview().is_none() {
        composer::draw(frame, app, &areas, context);
    }
    if modal::is_open(app) {
        modal::draw(frame, app, context);
    } else if app.completion_visible() {
        context.clear_hyperlinks(areas.completion_area());
        let input_view = app.chat_composer_view();
        let hovered_composer = match hovered {
            Some(PointerTarget::Composer(target)) => Some(*target),
            _ => None,
        };
        let pressed_composer = match pressed {
            Some(PointerTarget::Composer(target)) => Some(*target),
            _ => None,
        };
        chat_composer::draw_completion_layer(
            frame,
            areas.completion_area(),
            &input_view,
            hovered_composer,
            pressed_composer,
            context,
        );
    }
    app.fullscreen.selection.draw(frame.buffer_mut(), context);
}

#[cfg(test)]
#[path = "fullscreen/frame_tests.rs"]
mod tests;

pub(super) fn process_resource_demand(
    app: &App,
    area: Rect,
) -> ash_memory_diagnostics::ProcessResourceDemand {
    if modal::is_open(app) {
        return if modal::process_resources_visible(app, area) {
            ash_memory_diagnostics::ProcessResourceDemand::Detailed
        } else {
            ash_memory_diagnostics::ProcessResourceDemand::Disabled
        };
    }
    header::process_resource_demand(app, layout(app, area).header)
}

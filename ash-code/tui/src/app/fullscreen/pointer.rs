use super::selection::ClickCount;
use super::selection::ScreenSelectionOutcome;
use crate::app::App;
use crate::app::AppCommand;
use crate::host;
use crate::render::InteractionState;
use crate::terminal;
use crate::thread::composer as chat_composer;
use crate::thread::composer::ChatComposerPointerTarget;
use crate::thread::queue::QueueId;
use crate::thread::transcript::ChatHistoryPointerState;
use crate::thread::transcript::ChatHistoryPointerTarget;
use crate::thread::transcript::ChatHistoryView;
use crate::thread::transcript::TranscriptCellId;
use crate::thread::transcript::TranscriptScrollDirection;
use crossterm::event::MouseButton;
use crossterm::event::MouseEvent;
use crossterm::event::MouseEventKind;
use ratatui::layout::Rect;
use std::time::Instant;

/// Keeps pointer hover separate from keyboard selection and click activation.
///
/// A pointer move may change only `hovered`. Components continue to own their keyboard cursor,
/// while a click carries its resolved target directly to the component activation path.
/// Rendering resolves hover, press, and keyboard selection independently; that visual choice must
/// never merge their state or make hover affect keyboard behavior.
#[derive(Debug)]
pub(crate) struct PointerInteraction<T> {
    hovered: Option<T>,
    pressed: Option<T>,
    click: Option<(T, Instant)>,
}

impl<T> Default for PointerInteraction<T> {
    fn default() -> Self {
        Self {
            hovered: None,
            pressed: None,
            click: None,
        }
    }
}

impl<T> PointerInteraction<T> {
    pub(crate) fn update_hover(&mut self, target: Option<T>) {
        self.hovered = target;
    }

    pub(crate) fn update_pressed(&mut self, target: Option<T>) {
        self.pressed = target;
    }

    pub(crate) fn cancel_click(&mut self) {
        self.pressed = None;
        self.click = None;
    }

    pub(crate) fn clear(&mut self) {
        self.hovered = None;
        self.cancel_click();
    }

    pub(crate) fn hovered(&self) -> Option<&T> {
        self.hovered.as_ref()
    }

    pub(crate) fn pressed(&self) -> Option<&T> {
        self.pressed.as_ref()
    }
}

impl<T: PartialEq> PointerInteraction<T> {
    fn finish_click(
        &mut self,
        target: Option<T>,
        now: Instant,
    ) -> Option<crate::widgets::list_selection::ListSelectionClick> {
        use crate::widgets::list_selection::ListSelectionClick;
        let pressed = self.pressed.take();
        if target.is_none() || pressed != target {
            self.click = None;
            return None;
        }
        let previous = self.click.take();
        if previous.is_some_and(|(previous, time)| {
            Some(&previous) == target.as_ref()
                && now
                    .checked_duration_since(time)
                    .is_some_and(|elapsed| elapsed <= std::time::Duration::from_millis(500))
        }) {
            return Some(ListSelectionClick::Double);
        }
        self.click = target.map(|target| (target, now));
        Some(ListSelectionClick::Single)
    }

    pub(crate) fn interaction_state(&self, target: &T) -> InteractionState {
        InteractionState {
            hovered: self.hovered.as_ref() == Some(target),
            pressed: self.pressed.as_ref() == Some(target),
            ..InteractionState::default()
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum PointerTarget {
    Header(super::header::Target),
    HomeAction(super::home::Action),
    Issues(crate::issues::PointerTarget),
    SessionManager(crate::sessions::SessionManagerPointerTarget),
    Approval(usize),
    Query(usize),
    Queue(QueueId),
    AgentThread(ash_protocol::ThreadId),
    Modal(super::modal::Target),
    Composer(ChatComposerPointerTarget),
    Transcript(ChatHistoryPointerTarget),
}

pub(super) fn transcript_pointer(app: &App) -> ChatHistoryPointerState<'_> {
    ChatHistoryPointerState {
        hovered_jump_to_bottom: app.fullscreen.pointer.hovered()
            == Some(&PointerTarget::Transcript(
                ChatHistoryPointerTarget::JumpToBottom,
            )),
        hovered_toggle: match app.fullscreen.pointer.hovered() {
            Some(PointerTarget::Transcript(ChatHistoryPointerTarget::Toggle(cell_id))) => {
                Some(cell_id.as_str())
            }
            _ => None,
        },
        hovered_details: match app.fullscreen.pointer.hovered() {
            Some(PointerTarget::Transcript(ChatHistoryPointerTarget::Details(cell_id))) => {
                Some(cell_id.as_str())
            }
            _ => None,
        },
        pressed_jump_to_bottom: app.fullscreen.pointer.pressed()
            == Some(&PointerTarget::Transcript(
                ChatHistoryPointerTarget::JumpToBottom,
            )),
        pressed_toggle: match app.fullscreen.pointer.pressed() {
            Some(PointerTarget::Transcript(ChatHistoryPointerTarget::Toggle(cell_id))) => {
                Some(cell_id.as_str())
            }
            _ => None,
        },
        pressed_details: match app.fullscreen.pointer.pressed() {
            Some(PointerTarget::Transcript(ChatHistoryPointerTarget::Details(cell_id))) => {
                Some(cell_id.as_str())
            }
            _ => None,
        },
    }
}

pub(crate) fn target_at(
    app: &App,
    terminal_area: Rect,
    column: u16,
    row: u16,
) -> Option<PointerTarget> {
    if !app.mouse_mode().enables_pointer_actions() {
        return None;
    }
    let areas = super::layout(app, terminal_area);
    let position = ratatui::layout::Position::new(column, row);
    if super::modal::is_open(app) {
        return super::modal::target_at(app, terminal_area, position).map(PointerTarget::Modal);
    }
    if app.approval_view().is_none()
        && app.query_view().is_none()
        && let Some(target) = super::header::target_at(app, areas.header, position)
    {
        return Some(PointerTarget::Header(target));
    }
    if app.completion_visible() && overlay_contains(app, terminal_area, position) {
        return chat_composer::pointer_target_at(
            areas.completion_area(),
            &app.chat_composer_view(),
            true,
            column,
            row,
        )
        .map(PointerTarget::Composer);
    }
    if app.approval_view().is_none()
        && app.query_view().is_none()
        && !areas.input.is_empty()
        && chat_composer::ChatInputChrome::Box
            .border_area(areas.input)
            .contains(position)
    {
        return Some(PointerTarget::Composer(ChatComposerPointerTarget::Input));
    }
    if app.fullscreen.welcome_visible() {
        return super::home::action_at(app, areas.session.transcript, position)
            .map(PointerTarget::HomeAction);
    }
    if let Some(manager) = app.issue_manager() {
        return manager
            .pointer_target_at(areas.session.transcript, position, app.language())
            .map(PointerTarget::Issues);
    }
    if let Some(manager) = app.session_manager_view()
        && app.session_preview().is_none()
    {
        return crate::sessions::session_manager_pointer_target_at(
            areas.session.transcript,
            manager,
            position,
        )
        .map(PointerTarget::SessionManager);
    }
    if let Some(approval) = app.approval_view() {
        return crate::thread::interaction::approval::choice_at(
            areas.session.composer,
            approval,
            position,
        )
        .map(PointerTarget::Approval);
    }
    if let Some(query) = app.query_view() {
        return crate::thread::interaction::query::choice_at(
            areas.session.request,
            query,
            position,
        )
        .map(PointerTarget::Query);
    }
    let queue_view = app.queue_view();
    if let Some(queue_id) = crate::thread::queue::pointer_target_at(
        areas.session.queue,
        &queue_view,
        crate::thread::queue::DEFAULT_MAX_VISIBLE_ITEMS,
        position,
    ) {
        return Some(PointerTarget::Queue(queue_id));
    }
    if let Some(agent_threads) = app.agent_thread_switcher_view()
        && let Some(thread_id) = crate::thread::agent_thread_pointer_target_at(
            crate::thread::composer::content_area(areas.session.agent_thread_switcher),
            agent_threads,
            position,
        )
    {
        return Some(PointerTarget::AgentThread(thread_id));
    }
    let context = app.render_context();
    let messages = if let Some(preview) = app.session_preview() {
        preview.messages()
    } else {
        app.visible_transcript_views()
    };
    let (scroll, render_cache) = if app.session_preview().is_some() {
        (
            &app.fullscreen.preview.scroll,
            &app.fullscreen.preview.cache,
        )
    } else {
        (app.transcript_scroll(), app.transcript_render_cache())
    };
    let target = ChatHistoryView {
        jump_label: super::JUMP_LABEL,
        header: None,
        messages: &messages,
        scroll,
        render_cache,
        pointer: transcript_pointer(app),
    }
    .pointer_target_at(areas.session.transcript, position, context)?;
    if app.session_preview().is_some() && target != ChatHistoryPointerTarget::JumpToBottom {
        return None;
    }
    Some(PointerTarget::Transcript(target))
}

pub(crate) fn overlay_contains(
    app: &App,
    terminal_area: Rect,
    position: ratatui::layout::Position,
) -> bool {
    if !app.mouse_mode().captures_terminal_input() {
        return false;
    }
    let areas = super::layout(app, terminal_area);
    if super::modal::is_open(app) {
        return super::modal::layout(terminal_area)
            .surface
            .contains(position);
    }
    if !app.completion_visible() {
        return false;
    }
    chat_composer::completion_contains(
        areas.completion_area(),
        &app.chat_composer_view(),
        position.x,
        position.y,
    )
}

pub(in crate::app) enum MouseAction {
    Selection(Option<ScreenSelectionOutcome>),
    Command(Option<AppCommand>),
}

pub(in crate::app) fn handle_mouse(
    app: &mut App,
    area: ratatui::layout::Rect,
    mouse: MouseEvent,
) -> MouseAction {
    let mouse_mode = app.mouse_mode();
    if !mouse_mode.captures_terminal_input() {
        app.fullscreen.clear();
        return MouseAction::Selection(None);
    }
    let position = ratatui::layout::Position::new(mouse.column, mouse.row);
    if super::modal::is_open(app) {
        let target = target_at(app, area, mouse.column, mouse.row);
        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                if super::modal::layout(area).surface.contains(position) {
                    app.fullscreen.modal_alert = false;
                }
                app.fullscreen.pointer.update_pressed(target);
            }
            MouseEventKind::Drag(MouseButton::Left) => app.fullscreen.pointer.cancel_click(),
            MouseEventKind::Up(MouseButton::Left) => {
                let click = app
                    .fullscreen
                    .pointer
                    .finish_click(target.clone(), Instant::now());
                if let (Some(click), Some(PointerTarget::Modal(target))) = (click, target) {
                    return MouseAction::Command(super::modal::activate(app, area, target, click));
                }
            }
            MouseEventKind::Moved => app.fullscreen.pointer.update_hover(target),
            MouseEventKind::ScrollUp | MouseEventKind::ScrollDown
                if super::modal::layout(area).surface.contains(position) =>
            {
                let body = app.command_panel().map(|panel| {
                    super::modal::body_area(panel, super::modal::layout(area).content)
                });
                if let Some(super::super::command_panel::CommandPanel::Memories(panel)) =
                    app.fullscreen.panels.command_mut()
                {
                    panel.scroll(
                        body.expect("open memories panel"),
                        position,
                        if mouse.kind == MouseEventKind::ScrollUp {
                            -3
                        } else {
                            3
                        },
                    );
                    return MouseAction::Selection(None);
                }
                let key = crossterm::event::KeyEvent::new(
                    if mouse.kind == MouseEventKind::ScrollUp {
                        crossterm::event::KeyCode::Up
                    } else {
                        crossterm::event::KeyCode::Down
                    },
                    crossterm::event::KeyModifiers::NONE,
                );
                return MouseAction::Command(super::modal::handle_key(app, key, area).flatten());
            }
            _ => {}
        }
        return MouseAction::Selection(None);
    }
    if mouse.kind == MouseEventKind::Down(MouseButton::Left) {
        let input = super::layout(app, area).input;
        if !input.is_empty() && app.approval_view().is_none() && app.query_view().is_none() {
            match target_at(app, area, mouse.column, mouse.row) {
                Some(PointerTarget::Composer(_)) => super::navigation::focus_input(app),
                Some(PointerTarget::Header(target)) => app.fullscreen.focus_header(target),
                Some(_) => app.fullscreen.focus_page(),
                None => super::navigation::focus_page(app),
            }
        }
    }
    let overlay_contains = overlay_contains(app, area, position);
    if (app.overlay().is_some() || app.completion_visible()) && !overlay_contains {
        app.fullscreen.clear();
        return MouseAction::Selection(None);
    }
    match mouse.kind {
        MouseEventKind::ScrollUp | MouseEventKind::ScrollDown => {
            let direction = if mouse.kind == MouseEventKind::ScrollUp {
                TranscriptScrollDirection::Up
            } else {
                TranscriptScrollDirection::Down
            };
            let command = if overlay_contains {
                scroll_pointer_item(app, area, mouse.column, mouse.row, direction)
            } else if !app.fullscreen.home_visible()
                && app.session_manager_view().is_none()
                && app.issue_manager().is_none()
                && super::layout(app, area)
                    .session
                    .transcript
                    .contains(position)
            {
                app.navigate_transcript(direction, area)
            } else {
                None
            };
            return MouseAction::Command(command);
        }
        MouseEventKind::Down(MouseButton::Left) => {
            let target = target_at(app, area, mouse.column, mouse.row);
            app.fullscreen.pointer.update_pressed(target);
            app.fullscreen.selection.begin(position);
        }
        MouseEventKind::Drag(MouseButton::Left) => {
            app.fullscreen.pointer.cancel_click();
            app.fullscreen.selection.drag(position);
        }
        MouseEventKind::Up(MouseButton::Left) => {
            let outcome = app.fullscreen.selection.finish(position, Instant::now());
            app.fullscreen.pointer.cancel_click();
            return MouseAction::Selection(outcome);
        }
        MouseEventKind::Moved => update_pointer_hover(app, area, mouse.column, mouse.row),
        _ => {}
    }
    MouseAction::Selection(None)
}

pub(super) fn activate_pointer_item(
    app: &mut App,
    area: ratatui::layout::Rect,
    column: u16,
    row: u16,
) -> Option<AppCommand> {
    let target = target_at(app, area, column, row)?;
    match target {
        PointerTarget::Header(target) => super::navigation::activate_header_target(app, target),
        PointerTarget::HomeAction(action) => super::home::activate(app, action),
        PointerTarget::Issues(target) => app
            .fullscreen
            .issues
            .activate_pointer(&target)
            .map(Into::into),
        PointerTarget::SessionManager(target) => {
            match app
                .fullscreen
                .sessions
                .activate_manager_pointer(&app.sessions, &target)
            {
                crate::sessions::SessionManagerInputOutcome::Command(command) => {
                    Some(command.into())
                }
                crate::sessions::SessionManagerInputOutcome::DetailsRequested => {
                    app.fullscreen.panels.overlay = None;
                    app.fullscreen.sessions.open_details(&app.sessions);
                    app.fullscreen.pointer.clear();
                    None
                }
                crate::sessions::SessionManagerInputOutcome::ExitRequested => {
                    if let Some(session_id) = app.sessions.active_session_id().cloned() {
                        super::navigation::show_conversation(app, session_id);
                    } else {
                        app.open_home();
                    }
                    None
                }
                crate::sessions::SessionManagerInputOutcome::Consumed
                | crate::sessions::SessionManagerInputOutcome::Unhandled => None,
            }
        }
        PointerTarget::Approval(index) => app.activate_approval(index),
        PointerTarget::Query(index) => app.activate_query_choice(index),
        PointerTarget::Queue(queue_id) => {
            if !app.focus_queue_item(queue_id) {
                return None;
            }
            super::navigation::handle_queue_key(
                app,
                crossterm::event::KeyEvent::new(
                    crossterm::event::KeyCode::Enter,
                    crossterm::event::KeyModifiers::NONE,
                ),
            )
            .flatten()
        }
        PointerTarget::AgentThread(thread_id) => {
            if !app
                .fullscreen
                .agent_thread_switcher
                .focus_pointer(&thread_id)
            {
                return None;
            }
            Some(crate::sessions::Command::SwitchThread { thread_id }.into())
        }
        PointerTarget::Modal(target) => super::modal::activate(
            app,
            area,
            target,
            crate::widgets::list_selection::ListSelectionClick::Single,
        ),
        PointerTarget::Composer(
            ChatComposerPointerTarget::Input | ChatComposerPointerTarget::CompletionSurface,
        ) => {
            super::navigation::focus_input(app);
            None
        }
        PointerTarget::Composer(ChatComposerPointerTarget::CompletionItem(index)) => {
            super::navigation::focus_input(app);
            app.activate_input_completion(index)
        }
        PointerTarget::Transcript(ChatHistoryPointerTarget::JumpToBottom) => {
            app.follow_latest_transcript();
            None
        }
        PointerTarget::Transcript(ChatHistoryPointerTarget::Toggle(cell_id)) => {
            app.fullscreen
                .viewports
                .active_mut()
                .toggle_cell(&TranscriptCellId::from_render_key(cell_id));
            None
        }
        PointerTarget::Transcript(ChatHistoryPointerTarget::Details(cell_id)) => {
            app.open_transcript_cell_details(&cell_id);
            None
        }
    }
}

fn scroll_pointer_item(
    app: &mut App,
    area: ratatui::layout::Rect,
    column: u16,
    row: u16,
    direction: TranscriptScrollDirection,
) -> Option<AppCommand> {
    let position = ratatui::layout::Position::new(column, row);
    if !overlay_contains(app, area, position) {
        return None;
    }
    let key = match direction {
        TranscriptScrollDirection::Up => crossterm::event::KeyCode::Up,
        TranscriptScrollDirection::Down => crossterm::event::KeyCode::Down,
    };
    app.fullscreen.clear();
    app.handle_key_in_area(
        crossterm::event::KeyEvent::new(key, crossterm::event::KeyModifiers::NONE),
        area,
    )
}

pub(super) fn update_pointer_hover(
    app: &mut App,
    area: ratatui::layout::Rect,
    column: u16,
    row: u16,
) {
    let target = target_at(app, area, column, row);
    app.fullscreen.pointer.update_hover(target);
}

pub(in crate::app) fn finish_pointer_gesture(
    app: &mut App,
    terminal: &terminal::TerminalSession,
    outcome: Option<ScreenSelectionOutcome>,
) -> Result<Option<AppCommand>, std::io::Error> {
    let select = |app: &mut App, range| {
        super::selection::apply_screen_selection(
            app,
            range,
            |range| terminal.selected_text(range),
            host::clipboard::write_text,
        );
    };
    match outcome {
        Some(ScreenSelectionOutcome::Click {
            position,
            count: ClickCount::Single,
        }) => {
            let area = terminal.area()?;
            Ok(activate_pointer_item(app, area, position.x, position.y))
        }
        Some(ScreenSelectionOutcome::Click {
            position,
            count: ClickCount::Double,
        }) => {
            if let Some(range) = terminal.token_range_at(position) {
                select(app, range);
            }
            Ok(None)
        }
        Some(ScreenSelectionOutcome::Click {
            position,
            count: ClickCount::Triple,
        }) => {
            if let Some(range) = terminal.line_range_at(position) {
                select(app, range);
            }
            Ok(None)
        }
        Some(ScreenSelectionOutcome::Selection(range)) => {
            select(app, range);
            Ok(None)
        }
        None => Ok(None),
    }
}

#[cfg(test)]
#[path = "pointer_tests.rs"]
mod tests;

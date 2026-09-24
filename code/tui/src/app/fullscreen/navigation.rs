use crate::app::App;
use crate::app::command::AppCommand;
use crate::app::command_panel::CommandPanel;
use crate::keymap::AppChordMatch;
use crate::keymap::bindings;
use crate::sessions::Command as SessionCommand;
use crate::sessions::SessionManagerInputOutcome;
use crate::sessions::SessionScreen;
use crate::thread::Command as ThreadCommand;
use crate::thread::ThreadPresentationEvent;
use crate::thread::composer::ChatComposerOutcome;
use crate::thread::queue::QueueKeyOutcome;
use crate::thread::transcript::TranscriptScrollDirection;
use crate::thread::transcript::first_scroll_target;
use crate::thread::transcript::scroll_target;
use crate::widgets::detail_list::DetailList;
use crate::widgets::navigation::Navigation;
use crate::widgets::overlay::DetailOverlay;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyEventKind;
use crossterm::event::KeyModifiers;
use ratatui::layout::Rect;
use std::time::Instant;

pub(in crate::app) fn handle_key(
    app: &mut App,
    key: KeyEvent,
    now: Instant,
    terminal_area: Rect,
) -> Option<AppCommand> {
    if key.kind == KeyEventKind::Press {
        app.fullscreen.pointer.clear();
    }
    if let Some(command) = super::modal::handle_key(app, key, terminal_area) {
        return command;
    }
    if key.kind == KeyEventKind::Press
        && bindings::ESC_RETURN.matches(key)
        && app.session_manager_view().is_some()
        && app.issue_manager().is_none()
        && app.approval_view().is_none()
        && app.query_view().is_none()
        && app.completion().is_none()
    {
        return exit_manager(app).flatten();
    }
    if key.kind == KeyEventKind::Press
        && bindings::RETURN_INPUT.matches(key)
        && !app.fullscreen.input_focused()
    {
        focus_input(app);
        return None;
    }
    if app.fullscreen.header_focused() {
        return handle_header_key(app, key).flatten();
    }
    if key.kind == KeyEventKind::Press
        && key.code == KeyCode::F(6)
        && app.fullscreen.input_focused()
        && app.approval_view().is_none()
        && app.query_view().is_none()
        && app.command_panel().is_none()
    {
        let targets = super::header::keyboard_targets(app);
        if let Some(target) = targets.last().copied() {
            app.fullscreen.focus_header(target);
        }
        return None;
    }
    if app.fullscreen.home_visible() {
        if let Some(command) = super::home::handle_key(app, key) {
            return command;
        }
        let context = app.app_keymap_context(key.kind == KeyEventKind::Press);
        match app.app_keymap.route_chord(&key, context, now) {
            AppChordMatch::PassThrough => {}
            AppChordMatch::Pending | AppChordMatch::Consumed => return None,
            AppChordMatch::Command(action) => return app.apply_app_keymap_action(action, now),
        }
        if !app.accepts_input() {
            return None;
        }
        if !app.fullscreen.input_focused() {
            return None;
        }
        let outcome = app.handle_composer_key(key);
        if matches!(outcome, ChatComposerOutcome::Unhandled) {
            let context = app.app_keymap_context(key.kind == KeyEventKind::Press);
            return app
                .app_keymap
                .resolve_single(&key, context)
                .and_then(|action| app.apply_app_keymap_action(action, now));
        }
        return app.handle_chat_composer_outcome(outcome, now);
    }
    if app.fullscreen.issues.is_open() {
        return app.fullscreen.issues.handle_key(key).map(Into::into);
    }
    if app.fullscreen.sessions.preview.is_some() {
        if key.kind == KeyEventKind::Press && bindings::CLOSE.matches(key) {
            app.fullscreen.sessions.preview = None;
            app.fullscreen.pointer.clear();
            return None;
        }
        return match Navigation::from_key(key) {
            Some(
                navigation @ (Navigation::Previous
                | Navigation::Next
                | Navigation::PagePrevious
                | Navigation::PageNext),
            ) => {
                let rows = match navigation {
                    Navigation::PagePrevious | Navigation::PageNext => usize::from(
                        super::layout(app, terminal_area)
                            .session
                            .transcript
                            .height
                            .saturating_sub(1)
                            .max(1),
                    ),
                    _ => 1,
                };
                let direction =
                    if matches!(navigation, Navigation::Previous | Navigation::PagePrevious) {
                        TranscriptScrollDirection::Up
                    } else {
                        TranscriptScrollDirection::Down
                    };
                navigate_preview(app, direction, rows, terminal_area)
            }
            Some(Navigation::First) => {
                let preview = app.fullscreen.sessions.preview.as_mut().unwrap();
                preview.first(&mut app.fullscreen.preview).map(|params| {
                    SessionCommand::Preview {
                        generation: preview.generation,
                        params,
                    }
                    .into()
                })
            }
            Some(Navigation::Last) => {
                app.follow_latest_transcript();
                None
            }
            None => None,
        };
    }
    if matches!(
        app.fullscreen.sessions.screen(),
        Some(SessionScreen::Manager)
    ) && app.fullscreen.sessions.manager().focused()
    {
        return handle_screen_navigation_key(app, key).flatten();
    }
    if matches!(
        app.fullscreen.sessions.screen(),
        Some(SessionScreen::Session(_))
    ) {
        if let Some(command) = app.handle_thread_request_key(key) {
            return command;
        }
        if app.chat_panel.request_active() {
            return None;
        }
    }
    if chat_input_focused(app) && app.input_state().history_intercepts(key) {
        let outcome = app.handle_composer_key(key);
        app.fullscreen.escape.reset();
        return app.handle_chat_composer_outcome(outcome, now);
    }
    if let Some(command) = handle_queue_key(app, key) {
        return command;
    }
    if app.fullscreen.agent_thread_switcher.focused() {
        return handle_screen_navigation_key(app, key).flatten();
    }
    let temporary_interaction_active = app.completion().is_some();
    let is_screen_escape_press = key.kind == KeyEventKind::Press
        && key.code == KeyCode::Esc
        && key.modifiers.is_empty()
        && !temporary_interaction_active;
    if key.kind == KeyEventKind::Press && !is_screen_escape_press {
        app.fullscreen.escape.reset();
    }
    let keymap_context = app.app_keymap_context(key.kind == KeyEventKind::Press);
    match app.app_keymap.route_chord(&key, keymap_context, now) {
        AppChordMatch::PassThrough => {}
        AppChordMatch::Pending | AppChordMatch::Consumed => return None,
        AppChordMatch::Command(action) => {
            return app.apply_app_keymap_action(action, now);
        }
    }
    if let Some(command) = handle_screen_navigation_key(app, key) {
        return command;
    }
    if handle_transcript_selection_key(app, key) {
        return None;
    }
    if !app.accepts_input() {
        app.fullscreen.escape.reset();
        return handle_app_key(app, key, now, terminal_area);
    }
    if !app.fullscreen.input_focused() {
        return handle_app_key(app, key, now, terminal_area);
    }

    let outcome = app.handle_composer_key(key);
    if matches!(outcome, ChatComposerOutcome::Unhandled) {
        return handle_app_key(app, key, now, terminal_area);
    }
    app.handle_chat_composer_outcome(outcome, now)
}

fn handle_header_key(app: &mut App, key: KeyEvent) -> Option<Option<AppCommand>> {
    if key.kind != KeyEventKind::Press {
        return Some(None);
    }
    let targets = super::header::keyboard_targets(app);
    let selected = app.fullscreen.header.selected()?;
    let index = targets
        .iter()
        .position(|target| *target == selected)
        .unwrap_or(0);
    match key.code {
        KeyCode::Left => {
            let next = index
                .checked_sub(1)
                .unwrap_or(targets.len().saturating_sub(1));
            app.fullscreen.focus_header(targets[next]);
            Some(None)
        }
        KeyCode::Right => {
            app.fullscreen
                .focus_header(targets[(index + 1) % targets.len()]);
            Some(None)
        }
        KeyCode::Enter => Some(activate_header_target(app, selected)),
        KeyCode::Tab | KeyCode::BackTab => {
            focus_input(app);
            Some(None)
        }
        _ => Some(None),
    }
}

pub(in crate::app) fn activate_header_target(
    app: &mut App,
    target: super::header::Target,
) -> Option<AppCommand> {
    use super::header::Target;
    match target {
        Target::Branch => {
            app.open_command_panel(CommandPanel::loading("Switch branch", "Loading branches…"));
            Some(crate::git::Command::OpenPicker.into())
        }
        Target::Workspace => {
            app.open_command_panel(CommandPanel::loading(
                "Switch project folder",
                "Loading Project folders…",
            ));
            Some(crate::projects::Command::OpenRoots.into())
        }
        Target::Context => {
            app.open_command_panel(CommandPanel::loading("Status", "Loading context…"));
            Some(crate::status::Command::OpenPanel.into())
        }
        Target::Dashboard => {
            if app.session_manager_view().is_some() {
                return exit_manager(app).flatten();
            }
            show_manager(app);
            None
        }
    }
}

pub(in crate::app) fn handle_queue_key(app: &mut App, key: KeyEvent) -> Option<Option<AppCommand>> {
    if app.queue_focused() {
        let outcome = app
            .fullscreen
            .viewports
            .active_mut()
            .queue
            .handle_key(&app.thread_presentations.active().queue, key);
        if outcome == QueueKeyOutcome::Unhandled {
            return None;
        }
        return Some(match outcome {
            QueueKeyOutcome::Restore(queue_id) => {
                if !app.thread_presentations.active().input.is_empty() {
                    app.thread.update(ThreadPresentationEvent::FailureReported(
                        "clear the current draft before restoring a queued message".into(),
                    ));
                    None
                } else {
                    app.thread_presentations
                        .active_mut()
                        .queue
                        .target(queue_id)
                        .map(|target| {
                            crate::thread::Command::EditQueue {
                                target,
                                action: crate::thread::queue::QueueAction::Pause,
                            }
                            .into()
                        })
                }
            }
            QueueKeyOutcome::Send(queue_id) => {
                let command = app.send_queued_message(queue_id);
                if command.is_some() {
                    app.fullscreen.viewports.active_mut().queue.blur();
                }
                command
            }
            QueueKeyOutcome::Delete(queue_id) => app
                .thread_presentations
                .active_mut()
                .queue
                .target(queue_id)
                .map(|target| crate::thread::Command::CancelQueue(target).into()),
            QueueKeyOutcome::Move(queue_id, direction) => app
                .thread_presentations
                .active_mut()
                .queue
                .target(queue_id)
                .map(|target| {
                    crate::thread::Command::EditQueue {
                        target,
                        action: crate::thread::queue::QueueAction::Move(direction),
                    }
                    .into()
                }),
            QueueKeyOutcome::Consumed => None,
            QueueKeyOutcome::Unhandled => unreachable!("handled above"),
        });
    }
    if !app.accepts_input() || app.session_manager_view().is_some() {
        return None;
    }
    if key.kind == KeyEventKind::Press
        && key.code == KeyCode::Up
        && key.modifiers == KeyModifiers::ALT
        && app
            .fullscreen
            .viewports
            .active_mut()
            .queue
            .focus_latest(&app.thread_presentations.active().queue)
    {
        app.fullscreen.viewports.active_mut().selected_cell = None;
        app.fullscreen.agent_thread_switcher.blur();
        return Some(None);
    }
    None
}

pub(in crate::app) fn handle_screen_navigation_key(
    app: &mut App,
    key: KeyEvent,
) -> Option<Option<AppCommand>> {
    if key.kind == KeyEventKind::Release
        || (key.kind == KeyEventKind::Repeat && Navigation::from_key(key).is_none())
    {
        return None;
    }
    if matches!(
        app.fullscreen.sessions.screen(),
        Some(SessionScreen::Manager)
    ) && app.fullscreen.sessions.manager().focused()
    {
        return match app
            .fullscreen
            .sessions
            .handle_manager_key(&app.sessions, key)
        {
            SessionManagerInputOutcome::Unhandled => None,
            SessionManagerInputOutcome::Consumed => Some(None),
            SessionManagerInputOutcome::Command(command) => Some(Some(command.into())),
            SessionManagerInputOutcome::ExitRequested => exit_manager(app),
            SessionManagerInputOutcome::DetailsRequested => {
                app.fullscreen.panels.overlay = None;
                app.fullscreen.sessions.open_details(&app.sessions);
                app.fullscreen.pointer.clear();
                Some(None)
            }
        };
    }
    if app.fullscreen.agent_thread_switcher.focused() {
        if let Some(navigation) = Navigation::from_key(key) {
            app.fullscreen.agent_thread_switcher.navigate(navigation);
            return Some(None);
        }
        return match key.code {
            _ if bindings::THREAD_SWITCH.matches(key) => Some(
                app.fullscreen
                    .agent_thread_switcher
                    .selected()
                    .cloned()
                    .map(|thread_id| SessionCommand::SwitchThread { thread_id }.into()),
            ),
            _ if bindings::RETURN_INPUT.matches(key) => {
                app.fullscreen.agent_thread_switcher.blur();
                Some(None)
            }
            _ => None,
        };
    }
    if !key.modifiers.is_empty() || !chat_input_focused(app) || !app.input().is_empty() {
        return None;
    }
    if key.code == KeyCode::Left && app.session_manager_view().is_none() {
        close_transient_surfaces(app);
        app.fullscreen.sessions.show_manager(&app.sessions);
        return Some(None);
    }
    if key.code == KeyCode::Right && app.session_manager_view().is_none() {
        return Some(app.fullscreen.issues.open().map(Into::into));
    }
    let target = match empty_input_navigation(app.fullscreen.sessions.screen(), key.code)? {
        EmptyInputNavigation::PreviousScreen => match app.fullscreen.sessions.previous_screen() {
            Some(target) => target,
            None => return Some(None),
        },
        EmptyInputNavigation::NextScreen => {
            match app.fullscreen.sessions.next_screen(&app.sessions) {
                Some(target) => target,
                None => return Some(None),
            }
        }
        EmptyInputNavigation::FocusManager => {
            app.fullscreen.sessions.manager_mut().focus();
            return Some(None);
        }
        EmptyInputNavigation::FocusAgentThreads => {
            app.fullscreen.agent_thread_switcher.focus();
            return Some(None);
        }
    };
    match target {
        SessionScreen::Manager => {
            close_transient_surfaces(app);
            app.fullscreen.sessions.show_manager(&app.sessions);
            Some(None)
        }
        SessionScreen::Session(session_id) => {
            if app.sessions.active_session_id() == Some(&session_id) {
                if let Some(thread_id) = app.sessions.restorable_thread(&session_id)
                    && app.sessions.remembered_thread(&session_id) != Some(&thread_id)
                {
                    return Some(Some(
                        SessionCommand::Resume {
                            session_id: session_id.to_string(),
                            preferred_thread_id: Some(thread_id),
                        }
                        .into(),
                    ));
                }
                close_transient_surfaces(app);
                app.fullscreen.sessions.show_session(session_id);
                Some(None)
            } else {
                Some(Some(
                    SessionCommand::Resume {
                        session_id: session_id.to_string(),
                        preferred_thread_id: app.sessions.remembered_thread(&session_id).cloned(),
                    }
                    .into(),
                ))
            }
        }
    }
}

pub(in crate::app) fn handle_app_key(
    app: &mut App,
    key: KeyEvent,
    now: Instant,
    terminal_area: Rect,
) -> Option<AppCommand> {
    let keymap_context = app.app_keymap_context(key.kind == KeyEventKind::Press);
    if let Some(action) = app.app_keymap.resolve_single(&key, keymap_context) {
        return app.apply_app_keymap_action(action, now);
    }
    if app.list_selection().is_none()
        && let Some(command) = handle_transcript_scroll_key(app, key, terminal_area)
    {
        return command;
    }
    None
}

pub(in crate::app) fn handle_transcript_scroll_key(
    app: &mut App,
    key: KeyEvent,
    terminal_area: Rect,
) -> Option<Option<AppCommand>> {
    match (key.modifiers, key.code) {
        (KeyModifiers::NONE, KeyCode::PageUp) => Some(navigate_transcript(
            app,
            TranscriptScrollDirection::Up,
            terminal_area,
        )),
        (KeyModifiers::NONE, KeyCode::PageDown) => Some(navigate_transcript(
            app,
            TranscriptScrollDirection::Down,
            terminal_area,
        )),
        (KeyModifiers::CONTROL, KeyCode::Home) => {
            let messages = app.visible_transcript_views();
            if let Some(target) = first_scroll_target(false, &messages) {
                app.fullscreen.viewports.active_mut().scroll.apply(target);
            }
            Some(Some(ThreadCommand::LoadOlderHistory.into()))
        }
        (KeyModifiers::CONTROL, KeyCode::End) => {
            app.follow_latest_transcript();
            Some(None)
        }
        _ => None,
    }
}

pub(in crate::app) fn handle_transcript_selection_key(app: &mut App, key: KeyEvent) -> bool {
    if key.kind == KeyEventKind::Release
        || !matches!(
            app.fullscreen.sessions.screen(),
            Some(SessionScreen::Session(_))
        )
        || app.fullscreen.panels.command_active()
        || app.completion().is_some()
    {
        return false;
    }
    if key.kind == KeyEventKind::Press
        && bindings::RETURN_INPUT.matches(key)
        && app.fullscreen.viewports.active().selected_cell.is_some()
    {
        app.fullscreen.viewports.active_mut().selected_cell = None;
        return true;
    }
    if !app.input().is_empty() {
        return false;
    }
    let cell_ids = app
        .thread
        .cells()
        .iter()
        .map(|cell| cell.cell_id().clone())
        .collect::<Vec<_>>();
    let navigation_key = if key.modifiers == KeyModifiers::CONTROL
        && matches!(key.code, KeyCode::Up | KeyCode::Down)
    {
        KeyEvent {
            modifiers: KeyModifiers::NONE,
            ..key
        }
    } else {
        key
    };
    if app.fullscreen.viewports.active().selected_cell.is_some()
        && let Some(navigation) = Navigation::from_key(navigation_key)
    {
        app.fullscreen
            .viewports
            .active_mut()
            .navigate_cell(&cell_ids, navigation);
        return true;
    }
    if key.kind != KeyEventKind::Press {
        return app.fullscreen.viewports.active().selected_cell.is_some();
    }
    match (key.modifiers, key.code) {
        (KeyModifiers::CONTROL, KeyCode::Up) => app
            .fullscreen
            .viewports
            .active_mut()
            .select_previous_cell(&cell_ids),
        (KeyModifiers::CONTROL, KeyCode::Down) => app
            .fullscreen
            .viewports
            .active_mut()
            .select_next_cell(&cell_ids),
        _ if bindings::TRANSCRIPT_EXPAND.matches(key) => {
            let Some(selected) = app.fullscreen.viewports.active().selected_cell.clone() else {
                return false;
            };
            if app
                .thread
                .cells()
                .iter()
                .any(|cell| cell.cell_id() == &selected && cell.can_expand())
            {
                app.fullscreen.viewports.active_mut().toggle_cell(&selected);
            }
            true
        }
        _ if bindings::TRANSCRIPT_DETAILS.matches(key) => {
            let Some(selected) = app.fullscreen.viewports.active().selected_cell.clone() else {
                return false;
            };
            app.open_transcript_cell_details(selected.as_str());
            true
        }
        _ => false,
    }
}

pub(in crate::app) fn scroll_transcript(
    app: &mut App,
    direction: TranscriptScrollDirection,
    terminal_area: Rect,
) -> bool {
    let transcript_area = super::layout(app, terminal_area).session.transcript;
    let messages = app.visible_transcript_views();
    let target = scroll_target(
        transcript_area,
        0,
        &messages,
        app.transcript_scroll(),
        app.transcript_render_cache(),
        app.render_context(),
        direction,
        5,
    );
    target.is_some_and(|target| app.fullscreen.viewports.active_mut().scroll.apply(target))
}

pub(in crate::app) fn navigate_transcript(
    app: &mut App,
    direction: TranscriptScrollDirection,
    terminal_area: Rect,
) -> Option<AppCommand> {
    if app.fullscreen.sessions.preview.is_some() {
        return navigate_preview(app, direction, 5, terminal_area);
    }
    if scroll_transcript(app, direction, terminal_area)
        || direction == TranscriptScrollDirection::Down
    {
        return None;
    }
    let messages = app.visible_transcript_views();
    if let Some(target) = first_scroll_target(false, &messages) {
        app.fullscreen.viewports.active_mut().scroll.apply(target);
    }
    Some(ThreadCommand::LoadOlderHistory.into())
}

pub(in crate::app) fn navigate_preview(
    app: &mut App,
    direction: TranscriptScrollDirection,
    rows: usize,
    terminal_area: Rect,
) -> Option<AppCommand> {
    let area = super::layout(app, terminal_area).session.transcript;
    let mut preview = app.fullscreen.sessions.preview.take()?;
    let mut viewport = std::mem::take(&mut app.fullscreen.preview);
    let params = preview.navigate(
        &mut viewport,
        direction,
        rows,
        area,
        0,
        app.render_context(),
    );
    let command = params.map(|params| {
        SessionCommand::Preview {
            generation: preview.generation,
            params,
        }
        .into()
    });
    app.fullscreen.sessions.preview = Some(preview);
    app.fullscreen.preview = viewport;
    command
}

pub(in crate::app) fn completion_visible(app: &App) -> bool {
    app.session_preview().is_none()
        && app.overlay().is_none()
        && app.command_panel().is_none()
        && app.approval_view().is_none()
        && app.query_view().is_none()
        && app.completion().is_some()
}

pub(in crate::app) fn chat_input_focused(app: &App) -> bool {
    if app.fullscreen.home_visible() {
        return app.fullscreen.input_focused()
            && !super::modal::is_open(app)
            && app.fullscreen.home.selected.is_none()
            && app.sessions.pending_submission.is_none();
    }
    app.fullscreen.input_focused()
        && app.overlay().is_none()
        && app.approval_view().is_none()
        && app.query_view().is_none()
        && !app.fullscreen.issues.is_open()
        && !app.fullscreen.sessions.manager().focused()
        && !app.fullscreen.agent_thread_switcher.focused()
        && !app.queue_focused()
        && !transcript_selection_active(app)
        && !app.fullscreen.panels.command_active()
}

pub(in crate::app) fn transcript_selection_active(app: &App) -> bool {
    !app.fullscreen.home_visible()
        && matches!(
            app.fullscreen.sessions.screen(),
            Some(SessionScreen::Session(_))
        )
        && app.fullscreen.viewports.active().selected_cell.is_some()
}

pub(in crate::app) fn screen_navigation_tip(app: &App) -> Option<&'static str> {
    if !chat_input_focused(app) || !app.input().is_empty() {
        return None;
    }
    match app.fullscreen.sessions.previous_screen()? {
        SessionScreen::Manager => Some("← Dashboard"),
        SessionScreen::Session(_) => None,
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum EmptyInputNavigation {
    PreviousScreen,
    NextScreen,
    FocusManager,
    FocusAgentThreads,
}

fn empty_input_navigation(
    screen: Option<&SessionScreen>,
    key: KeyCode,
) -> Option<EmptyInputNavigation> {
    match key {
        KeyCode::Left => Some(EmptyInputNavigation::PreviousScreen),
        KeyCode::Esc if matches!(screen, Some(SessionScreen::Manager)) => {
            Some(EmptyInputNavigation::NextScreen)
        }
        KeyCode::Up if matches!(screen, Some(SessionScreen::Manager)) => {
            Some(EmptyInputNavigation::FocusManager)
        }
        KeyCode::Down if matches!(screen, Some(SessionScreen::Session(_))) => {
            Some(EmptyInputNavigation::FocusAgentThreads)
        }
        _ => None,
    }
}

pub(in crate::app) fn open_command_panel(app: &mut App, panel: CommandPanel) {
    app.fullscreen.escape.reset();
    app.fullscreen.panels.overlay = None;
    app.fullscreen.sessions.details = None;
    let generation = app.new_panel_generation();
    app.fullscreen.panels.open_command(panel, generation);
    app.fullscreen.clear();
}

pub(in crate::app) fn close_command_panel(app: &mut App) {
    app.fullscreen.escape.reset();
    app.fullscreen.panels.close_command();
    app.fullscreen.clear();
}

pub(in crate::app) fn show_overlay(app: &mut App, detail: DetailList) {
    app.fullscreen.escape.reset();
    app.fullscreen.sessions.details = None;
    app.fullscreen.panels.overlay = Some(DetailOverlay::new(detail));
    app.fullscreen.clear();
}

pub(in crate::app) fn close_overlay(app: &mut App) {
    app.fullscreen.escape.reset();
    app.fullscreen.panels.overlay = None;
    app.fullscreen.sessions.details = None;
    app.fullscreen.clear();
}

pub(in crate::app) fn close_transient_surfaces(app: &mut App) {
    app.fullscreen.escape.reset();
    app.fullscreen.panels.close_command();
    app.fullscreen.panels.overlay = None;
    app.fullscreen.sessions.details = None;
    app.fullscreen.viewports.active_mut().queue.blur();
    app.fullscreen.clear();
}

pub(super) fn focus_input(app: &mut App) {
    clear_page_focus(app);
    app.fullscreen.focus_input();
}

pub(super) fn focus_page(app: &mut App) {
    clear_page_focus(app);
    app.fullscreen.focus_page();
}

fn clear_page_focus(app: &mut App) {
    app.fullscreen.home.selected = None;
    app.fullscreen.sessions.manager_mut().blur();
    app.fullscreen.agent_thread_switcher.blur();
    app.fullscreen.viewports.active_mut().queue.blur();
    app.fullscreen.viewports.active_mut().selected_cell = None;
}

pub(in crate::app) fn open_home(app: &mut App) {
    let draft_is_empty = app.sessions.input.text().is_empty() && app.sessions.input.is_empty();
    close_transient_surfaces(app);
    app.fullscreen.issues.close();
    app.fullscreen.agent_thread_switcher.blur();
    app.fullscreen.sessions.manager_mut().blur();
    app.fullscreen.home.show_welcome();
    if !draft_is_empty {
        app.fullscreen.home.dismiss_welcome();
    }
    app.fullscreen.page = super::Page::Home;
    app.chat_panel.reset_top_tip();
    app.fullscreen.focus_input();
}

pub(in crate::app) fn show_conversation(app: &mut App, session_id: ash_protocol::SessionId) {
    close_transient_surfaces(app);
    app.fullscreen.page = super::Page::Conversation;
    app.fullscreen.sessions.show_session(session_id);
    app.fullscreen.focus_input();
}

pub(in crate::app) fn show_manager(app: &mut App) {
    close_transient_surfaces(app);
    app.fullscreen.agent_thread_switcher.blur();
    app.fullscreen.page = super::Page::Conversation;
    app.fullscreen.sessions.show_manager(&app.sessions);
    app.fullscreen.focus_input();
}

pub(in crate::app) fn open_issues(app: &mut App) -> Option<AppCommand> {
    close_transient_surfaces(app);
    app.fullscreen.page = super::Page::Conversation;
    app.fullscreen.issues.open().map(Into::into)
}

pub(in crate::app) fn exit_manager(app: &mut App) -> Option<Option<AppCommand>> {
    let target = app.fullscreen.sessions.next_screen(&app.sessions);
    match target {
        Some(SessionScreen::Session(session_id)) => {
            if app.sessions.active_session_id() == Some(&session_id) {
                if let Some(thread_id) = app.sessions.restorable_thread(&session_id)
                    && app.sessions.remembered_thread(&session_id) != Some(&thread_id)
                {
                    return Some(Some(
                        SessionCommand::Resume {
                            session_id: session_id.to_string(),
                            preferred_thread_id: Some(thread_id),
                        }
                        .into(),
                    ));
                }
                show_conversation(app, session_id);
                Some(None)
            } else {
                Some(Some(
                    SessionCommand::Resume {
                        session_id: session_id.to_string(),
                        preferred_thread_id: app.sessions.remembered_thread(&session_id).cloned(),
                    }
                    .into(),
                ))
            }
        }
        _ => {
            close_transient_surfaces(app);
            if app.fullscreen_home_visible() || app.sessions.active_session_id().is_none() {
                open_home(app);
            } else {
                app.show_conversation();
            }
            Some(None)
        }
    }
}

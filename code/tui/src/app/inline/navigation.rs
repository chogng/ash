use super::header;
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
use crate::widgets::overlay::OverlayInputOutcome;
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
    if app.inline.issues.is_open() {
        return app.inline.issues.handle_key(key).map(Into::into);
    }
    let overlay_area = super::layout(app, terminal_area).transient_area();
    if let Some(overlay) = app.overlay_mut() {
        if overlay.handle_key(key, overlay_area) == OverlayInputOutcome::Dismiss {
            close_overlay(app);
        }
        return None;
    }
    if app.inline.sessions.preview.is_some() {
        if key.kind == KeyEventKind::Press && bindings::CLOSE.matches(key) {
            app.inline.sessions.preview = None;

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
                let preview = app.inline.sessions.preview.as_mut().unwrap();
                preview.first(&mut app.inline.preview).map(|params| {
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
    if matches!(app.inline.sessions.screen(), Some(SessionScreen::Manager))
        && app.inline.sessions.manager().focused()
    {
        return handle_screen_navigation_key(app, key).flatten();
    }
    if matches!(
        app.inline.sessions.screen(),
        Some(SessionScreen::Session(_))
    ) {
        if let Some(command) = app.handle_thread_request_key(key) {
            return command;
        }
        if app.chat_panel.request_active() {
            return None;
        }
    }
    let composer_area = super::layout(app, terminal_area).session.composer;
    if let Some(panel) = app.inline.panels.command_mut() {
        let outcome = super::panel::handle_key(panel, key, composer_area);
        return app.handle_command_panel_outcome(outcome);
    }
    if chat_input_focused(app) && app.input_state().history_intercepts(key) {
        let outcome = app.handle_composer_key(key);
        app.inline.escape.reset();
        return app.handle_chat_composer_outcome(outcome, now);
    }
    if let Some(command) = handle_queue_key(app, key) {
        return command;
    }
    if app.inline.agent_thread_switcher.focused() {
        return handle_screen_navigation_key(app, key).flatten();
    }
    let temporary_interaction_active = app.completion().is_some();
    let is_screen_escape_press = key.kind == KeyEventKind::Press
        && key.code == KeyCode::Esc
        && key.modifiers.is_empty()
        && !temporary_interaction_active;
    if key.kind == KeyEventKind::Press && !is_screen_escape_press {
        app.inline.escape.reset();
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
        app.inline.escape.reset();
        return handle_app_key(app, key, now, terminal_area);
    }

    let outcome = app.handle_composer_key(key);
    if matches!(outcome, ChatComposerOutcome::Unhandled) {
        return handle_app_key(app, key, now, terminal_area);
    }
    app.handle_chat_composer_outcome(outcome, now)
}

pub(in crate::app) fn handle_queue_key(app: &mut App, key: KeyEvent) -> Option<Option<AppCommand>> {
    if app.queue_focused() {
        let outcome = app
            .inline
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
                    app.inline.viewports.active_mut().queue.blur();
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
            .inline
            .viewports
            .active_mut()
            .queue
            .focus_latest(&app.thread_presentations.active().queue)
    {
        app.inline.viewports.active_mut().selected_cell = None;
        app.inline.agent_thread_switcher.blur();
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
    if matches!(app.inline.sessions.screen(), Some(SessionScreen::Manager))
        && app.inline.sessions.manager().focused()
    {
        return match app.inline.sessions.handle_manager_key(&app.sessions, key) {
            SessionManagerInputOutcome::Unhandled => None,
            SessionManagerInputOutcome::Consumed => Some(None),
            SessionManagerInputOutcome::Command(command) => Some(Some(command.into())),
            SessionManagerInputOutcome::DetailsRequested => {
                app.inline.panels.overlay = None;
                app.inline.sessions.open_details(&app.sessions);

                Some(None)
            }
            SessionManagerInputOutcome::ExitRequested => exit_manager(app),
        };
    }
    if app.inline.agent_thread_switcher.focused() {
        if let Some(navigation) = Navigation::from_key(key) {
            app.inline.agent_thread_switcher.navigate(navigation);
            return Some(None);
        }
        return match key.code {
            _ if bindings::THREAD_SWITCH.matches(key) => Some(
                app.inline
                    .agent_thread_switcher
                    .selected()
                    .cloned()
                    .map(|thread_id| SessionCommand::SwitchThread { thread_id }.into()),
            ),
            _ if bindings::RETURN_INPUT.matches(key) => {
                app.inline.agent_thread_switcher.blur();
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
        app.inline.sessions.show_manager(&app.sessions);
        return Some(None);
    }
    if key.code == KeyCode::Right && app.session_manager_view().is_none() {
        return Some(app.inline.issues.open().map(Into::into));
    }
    let target = match empty_input_navigation(app.inline.sessions.screen(), key.code)? {
        EmptyInputNavigation::PreviousScreen => match app.inline.sessions.previous_screen() {
            Some(target) => target,
            None => return Some(None),
        },
        EmptyInputNavigation::NextScreen => return exit_manager(app),
        EmptyInputNavigation::FocusManager => {
            app.inline.sessions.manager_mut().focus();
            return Some(None);
        }
        EmptyInputNavigation::FocusAgentThreads => {
            app.inline.agent_thread_switcher.focus();
            return Some(None);
        }
    };
    match target {
        SessionScreen::Manager => {
            close_transient_surfaces(app);
            app.inline.sessions.show_manager(&app.sessions);
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
                app.inline.sessions.show_session(session_id);
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
            if let Some(target) = first_scroll_target(true, &messages) {
                app.inline.viewports.active_mut().scroll.apply(target);
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
            app.inline.sessions.screen(),
            Some(SessionScreen::Session(_))
        )
        || app.inline.panels.command_active()
        || app.completion().is_some()
    {
        return false;
    }
    if key.kind == KeyEventKind::Press
        && bindings::RETURN_INPUT.matches(key)
        && app.inline.viewports.active().selected_cell.is_some()
    {
        app.inline.viewports.active_mut().selected_cell = None;
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
    if app.inline.viewports.active().selected_cell.is_some()
        && let Some(navigation) = Navigation::from_key(navigation_key)
    {
        app.inline
            .viewports
            .active_mut()
            .navigate_cell(&cell_ids, navigation);
        return true;
    }
    if key.kind != KeyEventKind::Press {
        return app.inline.viewports.active().selected_cell.is_some();
    }
    match (key.modifiers, key.code) {
        (KeyModifiers::CONTROL, KeyCode::Up) => app
            .inline
            .viewports
            .active_mut()
            .select_previous_cell(&cell_ids),
        (KeyModifiers::CONTROL, KeyCode::Down) => app
            .inline
            .viewports
            .active_mut()
            .select_next_cell(&cell_ids),
        _ if bindings::TRANSCRIPT_EXPAND.matches(key) => {
            let Some(selected) = app.inline.viewports.active().selected_cell.clone() else {
                return false;
            };
            if app
                .thread
                .cells()
                .iter()
                .any(|cell| cell.cell_id() == &selected && cell.can_expand())
            {
                app.inline.viewports.active_mut().toggle_cell(&selected);
            }
            true
        }
        _ if bindings::TRANSCRIPT_DETAILS.matches(key) => {
            let Some(selected) = app.inline.viewports.active().selected_cell.clone() else {
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
        usize::from(header::history_height(transcript_area.height)),
        &messages,
        app.transcript_scroll(),
        app.transcript_render_cache(),
        app.render_context(),
        direction,
        5,
    );
    target.is_some_and(|target| app.inline.viewports.active_mut().scroll.apply(target))
}

pub(in crate::app) fn navigate_transcript(
    app: &mut App,
    direction: TranscriptScrollDirection,
    terminal_area: Rect,
) -> Option<AppCommand> {
    if app.inline.sessions.preview.is_some() {
        return navigate_preview(app, direction, 5, terminal_area);
    }
    if scroll_transcript(app, direction, terminal_area)
        || direction == TranscriptScrollDirection::Down
    {
        return None;
    }
    let messages = app.visible_transcript_views();
    if let Some(target) = first_scroll_target(true, &messages) {
        app.inline.viewports.active_mut().scroll.apply(target);
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
    let mut preview = app.inline.sessions.preview.take()?;
    let mut viewport = std::mem::take(&mut app.inline.preview);
    let params = preview.navigate(
        &mut viewport,
        direction,
        rows,
        area,
        usize::from(header::history_height(area.height)),
        app.render_context(),
    );
    let command = params.map(|params| {
        SessionCommand::Preview {
            generation: preview.generation,
            params,
        }
        .into()
    });
    app.inline.sessions.preview = Some(preview);
    app.inline.preview = viewport;
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
    app.overlay().is_none()
        && app.approval_view().is_none()
        && app.query_view().is_none()
        && !app.inline.sessions.manager().focused()
        && !app.inline.agent_thread_switcher.focused()
        && !app.queue_focused()
        && !transcript_selection_active(app)
        && !app.inline.panels.command_active()
}

pub(in crate::app) fn transcript_selection_active(app: &App) -> bool {
    matches!(
        app.inline.sessions.screen(),
        Some(SessionScreen::Session(_))
    ) && app.inline.viewports.active().selected_cell.is_some()
}

pub(in crate::app) fn screen_navigation_tip(app: &App) -> Option<&'static str> {
    if !chat_input_focused(app) || !app.input().is_empty() {
        return None;
    }
    match app.inline.sessions.previous_screen()? {
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
    app.inline.escape.reset();
    app.inline.panels.overlay = None;
    app.inline.sessions.details = None;
    let generation = app.new_panel_generation();
    app.inline.panels.open_command(panel, generation);
}

pub(in crate::app) fn close_command_panel(app: &mut App) {
    app.inline.escape.reset();
    app.inline.panels.close_command();
}

pub(in crate::app) fn show_overlay(app: &mut App, detail: DetailList) {
    app.inline.escape.reset();
    app.inline.sessions.details = None;
    app.inline.panels.overlay = Some(DetailOverlay::new(detail));
}

pub(in crate::app) fn close_overlay(app: &mut App) {
    app.inline.escape.reset();
    app.inline.panels.overlay = None;
    app.inline.sessions.details = None;
}

pub(in crate::app) fn close_transient_surfaces(app: &mut App) {
    app.inline.escape.reset();
    app.inline.panels.close_command();
    app.inline.panels.overlay = None;
    app.inline.sessions.details = None;
    app.inline.viewports.active_mut().queue.blur();
}

pub(in crate::app) fn open_home(app: &mut App) {
    close_transient_surfaces(app);
    app.inline.issues.close();
    app.inline.agent_thread_switcher.blur();
    app.inline.sessions.show_manager(&app.sessions);
}

pub(in crate::app) fn show_conversation(app: &mut App, session_id: ash_protocol::SessionId) {
    close_transient_surfaces(app);
    app.inline.sessions.show_session(session_id);
}

pub(in crate::app) fn show_manager(app: &mut App) {
    close_transient_surfaces(app);
    app.inline.agent_thread_switcher.blur();
    app.inline.sessions.show_manager(&app.sessions);
}

pub(in crate::app) fn open_issues(app: &mut App) -> Option<AppCommand> {
    close_transient_surfaces(app);
    app.inline.issues.open().map(Into::into)
}

pub(in crate::app) fn exit_manager(app: &mut App) -> Option<Option<AppCommand>> {
    let target = app.inline.sessions.next_screen(&app.sessions);
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
                close_transient_surfaces(app);
                app.inline.sessions.show_session(session_id);
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
            open_home(app);
            Some(None)
        }
    }
}

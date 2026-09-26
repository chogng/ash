use crate::app::App;
use crate::app::fullscreen::pointer::MouseAction;
use crate::app::fullscreen::selection::ClickCount;
use crate::app::fullscreen::selection::ScreenSelectionOutcome;
use crate::host;
use crate::terminal::TerminalSession;
use crate::thread::composer as chat_composer;
use crate::thread::composer::ChatComposerPointerTarget;
use crate::thread::transcript::TranscriptScrollDirection;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use crossterm::event::MouseButton;
use crossterm::event::MouseEvent;
use crossterm::event::MouseEventKind;
use ratatui::layout::Position;
use ratatui::layout::Rect;
use std::time::Instant;

pub(in crate::app) fn handle_mouse(app: &mut App, area: Rect, mouse: MouseEvent) -> MouseAction {
    let areas = super::layout(app, area);
    let position = Position::new(mouse.column, mouse.row);
    let input_down = mouse.kind == MouseEventKind::Down(MouseButton::Left)
        && app.accepts_input()
        && !areas.input.is_empty()
        && app.approval_view().is_none()
        && app.query_view().is_none()
        && chat_composer::ChatInputChrome::Rules
            .border_area(areas.input)
            .contains(position);
    if input_down
        || (app.input_state().pointer_active()
            && matches!(
                mouse.kind,
                MouseEventKind::Drag(MouseButton::Left) | MouseEventKind::Up(MouseButton::Left)
            ))
    {
        app.inline.completion_pressed = None;
        app.inline.selection.clear();
        let input = app.input_state();
        let hit = chat_composer::cursor_at(
            areas.input,
            chat_composer::ChatInputChrome::Rules,
            input.text(),
            input.cursor_line(),
            input.cursor_display_width(),
            input.pointer_scroll_row(),
            position,
        );
        match mouse.kind {
            MouseEventKind::Down(MouseButton::Left) => {
                super::navigation::focus_input(app);
                app.input_state_mut().pointer_down(hit);
            }
            MouseEventKind::Drag(MouseButton::Left) => app.input_state_mut().pointer_drag(hit),
            MouseEventKind::Up(MouseButton::Left) => {
                app.input_state_mut().pointer_drag(hit);
                app.input_state_mut().pointer_up();
                if let Some(range) = app.input_state().selection_range() {
                    return MouseAction::InputSelection(app.input()[range].to_owned());
                }
            }
            _ => unreachable!(),
        }
        return MouseAction::Selection(None);
    }
    if mouse.kind == MouseEventKind::Down(MouseButton::Left) {
        app.input_state_mut().pointer_up();
    }
    let completion = if app.completion_visible() {
        match chat_composer::pointer_target_at(
            areas.completion_area(),
            &app.chat_composer_view(),
            true,
            mouse.column,
            mouse.row,
            app.language(),
        ) {
            Some(ChatComposerPointerTarget::CompletionItem(index)) => Some(index),
            _ => None,
        }
    } else {
        None
    };
    if matches!(
        mouse.kind,
        MouseEventKind::ScrollUp | MouseEventKind::ScrollDown
    ) {
        let direction = if mouse.kind == MouseEventKind::ScrollUp {
            TranscriptScrollDirection::Up
        } else {
            TranscriptScrollDirection::Down
        };
        if completion.is_some() {
            let key = if mouse.kind == MouseEventKind::ScrollUp {
                KeyCode::Up
            } else {
                KeyCode::Down
            };
            return MouseAction::Command(
                app.handle_key_in_area(KeyEvent::new(key, KeyModifiers::NONE), area),
            );
        }
        if areas.session.transcript.contains(position) {
            return MouseAction::Command(app.navigate_transcript(direction, area));
        }
    }
    match mouse.kind {
        MouseEventKind::Down(MouseButton::Left) => {
            app.inline.completion_pressed = completion;
            app.inline.selection.clear();
            if completion.is_none() && area.contains(position) {
                app.inline.selection.begin(position);
            }
        }
        MouseEventKind::Drag(MouseButton::Left) => {
            app.inline.completion_pressed = None;
            app.inline.selection.drag(position);
        }
        MouseEventKind::Up(MouseButton::Left) => {
            let pressed = app.inline.completion_pressed.take();
            if let Some(index) = completion.filter(|index| Some(*index) == pressed) {
                app.inline.selection.clear();
                super::navigation::focus_input(app);
                return MouseAction::Command(app.activate_input_completion(index));
            }
            return MouseAction::Selection(app.inline.selection.finish(position, Instant::now()));
        }
        _ => {}
    }
    MouseAction::Selection(None)
}

pub(in crate::app) fn finish_pointer_gesture(
    app: &mut App,
    terminal: &TerminalSession,
    outcome: Option<ScreenSelectionOutcome>,
) {
    let range = match outcome {
        Some(ScreenSelectionOutcome::Selection(range)) => Some(range),
        Some(ScreenSelectionOutcome::Click {
            position,
            count: ClickCount::Double,
        }) => terminal.token_range_at(position),
        Some(ScreenSelectionOutcome::Click {
            position,
            count: ClickCount::Triple,
        }) => terminal.line_range_at(position),
        _ => None,
    };
    if let Some(range) = range {
        app.inline.selection.select(range);
        if let Some(text) = terminal.selected_text(range) {
            crate::app::fullscreen::selection::apply_copied_text(
                app,
                &text,
                host::clipboard::write_text,
            );
        }
    }
}

#[cfg(test)]
#[path = "pointer_tests.rs"]
mod tests;

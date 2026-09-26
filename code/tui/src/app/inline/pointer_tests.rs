use super::handle_mouse;
use crate::app::App;
use crate::app::AppCommand;
use crate::app::fullscreen::pointer::MouseAction;
use crate::app::fullscreen::selection::ScreenSelectionOutcome;
use crate::config::TerminalSettings;
use crate::terminal::ScreenMode;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use crossterm::event::MouseButton;
use crossterm::event::MouseEvent;
use crossterm::event::MouseEventKind;
use ratatui::layout::Rect;

fn inline_app() -> App {
    let mut app = App::new();
    let mut settings = TerminalSettings::default();
    settings.set_screen_mode(ScreenMode::Inline);
    app.update(crate::config::Event::SettingsReceived(settings));
    app
}

fn mouse(kind: MouseEventKind, column: u16, row: u16) -> MouseEvent {
    MouseEvent {
        kind,
        column,
        row,
        modifiers: KeyModifiers::NONE,
    }
}

#[test]
fn click_moves_cursor_and_drag_selects_editable_inline_text() {
    let mut app = inline_app();
    app.insert_text("ab你cd");
    let area = Rect::new(0, 8, 60, 16);
    let row = super::super::layout(&app, area).input.y + 1;

    handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Down(MouseButton::Left), 3, row),
    );
    handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Up(MouseButton::Left), 3, row),
    );
    assert_eq!(app.input_state().cursor_display_width(), 1);

    handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Down(MouseButton::Left), 3, row),
    );
    handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Drag(MouseButton::Left), 7, row),
    );
    let outcome = handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Up(MouseButton::Left), 7, row),
    );
    assert!(matches!(outcome, MouseAction::InputSelection(ref text) if text == "b你c"));
    assert_eq!(app.input_state().selection_range(), Some(1..6));

    app.handle_paste("X".into());
    assert_eq!(app.input(), "aXd");
    assert_eq!(app.input_state().selection_range(), None);
}

#[test]
fn backspace_and_delete_remove_the_dragged_inline_selection() {
    for key in [KeyCode::Backspace, KeyCode::Delete] {
        let mut app = inline_app();
        app.insert_text("ab你cd");
        let area = Rect::new(0, 8, 60, 16);
        let row = super::super::layout(&app, area).input.y + 1;
        handle_mouse(
            &mut app,
            area,
            mouse(MouseEventKind::Down(MouseButton::Left), 3, row),
        );
        handle_mouse(
            &mut app,
            area,
            mouse(MouseEventKind::Drag(MouseButton::Left), 7, row),
        );
        let outcome = handle_mouse(
            &mut app,
            area,
            mouse(MouseEventKind::Up(MouseButton::Left), 7, row),
        );
        let MouseAction::InputSelection(text) = outcome else {
            panic!("dragging the input must copy the selected text");
        };
        let mut copied = None;
        crate::app::fullscreen::selection::apply_copied_text(&mut app, &text, |text| {
            copied = Some(text.to_owned());
            Ok(())
        });
        assert_eq!(copied.as_deref(), Some("b你c"));
        assert_eq!(app.input_state().selection_range(), Some(1..6));

        app.handle_key(KeyEvent::new(key, KeyModifiers::NONE));

        assert_eq!(app.input(), "ad");
        assert_eq!(app.input_state().selection_range(), None);
    }
}

#[test]
fn dragging_beyond_the_inline_input_clamps_to_the_draft() {
    let mut app = inline_app();
    app.insert_text("first\nsecond");
    let area = Rect::new(0, 5, 60, 16);
    let input = super::super::layout(&app, area).input;

    handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Down(MouseButton::Left), 2, input.y + 1),
    );
    handle_mouse(
        &mut app,
        area,
        mouse(
            MouseEventKind::Drag(MouseButton::Left),
            50,
            area.bottom() - 1,
        ),
    );
    let outcome = handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Up(MouseButton::Left), 50, area.bottom() - 1),
    );
    assert!(matches!(outcome, MouseAction::InputSelection(ref text) if text == "first\nsecond"));
    assert_eq!(
        app.input_state().selection_range(),
        Some(0.."first\nsecond".len())
    );
}

#[test]
fn click_outside_input_cancels_an_unfinished_drag() {
    let mut app = inline_app();
    app.insert_text("draft");
    let area = Rect::new(0, 0, 60, 16);
    let input = super::super::layout(&app, area).input;
    handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Down(MouseButton::Left), 2, input.y + 1),
    );
    handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Down(MouseButton::Left), 2, 0),
    );
    assert!(!app.input_state().pointer_active());
    assert!(matches!(
        handle_mouse(
            &mut app,
            area,
            mouse(MouseEventKind::Up(MouseButton::Left), 9, 0)
        ),
        MouseAction::Selection(_)
    ));
}

#[test]
fn completion_requires_a_matching_press_and_release() {
    let mut app = inline_app();
    app.insert_text("/q");
    let area = Rect::new(0, 0, 80, 24);
    let completion_area = super::super::layout(&app, area).completion_area();
    let (column, row) = (completion_area.y..completion_area.bottom())
        .flat_map(|row| {
            (completion_area.x..completion_area.right()).map(move |column| (column, row))
        })
        .find(|(column, row)| {
            matches!(
                crate::thread::composer::pointer_target_at(
                    completion_area,
                    &app.chat_composer_view(),
                    true,
                    *column,
                    *row,
                    app.language(),
                ),
                Some(crate::thread::composer::ChatComposerPointerTarget::CompletionItem(0))
            )
        })
        .expect("completion item");

    assert!(matches!(
        handle_mouse(
            &mut app,
            area,
            mouse(MouseEventKind::Up(MouseButton::Left), column, row)
        ),
        MouseAction::Selection(_)
    ));
    handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Down(MouseButton::Left), column, row),
    );
    assert!(matches!(
        handle_mouse(
            &mut app,
            area,
            mouse(MouseEventKind::Up(MouseButton::Left), column, row)
        ),
        MouseAction::Command(Some(AppCommand::Quit))
    ));
}

#[test]
fn dragging_visible_inline_output_selects_screen_text() {
    let mut app = inline_app();
    app.update(crate::thread::Event::FailureReported(
        "visible output".into(),
    ));
    let area = Rect::new(0, 0, 60, 16);
    let transcript = super::super::layout(&app, area).session.transcript;
    assert!(!transcript.is_empty());
    let row = transcript.y;
    handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Down(MouseButton::Left), 2, row),
    );
    handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Drag(MouseButton::Left), 8, row),
    );
    let outcome = handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::Up(MouseButton::Left), 8, row),
    );
    assert!(matches!(
        outcome,
        MouseAction::Selection(Some(ScreenSelectionOutcome::Selection(_)))
    ));
    assert!(app.inline.selection.range().is_some());
}

#[test]
fn wheel_scrolls_inline_transcript() {
    let mut app = inline_app();
    for index in 0..12 {
        app.update(crate::thread::Event::FailureReported(format!(
            "failure {index}"
        )));
    }
    let area = Rect::new(0, 0, 50, 16);
    let transcript = super::super::layout(&app, area).session.transcript;
    assert!(!transcript.is_empty());
    handle_mouse(
        &mut app,
        area,
        mouse(MouseEventKind::ScrollUp, transcript.x, transcript.y),
    );
    assert!(app.transcript_scroll().anchor().is_some());
}

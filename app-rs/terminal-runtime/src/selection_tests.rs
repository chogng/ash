use super::{TerminalSelection, TerminalSelectionRange, paint_terminal_selection, selected_text};
use ash_terminal::{ScreenBuffer, TerminalMousePosition};
use zui::input::ElementState;
use zui::ui::{Color, Rect, UiScene};

fn position(row: u16, col: u16) -> TerminalMousePosition {
    TerminalMousePosition::new(row, col)
}

#[test]
fn reverse_drag_normalizes_to_document_order() {
    let mut selection = TerminalSelection::default();

    assert!(selection.button_changed(
        ScreenBuffer::Primary,
        Some(position(2, 4)),
        ElementState::Pressed,
    ));
    assert!(selection.moved(Some(position(0, 1))));
    assert!(selection.button_changed(
        ScreenBuffer::Primary,
        Some(position(0, 1)),
        ElementState::Released,
    ));

    assert_eq!(
        selection.range(),
        Some(TerminalSelectionRange {
            start: position(0, 1),
            end: position(2, 4),
        })
    );
}

#[test]
fn single_click_does_not_leave_a_painted_selection() {
    let mut selection = TerminalSelection::default();

    assert!(selection.button_changed(
        ScreenBuffer::Primary,
        Some(position(4, 7)),
        ElementState::Pressed,
    ));
    assert_eq!(selection.range(), None);
    assert!(selection.button_changed(
        ScreenBuffer::Primary,
        Some(position(4, 7)),
        ElementState::Released,
    ));

    assert_eq!(selection.range(), None);
}

#[test]
fn multiline_copy_respects_terminal_cell_columns_and_wide_characters() {
    let lines = vec!["a你b".to_string(), "second".to_string()];
    let text = selected_text(
        &lines,
        TerminalSelectionRange {
            start: position(0, 1),
            end: position(1, 2),
        },
    );

    assert_eq!(text.as_deref(), Some("你b\nsec"));
}

#[test]
fn alternate_screen_cancels_product_owned_selection() {
    let mut selection = TerminalSelection::default();
    selection.button_changed(
        ScreenBuffer::Primary,
        Some(position(0, 0)),
        ElementState::Pressed,
    );

    assert!(!selection.button_changed(
        ScreenBuffer::Alternate,
        Some(position(0, 2)),
        ElementState::Released,
    ));
    assert_eq!(selection.range(), None);
}

#[test]
fn multiline_selection_paints_one_rect_per_visible_row() {
    let mut scene = UiScene::new(Color::TRANSPARENT);

    paint_terminal_selection(
        &mut scene,
        Rect::from_xywh(10.0, 20.0, 80.0, 54.0),
        10,
        TerminalSelectionRange {
            start: position(0, 2),
            end: position(2, 4),
        },
        8.0,
        18.0,
        Color::rgb(1, 2, 3),
    );

    assert_eq!(scene.rects().len(), 3);
    assert_eq!(
        scene.rects()[0].bounds(),
        Rect::from_xywh(26.0, 20.0, 64.0, 18.0)
    );
    assert_eq!(
        scene.rects()[2].bounds(),
        Rect::from_xywh(10.0, 56.0, 40.0, 18.0)
    );
}

use super::TextArea;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;
use ratatui::layout::Position;
use std::time::Duration;
use std::time::Instant;

#[test]
fn editor_uses_unicode_cursor_boundaries() {
    let mut textarea = TextArea::new();
    textarea.insert_text("你a");

    textarea.handle_key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));
    textarea.handle_key(KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE));

    assert_eq!(textarea.text(), "a");
    assert_eq!(textarea.cursor_display_width(), 0);
}

#[test]
fn paste_is_inserted_at_the_cursor() {
    let mut textarea = TextArea::new();
    textarea.insert_text("ac");
    textarea.handle_key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));

    textarea.insert_text("b");

    assert_eq!(textarea.text(), "abc");
    assert_eq!(textarea.cursor_display_width(), 2);
}

#[test]
fn pointer_selection_replaces_text_and_keeps_atomic_elements_whole() {
    let mut textarea = TextArea::new();
    textarea.insert_text("a");
    let element = textarea.insert_element("[P]");
    textarea.insert_text("b");

    textarea.pointer_down(0);
    textarea.pointer_drag(2);
    textarea.pointer_up();
    assert_eq!(textarea.selection_range(), Some(0..4));

    textarea.insert_text("x");
    assert_eq!(textarea.text(), "xb");
    assert_eq!(textarea.selection_range(), None);
    assert!(!textarea.has_element(element));
}

#[test]
fn double_and_triple_click_select_an_editable_word_then_line() {
    let mut textarea = TextArea::new();
    textarea.insert_text("alpha beta\nnext");
    let position = Position::new(12, 4);
    let now = Instant::now();

    textarea.pointer_down(8);
    assert_eq!(
        textarea.pointer_finish(8, Some(8), 0..10, position, now),
        None
    );
    textarea.pointer_down(8);
    assert_eq!(
        textarea.pointer_finish(
            8,
            Some(8),
            0..10,
            position,
            now + Duration::from_millis(100)
        ),
        Some(6..10)
    );
    assert_eq!(textarea.selection_range(), Some(6..10));
    textarea.pointer_down(8);
    assert_eq!(
        textarea.pointer_finish(
            8,
            Some(8),
            0..10,
            position,
            now + Duration::from_millis(200)
        ),
        Some(0..10)
    );
    assert_eq!(textarea.selection_range(), Some(0..10));

    textarea.insert_text("replacement");
    assert_eq!(textarea.text(), "replacement\nnext");
}

#[test]
fn double_click_keeps_an_atomic_element_whole() {
    let mut textarea = TextArea::new();
    textarea.insert_text("a ");
    textarea.insert_element("[Context]");
    let position = Position::new(8, 2);
    let now = Instant::now();

    textarea.pointer_down(5);
    assert_eq!(
        textarea.pointer_finish(5, Some(5), 0..11, position, now),
        None
    );
    textarea.pointer_down(5);
    assert_eq!(
        textarea.pointer_finish(
            5,
            Some(5),
            0..11,
            position,
            now + Duration::from_millis(100)
        ),
        Some(2..11)
    );
    assert_eq!(textarea.selection_range(), Some(2..11));
}

#[test]
fn double_click_stops_at_newlines_and_atomic_elements() {
    let mut textarea = TextArea::new();
    textarea.insert_text("ab");
    textarea.insert_element("cd");
    textarea.insert_text("  \n  ef");
    let position = Position::new(8, 2);
    let now = Instant::now();

    textarea.pointer_down(0);
    assert_eq!(
        textarea.pointer_finish(0, Some(0), 0..6, position, now),
        None
    );
    textarea.pointer_down(0);
    assert_eq!(
        textarea.pointer_finish(0, Some(0), 0..6, position, now + Duration::from_millis(100)),
        Some(0..2)
    );

    let next = now + Duration::from_secs(1);
    textarea.pointer_down(5);
    assert_eq!(
        textarea.pointer_finish(5, Some(5), 0..6, position, next),
        None
    );
    textarea.pointer_down(5);
    assert_eq!(
        textarea.pointer_finish(
            5,
            Some(5),
            0..6,
            position,
            next + Duration::from_millis(100)
        ),
        Some(4..6)
    );
}

#[test]
fn triple_click_selects_only_the_rendered_row() {
    let mut textarea = TextArea::new();
    textarea.insert_text("alpha beta gamma");
    let position = Position::new(8, 2);
    let now = Instant::now();

    for count in 0..3 {
        textarea.pointer_down(12);
        let selected = textarea.pointer_finish(
            12,
            Some(12),
            11..16,
            position,
            now + Duration::from_millis(count * 100),
        );
        if count == 2 {
            assert_eq!(selected, Some(11..16));
        }
    }
}

#[test]
fn triple_click_keeps_a_wrapped_atomic_element_whole() {
    let mut textarea = TextArea::new();
    textarea.insert_text("ab");
    textarea.insert_element("CDEF");
    textarea.insert_text("gh");
    let position = Position::new(8, 2);
    let now = Instant::now();

    for count in 0..3 {
        textarea.pointer_down(3);
        let selected = textarea.pointer_finish(
            3,
            Some(2),
            0..4,
            position,
            now + Duration::from_millis(count * 100),
        );
        if count == 2 {
            assert_eq!(selected, Some(0..6));
        }
    }
}

#[test]
fn double_click_stops_at_a_soft_wrap() {
    let mut textarea = TextArea::new();
    textarea.insert_text("abcdefgh");
    let position = Position::new(8, 2);
    let now = Instant::now();

    textarea.pointer_down(2);
    assert_eq!(
        textarea.pointer_finish(2, Some(2), 0..4, position, now),
        None
    );
    textarea.pointer_down(2);
    assert_eq!(
        textarea.pointer_finish(2, Some(2), 0..4, position, now + Duration::from_millis(100)),
        Some(0..4)
    );
}

#[test]
fn double_click_keeps_combining_marks_with_the_word() {
    let mut textarea = TextArea::new();
    textarea.insert_text("e\u{301}!");
    let position = Position::new(8, 2);
    let now = Instant::now();

    textarea.pointer_down(0);
    assert_eq!(
        textarea.pointer_finish(0, Some(0), 0..4, position, now),
        None
    );
    textarea.pointer_down(0);
    assert_eq!(
        textarea.pointer_finish(0, Some(0), 0..4, position, now + Duration::from_millis(100)),
        Some(0..3)
    );
}

#[test]
fn control_keys_are_left_for_parent_routing() {
    let mut textarea = TextArea::new();

    let outcome = textarea.handle_key(KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL));

    assert_eq!(outcome, super::TextAreaOutcome::Unhandled);
    assert_eq!(textarea.text(), "");
}

#[test]
fn cursor_movement_skips_atomic_elements() {
    let mut textarea = TextArea::new();
    textarea.insert_text("a");
    textarea.insert_element("[P]");
    textarea.insert_text("b");

    textarea.handle_key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));
    textarea.handle_key(KeyEvent::new(KeyCode::Left, KeyModifiers::NONE));

    assert_eq!(textarea.cursor_display_width(), 1);

    textarea.handle_key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE));

    assert_eq!(textarea.cursor_display_width(), 4);
}

#[test]
fn backspace_removes_an_atomic_element_as_a_unit() {
    let mut textarea = TextArea::new();
    textarea.insert_text("a");
    let element = textarea.insert_element("[P]");

    textarea.handle_key(KeyEvent::new(KeyCode::Backspace, KeyModifiers::NONE));

    assert_eq!(textarea.text(), "a");
    assert_eq!(textarea.cursor_display_width(), 1);
    assert!(!textarea.has_element(element));
}

#[test]
fn delete_removes_an_atomic_element_as_a_unit() {
    let mut textarea = TextArea::new();
    let element = textarea.insert_element("[P]");
    textarea.handle_key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE));

    textarea.handle_key(KeyEvent::new(KeyCode::Delete, KeyModifiers::NONE));

    assert_eq!(textarea.text(), "");
    assert_eq!(textarea.cursor_display_width(), 0);
    assert!(!textarea.has_element(element));
}

#[test]
fn replacing_editable_text_preserves_and_repositions_atomic_elements() {
    let mut textarea = TextArea::new();
    textarea.insert_text("@sr");
    textarea.insert_text(" ");
    let element = textarea.insert_element("[P]");
    textarea.handle_key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE));

    textarea.replace_range(0..3, "src/lib.rs");

    assert_eq!(textarea.text(), "src/lib.rs [P]");
    assert_eq!(textarea.cursor(), "src/lib.rs".len());
    assert!(textarea.has_element(element));
    assert_eq!(
        textarea.elements().next().unwrap().1,
        "src/lib.rs ".len().."src/lib.rs [P]".len()
    );
}

#[test]
fn existing_text_can_be_marked_and_unmarked_without_changing_its_contents() {
    let mut textarea = TextArea::new();
    textarea.insert_text("/review details");

    let element = textarea.mark_element(0.."/review".len());
    assert_eq!(textarea.element_range(element), Some(0.."/review".len()));

    textarea.unmark_element(element);

    assert_eq!(textarea.text(), "/review details");
    assert_eq!(textarea.element_range(element), None);
}

#[test]
fn multiline_cursor_moves_between_visual_columns() {
    let mut textarea = TextArea::new();
    textarea.insert_text("ab\n你c\nxyz");

    textarea.handle_key(KeyEvent::new(KeyCode::Up, KeyModifiers::NONE));

    assert_eq!(textarea.cursor_line(), 1);
    assert_eq!(textarea.cursor_display_width(), 3);

    textarea.handle_key(KeyEvent::new(KeyCode::Home, KeyModifiers::NONE));
    assert_eq!(textarea.cursor_line(), 1);
    assert_eq!(textarea.cursor_display_width(), 0);

    textarea.handle_key(KeyEvent::new(KeyCode::End, KeyModifiers::NONE));
    assert_eq!(textarea.cursor_display_width(), 3);
}

#[test]
fn newline_insertion_preserves_atomic_element_ranges() {
    let mut textarea = TextArea::new();
    textarea.insert_text("first");
    textarea.insert_newline();
    let element = textarea.insert_element("[Image]");

    assert_eq!(textarea.text(), "first\n[Image]");
    assert_eq!(textarea.cursor_line(), 1);
    assert_eq!(textarea.element_range(element), Some(6..13));
}

#[test]
fn arrows_and_backspace_treat_joined_emoji_as_one_editing_unit() {
    let mut editor = super::TextArea::new();
    editor.insert_text("x👩‍💻z");
    editor.move_left();
    assert_eq!(editor.cursor(), 12);
    editor.move_left();
    assert_eq!(editor.cursor(), 1);
    editor.move_right();
    assert_eq!(editor.cursor(), 12);
    editor.handle_key(crossterm::event::KeyEvent::new(
        crossterm::event::KeyCode::Backspace,
        crossterm::event::KeyModifiers::NONE,
    ));
    assert_eq!(editor.text(), "xz");
    assert_eq!(editor.cursor(), 1);
}

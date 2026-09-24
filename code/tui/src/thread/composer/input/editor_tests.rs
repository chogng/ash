use super::TextArea;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;

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

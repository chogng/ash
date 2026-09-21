use super::*;

#[test]
fn title_and_body_share_one_form_and_preserve_unicode_whitespace() {
    let mut editor = Editor::new(String::new(), String::new());
    editor.paste("Rust decision".into());
    editor.handle_key(KeyEvent::new(KeyCode::Tab, KeyModifiers::NONE));
    editor.paste("保留  两个空格\r\nsecond line".into());
    assert_eq!(
        editor.values(),
        ("Rust decision", "保留  两个空格\nsecond line")
    );
    assert!(editor.validate());
    editor.handle_key(KeyEvent::new(KeyCode::BackTab, KeyModifiers::SHIFT));
    assert_eq!(editor.field, Field::Title);
    let original = editor.values().0.to_owned();
    editor.paste("\nrejected".into());
    assert_eq!(editor.values().0, original);
    assert!(editor.dirty());
}

#[test]
fn wheel_scroll_does_not_move_the_edit_cursor_and_typing_reveals_it() {
    let mut editor = Editor::new("Title".into(), "one\ntwo\nthree\nfour\nfive".into());
    editor.field = Field::Body;
    let cursor = editor.body.cursor;
    editor.scroll(3);
    assert_eq!(editor.body.cursor, cursor);
    assert!(!editor.body.follow.get());
    editor.paste("!".into());
    assert!(editor.body.follow.get());
    assert_eq!(editor.body.cursor, cursor + 1);
}

#[test]
fn cursor_uses_the_same_cell_wrapping_as_the_rendered_text() {
    assert_eq!(
        wrapped("中文ab", "中文".len(), 4),
        (vec!["中文".into(), "ab".into()], 1, 0)
    );
    assert_eq!(
        wrapped("abcd", 4, 4),
        (vec!["abcd".into(), "".into()], 1, 0)
    );
    assert_eq!(
        wrapped("a\n中", 2, 4),
        (vec!["a".into(), "中".into()], 1, 0)
    );
}

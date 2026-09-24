use super::*;

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

#[test]
fn enter_edits_then_submits_once_and_success_keeps_the_field_out_of_editing() {
    let mut field = TextField::new("one", SearchBoxModel::new("Name"));
    field.handle_paste("ignored".into());
    assert_eq!(
        field.handle_key(key(KeyCode::Char('x'))),
        TextFieldOutcome::Unhandled
    );
    assert_eq!(field.query(), "one");
    assert_eq!(
        field.handle_key(key(KeyCode::Enter)),
        TextFieldOutcome::Consumed
    );
    assert!(field.is_editing());
    field.handle_paste(" two".into());
    assert_eq!(
        field.handle_key(key(KeyCode::Enter)),
        TextFieldOutcome::Submit
    );
    assert!(!field.is_editing());
    assert_eq!(
        field.handle_key(key(KeyCode::Enter)),
        TextFieldOutcome::Consumed
    );
    field.handle_paste("ignored while saving".into());
    assert_eq!(field.query(), "onetwo");
    field.accept("one two".into());
    assert!(!field.is_editing());
    assert_eq!(field.query(), "one two");
    assert!(field.key_hints().text().contains("edit"));
}

#[test]
fn escape_restores_the_confirmed_value_and_only_a_second_escape_leaves_the_field() {
    let mut field = TextField::new("confirmed", SearchBoxModel::new("Name"));
    field.handle_key(key(KeyCode::Enter));
    field.handle_paste("draft".into());
    assert_eq!(
        field.handle_key(key(KeyCode::Esc)),
        TextFieldOutcome::Consumed
    );
    assert_eq!(field.query(), "confirmed");
    assert!(!field.is_editing());
    assert_eq!(
        field.handle_key(key(KeyCode::Esc)),
        TextFieldOutcome::Unhandled
    );
}

#[test]
fn blur_preserves_draft_without_submitting_and_enter_resumes_editing() {
    let mut field = TextField::new("", SearchBoxModel::new("URL"));
    field.handle_key(key(KeyCode::Enter));
    field.handle_paste("invalid".into());
    assert!(field.is_editing());
    assert_eq!(field.query(), "invalid");
    field.blur();
    assert!(!field.is_editing());
    assert_eq!(field.query(), "invalid");
    field.handle_key(key(KeyCode::Enter));
    assert_eq!(
        field.handle_key(key(KeyCode::Enter)),
        TextFieldOutcome::Submit
    );
}

#[test]
fn navigation_and_repeated_control_keys_do_not_submit_or_activate_twice() {
    let mut field = TextField::new("", SearchBoxModel::new("Name"));
    for kind in [KeyEventKind::Repeat, KeyEventKind::Release] {
        field.handle_key(KeyEvent::new_with_kind(
            KeyCode::Enter,
            KeyModifiers::NONE,
            kind,
        ));
        assert!(!field.is_editing());
    }
    field.handle_key(key(KeyCode::Enter));
    assert_eq!(
        field.handle_key(key(KeyCode::Down)),
        TextFieldOutcome::Consumed
    );
    assert_eq!(
        field.handle_key(key(KeyCode::Tab)),
        TextFieldOutcome::Unhandled
    );
    assert!(field.is_editing());
}

#[test]
fn masked_field_hides_both_confirmed_and_edited_values_in_debug_and_rendering() {
    let mut field = TextField::new("saved-secret", SearchBoxModel::new("Key").masked());
    field.handle_key(key(KeyCode::Enter));
    field.handle_paste("draft-secret".into());
    assert!(!format!("{field:?}").contains("secret"));
    let mut terminal = ratatui::Terminal::new(ratatui::backend::TestBackend::new(40, 3)).unwrap();
    terminal
        .draw(|frame| {
            draw(
                frame,
                frame.area(),
                &field,
                true,
                crate::render::test_context(),
            )
        })
        .unwrap();
    let output = terminal
        .backend()
        .buffer()
        .content()
        .iter()
        .map(|cell| cell.symbol())
        .collect::<String>();
    assert!(!output.contains("secret"));
    assert!(output.contains('•'));
}

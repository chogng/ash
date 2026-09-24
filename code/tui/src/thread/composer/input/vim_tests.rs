use super::super::editor::TextArea;
use super::VimOutcome;
use super::VimState;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;

#[test]
fn escape_enters_normal_mode_and_i_returns_to_insert_mode() {
    let mut textarea = TextArea::new();
    textarea.insert_text("abc");
    let mut vim = VimState::default();

    assert_eq!(
        press(&mut vim, &mut textarea, KeyCode::Esc),
        VimOutcome::Consumed
    );
    assert!(!vim.accepts_submission_key());
    press(&mut vim, &mut textarea, KeyCode::Char('h'));
    press(&mut vim, &mut textarea, KeyCode::Char('i'));

    assert!(vim.accepts_submission_key());
    textarea.insert_text("X");
    assert_eq!(textarea.text(), "abXc");
}

#[test]
fn normal_delete_line_and_visual_delete_mutate_only_the_editor() {
    let mut textarea = TextArea::new();
    textarea.insert_text("one\ntwo");
    textarea.set_cursor(0);
    let mut vim = VimState::default();
    press(&mut vim, &mut textarea, KeyCode::Esc);
    press(&mut vim, &mut textarea, KeyCode::Char('d'));
    press(&mut vim, &mut textarea, KeyCode::Char('d'));
    assert_eq!(textarea.text(), "two");

    press(&mut vim, &mut textarea, KeyCode::Char('v'));
    press(&mut vim, &mut textarea, KeyCode::Char('l'));
    press(&mut vim, &mut textarea, KeyCode::Char('d'));
    assert_eq!(textarea.text(), "wo");
}

fn press(vim: &mut VimState, textarea: &mut TextArea, code: KeyCode) -> VimOutcome {
    vim.handle_key(textarea, KeyEvent::new(code, KeyModifiers::NONE))
}

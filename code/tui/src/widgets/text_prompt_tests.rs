use super::TextPrompt;
use super::TextPromptOutcome;
use super::TextPromptSpec;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;

#[test]
fn masked_prompt_submits_non_empty_text_and_can_be_dismissed() {
    let mut prompt = TextPrompt::new(TextPromptSpec {
        title: "Secret".into(),
        explanation: "Stored securely".into(),
        placeholder: "Enter secret".into(),
        masked: true,
    });
    prompt.handle_paste("value".into());

    assert!(prompt.input().masked());
    assert_eq!(
        prompt.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        TextPromptOutcome::Submit("value".into())
    );
    assert_eq!(
        prompt.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE)),
        TextPromptOutcome::Dismiss
    );
}

#[test]
fn prompt_can_clear_an_entered_value_before_editing() {
    let mut prompt = TextPrompt::new(TextPromptSpec {
        title: "Program".into(),
        explanation: "Executable to run".into(),
        placeholder: "Program".into(),
        masked: false,
    });
    prompt.handle_paste("old-program".into());
    assert_eq!(prompt.input().query(), "old-program");
    assert_eq!(
        prompt.handle_key(KeyEvent::new(KeyCode::Char('u'), KeyModifiers::CONTROL)),
        TextPromptOutcome::Consumed
    );
    prompt.handle_paste("new-program".into());
    assert_eq!(
        prompt.handle_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE)),
        TextPromptOutcome::Submit("new-program".into())
    );
}

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

use super::ChatComposer;
use super::ChatComposerOutcome;
use crate::thread::composer::ChatInput;
use crate::thread::composer::ChatInputItem;
use crossterm::event::KeyCode;
use crossterm::event::KeyEvent;
use crossterm::event::KeyModifiers;

#[test]
fn composer_routes_submission_from_thread_owned_input() {
    let mut composer = ChatComposer::new();
    let mut input = ChatInput::new();
    composer.insert_text(&mut input, "hello");

    let outcome = composer.handle_key(
        &mut input,
        KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
    );

    let ChatComposerOutcome::Submit(submission) = outcome else {
        panic!("expected submission");
    };
    assert_eq!(submission.display_text, "hello");
    assert_eq!(submission.input, vec![ChatInputItem::Text("hello".into())]);
    assert_eq!(input.text(), "");
}

#[test]
fn queue_target_returns_content_to_the_feature_owner() {
    let mut composer = ChatComposer::new();
    let mut input = ChatInput::new();
    composer.insert_text(&mut input, "follow up");

    let outcome = composer.handle_queued_turn_key(
        &mut input,
        KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
    );

    let ChatComposerOutcome::Queued(queued) = outcome else {
        panic!("expected Queue content");
    };
    assert_eq!(queued.display_text(), "follow up");
    assert_eq!(input.text(), "");
}

#[test]
fn active_turn_queues_enter_and_steers_ctrl_enter() {
    let mut composer = ChatComposer::new();
    let mut input = ChatInput::new();
    composer.insert_text(&mut input, "queued");

    assert!(matches!(
        composer.handle_active_turn_key(
            &mut input,
            KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
        ),
        ChatComposerOutcome::Queued(_)
    ));

    composer.insert_text(&mut input, "steered");
    let outcome = composer.handle_active_turn_key(
        &mut input,
        KeyEvent::new(KeyCode::Enter, KeyModifiers::CONTROL),
    );
    let ChatComposerOutcome::Submit(submission) = outcome else {
        panic!("expected a one-shot steer submission");
    };
    assert_eq!(submission.display_text, "steered");
}

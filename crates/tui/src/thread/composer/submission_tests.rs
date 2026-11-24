use super::ChatComposer;
use super::ChatComposerOutcome;
use super::SlashCommandAvailability;
use crate::keymap::KeyEvent;
use crate::thread::composer::ChatInput;
use crate::thread::composer::ChatInputCatalog;
use crate::thread::composer::ChatInputItem;
use ash_slash_commands::SlashCommandCatalog;
use crossterm::event::KeyCode;
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
        SlashCommandAvailability::ActiveTurn,
    );

    let ChatComposerOutcome::Queued(queued) = outcome else {
        panic!("expected Queue content");
    };
    assert_eq!(queued.display_text(), "follow up");
    assert_eq!(input.text(), "");
}

#[test]
fn queued_unknown_command_is_rejected_before_it_becomes_a_follow_up() {
    let mut composer = ChatComposer::new();
    let mut input = ChatInput::new();
    composer.insert_text(&mut input, "/confg");
    input.handle_key(KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE));

    let outcome = composer.handle_queued_turn_key(
        &mut input,
        KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE),
        SlashCommandAvailability::ActiveTurn,
    );

    let ChatComposerOutcome::UnknownCommand(command) = outcome else {
        panic!("expected local unknown command");
    };
    assert_eq!(command.name, "confg");
    assert_eq!(command.suggestion.as_deref(), Some("config"));
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

#[test]
fn busy_compact_keeps_the_draft_for_queue_steer_and_completion() {
    let mut composer = ChatComposer::new();
    let enter = KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE);
    let steer = KeyEvent::new(KeyCode::Enter, KeyModifiers::CONTROL);
    let escape = KeyEvent::new(KeyCode::Esc, KeyModifiers::NONE);
    let mut input = ChatInput::with_catalog(ChatInputCatalog::with_slash_commands(
        SlashCommandCatalog::default(),
    ));
    composer.insert_text(&mut input, "/compact keep paths");
    let _ = composer.handle_active_turn_key(&mut input, escape);
    let rejected = ChatComposerOutcome::SubmissionRejected(
        "Wait for the active turn to finish before compacting context.".into(),
    );
    assert_eq!(composer.handle_active_turn_key(&mut input, enter), rejected);
    assert_eq!(composer.handle_active_turn_key(&mut input, steer), rejected);
    assert_eq!(input.text(), "/compact keep paths");

    let mut input = ChatInput::with_catalog(ChatInputCatalog::with_slash_commands(
        SlashCommandCatalog::default(),
    ));
    composer.insert_text(&mut input, "/compac");
    assert_eq!(
        composer.activate_completion(&mut input, 0),
        Some(ChatComposerOutcome::Consumed),
    );
    assert_eq!(input.text().trim(), "/compact");
    assert_eq!(composer.handle_active_turn_key(&mut input, enter), rejected);
    let ChatComposerOutcome::Command(invocation) = composer.handle_key(&mut input, enter) else {
        panic!("an idle conversation should accept /compact");
    };
    assert_eq!(invocation.command.name, "compact");
    assert_eq!(
        crate::nls::localize(
            crate::nls::Language::Chinese,
            "Wait for the active turn to finish before compacting context."
        ),
        "请等待当前回合结束后再压缩上下文。",
    );
}

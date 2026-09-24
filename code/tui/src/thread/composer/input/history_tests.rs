use super::*;
use message_history::MessageHistoryQuery as Query;
use message_history::MessageHistoryRetention as Retention;
use message_history::MessageHistoryStore;
use std::sync::Arc;
use std::sync::mpsc;
use std::time::Duration;

fn key(code: KeyCode) -> KeyEvent {
    KeyEvent::new(code, KeyModifiers::NONE)
}

fn wait_for(
    input: &mut ChatInput,
    wake: &mpsc::Receiver<()>,
    predicate: impl Fn(&ChatInput) -> bool,
) {
    while !predicate(input) {
        wake.recv_timeout(Duration::from_secs(5)).unwrap();
        input.poll_history();
    }
}

#[test]
fn persistent_history_recalls_after_reopening_without_replaying_a_submission() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite3");
    let store = Arc::new(state::SqliteMessageHistory::open(&path, Retention::default()).unwrap());
    let (notify, wake) = mpsc::channel();
    let client = MessageHistory::with_waker(store.clone(), move || {
        let _ = notify.send(());
    })
    .unwrap();
    let mut first = ChatInput::new();
    first.connect_history(client, "first-thread".into());
    first.insert_text("older submitted input");
    assert!(matches!(
        first.submit_current(),
        ChatInputOutcome::Submit(_)
    ));
    wake.recv_timeout(Duration::from_secs(5)).unwrap();
    drop(first);

    let (notify, wake) = mpsc::channel();
    let client = MessageHistory::with_waker(store.clone(), move || {
        let _ = notify.send(());
    })
    .unwrap();
    let mut input = ChatInput::new();
    input.connect_history(client, "second-thread".into());
    input.insert_text("current draft");
    input.handle_key(key(KeyCode::Up));
    wait_for(&mut input, &wake, |input| {
        input.text() == "older submitted input"
    });
    input.handle_key(key(KeyCode::Down));
    assert_eq!(input.text(), "current draft");
    assert_eq!(store.read(&Query::default()).unwrap().entries.len(), 1);

    input.handle_key(key(KeyCode::Esc));
    input.textarea.clear();
    input.handle_key(KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL));
    input.handle_key(key(KeyCode::Char('o')));
    wait_for(&mut input, &wake, |input| {
        input.text() == "older submitted input"
    });
    assert_eq!(
        input.handle_key(key(KeyCode::Enter)),
        ChatInputOutcome::Consumed
    );
    assert_eq!(store.read(&Query::default()).unwrap().entries.len(), 1);
    assert!(matches!(
        input.handle_key(key(KeyCode::Enter)),
        ChatInputOutcome::Submit(_)
    ));
    while store.read(&Query::default()).unwrap().entries.len() < 2 {
        wake.recv_timeout(Duration::from_secs(5)).unwrap();
    }
}

#[test]
fn cancelling_recall_restores_images_large_pastes_and_the_exact_editable_draft() {
    let mut input = ChatInput::new();
    input.insert_text("recall this");
    input.submit_current();
    input.insert_text("before ");
    input
        .attach_image_bytes(b"\x89PNG\r\n\x1a\npayload".to_vec())
        .unwrap();
    input.handle_paste("large paste ".repeat(150)).unwrap();
    input.insert_text(" after");
    let expected = input.prepare_submission();
    let cursor = input.textarea.cursor_display_width();
    input.handle_key(key(KeyCode::Up));
    assert_eq!(input.text(), "recall this");
    input.handle_key(key(KeyCode::Esc));
    assert_eq!(input.prepare_submission(), expected);
    assert_eq!(input.textarea.cursor_display_width(), cursor);
}

#[test]
fn search_accepts_text_without_queueing_or_steering_it() {
    let mut input = ChatInput::new();
    input.insert_text("saved input");
    input.submit_current();
    let mut composer = crate::thread::composer::ChatComposer::new();
    composer.handle_active_turn_key(
        &mut input,
        KeyEvent::new(KeyCode::Char('r'), KeyModifiers::CONTROL),
    );
    assert_eq!(input.text(), "saved input");
    assert!(matches!(
        composer.handle_active_turn_key(&mut input, key(KeyCode::Enter)),
        crate::thread::composer::ChatComposerOutcome::Consumed
    ));
    assert_eq!(input.text(), "saved input");
    assert!(matches!(
        composer.handle_active_turn_key(&mut input, key(KeyCode::Enter)),
        crate::thread::composer::ChatComposerOutcome::Queued(_)
    ));
}

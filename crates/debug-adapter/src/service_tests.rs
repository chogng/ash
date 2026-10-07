use serde_json::json;

use super::DebugAdapterState;
use super::push_message;
use super::read_buffered_state;

#[test]
fn buffered_messages_advance_only_through_the_returned_page() {
    let shared = std::sync::Arc::new(std::sync::Mutex::new(DebugAdapterState::default()));
    for index in 0..200 {
        push_message(&shared, json!({ "seq": index }));
    }
    let mut state = std::mem::take(&mut *shared.lock().unwrap());

    let first = read_buffered_state(&mut state, 0, 128).unwrap();
    assert_eq!(first.messages.len(), 128);
    assert_eq!(first.next_sequence, 128);

    let second = read_buffered_state(&mut state, first.next_sequence, 128).unwrap();
    assert_eq!(second.messages.len(), 72);
    assert_eq!(second.next_sequence, 200);
}

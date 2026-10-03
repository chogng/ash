use super::*;
use ash_async_utils::CancellationSource;

struct UnserializableParams;

#[test]
fn document_turn_finished_goes_only_to_its_owner_and_only_once() {
    let host = ClientHost::default();
    let owner = NotificationQueue::default();
    let other = NotificationQueue::default();
    host.register(7, true, owner.clone());
    host.register(8, true, other.clone());
    let thread = ash_protocol::ThreadId::new("thread").unwrap();
    let turn = ash_protocol::TurnId::new("turn").unwrap();
    host.submit_turn(&thread, Some(7), TextDocumentMode::Client, || {
        Ok(TurnReceipt {
            turn_id: turn.clone(),
            sequence: 1,
        })
    })
    .unwrap();
    host.finish_turn(&thread, &turn, TextDocumentTurnOutcome::Completed);
    host.finish_turn(&thread, &turn, TextDocumentTurnOutcome::Completed);
    assert_eq!(
        owner.listener().drain(),
        vec![serde_json::json!({
            "jsonrpc": "2.0", "method": "textDocument/turnFinished",
            "params": { "threadId": "thread", "turnId": "turn", "outcome": "completed" }
        })]
    );
    assert!(other.listener().drain().is_empty());
}

impl Serialize for UnserializableParams {
    fn serialize<S: serde::Serializer>(&self, _: S) -> Result<S::Ok, S::Error> {
        Err(serde::ser::Error::custom("invalid browser params"))
    }
}

#[test]
fn parameter_serialization_failure_does_not_register_or_publish_a_request() {
    let host = ClientHost::default();
    let outbound = NotificationQueue::default();
    host.register(7, false, outbound.clone());
    let result = host.request::<_, Value>(
        7,
        HostMethod::BrowserCreate,
        &UnserializableParams,
        &CancellationSource::new().token(),
    );
    assert!(
        matches!(result, Err(ClientHostError::Failed(message)) if message == "invalid browser params")
    );
    let state = host.state.lock().unwrap();
    assert!(state.pending.is_empty());
    assert!(state.retired.is_empty());
    assert_eq!(state.next_request_id, 0);
    assert!(outbound.listener().drain().is_empty());
}

#[test]
fn child_binding_survives_parent_completion_and_isolated_children_use_disk() {
    let host = ClientHost::default();
    host.register(7, true, NotificationQueue::default());
    let parent = ash_protocol::ThreadId::new("parent").unwrap();
    let parent_turn = ash_protocol::TurnId::new("parent-turn").unwrap();
    host.submit_turn(&parent, Some(7), TextDocumentMode::Client, || {
        Ok(TurnReceipt {
            turn_id: parent_turn.clone(),
            sequence: 1,
        })
    })
    .unwrap();
    for mode in [TextDocumentMode::Client, TextDocumentMode::FileSystem] {
        let child = ash_protocol::ThreadId::new(format!("child-{mode:?}")).unwrap();
        let turn = ash_protocol::TurnId::new(format!("turn-{mode:?}")).unwrap();
        host.submit_agent_turn(&parent, &parent_turn, &child, None, mode, || {
            Ok(ash_core::StartTurnResult {
                turn_id: turn.clone(),
                sequence: 1,
                disposition: ash_core::StartTurnDisposition::Created,
            })
        })
        .unwrap();
        let binding = host.binding(&child, &turn).unwrap().unwrap();
        assert_eq!(
            (binding.connection_id, binding.text_documents),
            (7, mode == TextDocumentMode::Client)
        );
    }
    host.finish_turn(
        &parent,
        &parent_turn,
        ash_app_server_protocol::protocol::text_document::TextDocumentTurnOutcome::Completed,
    );
    let child = ash_protocol::ThreadId::new("child-Client").unwrap();
    let turn = ash_protocol::TurnId::new("turn-Client").unwrap();
    host.submit_agent_turn(
        &parent,
        &parent_turn,
        &child,
        Some(&turn),
        TextDocumentMode::Client,
        || {
            Ok(ash_core::StartTurnResult {
                turn_id: turn.clone(),
                sequence: 1,
                disposition: ash_core::StartTurnDisposition::Replayed,
            })
        },
    )
    .unwrap();
    assert!(
        host.submit_agent_turn(
            &parent,
            &parent_turn,
            &child,
            None,
            TextDocumentMode::Client,
            || panic!("a missing editor context must reject admission")
        )
        .is_err()
    );
    host.unregister(7);
    let child = ash_protocol::ThreadId::new("child-Client").unwrap();
    let turn = ash_protocol::TurnId::new("turn-Client").unwrap();
    let binding = host.binding(&child, &turn).unwrap().unwrap();
    assert!(binding.text_documents);
    assert!(!host.is_connected(binding.connection_id));
}

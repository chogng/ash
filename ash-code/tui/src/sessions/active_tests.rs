use std::fs;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use ash_app_server_client::AppServerClient;
use ash_app_server_client::InProcessClientOptions;
use ash_app_server_client::InProcessTransport;
use ash_app_server_client::start_in_process_client;
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_client::ClientError;
use ash_client::ClientRequest;
use ash_client::ClientResponse;
use ash_client::OperationClient;
use ash_protocol::SessionStatus;

use super::ActiveConversation;
use crate::TuiRecoveryState;

#[test]
fn manager_restore_and_delete_update_the_durable_catalog() {
    let _guard = crate::test_support::in_process_test_guard();
    let (mut client, state_root) = client();
    let conversation =
        ActiveConversation::start(&mut client, "restore then delete".into()).unwrap();
    let id = conversation.session_id().clone();
    super::super::archive(&mut client, vec![id.clone()]).unwrap();
    let restored = super::super::restore(&mut client, id.clone()).unwrap();
    assert_eq!(
        restored
            .iter()
            .find(|session| session.session_id == id)
            .unwrap()
            .status,
        SessionStatus::Active
    );
    assert!(
        ActiveConversation::recover(
            &mut client,
            TuiRecoveryState::new(id.clone(), conversation.thread_id().clone())
        )
        .is_ok()
    );
    super::super::archive(&mut client, vec![id.clone()]).unwrap();
    assert!(
        !super::super::delete(&mut client, id.clone())
            .unwrap()
            .iter()
            .any(|session| session.session_id == id)
    );
    assert!(
        client
            .read_session(
                ash_app_server_protocol::protocol::session::SessionReadParams { session_id: id }
            )
            .is_err()
    );
    drop(client);
    let _ = fs::remove_dir_all(state_root);
}

#[test]
fn thread_sequence_never_moves_backwards() {
    let _guard = crate::test_support::in_process_test_guard();
    let (mut client, state_root) = client();
    let mut conversation = ActiveConversation::start(&mut client, "sequence".into()).unwrap();

    conversation.set_thread_sequence(12);
    conversation.set_thread_sequence(4);

    assert_eq!(conversation.thread_sequence(), 12);
    drop(client);
    let _ = fs::remove_dir_all(state_root);
}

#[test]
fn recovery_reopens_the_exact_durable_conversation() {
    let _guard = crate::test_support::in_process_test_guard();
    let (mut client, state_root) = client();
    let conversation = ActiveConversation::start(&mut client, "recover exact".into()).unwrap();
    let state = TuiRecoveryState::new(
        conversation.session_id().clone(),
        conversation.thread_id().clone(),
    );

    let recovered = ActiveConversation::recover(&mut client, state).unwrap();

    assert_eq!(recovered.session_id(), conversation.session_id());
    assert_eq!(recovered.thread_id(), conversation.thread_id());
    assert_eq!(recovered.thread_sequence(), conversation.thread_sequence());
    drop(client);
    let _ = fs::remove_dir_all(state_root);
}

#[test]
fn recovery_keeps_the_explicit_branch_after_another_branch_is_created() {
    let _guard = crate::test_support::in_process_test_guard();
    let (mut client, state_root) = client();
    let mut conversation =
        ActiveConversation::start(&mut client, "recover fallback".into()).unwrap();
    let session_id = conversation.session_id().clone();
    let stale_thread_id = conversation.thread_id().clone();
    conversation
        .branch_active_thread(&mut client, "surviving thread")
        .unwrap();
    assert_ne!(conversation.thread_id(), &stale_thread_id);

    let recovered = ActiveConversation::recover(
        &mut client,
        TuiRecoveryState::new(session_id, stale_thread_id.clone()),
    )
    .unwrap();

    assert_eq!(recovered.thread_id(), &stale_thread_id);
    drop(client);
    let _ = fs::remove_dir_all(state_root);
}

#[test]
fn manager_archive_applies_to_every_selected_session_and_returns_the_new_catalog() {
    let _guard = crate::test_support::in_process_test_guard();
    let (mut client, state_root) = client();
    let first = ActiveConversation::start(&mut client, "first".into()).unwrap();
    let second = ActiveConversation::start(&mut client, "second".into()).unwrap();

    let catalog = super::super::archive(
        &mut client,
        vec![first.session_id().clone(), second.session_id().clone()],
    )
    .unwrap();

    assert!(
        catalog
            .iter()
            .filter(|session| {
                session.session_id == *first.session_id()
                    || session.session_id == *second.session_id()
            })
            .all(|session| session.status == SessionStatus::Archived)
    );
    drop(client);
    let _ = fs::remove_dir_all(state_root);
}

fn client() -> (AppServerClient<InProcessTransport>, PathBuf) {
    static NEXT_STATE_ROOT: AtomicU64 = AtomicU64::new(1);
    let state_root = std::env::temp_dir().join(format!(
        "ash-tui-recovery-{}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
        NEXT_STATE_ROOT.fetch_add(1, Ordering::Relaxed)
    ));
    let client = start_in_process_client(
        InProcessClientOptions::new(
            &state_root,
            ClientInfo {
                name: "ash-tui-recovery-test".into(),
                version: "1".into(),
            },
        )
        .with_model_operation_client(Arc::new(OfflineOperationClient)),
    )
    .unwrap();
    (client, state_root)
}

struct OfflineOperationClient;

impl OperationClient for OfflineOperationClient {
    fn execute(&self, _: &ClientRequest) -> Result<ClientResponse, ClientError> {
        Err(ClientError::Transport(
            "model transport is disabled in TUI recovery tests".into(),
        ))
    }
}

use super::*;
use crate::client_host::TextDocumentMode;
use crate::server::notification_queue::NotificationQueue;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use core_api::TurnReceipt;

#[test]
fn ide_discovery_across_directory_hosts_does_not_merge_equal_connection_ids() {
    let registry = IdeRegistry::default();
    let first = Arc::new(ClientHost::default());
    let second = Arc::new(ClientHost::default());
    first.register(7, false, NotificationQueue::default());
    second.register(7, false, NotificationQueue::default());
    let a = registry
        .register(&first, 7, "First".into(), vec!["/first".into()])
        .unwrap();
    let b = registry
        .register(&second, 7, "Second".into(), vec!["/second".into()])
        .unwrap();
    assert_ne!(a.id, b.id);
    assert_eq!(registry.list().len(), 2);
    registry.unregister(&first, 7);
    assert_eq!(registry.list(), vec![b.clone()]);
    assert!(registry.get(&a.id).is_err());
    assert!(registry.get(&b.id).is_ok());
}

#[test]
fn ide_turn_binding_keeps_initiator_and_selected_window_when_selection_changes() {
    let registry = IdeRegistry::default();
    let tui = Arc::new(ClientHost::default());
    let editor = Arc::new(ClientHost::default());
    tui.register(1, false, NotificationQueue::default());
    editor.register(1, true, NotificationQueue::default());
    editor.register(2, true, NotificationQueue::default());
    let a = registry
        .register(&editor, 1, "First".into(), vec!["/first".into()])
        .unwrap();
    let b = registry
        .register(&editor, 2, "Second".into(), vec!["/second".into()])
        .unwrap();
    tui.select_ide(1, Some(registry.get(&a.id).unwrap()))
        .unwrap();
    let thread = ThreadId::new("thread").unwrap();
    let turn = TurnId::new("turn").unwrap();
    tui.submit_turn_with_ide(
        &thread,
        Some(1),
        TextDocumentMode::Client,
        Some(&a.id),
        || {
            Ok(TurnReceipt {
                turn_id: turn.clone(),
                sequence: 1,
            })
        },
    )
    .unwrap();
    tui.select_ide(1, Some(registry.get(&b.id).unwrap()))
        .unwrap();
    let binding = tui.binding(&thread, &turn).unwrap().unwrap();
    assert_eq!(binding.connection_id, 1);
    assert!(
        !binding.text_documents,
        "IDE context must not enable editor writes"
    );
    assert_eq!(binding.ide.as_ref().unwrap().window.id, a.id);
    assert!(
        tui.submit_turn_with_ide(
            &thread,
            Some(1),
            TextDocumentMode::Client,
            Some(&a.id),
            || panic!("stale context must not start a turn")
        )
        .is_err()
    );
    registry.unregister(&editor, 1);
    assert!(!binding.ide.unwrap().is_connected());
    assert_eq!(tui.selected_ide(1).unwrap().unwrap().window.id, b.id);
}

#[test]
fn ide_workspace_change_retires_old_window_identity_and_binding() {
    let registry = IdeRegistry::default();
    let host = Arc::new(ClientHost::default());
    host.register(1, false, NotificationQueue::default());
    let first = registry
        .register(&host, 1, "Project".into(), vec!["/old".into()])
        .unwrap();
    let old = registry.get(&first.id).unwrap();
    let next = registry
        .register(&host, 1, "Project".into(), vec!["/new".into()])
        .unwrap();
    assert_ne!(first.id, next.id);
    assert!(!old.is_connected());
    assert_eq!(registry.list(), vec![next]);
}

#[test]
fn ide_requests_return_only_from_the_owning_connection_and_disconnect_wakes_waiters() {
    let registry = IdeRegistry::default();
    let host = Arc::new(ClientHost::default());
    let outgoing = NotificationQueue::default();
    host.register(1, false, outgoing.clone());
    host.register(2, false, NotificationQueue::default());
    let window = registry
        .register(&host, 1, "Project".into(), vec!["/project".into()])
        .unwrap();
    let target = registry.get(&window.id).unwrap();
    std::thread::scope(|scope| {
        let call = scope.spawn(|| {
            target.request(
                &IdeHostRequest::OpenFile {
                    path: "/project/a.rs".into(),
                    line: Some(4),
                },
                &ash_async_utils::CancellationSource::new().token(),
            )
        });
        let listener = outgoing.listener();
        assert!(listener.wait());
        let request = listener.drain().remove(0);
        assert_eq!(request["method"], "ide/hostRequest");
        assert_eq!(request["params"]["line"], 4);
        let response =
            serde_json::json!({"jsonrpc":"2.0", "id":request["id"], "result":{"type":"opened"}});
        assert!(host.handle_response(2, response.clone()).is_err());
        assert!(host.handle_response(1, response).unwrap());
        assert_eq!(call.join().unwrap().unwrap(), IdeHostResult::Opened {});
        let call = scope.spawn(|| {
            target.request(
                &IdeHostRequest::OpenReview {
                    original: "/project/a.rs".into(),
                    modified: "/project/b.rs".into(),
                },
                &ash_async_utils::CancellationSource::new().token(),
            )
        });
        assert!(listener.wait());
        let request = listener.drain().remove(0);
        host.unregister(1);
        assert!(matches!(
            call.join().unwrap(),
            Err(ClientHostError::CapabilityUnavailable)
        ));
        // Late responses to abandoned requests are retired by the existing host transport.
        assert!(
            host.handle_response(
                1,
                serde_json::json!({"jsonrpc":"2.0", "id":request["id"], "result":{"type":"opened"}})
            )
            .unwrap()
        );
    });
}

#[test]
fn ide_window_on_the_same_directory_host_can_be_pinned_without_recursive_locking() {
    let registry = IdeRegistry::default();
    let host = Arc::new(ClientHost::default());
    host.register(1, false, NotificationQueue::default());
    host.register(2, true, NotificationQueue::default());
    let window = registry
        .register(&host, 2, "IDE".into(), vec!["/project".into()])
        .unwrap();
    host.select_ide(1, Some(registry.get(&window.id).unwrap()))
        .unwrap();
    let thread = ThreadId::new("thread").unwrap();
    let turn = TurnId::new("turn").unwrap();
    host.submit_turn_with_ide(
        &thread,
        Some(1),
        TextDocumentMode::Client,
        Some(&window.id),
        || {
            Ok(TurnReceipt {
                turn_id: turn.clone(),
                sequence: 1,
            })
        },
    )
    .unwrap();
    let binding = host.binding(&thread, &turn).unwrap().unwrap();
    assert_eq!(binding.connection_id, 1);
    assert_eq!(binding.ide.unwrap().window.id, window.id);
}

#[test]
fn ide_active_file_title_changes_keep_the_window_and_running_turn_identity() {
    let registry = IdeRegistry::default();
    let host = Arc::new(ClientHost::default());
    host.register(1, false, NotificationQueue::default());
    let first = registry
        .register(
            &host,
            1,
            "Project · first.rs".into(),
            vec!["/project".into()],
        )
        .unwrap();
    let target = registry.get(&first.id).unwrap();
    let next = registry
        .register(
            &host,
            1,
            "Project · next.rs".into(),
            vec!["/project".into()],
        )
        .unwrap();
    assert_eq!(first.id, next.id);
    assert!(target.is_connected());
    assert_eq!(
        registry.get(&first.id).unwrap().window.title,
        "Project · next.rs"
    );
}

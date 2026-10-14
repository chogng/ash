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
        .register(&first, 7, "First".into(), vec!["/first".into()], None)
        .unwrap();
    let b = registry
        .register(&second, 7, "Second".into(), vec!["/second".into()], None)
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
    let profile_peer = Arc::new(ClientHost::default());
    let editor = Arc::new(ClientHost::default());
    let attachment = Arc::new(crate::client_host::IdeAttachment::default());
    tui.register(1, false, NotificationQueue::default());
    profile_peer.register(8, false, NotificationQueue::default());
    tui.install_ide_attachment(1, Arc::clone(&attachment));
    profile_peer.install_ide_attachment(8, attachment);
    editor.register(1, true, NotificationQueue::default());
    editor.register(2, true, NotificationQueue::default());
    let a = registry
        .register(&editor, 1, "First".into(), vec!["/first".into()], None)
        .unwrap();
    let b = registry
        .register(&editor, 2, "Second".into(), vec!["/second".into()], None)
        .unwrap();
    profile_peer
        .select_ide(8, Some(registry.get(&a.id).unwrap()))
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
    profile_peer
        .select_ide(8, Some(registry.get(&b.id).unwrap()))
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
    assert!(
        editor.selected_ide(1).unwrap().is_none(),
        "another logical connection must stay isolated"
    );
    profile_peer.unregister(8);
    assert_eq!(
        tui.selected_ide(1).unwrap().unwrap().window.id,
        b.id,
        "closing one directory peer must not clear the surviving logical connection"
    );
}

#[test]
fn ide_workspace_change_retires_old_window_identity_and_binding() {
    let registry = IdeRegistry::default();
    let host = Arc::new(ClientHost::default());
    host.register(1, false, NotificationQueue::default());
    let first = registry
        .register(&host, 1, "Project".into(), vec!["/old".into()], None)
        .unwrap();
    let old = registry.get(&first.id).unwrap();
    let next = registry
        .register(&host, 1, "Project".into(), vec!["/new".into()], None)
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
        .register(&host, 1, "Project".into(), vec!["/project".into()], None)
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
        .register(&host, 2, "IDE".into(), vec!["/project".into()], None)
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
            None,
        )
        .unwrap();
    let target = registry.get(&first.id).unwrap();
    let next = registry
        .register(
            &host,
            1,
            "Project · next.rs".into(),
            vec!["/project".into()],
            None,
        )
        .unwrap();
    assert_eq!(first.id, next.id);
    assert!(target.is_connected());
    assert_eq!(
        registry.get(&first.id).unwrap().window.title,
        "Project · next.rs"
    );
}

#[test]
fn ide_terminal_origin_survives_reconnect_without_retargeting_old_turns() {
    let registry = IdeRegistry::default();
    let host = Arc::new(ClientHost::default());
    host.register(1, false, NotificationQueue::default());
    host.register(2, false, NotificationQueue::default());
    let key = "01234567890123456789012345678901";
    let first = registry
        .register(
            &host,
            1,
            "First".into(),
            vec!["/project".into()],
            Some(key.into()),
        )
        .unwrap();
    let old_target = registry.get(&first.id).unwrap();
    assert_eq!(registry.find_window_key(key).unwrap().window.id, first.id);
    assert!(
        registry
            .register(
                &host,
                2,
                "Impostor".into(),
                vec!["/project".into()],
                Some(key.into())
            )
            .is_err()
    );
    registry.unregister(&host, 1);
    assert!(registry.find_window_key(key).is_none());
    assert!(!old_target.is_connected());
    let next = registry
        .register(
            &host,
            2,
            "Reconnected".into(),
            vec!["/project".into()],
            Some(key.into()),
        )
        .unwrap();
    assert_eq!(registry.find_window_key(key).unwrap().window.id, next.id);
    assert_ne!(first.id, next.id);
    assert!(
        !old_target.is_connected(),
        "an old Turn cannot route to the replacement registration"
    );
}

#[test]
fn ide_desktop_handoff_observes_turn_bindings_in_other_directory_peers_and_isolates_clients() {
    let first = Arc::new(ClientHost::default());
    let second = Arc::new(ClientHost::default());
    let unrelated = Arc::new(ClientHost::default());
    for host in [&first, &second, &unrelated] {
        host.register(1, false, NotificationQueue::default());
    }
    let attachment = Arc::new(crate::client_host::IdeAttachment::default());
    first.install_ide_attachment(1, Arc::clone(&attachment));
    second.install_ide_attachment(1, attachment);
    let thread = ThreadId::new("background-other-session").unwrap();
    let turn = TurnId::new("background-turn").unwrap();
    second
        .submit_turn_with_ide(&thread, Some(1), TextDocumentMode::FileSystem, None, || {
            Ok(TurnReceipt {
                turn_id: turn.clone(),
                sequence: 1,
            })
        })
        .unwrap();
    assert!(first.has_pending_turns(1).unwrap());
    assert!(second.has_pending_turns(1).unwrap());
    assert!(
        !unrelated.has_pending_turns(1).unwrap(),
        "equal directory-local connection IDs cannot merge clients"
    );
    first.register(2, false, NotificationQueue::default());
    first
        .submit_turn_with_ide(
            &ThreadId::new("another-client-session").unwrap(),
            Some(2),
            TextDocumentMode::FileSystem,
            None,
            || {
                Ok(TurnReceipt {
                    turn_id: TurnId::new("another-client-turn").unwrap(),
                    sequence: 1,
                })
            },
        )
        .unwrap();
    second.finish_turn(
        &thread,
        &turn,
        ash_app_server_protocol::protocol::text_document::TextDocumentTurnOutcome::Completed,
    );
    assert!(
        !first.has_pending_turns(1).unwrap(),
        "work owned by another client in the same runtime must not block handoff"
    );
    assert!(first.has_pending_turns(2).unwrap());
}

use super::*;
use crate::client_host::ClientHost;
use crate::client_host::TextDocumentMode;
use crate::server::notification_queue::NotificationQueue;
use ash_app_server_protocol::protocol::ide::IdeHostResult;
use ash_protocol::ThreadId;
use ash_protocol::ToolCallId;
use ash_protocol::TurnId;
use core_api::TurnReceipt;
use std::sync::Arc;

#[test]
fn ide_display_routes_to_the_frozen_window_while_other_app_actions_keep_the_initiator() {
    let server = crate::tests::server();
    let workspace = tempfile::tempdir().unwrap();
    let root = workspace.path().canonicalize().unwrap();
    let original = root.join("old.rs");
    let modified = root.join("new.rs");
    std::fs::write(&original, "old").unwrap();
    std::fs::write(&modified, "new").unwrap();
    let editor = Arc::new(ClientHost::default());
    let first_queue = NotificationQueue::default();
    let second_queue = NotificationQueue::default();
    editor.register(1, false, first_queue.clone());
    editor.register(2, false, second_queue.clone());
    server
        .client_host
        .register(7, false, NotificationQueue::default());
    let first = server
        .ide_registry
        .register(
            &editor,
            1,
            "First".into(),
            vec![root.to_string_lossy().into_owned()],
        )
        .unwrap();
    let second = server
        .ide_registry
        .register(
            &editor,
            2,
            "Second".into(),
            vec![root.to_string_lossy().into_owned()],
        )
        .unwrap();
    server
        .client_host
        .select_ide(7, Some(server.ide_registry.get(&first.id).unwrap()))
        .unwrap();
    let thread = ThreadId::new("thread").unwrap();
    let turn = TurnId::new("turn").unwrap();
    server
        .client_host
        .submit_turn(&thread, Some(7), TextDocumentMode::Client, || {
            Ok(TurnReceipt {
                turn_id: turn.clone(),
                sequence: 1,
            })
        })
        .unwrap();
    server
        .client_host
        .select_ide(7, Some(server.ide_registry.get(&second.id).unwrap()))
        .unwrap();
    let context = AppToolContext {
        session_id: ash_protocol::SessionId::new("session").unwrap(),
        thread_id: thread,
        turn_id: turn,
        call_id: ToolCallId::new("call").unwrap(),
    };
    std::thread::scope(|scope| {
        let call = scope.spawn(|| {
            server.execute_app_host(
                AppHostOperation::OpenReview {
                    original: original.to_string_lossy().into_owned(),
                    modified: modified.to_string_lossy().into_owned(),
                },
                &context,
                &ash_async_utils::CancellationSource::new().token(),
            )
        });
        let listener = first_queue.listener();
        assert!(listener.wait());
        let request = listener.drain().remove(0);
        assert_eq!(request["method"], "ide/hostRequest");
        assert_eq!(request["params"]["type"], "openReview");
        assert!(second_queue.listener().drain().is_empty());
        editor.handle_response(1, serde_json::json!({"jsonrpc":"2.0", "id":request["id"], "result":IdeHostResult::Opened {}})).unwrap();
        assert_eq!(
            call.join().unwrap().unwrap(),
            serde_json::json!({"opened":true})
        );
    });
    assert!(
        server
            .execute_app_host(
                AppHostOperation::Confetti {},
                &context,
                &ash_async_utils::CancellationSource::new().token()
            )
            .is_err()
    );
    assert!(
        server
            .execute_app_host(
                AppHostOperation::OpenFile {
                    path: "/other/secret.rs".into(),
                    line: None
                },
                &context,
                &ash_async_utils::CancellationSource::new().token()
            )
            .is_err()
    );
    #[cfg(unix)]
    {
        let outside = tempfile::NamedTempFile::new().unwrap();
        let linked = root.join("linked.rs");
        std::os::unix::fs::symlink(outside.path(), &linked).unwrap();
        assert!(
            server
                .execute_app_host(
                    AppHostOperation::OpenFile {
                        path: linked.to_string_lossy().into_owned(),
                        line: None
                    },
                    &context,
                    &ash_async_utils::CancellationSource::new().token(),
                )
                .is_err()
        );
        assert!(first_queue.listener().drain().is_empty());
    }
    server.ide_registry.unregister(&editor, 1);
    assert!(
        server
            .execute_app_host(
                AppHostOperation::OpenFile {
                    path: modified.to_string_lossy().into_owned(),
                    line: None
                },
                &context,
                &ash_async_utils::CancellationSource::new().token()
            )
            .is_err()
    );
    assert!(second_queue.listener().drain().is_empty());
}

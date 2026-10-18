use super::*;
use crate::server::notification_queue::NotificationQueue;
use core_api::TurnReceipt;
use serde_json::{Value, json};
use std::thread;

fn bound_host() -> (
    Arc<ClientHost>,
    TextDocumentHost,
    NotificationQueue,
    ash_protocol::ThreadId,
    ash_protocol::TurnId,
) {
    let clients = Arc::new(ClientHost::default());
    let outbound = NotificationQueue::default();
    clients.register(7, true, outbound.clone());
    let thread = ash_protocol::ThreadId::new("document-thread").unwrap();
    let turn = ash_protocol::TurnId::new("document-turn").unwrap();
    clients
        .submit_turn(
            &thread,
            Some(7),
            crate::client_host::TextDocumentMode::Client,
            || {
                Ok(TurnReceipt {
                    turn_id: turn.clone(),
                    sequence: 1,
                })
            },
        )
        .unwrap();
    let host = TextDocumentHost::new(Arc::clone(&clients));
    (clients, host, outbound, thread, turn)
}

fn authorized_editor(editor: Arc<dyn TextDocumentEditor>) -> Arc<dyn TextDocumentEditor> {
    let dir = ash_file_access::Dir::open_local(std::env::current_dir().unwrap()).unwrap();
    let grant = ash_file_access::Grant::for_environment(
        dir,
        ash_file_access::GrantSource::ExplicitUser,
        ash_file_access::Permissions::new([ash_file_access::Permission::WriteFiles]),
    );
    Arc::new(ash_file_system::AuthorizedTextDocuments::new(
        grant
            .authorize(ash_file_access::Permission::WriteFiles)
            .unwrap(),
        editor,
        [],
    ))
}

fn next_request(outbound: &NotificationQueue) -> Value {
    let listener = outbound.listener();
    assert!(listener.wait());
    listener.drain().into_iter().next().unwrap()
}

#[test]
fn document_reads_and_commits_use_the_exact_initiating_connection() {
    let (clients, host, outbound, thread_id, turn) = bound_host();
    let editor = authorized_editor(host.for_turn(&thread_id, &turn).unwrap().unwrap());
    let worker_editor = Arc::clone(&editor);
    let worker = thread::spawn(move || {
        worker_editor.read(
            &std::env::current_dir().unwrap().join("dirty.txt"),
            &CancellationSource::new().token(),
        )
    });
    let request = next_request(&outbound);
    assert_eq!(request["method"], "textDocument/read");
    let response = json!({"jsonrpc":"2.0", "id":request["id"], "result":{"kind":"document", "snapshot":"version-1", "text":"unsaved\r\n"}});
    assert!(clients.handle_response(8, response.clone()).is_err());
    clients.handle_response(7, response).unwrap();
    assert_eq!(worker.join().unwrap().unwrap().unwrap().text, "unsaved\r\n");
    let worker = thread::spawn(move || {
        editor.apply(
            vec![TextDocumentChange::Update {
                snapshot: "version-1".into(),
                text: "updated\n".into(),
            }],
            &CancellationSource::new().token(),
        )
    });
    let request = next_request(&outbound);
    assert_eq!(request["method"], "textDocument/apply");
    assert_eq!(request["params"]["threadId"], "document-thread");
    assert_eq!(request["params"]["turnId"], "document-turn");
    clients
        .handle_response(
            7,
            json!({"jsonrpc":"2.0", "id":request["id"], "result":{"kind":"conflict"}}),
        )
        .unwrap();
    assert_eq!(worker.join().unwrap(), Err(TextDocumentError::Conflict));
}

#[test]
fn disconnect_preserves_editor_selection_and_lost_commit_is_uncertain() {
    let (clients, host, outbound, thread_id, turn) = bound_host();
    let editor = host.for_turn(&thread_id, &turn).unwrap().unwrap();
    let worker = thread::spawn(move || {
        editor.apply(
            vec![TextDocumentChange::Update {
                snapshot: "version-1".into(),
                text: "updated".into(),
            }],
            &CancellationSource::new().token(),
        )
    });
    next_request(&outbound);
    clients.unregister(7);
    assert!(matches!(
        worker.join().unwrap(),
        Err(TextDocumentError::OutcomeUnknown(_))
    ));
    assert!(matches!(
        host.for_turn(&thread_id, &turn),
        Err(TextDocumentError::Unavailable)
    ));
    clients.finish_turn(
        &thread_id,
        &turn,
        ash_app_server_protocol::protocol::text_document::TextDocumentTurnOutcome::Completed,
    );
    assert!(matches!(
        host.for_turn(&thread_id, &turn),
        Err(TextDocumentError::Unavailable)
    ));
}

#[test]
fn disabled_document_capability_explicitly_selects_disk_and_replay_cannot_rebind() {
    let (clients, host, _, thread_id, turn) = bound_host();
    clients.register(8, false, NotificationQueue::default());
    clients
        .submit_turn(
            &thread_id,
            Some(8),
            crate::client_host::TextDocumentMode::Client,
            || {
                Ok(TurnReceipt {
                    turn_id: turn.clone(),
                    sequence: 1,
                })
            },
        )
        .unwrap();
    assert_eq!(
        clients
            .binding(&thread_id, &turn)
            .unwrap()
            .unwrap()
            .connection_id,
        7
    );
    let disk_turn = ash_protocol::TurnId::new("disk-turn").unwrap();
    clients
        .submit_turn(
            &thread_id,
            Some(8),
            crate::client_host::TextDocumentMode::Client,
            || {
                Ok(TurnReceipt {
                    turn_id: disk_turn.clone(),
                    sequence: 2,
                })
            },
        )
        .unwrap();
    assert!(host.for_turn(&thread_id, &disk_turn).unwrap().is_none());
}

#[test]
fn cancellation_retires_request_and_accepts_late_reply_without_republishing() {
    let (clients, host, outbound, thread_id, turn) = bound_host();
    let editor = authorized_editor(host.for_turn(&thread_id, &turn).unwrap().unwrap());
    let cancellation = CancellationSource::new();
    let token = cancellation.token();
    let worker = thread::spawn(move || {
        editor.read(&std::env::current_dir().unwrap().join("file.txt"), &token)
    });
    let request = next_request(&outbound);
    cancellation.cancel();
    assert_eq!(worker.join().unwrap(), Err(TextDocumentError::Cancelled));
    let cancel = next_request(&outbound);
    assert_eq!(cancel["method"], "$/cancelRequest");
    clients
        .handle_response(
            7,
            json!({"jsonrpc":"2.0", "id":request["id"], "result":{"kind":"notFound"}}),
        )
        .unwrap();
    assert!(outbound.listener().drain().is_empty());
}

#[cfg(unix)]
#[test]
fn editor_forwarding_enforces_agent_policy_on_the_final_read_target() {
    use ash_file_access::Dir;
    use ash_file_access::Grant;
    use ash_file_access::GrantSource;
    use ash_file_access::PathAccess;
    use ash_file_access::PathAccessPolicy;
    use ash_file_access::PathAccessRule;
    use ash_file_access::Permission;
    use ash_file_access::Permissions;
    use std::fs;

    for (replaced, target) in [
        ("visible", "restricted"),
        ("visible/nested", "../restricted/nested"),
        ("visible/nested/file", "../../restricted/nested/file"),
    ] {
        let temp = tempfile::tempdir().unwrap();
        let dir = Dir::open_local(temp.path()).unwrap();
        let root = dir.canonical_path();
        fs::create_dir_all(root.join("visible/nested")).unwrap();
        fs::create_dir_all(root.join("restricted/nested")).unwrap();
        fs::write(root.join("visible/nested/file"), "public").unwrap();
        fs::write(root.join("restricted/nested/file"), "secret").unwrap();
        let grant = Grant::for_environment(
            dir.clone(),
            GrantSource::ExplicitUser,
            Permissions::new([Permission::ReadFiles]),
        )
        .with_path_policy(
            PathAccessPolicy::new(
                PathAccess::ReadWrite,
                vec![PathAccessRule {
                    pattern: "restricted".into(),
                    access: PathAccess::Denied,
                }],
            )
            .unwrap(),
        );
        let (clients, host, outbound, thread_id, turn) = bound_host();
        let editor = ash_file_system::AuthorizedTextDocuments::new(
            grant.authorize(Permission::ReadFiles).unwrap(),
            host.for_turn(&thread_id, &turn).unwrap().unwrap(),
            [],
        );
        let path = root.join("visible/nested/file");
        let worker_path = path.clone();
        let worker =
            thread::spawn(move || editor.read(&worker_path, &CancellationSource::new().token()));
        let request = next_request(&outbound);
        let access = request["params"]["readAccess"].as_str().unwrap();
        assert_eq!(
            host.read_content(7, access, &path, 1024).unwrap().bytes,
            b"public"
        );
        assert!(host.read_content(8, access, &path, 1024).is_err());
        assert!(
            host.read_content(7, access, &root.join("restricted/nested/file"), 1024)
                .is_err()
        );

        // The editor is allowed to read this tree, but the initiating Agent is not.
        // Replace only after authorization and forwarding, before its cold model read.
        fs::rename(root.join(replaced), root.join("old")).unwrap();
        std::os::unix::fs::symlink(target, root.join(replaced)).unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "secret");
        assert!(
            host.read_content(7, access, &path, 1024).is_err(),
            "followed {replaced}"
        );
        clients
            .handle_response(
                7,
                json!({"jsonrpc":"2.0", "id":request["id"],
            "result":{"kind":"failed", "message":"denied"}}),
            )
            .unwrap();
        assert!(worker.join().unwrap().is_err());
        assert!(host.read_content(7, access, &path, 1024).is_err());
    }
}

#[test]
fn editor_read_proofs_preserve_content_and_expire_with_the_callback() {
    use ash_file_access::Dir;
    use ash_file_access::Grant;
    use ash_file_access::GrantSource;
    use ash_file_access::Permission;
    use ash_file_access::Permissions;
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let path = dir.canonical_path().join("file");
    std::fs::write(&path, "disk").unwrap();
    let grant = Grant::for_environment(
        dir,
        GrantSource::ExplicitUser,
        Permissions::new([Permission::ReadFiles]),
    );
    let (clients, host, outbound, thread_id, turn) = bound_host();
    for outcome in ["document", "cancel", "disconnect", "revoke"] {
        let editor = ash_file_system::AuthorizedTextDocuments::new(
            grant.authorize(Permission::ReadFiles).unwrap(),
            host.for_turn(&thread_id, &turn).unwrap().unwrap(),
            [],
        );
        let cancellation = CancellationSource::new();
        let token = cancellation.token();
        let worker_path = path.clone();
        let worker = thread::spawn(move || editor.read(&worker_path, &token));
        let request = next_request(&outbound);
        let access = request["params"]["readAccess"].as_str().unwrap();
        assert_eq!(
            host.read_content(7, access, &path, 1024).unwrap().bytes,
            b"disk"
        );
        assert!(host.read_content(7, access, &path, 1).is_err());
        match outcome {
            "cancel" => {
                cancellation.cancel();
            }
            "disconnect" => {
                clients.unregister(7);
            }
            "revoke" => {
                grant.revoke();
            }
            "document" => {}
            _ => unreachable!(),
        }
        if outcome != "document" {
            assert!(host.read_content(7, access, &path, 1024).is_err());
        }
        if matches!(outcome, "document" | "revoke") {
            clients
                .handle_response(
                    7,
                    json!({"jsonrpc":"2.0", "id":request["id"],
                "result":{"kind":"document", "snapshot":"dirty", "text":"unsaved"}}),
                )
                .unwrap();
        }
        if outcome == "revoke" {
            let release = next_request(&outbound);
            assert_eq!(release["method"], "textDocument/release");
            clients
                .handle_response(
                    7,
                    json!({"jsonrpc":"2.0", "id":release["id"], "result":null}),
                )
                .unwrap();
        }
        let result = worker.join().unwrap();
        if outcome == "document" {
            assert_eq!(result.unwrap().unwrap().text, "unsaved");
        } else {
            assert!(result.is_err());
        }
        assert!(host.read_content(7, access, &path, 1024).is_err());
        if outcome == "cancel" {
            next_request(&outbound);
        }
        if outcome == "disconnect" {
            clients.register(7, true, outbound.clone());
        }
    }
}

#[test]
fn editor_reads_without_a_directory_proof_are_rejected_before_forwarding() {
    let (_, host, outbound, thread_id, turn) = bound_host();
    let editor = host.for_turn(&thread_id, &turn).unwrap().unwrap();
    assert_eq!(
        editor.read(
            Path::new("/workspace/file"),
            &CancellationSource::new().token()
        ),
        Err(TextDocumentError::Unavailable)
    );
    assert!(outbound.listener().drain().is_empty());
}

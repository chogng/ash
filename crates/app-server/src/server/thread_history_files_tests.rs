use super::*;
use crate::AppServer;
use crate::AppServerOptions;
use crate::ConnectionState;
use crate::open_app_server;
use serde_json::Value;

fn rpc(server: &AppServer, connection: &mut ConnectionState, method: &str, params: Value) -> Value {
    static REQUEST_ID: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(1);
    let id = REQUEST_ID.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    serde_json::from_str(&server.handle_json(
        connection,
        &serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}).to_string(),
    ))
    .unwrap()
}

fn call(
    server: &AppServer,
    connection: &mut ConnectionState,
    method: &str,
    params: Value,
) -> Value {
    let response = rpc(server, connection, method, params);
    assert!(response.get("error").is_none(), "{method}: {response}");
    response["result"].clone()
}

fn initialize(server: &AppServer, connection: &mut ConnectionState) {
    call(
        server,
        connection,
        "initialize",
        serde_json::json!({"clientInfo":{"name":"history-test","version":"1"},"capabilities":{}}),
    );
}

fn history(
    server: &AppServer,
    connection: &mut ConnectionState,
    session: &str,
    thread: &str,
) -> Value {
    call(
        server,
        connection,
        "session/thread/history",
        serde_json::json!({"sessionId":session,"threadId":thread}),
    )
}

fn move_history(
    server: &AppServer,
    connection: &mut ConnectionState,
    session: &str,
    thread: &str,
    command: &str,
    direction: &str,
) {
    let state = history(server, connection, session, thread);
    let result = call(
        server,
        connection,
        "session/request",
        serde_json::json!({"commandId":command,"sessionId":session,"request":{"type":"moveThreadHistory","threadId":thread,"expectedSequence":state["sequence"],"direction":direction}}),
    );
    assert_eq!(result["value"]["threadId"], thread);
}

#[test]
fn git_and_directory_history_restore_files_and_keep_the_same_thread_after_restart() {
    for git in [true, false] {
        let profile = tempfile::tempdir().unwrap();
        let source = tempfile::tempdir().unwrap();
        std::fs::write(source.path().join("note"), "initial\n").unwrap();
        if git {
            for arguments in [
                vec!["init", "--quiet", "--initial-branch=main"],
                vec!["config", "core.autocrlf", "false"],
                vec!["add", "."],
                vec!["commit", "--quiet", "-m", "baseline"],
            ] {
                let output = std::process::Command::new("git")
                    .current_dir(source.path())
                    .args([
                        "-c",
                        "user.name=History test",
                        "-c",
                        "user.email=history@example.test",
                    ])
                    .args(arguments)
                    .output()
                    .unwrap();
                assert!(
                    output.status.success(),
                    "{}",
                    String::from_utf8_lossy(&output.stderr)
                );
            }
        }
        let options = || {
            AppServerOptions::new(profile.path())
                .with_codex_home(profile.path().join("codex"))
                .without_built_in_skills()
                .with_dir_root(source.path())
        };
        let server = open_app_server(options()).unwrap();
        let mut connection = server.connection();
        initialize(&server, &mut connection);
        call(
            &server,
            &mut connection,
            "execPolicy/rule/upsert",
            serde_json::json!({"commandId":"shell-policy","expectedRevision":0,"rule":{"id":"shell-policy","selector":{"type":"source","source":"built_in_tool","sourceId":"shell-command"},"effect":{"type":"allowUnsandboxed"},"justification":"test owns this temporary directory"}}),
        );
        let session = call(
            &server,
            &mut connection,
            "session/create",
            serde_json::json!({"commandId":"session","title":"History","executionTarget":{"type":"local","root":source.path()}}),
        );
        let session_id = session["session"]["sessionId"]
            .as_str()
            .unwrap()
            .to_string();
        let thread_id = session["session"]["threads"][0]["threadId"]
            .as_str()
            .unwrap()
            .to_string();
        let read = call(
            &server,
            &mut connection,
            "session/thread/read",
            serde_json::json!({"sessionId":session_id,"threadId":thread_id}),
        );
        let directory = PathBuf::from(read["directory"]["root"].as_str().unwrap());
        call(
            &server,
            &mut connection,
            "session/request",
            serde_json::json!({"commandId":"write","sessionId":session_id,"request":{"type":"startShellTurn","threadId":thread_id,"expectedSequence":read["thread"]["sequence"],"approvalMode":"bypassPermissions","command":if cfg!(windows) { "echo changed>note" } else { "printf 'changed\\n' > note" },"workingDirectory":"."}}),
        );
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while history(&server, &mut connection, &session_id, &thread_id)["canUndo"] != true {
            assert!(
                std::time::Instant::now() < deadline,
                "request did not acquire a history checkpoint"
            );
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let points = call(
            &server,
            &mut connection,
            "session/thread/checkpoints",
            serde_json::json!({"sessionId":session_id,"threadId":thread_id}),
        );
        assert_eq!(points["checkpoints"].as_array().unwrap().len(), 2);
        assert!(
            points["checkpoints"]
                .as_array()
                .unwrap()
                .iter()
                .all(|point| point["workspace"]["type"] == if git { "git" } else { "directory" })
        );
        move_history(
            &server,
            &mut connection,
            &session_id,
            &thread_id,
            "undo",
            "undo",
        );
        assert_eq!(
            std::fs::read_to_string(directory.join("note"))
                .unwrap()
                .trim(),
            "initial"
        );
        let read = call(
            &server,
            &mut connection,
            "session/thread/read",
            serde_json::json!({"sessionId":session_id,"threadId":thread_id}),
        );
        assert!(read["thread"]["turns"].as_array().unwrap().is_empty());
        let changes = call(
            &server,
            &mut connection,
            "turnChanges/list",
            serde_json::json!({"sessionId":session_id,"threadId":thread_id}),
        );
        assert!(changes["changeSets"].as_array().unwrap().is_empty());
        server.close_connection(connection);
        drop(server);
        let server = open_app_server(options()).unwrap();
        let mut connection = server.connection();
        initialize(&server, &mut connection);
        assert_eq!(
            history(&server, &mut connection, &session_id, &thread_id)["canRedo"],
            true
        );
        move_history(
            &server,
            &mut connection,
            &session_id,
            &thread_id,
            "redo",
            "redo",
        );
        assert_eq!(
            std::fs::read_to_string(directory.join("note"))
                .unwrap()
                .trim(),
            "changed"
        );
        let runtime = server.git_turn_changes.as_ref().unwrap();
        let thread = ThreadId::new(thread_id.clone()).unwrap();
        let state = history(&server, &mut connection, &session_id, &thread_id);
        let backup = if git {
            // A fully applied file transaction with no journal event.
            std::fs::write(directory.join("note"), "initial\n").unwrap();
            None
        } else {
            // A process can stop between removing the original and installing the target.
            let staging = directory
                .parent()
                .unwrap()
                .join(".history-files-interrupted");
            let backup = staging.join("previous");
            std::fs::create_dir_all(&backup).unwrap();
            std::fs::rename(directory.join("note"), backup.join("note")).unwrap();
            Some(backup)
        };
        let intent = RestoreIntent {
            version: 2,
            thread_id: thread.clone(),
            command_id: CommandId::new("interrupted").unwrap(),
            expected_sequence: state["sequence"].as_u64().unwrap(),
            previous: serde_json::from_value(points["checkpoints"][1]["workspace"].clone())
                .unwrap(),
            target: serde_json::from_value(points["checkpoints"][0]["workspace"].clone()).unwrap(),
            directory_backup: backup,
        };
        let intent_path = runtime.history_intent_path(&thread);
        std::fs::create_dir_all(&runtime.history_restorations).unwrap();
        std::fs::write(&intent_path, serde_json::to_vec(&intent).unwrap()).unwrap();
        runtime.recover_history_restorations().unwrap();
        assert_eq!(
            std::fs::read_to_string(directory.join("note"))
                .unwrap()
                .trim(),
            "changed"
        );
        assert!(!intent_path.exists());
        assert_eq!(
            history(&server, &mut connection, &session_id, &thread_id)["sequence"],
            state["sequence"]
        );
        std::fs::write(directory.join("note"), "offline user edit").unwrap();
        std::fs::write(
            &intent_path,
            serde_json::to_vec(&RestoreIntent {
                directory_backup: None,
                ..intent
            })
            .unwrap(),
        )
        .unwrap();
        runtime.recover_history_restorations().unwrap();
        let blocked = rpc(
            &server,
            &mut connection,
            "session/thread/history",
            serde_json::json!({"sessionId":session_id,"threadId":thread_id}),
        );
        assert_eq!(blocked["error"]["data"]["kind"], "ThreadHistoryConflict");
        let rejected_request = rpc(
            &server,
            &mut connection,
            "session/request",
            serde_json::json!({"commandId":"pending-files","sessionId":session_id,"request":{"type":"startShellTurn","threadId":thread_id,"expectedSequence":state["sequence"],"approvalMode":"bypassPermissions","command":"echo forbidden>note","workingDirectory":"."}}),
        );
        assert_eq!(
            rejected_request["error"]["data"]["kind"],
            "ThreadHistoryConflict"
        );
        assert_eq!(
            std::fs::read_to_string(directory.join("note")).unwrap(),
            "offline user edit"
        );
        assert!(intent_path.exists());
        // A journaled operation only needs its leftover marker removed; later edits remain valid.
        let committed = RestoreIntent {
            version: 2,
            thread_id: thread,
            command_id: CommandId::new("redo").unwrap(),
            expected_sequence: state["sequence"].as_u64().unwrap() - 1,
            previous: serde_json::from_value(points["checkpoints"][0]["workspace"].clone())
                .unwrap(),
            target: serde_json::from_value(points["checkpoints"][1]["workspace"].clone()).unwrap(),
            directory_backup: None,
        };
        std::fs::write(&intent_path, serde_json::to_vec(&committed).unwrap()).unwrap();
        runtime.recover_history_restorations().unwrap();
        assert!(!intent_path.exists());
        assert_eq!(
            std::fs::read_to_string(directory.join("note")).unwrap(),
            "offline user edit"
        );
        std::fs::write(directory.join("note"), "user edit").unwrap();
        let state = history(&server, &mut connection, &session_id, &thread_id);
        let rejected = rpc(
            &server,
            &mut connection,
            "session/request",
            serde_json::json!({"commandId":"conflict","sessionId":session_id,"request":{"type":"moveThreadHistory","threadId":thread_id,"expectedSequence":state["sequence"],"direction":"undo"}}),
        );
        assert_eq!(
            rejected["error"]["data"]["kind"], "ThreadHistoryConflict",
            "{rejected}"
        );
        assert_eq!(
            std::fs::read_to_string(directory.join("note")).unwrap(),
            "user edit"
        );
        assert_eq!(
            history(&server, &mut connection, &session_id, &thread_id)["sequence"],
            state["sequence"]
        );
        if !git {
            // The immutable directory evidence outlives the original checkout.
            server.close_connection(connection);
            drop(server);
            assert!(directory.starts_with(dunce::canonicalize(profile.path()).unwrap()));
            std::fs::remove_dir_all(directory.parent().unwrap()).unwrap();
            let server = open_app_server(options()).unwrap();
            let mut connection = server.connection();
            initialize(&server, &mut connection);
            let restored = call(
                &server,
                &mut connection,
                "session/request",
                serde_json::json!({"commandId":"restore","sessionId":session_id,"request":{"type":"restoreMessage","threadId":thread_id,"itemId":points["checkpoints"][0]["itemId"],"boundary":"before","title":"Restored"}}),
            );
            let read = call(
                &server,
                &mut connection,
                "session/thread/read",
                serde_json::json!({"sessionId":session_id,"threadId":restored["value"]["threadId"]}),
            );
            let restored_directory = PathBuf::from(read["directory"]["root"].as_str().unwrap());
            assert_ne!(directory, restored_directory);
            assert_eq!(
                std::fs::read_to_string(restored_directory.join("note")).unwrap(),
                "initial\n"
            );
            server.close_connection(connection);
        } else {
            server.close_connection(connection);
        }
        assert_eq!(
            std::fs::read_to_string(source.path().join("note")).unwrap(),
            "initial\n"
        );
    }
}

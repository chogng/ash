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

fn conversation_changes(
    server: &AppServer,
    connection: &mut ConnectionState,
    session: &str,
    thread: &str,
) -> Value {
    call(
        server,
        connection,
        "turnChanges/summary",
        serde_json::json!({"sessionId":session,"threadId":thread}),
    )
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
        if git {
            // Existing source edits belong to the initial directory baseline, never this chat.
            std::fs::write(source.path().join("preexisting"), "source work\n").unwrap();
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
        if git {
            assert_eq!(
                std::fs::read_to_string(directory.join("preexisting")).unwrap(),
                "source work\n"
            );
        }
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
        let original_summary =
            conversation_changes(&server, &mut connection, &session_id, &thread_id);
        assert_eq!(
            original_summary["statistics"]["files"],
            if git { 1 } else { 0 }
        );
        assert!(
            rpc(
                &server,
                &mut connection,
                "turnChanges/summary",
                serde_json::json!({"sessionId":"wrong-owner","threadId":thread_id})
            )
            .get("error")
            .is_some()
        );
        let file_params = serde_json::json!({"sessionId":session_id,"threadId":thread_id,"revision":original_summary["revision"],"repositoryId":original_summary["repositories"][0]["repositoryId"],"path":"note"});
        if git {
            let file = call(
                &server,
                &mut connection,
                "turnChanges/summaryFile",
                file_params.clone(),
            );
            assert_eq!(file["before"], "initial\n");
            assert_eq!(file["after"].as_str().unwrap().trim(), "changed");
            let mut outside = file_params.clone();
            outside["path"] = serde_json::json!("../note");
            assert!(
                rpc(&server, &mut connection, "turnChanges/summaryFile", outside)
                    .get("error")
                    .is_some()
            );
        }
        move_history(
            &server,
            &mut connection,
            &session_id,
            &thread_id,
            "undo",
            "undo",
        );
        let undone_summary =
            conversation_changes(&server, &mut connection, &session_id, &thread_id);
        assert_eq!(
            undone_summary["statistics"],
            serde_json::json!({"files":0,"additions":0,"deletions":0})
        );
        assert_ne!(undone_summary["revision"], original_summary["revision"]);
        if git {
            assert!(
                rpc(
                    &server,
                    &mut connection,
                    "turnChanges/summaryFile",
                    file_params
                )
                .get("error")
                .is_some()
            );
        }
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
        let changed_content = std::fs::read(directory.join("note")).unwrap();
        let redone_summary =
            conversation_changes(&server, &mut connection, &session_id, &thread_id);
        assert_eq!(redone_summary["statistics"], original_summary["statistics"]);
        assert_ne!(redone_summary["revision"], original_summary["revision"]);
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
            // Continue from an earlier checkpoint. The old future must not contribute, and
            // a subsequent reversal must net to zero instead of summing both new Turns.
            std::fs::write(directory.join("note"), &changed_content).unwrap();
            move_history(
                &server,
                &mut connection,
                &session_id,
                &thread_id,
                "branch-undo",
                "undo",
            );
            for (command_id, command, expected_files) in [
                (
                    "continue",
                    if cfg!(windows) {
                        "echo continued>note && echo branch>branch.txt"
                    } else {
                        "printf 'continued\\n' > note; printf 'branch\\n' > branch.txt"
                    },
                    2,
                ),
                (
                    "reverse",
                    if cfg!(windows) {
                        "git restore -- note && del branch.txt"
                    } else {
                        "printf 'initial\\n' > note; rm branch.txt"
                    },
                    0,
                ),
            ] {
                let state = history(&server, &mut connection, &session_id, &thread_id);
                call(
                    &server,
                    &mut connection,
                    "session/request",
                    serde_json::json!({"commandId":command_id,"sessionId":session_id,"request":{"type":"startShellTurn","threadId":thread_id,"expectedSequence":state["sequence"],"approvalMode":"bypassPermissions","command":command,"workingDirectory":"."}}),
                );
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
                loop {
                    let read = call(
                        &server,
                        &mut connection,
                        "session/thread/read",
                        serde_json::json!({"sessionId":session_id,"threadId":thread_id}),
                    );
                    if read["thread"]["turns"]
                        .as_array()
                        .unwrap()
                        .last()
                        .is_some_and(|turn| turn["status"] == "completed")
                    {
                        break;
                    }
                    assert!(std::time::Instant::now() < deadline);
                    std::thread::sleep(std::time::Duration::from_millis(10));
                }
                let summary =
                    conversation_changes(&server, &mut connection, &session_id, &thread_id);
                assert_eq!(summary["statistics"]["files"], expected_files, "{summary}");
                assert_eq!(
                    history(&server, &mut connection, &session_id, &thread_id)["canRedo"],
                    false
                );
                if expected_files > 0 {
                    let file = call(
                        &server,
                        &mut connection,
                        "turnChanges/summaryFile",
                        serde_json::json!({"sessionId":session_id,"threadId":thread_id,"revision":summary["revision"],"repositoryId":summary["repositories"][0]["repositoryId"],"path":"note"}),
                    );
                    assert_eq!(file["before"], "initial\n");
                    assert_eq!(file["after"].as_str().unwrap().trim(), "continued");
                }
            }
            server.close_connection(connection);
        }
        assert_eq!(
            std::fs::read_to_string(source.path().join("note")).unwrap(),
            "initial\n"
        );
    }
}

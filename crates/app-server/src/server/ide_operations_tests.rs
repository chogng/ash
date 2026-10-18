use super::*;
use ash_app_server_protocol::protocol::ide::IdeActiveFile;
use ash_app_server_protocol::protocol::ide::IdeSelection;

#[test]
fn ide_context_rejects_escaped_paths_invalid_ranges_and_large_selections() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("lib.rs");
    std::fs::write(&file, "disk").unwrap();
    let roots = vec![
        ash_file_access::Dir::open_local(root.path())
            .unwrap()
            .canonical_path()
            .to_string_lossy()
            .into_owned(),
    ];
    let mut context = IdeContext {
        active_file: Some(IdeActiveFile {
            path: file.to_string_lossy().into_owned(),
            version: 1,
            selections: vec![IdeSelection {
                start_line: 1,
                start_column: 1,
                end_line: 1,
                end_column: 2,
                text: "x".into(),
                truncated: false,
            }],
        }),
        open_tabs: vec![],
        dirty_files: vec![],
    };
    validate_context(&context, &roots).unwrap();
    context.active_file.as_mut().unwrap().selections[0].end_column = 0;
    assert!(validate_context(&context, &roots).is_err());
    context.active_file.as_mut().unwrap().selections[0].end_column = 2;
    context.active_file.as_mut().unwrap().selections[0].text = "x".repeat(160_001);
    assert!(validate_context(&context, &roots).is_err());
    context.active_file = None;
    let outside = tempfile::NamedTempFile::new().unwrap();
    context
        .open_tabs
        .push(outside.path().to_string_lossy().into_owned());
    assert!(validate_context(&context, &roots).is_err());
}

#[cfg(windows)]
#[test]
fn ide_context_accepts_regular_and_verbatim_file_paths_with_directory_roots() {
    let directory = tempfile::tempdir().unwrap();
    let root = ash_file_access::Dir::open_local(directory.path()).unwrap();
    let file = root.canonical_path().join("lib.rs");
    std::fs::write(&file, "disk").unwrap();
    let roots = vec![root.canonical_path().to_string_lossy().into_owned()];
    for path in [&file, &file.canonicalize().unwrap()] {
        let path = path.to_string_lossy().into_owned();
        let context = IdeContext {
            active_file: Some(IdeActiveFile {
                path: path.clone(),
                version: 1,
                selections: vec![],
            }),
            open_tabs: vec![path.clone()],
            dirty_files: vec![path],
        };
        validate_context(&context, &roots).unwrap();
    }
    let outside = tempfile::NamedTempFile::new().unwrap();
    for path in [outside.path(), &outside.path().canonicalize().unwrap()] {
        let context = IdeContext {
            active_file: None,
            open_tabs: vec![path.to_string_lossy().into_owned()],
            dirty_files: vec![],
        };
        assert!(validate_context(&context, &roots).is_err());
    }
}

#[cfg(unix)]
#[test]
fn ide_context_rejects_symlinks_that_escape_directory_grants() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::NamedTempFile::new().unwrap();
    let alias = root.path().join("alias.rs");
    std::os::unix::fs::symlink(outside.path(), &alias).unwrap();
    let context = IdeContext {
        active_file: None,
        open_tabs: vec![alias.to_string_lossy().into_owned()],
        dirty_files: vec![],
    };
    assert!(
        validate_context(
            &context,
            &[ash_file_access::Dir::open_local(root.path())
                .unwrap()
                .canonical_path()
                .to_string_lossy()
                .into_owned()]
        )
        .is_err()
    );
}

#[test]
fn ide_context_omits_denied_buffers_and_does_not_block_messages_outside_the_workspace() {
    use ash_file_access::Dir;
    use ash_file_access::Grant;
    use ash_file_access::GrantSource;
    use ash_file_access::PathAccess;
    use ash_file_access::PathAccessPolicy;
    use ash_file_access::PathAccessRule;
    use ash_file_access::Permission;
    use ash_file_access::Permissions;

    let server = crate::tests::server();
    let directory = tempfile::tempdir().unwrap();
    let root = Dir::open_local(directory.path())
        .unwrap()
        .canonical_path()
        .to_path_buf();
    let allowed = root.join("lib.rs");
    let denied = root.join(".env");
    std::fs::write(&allowed, "disk").unwrap();
    std::fs::write(&denied, "private").unwrap();
    // The editor can return verbatim Windows paths even though grants use regular paths.
    let allowed = allowed.canonicalize().unwrap();
    let denied = denied.canonicalize().unwrap();
    let policy = PathAccessPolicy::new(
        PathAccess::ReadOnly,
        vec![PathAccessRule {
            pattern: ".env".into(),
            access: PathAccess::Denied,
        }],
    )
    .unwrap();
    server.env_runtime.write().unwrap().selected_grant = Some(
        Grant::for_environment(
            Dir::open_local(&root).unwrap(),
            GrantSource::HostConfiguration,
            Permissions::new([Permission::ReadFiles]),
        )
        .with_path_policy(policy),
    );
    let mut editor = server.product_host_connection();
    let mut tui = server.product_host_connection();
    crate::tests::initialize(&server, &mut editor);
    crate::tests::initialize(&server, &mut tui);
    let registered = crate::tests::call(
        &server,
        &mut editor,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"ide/request","params":{"type":"register","title":"IDE","roots":[root]}}),
    );
    assert!(registered.get("error").is_none(), "{registered}");
    let connected = crate::tests::call(
        &server,
        &mut tui,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"ide/request","params":{"type":"connect","windowId":registered["result"]["window"]["id"]}}),
    );
    assert!(connected.get("error").is_none(), "{connected}");
    let session = crate::tests::call(
        &server,
        &mut tui,
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"session/create","params":{"commandId":"context-permission-test","title":"Context","executionTarget":null}}),
    );
    assert!(session.get("error").is_none(), "{session}");
    let session_id = session["result"]["session"]["sessionId"].as_str().unwrap();
    let thread_id = server
        .threads()
        .list_threads()
        .unwrap()
        .into_iter()
        .find(|thread| thread.session_id.as_str() == session_id)
        .unwrap()
        .thread_id;
    let params = serde_json::json!({"type":"context","sessionId":session_id,"threadId":thread_id});
    let notifications = server.connection_notifications(&editor);
    std::thread::scope(|scope| {
        let read = scope.spawn(|| {
            let response = server.handle_json(
                &mut tui,
                &serde_json::json!({"jsonrpc":"2.0","id":4,"method":"ide/request","params":params})
                    .to_string(),
            );
            notifications.close();
            response
        });
        while notifications.wait() {
            for raw in notifications.drain() {
                let request: serde_json::Value = serde_json::from_str(&raw).unwrap();
                if request["method"] != "ide/hostRequest" {
                    continue;
                }
                server.handle_product_host_response(&editor, serde_json::json!({"jsonrpc":"2.0","id":request["id"],"result":{"type":"context","context":{"activeFile":{"path":denied,"version":2,"selections":[{"startLine":1,"startColumn":1,"endLine":1,"endColumn":8,"text":"private","truncated":false}]},"openTabs":[allowed,denied],"dirtyFiles":[denied]}}})).unwrap();
            }
        }
        let response: serde_json::Value = serde_json::from_str(&read.join().unwrap()).unwrap();
        assert!(response.get("error").is_none(), "{response}");
        assert_eq!(
            response["result"]["context"]["activeFile"],
            serde_json::Value::Null
        );
        assert_eq!(
            response["result"]["context"]["openTabs"],
            serde_json::json!([allowed])
        );
        assert_eq!(
            response["result"]["context"]["dirtyFiles"],
            serde_json::json!([])
        );
    });
    let outside = tempfile::tempdir().unwrap();
    server.env_runtime.write().unwrap().selected_grant = Some(Grant::for_environment(
        Dir::open_local(outside.path()).unwrap(),
        GrantSource::HostConfiguration,
        Permissions::new([Permission::ReadFiles]),
    ));
    let response = crate::tests::call(
        &server,
        &mut tui,
        serde_json::json!({"jsonrpc":"2.0","id":5,"method":"ide/request","params":params}),
    );
    assert!(response.get("error").is_none(), "{response}");
    assert_eq!(
        response["result"]["window"]["id"],
        registered["result"]["window"]["id"]
    );
    assert_eq!(response["result"]["context"], serde_json::Value::Null);
}

#[test]
fn ide_desktop_handoff_rejects_invalid_identity_and_accepted_work_without_calling_a_window() {
    use std::sync::Arc;
    let root = tempfile::tempdir().unwrap();
    let mut server = crate::tests::server();
    let session_id = ash_protocol::SessionId::new("handoff-session").unwrap();
    let thread_id = ash_protocol::ThreadId::new("handoff-thread").unwrap();
    server
        .threads()
        .create_thread(ash_core::CreateThreadRequest {
            execution_target: Some(ash_protocol::SessionExecutionTarget::Local {
                root: root.path().canonicalize().unwrap(),
            }),
            agent_id: ash_protocol::AgentId::new("handoff-agent").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            title: "Handoff".into(),
        })
        .unwrap();
    server.queue = Some(Arc::new(
        queue::QueueStore::open(&root.path().join("queue.sqlite")).unwrap(),
    ));
    let mut tui = server.product_host_connection();
    crate::tests::initialize(&server, &mut tui);
    let request =
        serde_json::json!({"type":"openConversation","sessionId":session_id,"threadId":thread_id});
    let call = |connection: &mut ConnectionState, id, params| {
        crate::tests::call(
            &server,
            connection,
            serde_json::json!({"jsonrpc":"2.0","id":id,"method":"ide/request","params":params}),
        )
    };
    let wrong = call(
        &mut tui,
        2,
        serde_json::json!({"type":"openConversation","sessionId":"wrong-session","threadId":thread_id}),
    );
    assert!(wrong.get("error").is_some(), "{wrong}");
    let missing = call(&mut tui, 3, request.clone());
    assert_eq!(missing["result"]["type"], "conversationUnavailable");
    let store = server.queue.as_ref().unwrap();
    let command_id = ash_protocol::CommandId::new("handoff-queued").unwrap();
    let message = store
        .enqueue(&queue::QueueInput {
            command_id: command_id.clone(),
            session_id: session_id.clone(),
            thread_id: thread_id.clone(),
            directory: root.path().to_string_lossy().into_owned(),
            input: vec![ash_protocol::UserInput::Text {
                text: "queued task".into(),
            }],
            mode: Default::default(),
            model: None,
            reasoning_effort: None,
            tool_mode: ash_protocol::ToolMode::Direct,
            approval_mode: ash_protocol::ApprovalMode::Manual,
            steer_turn: None,
        })
        .unwrap();
    assert_eq!(
        call(&mut tui, 4, request.clone())["result"]["type"],
        "conversationBusy"
    );
    store
        .edit(
            &session_id,
            &thread_id,
            &command_id,
            message.revision,
            &queue::QueueEdit::Pause,
        )
        .unwrap();
    assert_eq!(
        call(&mut tui, 5, request.clone())["result"]["type"],
        "conversationBusy"
    );
    store.cancel(&session_id, &thread_id, &command_id).unwrap();
    assert_eq!(
        call(&mut tui, 6, request.clone())["result"]["type"],
        "conversationUnavailable"
    );
    let sibling = ash_protocol::ThreadId::new("handoff-background-thread").unwrap();
    server
        .threads()
        .create_thread(ash_core::CreateThreadRequest {
            execution_target: Some(ash_protocol::SessionExecutionTarget::Local {
                root: root.path().canonicalize().unwrap(),
            }),
            agent_id: ash_protocol::AgentId::new("handoff-background-agent").unwrap(),
            origin: Default::default(),
            agent: None,
            session_id: session_id.clone(),
            thread_id: sibling.clone(),
            title: "Background".into(),
        })
        .unwrap();
    server
        .threads()
        .start_turn(
            &sibling,
            ash_core::StartTurnRequest {
                context_policy: Default::default(),
                mode: Default::default(),
                advisor: None,
                kind: ash_protocol::TurnKind::Coding,
                instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                command_id: ash_protocol::CommandId::new("handoff-start").unwrap(),
                expected_sequence: core_api::SequenceExpectation::Any,
                model: None,
                reasoning_effort: None,
                policy_revision: "handoff-policy".into(),
                approval_mode: ash_protocol::ApprovalMode::Manual,
                tool_mode: ash_protocol::ToolMode::Direct,
                tool_profile: None,
                activated_skills: vec![],
                input: vec![ash_protocol::UserInput::Text {
                    text: "accepted task".into(),
                }],
            },
        )
        .unwrap();
    assert_eq!(
        call(&mut tui, 7, request)["result"]["type"],
        "conversationBusy"
    );
    server.close_connection(tui);
}

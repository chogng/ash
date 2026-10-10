use ash_core::StartTurnRequest;
use ash_protocol::CommandId;
use ash_protocol::HookRunStatus;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use ash_protocol::ResponseItem;
use ash_protocol::StopReason;
use ash_protocol::ToolCall;
use ash_protocol::ToolCallId;
use ash_protocol::ToolName;
use ash_protocol::TurnStatus;
use core_api::CoreError;
use core_api::ModelSelection;
use core_api::ModelService;
use core_api::SequenceExpectation;
use core_api::StartThreadRequest;
use std::sync::Arc;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

struct ToolModel(AtomicUsize);

impl ModelService for ToolModel {
    fn invoke(
        &self,
        _: ModelSelection<'_>,
        _: &ModelRequest,
        _: &ash_async_utils::CancellationToken,
    ) -> Result<ModelResponse, CoreError> {
        let first = self.0.fetch_add(1, Ordering::SeqCst) == 0;
        Ok(ModelResponse {
            output: if first {
                vec![ResponseItem::ToolCall(ToolCall {
                    id: ToolCallId::new("hook-test-tool").unwrap(),
                    name: ToolName::new("shell-command").unwrap(),
                    arguments: serde_json::json!({"program":"/bin/sh", "arguments":["-c", "printf hook-test-executed"], "working_directory":"."}),
                })]
            } else {
                vec![ResponseItem::Text("done".into())]
            },
            usage: None,
            billing: None,
            stop_reason: if first {
                StopReason::ToolUse
            } else {
                StopReason::Completed
            },
        })
    }
}

#[test]
fn real_hook_processes_publish_results_and_replay_without_reexecution() {
    for (script, expected, executed) in [
        (
            "printf '{\"decision\":\"continue\"}'",
            HookRunStatus::Continued,
            true,
        ),
        (
            "printf '{\"decision\":\"deny\",\"reason\":\"hook-test-denied\"}'",
            HookRunStatus::Denied {
                reason: "hook-test-denied".into(),
            },
            false,
        ),
        (
            "printf hook-test-stderr >&2; exit 7",
            HookRunStatus::Failed {
                message: "execution failed: Hook 'user:hook:test' exited unsuccessfully".into(),
            },
            false,
        ),
    ] {
        let profile = tempfile::tempdir().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let evidence_root = profile.path().join("evidence");
        std::fs::write(profile.path().join("config.toml"), format!(
            "schemaVersion = 10\n[execPolicy]\nrules = [{{id = \"hook-test\", selector = {{kind = \"source\", source = \"user\", source_id = \"user:hook:test\"}}, effect = {{kind = \"require_sandbox\"}}}}]\n[agent.trace]\nenabled = true\ndirectory = {}\n[hooks.hooks.\"user:hook:test\"]\nid = \"user:hook:test\"\nevent = \"preToolUse\"\nenablement = \"enabled\"\n[hooks.hooks.\"user:hook:test\".matcher]\ntoolNames = [\"shell-command\"]\n[hooks.hooks.\"user:hook:test\".action]\ntype = \"process\"\nprogram = \"/bin/sh\"\nargs = [\"-c\", {}]\n",
            serde_json::to_string(&evidence_root).unwrap(), serde_json::to_string(script).unwrap(),
        )).unwrap();
        let server = crate::open_app_server(
            crate::AppServerOptions::new(profile.path())
                .without_built_in_skills()
                .with_dir_root(directory.path())
                .with_agent_model_service(Arc::new(ToolModel(AtomicUsize::new(0)))),
        )
        .unwrap();
        let thread = server
            .start_thread(StartThreadRequest {
                execution_target: Some(ash_protocol::SessionExecutionTarget::Local {
                    root: directory.path().to_path_buf(),
                }),
                branch_name: None,
                agent_id: None,
                agent: None,
                command_id: CommandId::new("hook-test-create").unwrap(),
                title: "Hooks".into(),
            })
            .unwrap();
        let turn = server
            .threads
            .start_turn(
                &thread.thread_id,
                StartTurnRequest {
                    context_policy: Default::default(),
                    mode: Default::default(),
                    advisor: None,
                    kind: ash_protocol::TurnKind::Coding,
                    instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                    command_id: CommandId::new("hook-test-turn").unwrap(),
                    expected_sequence: SequenceExpectation::Any,
                    model: None,
                    reasoning_effort: None,
                    policy_revision: server.turn_executor_snapshot().policy_revision(),
                    approval_mode: ash_protocol::ApprovalMode::BypassPermissions,
                    tool_mode: ash_protocol::ToolMode::Direct,
                    tool_profile: None,
                    activated_skills: Vec::new(),
                    input: vec![ash_protocol::UserInput::Text {
                        text: "run tool".into(),
                    }],
                },
            )
            .unwrap();
        let mut connections = [server.connection(), server.connection()];
        for connection in &mut connections {
            let initialized: serde_json::Value = serde_json::from_str(&server.handle_json(connection, &serde_json::json!({"jsonrpc":"2.0", "id":1, "method":"initialize", "params":{"clientInfo":{"name":"hook-test", "version":"1"}, "capabilities":{}}}).to_string())).unwrap();
            assert!(initialized.get("result").is_some(), "{initialized}");
            server.updates.subscribe_session_thread(
                connection.connection_id,
                thread.session_id.clone(),
                thread.thread_id.clone(),
                0,
            );
        }
        server
            .turn_executor_backend()
            .start(&thread.thread_id, &turn.turn_id)
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        let snapshot = loop {
            let snapshot = server.threads.read_thread(&thread.thread_id).unwrap();
            if matches!(
                snapshot.turns[0].status,
                TurnStatus::Completed | TurnStatus::Failed | TurnStatus::Interrupted
            ) {
                break snapshot;
            }
            assert!(
                Instant::now() < deadline,
                "Hook Turn did not finish: {snapshot:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        };
        assert_eq!(snapshot.hook_runs.len(), 1, "{snapshot:#?}");
        let run = &snapshot.hook_runs[0];
        match &expected {
            HookRunStatus::Failed { .. } => assert!(
                matches!(&run.status, HookRunStatus::Failed { message } if message.contains("exited unsuccessfully")),
                "{run:?}"
            ),
            _ => assert_eq!(run.status, expected),
        }
        assert_eq!(
            run.tool_call_id.as_ref().unwrap().as_str(),
            "hook-test-tool"
        );
        assert_eq!(run.turn_id.as_ref(), Some(&turn.turn_id));
        assert_eq!(snapshot.items.iter().any(|item| matches!(item,
            ash_protocol::ThreadItem::ToolResult { tool_call_id, text, is_error: false, .. }
                if tool_call_id.as_str() == "hook-test-tool" && text.contains("hook-test-executed")
        )), executed, "{snapshot:#?}");
        assert_eq!(
            snapshot.turns[0].status,
            if matches!(expected, HookRunStatus::Failed { .. }) {
                TurnStatus::Failed
            } else {
                TurnStatus::Completed
            }
        );
        let transcript = server
            .updates
            .thread_transcript_snapshot(&snapshot.public_thread(), true);
        assert!(transcript.entries.iter().any(|entry| matches!(entry, ash_thread_transcript::ThreadTranscriptEntry::HookRun { run: observed, .. } if observed == run)));
        let diagnostics = server
            .trace_reader()
            .read_trace_diagnostics(&thread.session_id, 0, 500)
            .unwrap();
        let recorded = diagnostics
            .diagnostics
            .events
            .iter()
            .find(|event| {
                matches!(
                    event.event,
                    ash_rollout_trace::DiagnosticEventKind::HookRunRecorded { .. }
                )
            })
            .unwrap();
        let payload = server
            .trace_reader()
            .read_trace_payload(
                &thread.session_id,
                diagnostics.diagnostics.capture_id.as_ref().unwrap(),
                &recorded.event.payload().unwrap().payload_id,
            )
            .unwrap();
        assert_eq!(payload["program"], "/bin/sh");
        assert_eq!(
            payload["exitCode"],
            if matches!(expected, HookRunStatus::Failed { .. }) {
                7
            } else {
                0
            }
        );
        if matches!(expected, HookRunStatus::Failed { .. }) {
            assert_eq!(payload["stderr"], "hook-test-stderr");
        }
        for connection in &mut connections {
            let observed = server
                .drain_notifications(connection)
                .into_iter()
                .map(|message| serde_json::from_str::<serde_json::Value>(&message).unwrap())
                .collect::<Vec<_>>();
            let states = observed
                .iter()
                .filter(|message| {
                    message["method"] == "session/thread/update"
                        && message["params"]["update"]["event"]["type"] == "hookRunUpdated"
                })
                .map(|message| {
                    message["params"]["update"]["event"]["run"]["status"]["type"]
                        .as_str()
                        .unwrap()
                })
                .collect::<Vec<_>>();
            assert_eq!(
                states,
                [
                    "running",
                    match expected {
                        HookRunStatus::Continued => "continued",
                        HookRunStatus::Denied { .. } => "denied",
                        HookRunStatus::Failed { .. } => "failed",
                        _ => unreachable!(),
                    }
                ],
                "{observed:?}"
            );
        }
        let identity = run.run_id.clone();
        drop(server);
        let restored = crate::open_app_server(
            crate::AppServerOptions::new(profile.path())
                .without_built_in_skills()
                .with_dir_root(directory.path()),
        )
        .unwrap();
        let restored_snapshot = restored.threads.read_thread(&thread.thread_id).unwrap();
        assert_eq!(restored_snapshot.hook_runs[0].run_id, identity);
        assert_eq!(restored_snapshot.hook_runs[0].status, run.status);
        assert!(
            restored
                .local_hook_runtime()
                .unwrap()
                .recent_runs()
                .is_empty()
        );
    }
}

use super::*;
use ash_core::RecordToolCallRequest;
use ash_core::StartTurnRequest;
use ash_protocol::ToolName;
use ash_protocol::TurnStatus;
use ash_protocol::UserInput;
use core_api::SequenceExpectation;
use core_api::StartThreadRequest;

#[test]
fn initial_directory_opens_before_recovered_tool_continuations_resume() {
    for user_config in [false, true] {
        let profile = tempfile::tempdir().unwrap();
        let directory = tempfile::tempdir().unwrap();
        let options = || {
            let options = AppServerOptions::new(profile.path())
                .with_codex_home(profile.path().join("codex"))
                .without_built_in_skills();
            if user_config {
                options.with_user_config_dir_root(directory.path())
            } else {
                options.with_dir_root(directory.path())
            }
        };
        let server = open_app_server(options()).unwrap();
        let thread = server
            .start_thread(StartThreadRequest {
                agent_id: None,
                agent: None,
                command_id: CommandId::new("recovery-thread").unwrap(),
                title: "Interrupted process".into(),
                branch_name: None,
                execution_target: None,
            })
            .unwrap();
        let turn = server
            .threads()
            .start_turn(
                &thread.thread_id,
                StartTurnRequest {
                    context_policy: Default::default(),
                    mode: Default::default(),
                    advisor: None,
                    kind: ash_protocol::TurnKind::Coding,
                    instructions: ash_prompts::AGENT_INSTRUCTIONS.freeze(),
                    command_id: CommandId::new("recovery-turn").unwrap(),
                    expected_sequence: SequenceExpectation::Any,
                    model: None,
                    reasoning_effort: None,
                    policy_revision: "test".into(),
                    approval_mode: ash_protocol::ApprovalMode::Manual,
                    tool_mode: ash_protocol::ToolMode::Direct,
                    tool_profile: None,
                    activated_skills: Vec::new(),
                    input: vec![UserInput::Text {
                        text: "wait".into(),
                    }],
                },
            )
            .unwrap();
        server
            .threads()
            .record_tool_call(
                &thread.thread_id,
                &turn.turn_id,
                RecordToolCallRequest {
                    tool_call_id: None,
                    name: ToolName::new("sleep").unwrap(),
                    arguments_json: r#"{"duration_ms":30000}"#.into(),
                    binding: None,
                },
            )
            .unwrap();
        assert!(
            server
                .threads()
                .read_thread(&thread.thread_id)
                .unwrap()
                .has_resumable_tool_continuation(&turn.turn_id)
        );
        // A real directory change must still reject live work. Only startup installs
        // services before resuming the recovered, not-yet-running continuation.
        assert_eq!(
            server
                .switch_local_dir_root(directory.path().to_path_buf())
                .unwrap_err()
                .to_string(),
            "a Turn is still active in the current Directory"
        );
        drop(server);

        let recovered = open_app_server(options()).expect("recovered work must not block startup");
        let mut connection = recovered.connection();
        let initialized = local_call(
            &recovered,
            &mut connection,
            serde_json::json!({
                "jsonrpc":"2.0", "id":1, "method":"initialize",
                "params":{"clientInfo":{"name":"recovery-test","version":"1"},"capabilities":{}}
            }),
        );
        assert!(initialized.get("result").is_some(), "{initialized}");
        let snapshot = recovered.threads().read_thread(&thread.thread_id).unwrap();
        assert_ne!(snapshot.turns[0].status, TurnStatus::Created);
        recovered.close_connection(connection);
    }
}

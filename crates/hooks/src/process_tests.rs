use super::*;
use ash_async_utils::CancellationSource;
use ash_config::HookEnablement;
use ash_config::HookId;
use ash_protocol::HookEvent;

#[test]
fn real_process_hooks_execute_inside_the_bound_directory() {
    let root = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(root.path()).unwrap();
    let hook = HookConfig {
        id: HookId::new("user:hook:process-test").unwrap(),
        event: HookEvent::Setup,
        matcher: Default::default(),
        enablement: HookEnablement::Enabled,
        claude_pre_tool_use: None,
        action: HookAction::Process {
            program: "/bin/sh".into(),
            args: vec![
                "-c".into(),
                "pwd > hook-cwd; /bin/sh -c 'printf %s \"$AI_AGENT\"' > hook-ai-agent".into(),
            ],
        },
    };
    let cancellation = CancellationSource::new();
    let output = LocalHookProcessExecutor::execute_process(
        dir.clone(),
        &hook,
        CommandExecutionAuthority::Unrestricted,
        Duration::from_secs(2),
        &cancellation.token(),
    )
    .unwrap();
    assert_eq!(output.exit_code, Some(0));
    assert_eq!(
        std::fs::read_to_string(root.path().join("hook-cwd"))
            .unwrap()
            .trim(),
        dir.canonical_path().to_str().unwrap()
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("hook-ai-agent")).unwrap(),
        "ash"
    );
    std::fs::remove_file(root.path().join("hook-cwd")).unwrap();
    std::fs::remove_file(root.path().join("hook-ai-agent")).unwrap();
    LocalHookProcessExecutor::new(dir.clone())
        .execute(
            &hook,
            Vec::new(),
            CommandExecutionAuthority::Unrestricted,
            &cancellation.token(),
            &mut core_api::HookRunEvidence {
                program: "/bin/sh".into(),
                arguments: Vec::new(),
                directory: root.path().into(),
                input: String::new(),
                stdout: String::new(),
                stderr: String::new(),
                exit_code: None,
                stdout_truncated: false,
                stderr_truncated: false,
            },
        )
        .unwrap();
    assert_eq!(
        std::fs::read_to_string(root.path().join("hook-ai-agent")).unwrap(),
        "ash"
    );
    assert_eq!(
        std::fs::read_to_string(root.path().join("hook-cwd"))
            .unwrap()
            .trim(),
        dir.canonical_path().to_str().unwrap()
    );
}

#[test]
fn claude_pre_tool_use_process_can_block_the_originating_tool() {
    let root = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(root.path()).unwrap();
    let hook = HookConfig {
        id: HookId::new("user:hook:claude-test").unwrap(),
        event: HookEvent::PreToolUse,
        matcher: Default::default(),
        enablement: HookEnablement::Enabled,
        claude_pre_tool_use: Some(ash_protocol::ClaudePreToolUseHook { timeout_seconds: 2 }),
        action: HookAction::Process {
            program: "/bin/sh".into(),
            args: vec![
                "-c".into(),
                r#"IFS= read -r payload || :; case "$payload" in *'"path":"blocked.txt"'*) printf '%s' 'File blocked' >&2; exit 2;; esac"#.into(),
            ],
        },
    };
    let request = core_api::BeforeToolHookRequest {
        session_id: ash_protocol::SessionId::new("session").unwrap(),
        thread_id: ash_protocol::ThreadId::new("thread").unwrap(),
        turn_id: ash_protocol::TurnId::new("turn").unwrap(),
        tool_call_id: ash_protocol::ToolCallId::new("tool").unwrap(),
        tool_name: "read_file".into(),
        tool_input: serde_json::json!({ "path": "blocked.txt" }),
    };
    let input = crate::protocol::encode_input(
        &hook,
        &crate::protocol::HookInvocation::BeforeTool(&request),
        dir.canonical_path(),
    )
    .unwrap();
    let mut evidence = core_api::HookRunEvidence {
        program: "/bin/sh".into(),
        arguments: Vec::new(),
        directory: root.path().into(),
        input: String::new(),
        stdout: String::new(),
        stderr: String::new(),
        exit_code: None,
        stdout_truncated: false,
        stderr_truncated: false,
    };
    let outcome = LocalHookProcessExecutor::new(dir)
        .execute(
            &hook,
            input,
            CommandExecutionAuthority::Unrestricted,
            &CancellationSource::new().token(),
            &mut evidence,
        )
        .unwrap();
    assert_eq!(
        outcome,
        HookDecision::Deny {
            reason: "File blocked".into()
        }
    );
    assert_eq!(evidence.exit_code, Some(2));
}

use super::*;
use ash_async_utils::CancellationSource;
use ash_config::HookEnablement;
use ash_config::HookId;
use ash_file_access::GrantSource;
use ash_file_access::PathAccessPolicy;
use ash_file_access::PathAccessRule;
use ash_file_access::Permissions;
use ash_protocol::HookEvent;
use ash_protocol::SessionId;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::PreparedCommand;
use ash_sandboxing::ResolvedFileSystem;
use ash_sandboxing::SandboxBackend;
use ash_sandboxing::SandboxCommand;
use ash_sandboxing::SandboxError;
use ash_sandboxing::SandboxKind;
use ash_sandboxing::SandboxPolicy;
use std::sync::Arc;
use std::sync::Mutex;

#[derive(Default)]
struct RecordingSandbox(Mutex<Vec<(SandboxPolicy, ResolvedFileSystem)>>);

impl SandboxBackend for RecordingSandbox {
    fn kind(&self) -> SandboxKind {
        SandboxKind::Restricted
    }

    fn prepare(
        &self,
        _: &SandboxCommand,
        _: SandboxPolicy,
        _: &Dir,
    ) -> Result<PreparedCommand, SandboxError> {
        unreachable!("a Session Hook must prepare a scoped command")
    }

    fn prepare_scoped(
        &self,
        _: &SandboxCommand,
        policy: SandboxPolicy,
        scope: &SandboxScope,
    ) -> Result<PreparedCommand, SandboxError> {
        let filesystem = scope.resolve_filesystem(policy.file_system())?;
        self.0.lock().unwrap().push((policy, filesystem));
        Err(SandboxError::UnsupportedPolicy(
            "test stops before spawn".into(),
        ))
    }
}

#[test]
fn session_hook_launch_obeys_file_permissions_even_with_unrestricted_action_approval() {
    let root = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(root.path()).unwrap();
    let path = dir.canonical_path().join("workspace-file");
    let hook = HookConfig {
        id: HookId::new("user:hook:scope-test").unwrap(),
        event: HookEvent::DirectoryAdded,
        matcher: Default::default(),
        enablement: HookEnablement::Enabled,
        claude_pre_tool_use: None,
        action: HookAction::Process {
            program: "test-hook".into(),
            args: Vec::new(),
        },
    };
    let cancellation = CancellationSource::new();

    for (files, read, write) in [
        (&[][..], false, false),
        (&[Permission::WriteFiles][..], false, false),
        (&[Permission::ReadFiles][..], true, false),
        (
            &[Permission::ReadFiles, Permission::WriteFiles][..],
            true,
            true,
        ),
    ] {
        let grant = Grant::for_session_tree(
            SessionId::new("hook-scope").unwrap(),
            dir.clone(),
            GrantSource::ExplicitUser,
            Permissions::new(
                [Permission::DiscoverHooks, Permission::ExecuteCommands]
                    .into_iter()
                    .chain(files.iter().copied()),
            ),
        );
        let mut process = LocalHookProcessExecutor::for_session_grant(&grant).unwrap();
        let backend = Arc::new(RecordingSandbox::default());
        process.executor = CommandExecutor::new(
            dir.clone(),
            SandboxBackends::new(vec![("test", backend.clone())]),
            AlwaysAuthorized,
            ExecutionLimits {
                timeout: HOOK_TIMEOUT,
                max_output_bytes: HOOK_OUTPUT_BYTES,
            },
        );
        let mut evidence = core_api::HookRunEvidence {
            program: "test-hook".into(),
            arguments: Vec::new(),
            directory: root.path().into(),
            input: String::new(),
            stdout: String::new(),
            stderr: String::new(),
            exit_code: None,
            stdout_truncated: false,
            stderr_truncated: false,
        };
        assert!(
            matches!(process.execute(&hook, Vec::new(), CommandExecutionAuthority::Unrestricted, &cancellation.token(), &mut evidence), Err(CoreError::Policy(message)) if message.contains("denied by the directory sandbox"))
        );
        let (policy, filesystem) = backend.0.lock().unwrap().pop().unwrap();
        assert_eq!(policy.network(), NetworkAccess::Denied);
        assert_eq!(
            policy.file_system(),
            if write {
                FileSystemAccess::DirectoryWrite
            } else {
                FileSystemAccess::ReadOnly
            }
        );
        assert_eq!(filesystem.allows_read(&path), read);
        assert_eq!(filesystem.allows_write(&path), write);

        grant.revoke();
        assert!(
            matches!(process.execute(&hook, Vec::new(), CommandExecutionAuthority::Unrestricted, &cancellation.token(), &mut evidence), Err(CoreError::Policy(message)) if message.contains("permission is required"))
        );
        assert!(backend.0.lock().unwrap().is_empty());
    }
}

#[test]
fn session_hook_scope_preserves_continuous_path_rules_and_host_visibility() {
    let root = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(root.path()).unwrap();
    let grant = Grant::for_session_tree(
        SessionId::new("hook-path-policy").unwrap(),
        dir,
        GrantSource::ExplicitUser,
        Permissions::new([
            Permission::ExecuteCommands,
            Permission::ReadFiles,
            Permission::WriteFiles,
        ]),
    )
    .with_path_policy(
        PathAccessPolicy::new(
            PathAccess::ReadWrite,
            vec![
                PathAccessRule {
                    pattern: "private/**".into(),
                    access: PathAccess::Denied,
                },
                PathAccessRule {
                    pattern: "reference/**".into(),
                    access: PathAccess::ReadOnly,
                },
            ],
        )
        .unwrap()
        .with_host_read(HostReadAccess::GrantedRoots),
    );
    let scope = session_sandbox_scope(&grant).unwrap();
    assert_eq!(scope.host_read(), HostReadScope::Minimal);
    assert_eq!(
        scope
            .path_rules()
            .iter()
            .map(|rule| (rule.continuous_pattern(), rule.access()))
            .collect::<Vec<_>>(),
        vec![
            (Some("private/**"), SandboxPathAccess::Denied),
            (Some("reference/**"), SandboxPathAccess::ReadOnly),
        ]
    );
    assert!(matches!(
        scope.resolve_filesystem(FileSystemAccess::DirectoryWrite),
        Err(SandboxError::UnsupportedPolicy(_))
    ));
}

#[cfg(unix)]
#[test]
#[ignore = "requires a working native process sandbox"]
fn native_session_hook_sandbox_respects_write_grant_changes() {
    let root = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(root.path()).unwrap();
    let marker = root.path().join("hook-marker");
    std::fs::write(root.path().join("workspace-file"), "data").unwrap();
    let hook = HookConfig {
        id: HookId::new("user:hook:native-scope-test").unwrap(),
        event: HookEvent::DirectoryAdded,
        matcher: Default::default(),
        enablement: HookEnablement::Enabled,
        claude_pre_tool_use: None,
        action: HookAction::Process {
            program: "/bin/sh".into(),
            args: vec![
                "-c".into(),
                r#"if test -r workspace-file; then printf readable >&2; fi; (printf verified > hook-marker); printf '{"decision":"continue"}'"#.into(),
            ],
        },
    };
    let session = SessionId::new("native-hook-scope").unwrap();
    let cancellation = CancellationSource::new();
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
    let mut access =
        ash_file_access::Access::new(ash_file_access::GrantSubject::SessionTree(session.clone()));
    let source = ash_file_access::DirSource::SessionRequest;
    let process_permissions = [Permission::DiscoverHooks, Permission::ExecuteCommands];
    let readonly = Permissions::new(
        process_permissions
            .into_iter()
            .chain([Permission::ReadFiles]),
    );
    access
        .add(
            Grant::for_session_tree(
                session,
                dir.clone(),
                GrantSource::ExplicitUser,
                Permissions::new(process_permissions),
            ),
            source,
        )
        .unwrap();
    let run = |process: &LocalHookProcessExecutor, evidence: &mut core_api::HookRunEvidence| {
        process.execute(
            &hook,
            Vec::new(),
            CommandExecutionAuthority::Unrestricted,
            &cancellation.token(),
            evidence,
        )
    };

    let no_files_hook =
        LocalHookProcessExecutor::for_session_grant(access.grant(&dir, source).unwrap()).unwrap();
    assert_eq!(
        run(&no_files_hook, &mut evidence).unwrap(),
        HookDecision::Continue
    );
    assert!(!evidence.stderr.contains("readable"));
    assert!(!marker.exists());

    access
        .set_permissions(&dir, source, 1, readonly.clone())
        .unwrap();
    let read_only_hook =
        LocalHookProcessExecutor::for_session_grant(access.grant(&dir, source).unwrap()).unwrap();
    assert_eq!(
        run(&read_only_hook, &mut evidence).unwrap(),
        HookDecision::Continue
    );
    assert!(evidence.stderr.contains("readable"));
    assert!(!marker.exists());

    access
        .set_permissions(
            &dir,
            source,
            2,
            Permissions::new(readonly.entries().chain([Permission::WriteFiles])),
        )
        .unwrap();
    let read_write_hook =
        LocalHookProcessExecutor::for_session_grant(access.grant(&dir, source).unwrap()).unwrap();
    assert_eq!(
        run(&read_write_hook, &mut evidence).unwrap(),
        HookDecision::Continue
    );
    assert_eq!(std::fs::read_to_string(&marker).unwrap(), "verified");
    std::fs::remove_file(&marker).unwrap();

    access.set_permissions(&dir, source, 3, readonly).unwrap();
    assert!(matches!(
        run(&read_write_hook, &mut evidence),
        Err(CoreError::Policy(_))
    ));
    assert!(!marker.exists());
}

#[cfg(unix)]
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

#[cfg(unix)]
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

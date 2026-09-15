#![cfg(unix)]

use super::*;
use ash_action_policy::GrantId;
use ash_async_utils::CancellationSource;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use ash_protocol::SessionId;
use ash_protocol::ToolCallId;
use ash_protocol::ToolName;
use ash_sandboxing::PreparedCommand;
use ash_sandboxing::SandboxCommand;
use ash_sandboxing::SandboxError;
use ash_sandboxing::SandboxKind;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

struct PassThroughBackend;

struct DeniedPathBackend {
    prepared: Arc<AtomicUsize>,
}

impl SandboxBackend for DeniedPathBackend {
    fn kind(&self) -> SandboxKind {
        SandboxKind::Restricted
    }

    fn prepare(
        &self,
        _: &SandboxCommand,
        _: SandboxPolicy,
        _: &Dir,
    ) -> Result<PreparedCommand, SandboxError> {
        panic!("approved commands with an existing denied path must keep their scope");
    }

    fn prepare_scoped(
        &self,
        _: &SandboxCommand,
        policy: SandboxPolicy,
        scope: &SandboxScope,
    ) -> Result<PreparedCommand, SandboxError> {
        assert_eq!(policy.file_system(), FileSystemAccess::FullAccess);
        assert_eq!(policy.network(), NetworkAccess::Allowed);
        let filesystem = scope.resolve_filesystem(policy.file_system()).unwrap();
        assert!(
            filesystem
                .denied_paths()
                .iter()
                .any(|path| path.ends_with(".env"))
        );
        self.prepared.fetch_add(1, Ordering::SeqCst);
        Err(SandboxError::UnsupportedPolicy("denied-path probe".into()))
    }
}

#[test]
fn approved_shell_keeps_an_existing_env_denial() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let scope = local_sandbox_scope(&dir).unwrap();
    let approval = ToolAuthorization::UnsandboxedGrant {
        grant_id: GrantId::new("approved-shell"),
    };

    assert_eq!(
        local_command_authority(&approval, shell_sandbox(), Some(&scope)).unwrap(),
        CommandExecutionAuthority::Unrestricted
    );

    let managed = SandboxPolicy::new(FileSystemAccess::DirectoryWrite, NetworkAccess::Managed)
        .with_host_acl_changes(local_acl_changes())
        .with_file_system_isolation(local_isolation());
    let CommandExecutionAuthority::Sandboxed(managed_policy) =
        local_command_authority(&approval, managed, Some(&scope)).unwrap()
    else {
        panic!("managed network policy must remain enforced after approval");
    };
    assert_eq!(managed_policy.network(), NetworkAccess::Managed);

    fs::write(temp.path().join(".env"), "secret").unwrap();
    let authority = local_command_authority(&approval, shell_sandbox(), Some(&scope)).unwrap();
    let CommandExecutionAuthority::Sandboxed(policy) = authority else {
        panic!("an existing denied file must keep the approved command sandboxed");
    };
    assert_eq!(policy.file_system(), FileSystemAccess::FullAccess);
    assert_eq!(policy.network(), NetworkAccess::Allowed);
    assert_eq!(
        policy.file_system_isolation(),
        shell_sandbox().file_system_isolation()
    );
}

#[test]
fn approved_shell_reaches_the_restricted_backend_with_an_env_denial() {
    let dir = TestDir::new();
    fs::write(dir.path().join(".env"), "secret").unwrap();
    let prepared = Arc::new(AtomicUsize::new(0));
    let service = LocalShellToolService::new(
        dir.authorization(),
        RipgrepExecutable::from_path(dir.ripgrep()).unwrap(),
        DeniedPathBackend {
            prepared: Arc::clone(&prepared),
        },
    )
    .unwrap();
    let call = tool_call(json!({
        "program": "/bin/cat",
        "arguments": [".env"],
        "working_directory": "."
    }));
    let approval = ToolAuthorization::UnsandboxedGrant {
        grant_id: GrantId::new("approved-shell"),
    };

    let result = service
        .execute(&call, &approval, &CancellationSource::new().token())
        .unwrap();
    assert!(matches!(result, ToolExecutionOutput::SandboxDenied(_)));
    assert_eq!(prepared.load(Ordering::SeqCst), 1);
}

impl SandboxBackend for PassThroughBackend {
    fn kind(&self) -> SandboxKind {
        SandboxKind::Unrestricted
    }

    fn prepare(
        &self,
        command: &SandboxCommand,
        policy: SandboxPolicy,
        _: &Dir,
    ) -> Result<PreparedCommand, SandboxError> {
        assert!(policy == read_only_sandbox() || policy == shell_sandbox());
        Ok(PreparedCommand::unrestricted(command))
    }
    fn prepare_scoped(
        &self,
        command: &SandboxCommand,
        policy: SandboxPolicy,
        scope: &ash_sandboxing::SandboxScope,
    ) -> Result<PreparedCommand, SandboxError> {
        self.prepare(command, policy, scope.command_dir())
    }
}

#[test]
fn local_registry_exposes_shell_command_and_preserves_read_only_ripgrep() {
    let dir = TestDir::new();
    let service = LocalShellToolService::new(
        dir.authorization(),
        RipgrepExecutable::from_path(dir.ripgrep()).unwrap(),
        PassThroughBackend,
    )
    .unwrap();
    let definition = &service.definitions()[0];
    assert_eq!(definition.name.as_str(), "shell-command");
    assert_eq!(
        definition.parameters["properties"]["program"]["type"],
        "string"
    );

    let call = tool_call(json!({
        "program": "rg",
        "arguments": ["needle", "."],
        "working_directory": "."
    }));
    let review = service.prepare(&call).unwrap();
    let policy = LocalShellPolicy::default();
    assert_eq!(
        policy
            .decide(&review, &CancellationSource::new().token())
            .unwrap(),
        ExecutionDecision::RunSandboxed(read_only_sandbox())
    );
    let output = service
        .execute(
            &call,
            &ToolAuthorization::Sandboxed(read_only_sandbox()),
            &CancellationSource::new().token(),
        )
        .unwrap();
    let ToolExecutionOutput::Success(output) = output else {
        panic!("fake ripgrep should complete: {output:?}");
    };
    assert!(output.contains("--no-config needle ."));
}

#[test]
fn local_registry_accepts_shell_processes_but_rejects_ripgrep_dir_escape_arguments() {
    let dir = TestDir::new();
    let service = LocalShellToolService::new(
        dir.authorization(),
        RipgrepExecutable::from_path(dir.ripgrep()).unwrap(),
        PassThroughBackend,
    )
    .unwrap();

    let shell = tool_call(json!({
        "program": "/bin/sh",
        "arguments": ["-lc", "printf hello"],
        "working_directory": "."
    }));
    let review = service.prepare(&shell).unwrap();
    assert_eq!(
        LocalShellPolicy::default()
            .decide(&review, &CancellationSource::new().token())
            .unwrap(),
        ExecutionDecision::RunSandboxed(shell_sandbox())
    );

    assert!(
        service
            .prepare(&tool_call(json!({
                "program": "rg",
                "arguments": ["--pre", "decoder", "needle"],
                "working_directory": "."
            })))
            .is_err()
    );
    assert!(
        service
            .prepare(&tool_call(json!({
                "program": "rg",
                "arguments": ["needle", "../outside"],
                "working_directory": "."
            })))
            .is_err()
    );
    std::os::unix::fs::symlink("/etc", dir.path().join("outside-link")).unwrap();
    assert!(
        service
            .prepare(&tool_call(json!({
                "program": "rg",
                "arguments": ["needle", "outside-link/passwd"],
                "working_directory": "."
            })))
            .is_err()
    );
}

#[test]
fn shell_executor_runs_in_a_session_dir() {
    let cwd_dir = TestDir::new();
    let session_dir = TestDir::new();
    let access = Arc::new(crate::dir_grants::DirGrants::default());
    let session_id = SessionId::new("shell-session-dir").unwrap();
    access
        .add_dir(
            session_id.clone(),
            Grant::for_session_tree(
                session_id.clone(),
                session_dir.root(),
                GrantSource::ExplicitUser,
                Permissions::new([Permission::ReadFiles, Permission::ExecuteCommands]),
            ),
        )
        .unwrap();
    let reviewer = LocalExecutorReviewer {
        shell_policy: shell_sandbox(),
        authorization: cwd_dir.authorization(),
        ripgrep: RipgrepExecutable::from_path(cwd_dir.ripgrep()).unwrap(),
        action_policy_revision: local_policy_revision(),
        dir_grants: Arc::clone(&access),
    };
    let call = tool_call(json!({
        "program": "/bin/sh",
        "arguments": ["-lc", "pwd"],
        "working_directory": session_dir.path(),
    }));
    let (_, request, authorizations) = reviewer
        .prepare_shell(&call, Some(&session_id), None)
        .unwrap();
    let authorization = authorizations[0].clone();
    assert_eq!(
        authorizations[0].dir().canonical_path(),
        session_dir.root().canonical_path()
    );
    reviewer
        .prepare_shell(
            &tool_call(json!({
                "program": "rg",
                "arguments": ["needle", "."],
                "working_directory": session_dir.path(),
            })),
            Some(&session_id),
            None,
        )
        .expect("ripgrep should use the selected directory boundary");

    let executor = ShellCommandTool::new(
        ash_tools::EnvId::new("session-dir-shell").unwrap(),
        cwd_dir.root(),
        PassThroughBackend,
        CoreAuthorized,
        ShellCommandLimits {
            timeout: DEFAULT_TIMEOUT,
            max_output_bytes: DEFAULT_OUTPUT_BYTES,
        },
    )
    .unwrap();
    let outcome = executor
        .execute_authorized(
            request,
            CommandExecutionAuthority::Sandboxed(shell_sandbox()),
            &CancellationSource::new().token(),
        )
        .unwrap();
    let CommandExecutionOutcome::Completed(output) = outcome else {
        panic!("session-dir shell command should complete: {outcome:?}");
    };
    assert_eq!(
        PathBuf::from(output.stdout.trim()).canonicalize().unwrap(),
        session_dir.root().canonical_path()
    );

    access
        .set_permissions(
            &session_id,
            session_dir.path(),
            1,
            Permissions::new([Permission::ReadFiles]),
        )
        .unwrap();
    assert!(authorization.ensure_active().is_err());
}

#[test]
fn durable_user_and_dir_exec_rules_drive_local_authorization() {
    let dir = TestDir::new();
    let user_rule = ExecPolicyRule::new(
        ExecPolicyRuleId::new("user-safe-shell"),
        ExecPolicySelector::all([
            ExecPolicySelector::source(Some("built_in_tool".into()), Some("shell-command".into())),
            ExecPolicySelector::command_prefix([
                ash_execpolicy::ExecPolicyToken::literal("/bin/sh"),
                ash_execpolicy::ExecPolicyToken::literal("-lc"),
                ash_execpolicy::ExecPolicyToken::literal("printf safe"),
            ]),
        ]),
        ExecPolicyEffect::AllowUnsandboxed,
    );
    let policy_config = LocalToolConfig {
        user: UserExecPolicyConfig {
            rules: vec![user_rule],
        },
        dir_config: None,
        agent_grep_backend: ash_config::AgentGrepBackend::Ripgrep,
    };
    let exec_policy = policy_config.snapshot().unwrap();
    let action_policy_revision = ActionPolicyRevision::from_components(
        exec_policy.revision(),
        LOCAL_GRANT_SNAPSHOT_REVISION,
        LOCAL_REVIEWER_POLICY_REVISION,
    );
    let service = LocalShellToolService::new_with_action_policy_revision(
        dir.authorization(),
        RipgrepExecutable::from_path(dir.ripgrep()).unwrap(),
        PassThroughBackend,
        action_policy_revision.clone(),
        shell_sandbox(),
    )
    .unwrap();
    let call = tool_call(json!({
        "program": "/bin/sh",
        "arguments": ["-lc", "printf safe"],
        "working_directory": "."
    }));
    let review = service.prepare(&call).unwrap();
    let decision = LocalShellPolicy {
        exec_policy,
        action_policy_revision,
    }
    .decide(&review, &CancellationSource::new().token())
    .unwrap();
    assert!(matches!(
        decision,
        ExecutionDecision::RunExecPolicyGranted(grant)
            if grant.source().rule_id().as_str() == "user-safe-shell"
    ));

    let restrictive_config = LocalToolConfig {
        user: policy_config.user,
        dir_config: Some((
            dir.root().id(),
            DirExecPolicyConfig {
                rules: vec![ExecPolicyRule::new(
                    ExecPolicyRuleId::new("dir-block-shell"),
                    ExecPolicySelector::source(
                        Some("built_in_tool".into()),
                        Some("shell-command".into()),
                    ),
                    ExecPolicyEffect::Deny("repository policy blocks shell".into()),
                )],
            },
        )),
        agent_grep_backend: ash_config::AgentGrepBackend::Ripgrep,
    };
    let exec_policy = restrictive_config.snapshot().unwrap();
    let action_policy_revision = ActionPolicyRevision::from_components(
        exec_policy.revision(),
        LOCAL_GRANT_SNAPSHOT_REVISION,
        LOCAL_REVIEWER_POLICY_REVISION,
    );
    let restrictive_service = LocalShellToolService::new_with_action_policy_revision(
        dir.authorization(),
        RipgrepExecutable::from_path(dir.ripgrep()).unwrap(),
        PassThroughBackend,
        action_policy_revision.clone(),
        shell_sandbox(),
    )
    .unwrap();
    let restrictive_review = restrictive_service.prepare(&call).unwrap();
    let decision = LocalShellPolicy {
        exec_policy,
        action_policy_revision,
    }
    .decide(&restrictive_review, &CancellationSource::new().token())
    .unwrap();
    assert!(matches!(
        decision,
        ExecutionDecision::Block(ash_action_policy::BlockReason::DeterministicRule {
            reason,
            ..
        }) if reason.contains("repository policy")
    ));
}

#[test]
fn local_policy_runs_agent_coordination_without_an_external_approval() {
    for tool_name in [
        crate::server::update_plan_tool::UPDATE_PLAN_TOOL_NAME,
        agent::SPAWN_AGENT_TOOL_NAME,
        agent::SEND_AGENT_MESSAGE_TOOL_NAME,
        agent::WAIT_AGENT_TOOL_NAME,
    ] {
        let request = ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(tool_name.as_bytes()),
                ActionKind::SystemOperation,
                "coordinate child Agent",
                CapabilitySet::new([]),
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, tool_name),
            SandboxCompatibility::NotApplicable {
                reason: "durable Session/Thread mutation".into(),
            },
            local_policy_revision(),
        );

        assert!(matches!(
            LocalShellPolicy::default()
                .decide(&request, &CancellationSource::new().token())
                .unwrap(),
            ExecutionDecision::RunExecPolicyGranted(_)
        ));
    }
}

#[test]
fn apply_patch_reviewer_materializes_paths_before_policy() {
    let dir = TestDir::new();
    let reviewer = LocalExecutorReviewer {
        shell_policy: shell_sandbox(),
        authorization: dir.authorization(),
        ripgrep: RipgrepExecutable::from_path(dir.ripgrep()).unwrap(),
        action_policy_revision: local_policy_revision(),
        dir_grants: Arc::new(crate::dir_grants::DirGrants::default()),
    };
    let patch = ToolCall {
        id: ToolCallId::new("apply-patch").unwrap(),
        name: ToolName::new("apply_patch").unwrap(),
        arguments: json!({
            "patch": "*** Begin Patch\n*** Add File: added.txt\n+hello\n*** End Patch"
        }),
    };
    let (review, _, _) = reviewer.prepare_apply_patch(&patch, None, None).unwrap();
    assert!(matches!(
        LocalShellPolicy::default()
            .decide(&review, &CancellationSource::new().token())
            .unwrap(),
        ExecutionDecision::AskUser(_)
    ));

    let escaping = ToolCall {
        id: ToolCallId::new("escaping-patch").unwrap(),
        name: ToolName::new("apply_patch").unwrap(),
        arguments: json!({
            "patch": "*** Begin Patch\n*** Add File: ../outside.txt\n+bad\n*** End Patch"
        }),
    };
    assert!(reviewer.prepare_apply_patch(&escaping, None, None).is_err());
}

#[test]
fn apply_patch_reviewer_selects_the_session_dir() {
    let cwd_dir = TestDir::new();
    let session_dir = TestDir::new();
    let access = Arc::new(crate::dir_grants::DirGrants::default());
    let session_id = SessionId::new("apply-patch-session-dir").unwrap();
    access
        .add_dir(
            session_id.clone(),
            Grant::for_session_tree(
                session_id.clone(),
                session_dir.root(),
                GrantSource::ExplicitUser,
                Permissions::new([
                    Permission::ReadFiles,
                    Permission::WriteFiles,
                    Permission::MutateRepository,
                ]),
            ),
        )
        .unwrap();
    let reviewer = LocalExecutorReviewer {
        shell_policy: shell_sandbox(),
        authorization: cwd_dir.authorization(),
        ripgrep: RipgrepExecutable::from_path(cwd_dir.ripgrep()).unwrap(),
        action_policy_revision: local_policy_revision(),
        dir_grants: access,
    };
    let absolute = session_dir.path().join("added.txt");
    let call = ToolCall {
        id: ToolCallId::new("apply-patch-session-dir").unwrap(),
        name: ToolName::new("apply_patch").unwrap(),
        arguments: json!({
            "patch": format!(
                "*** Begin Patch\n*** Add File: {}\n+hello\n*** End Patch",
                absolute.display()
            )
        }),
    };

    let (_, rewritten, dir) = reviewer
        .prepare_apply_patch(&call, Some(&session_id), None)
        .unwrap();

    assert_eq!(dir.dir(), &session_dir.root());
    assert!(rewritten.contains("*** Add File: added.txt"));
    assert!(!rewritten.contains(&absolute.display().to_string()));
}

#[test]
fn local_tool_port_exposes_one_canonical_coding_tool_surface() {
    let dir = TestDir::new();
    let authorization = dir.authorization();
    let ripgrep = RipgrepExecutable::from_path(dir.ripgrep()).unwrap();
    let environment_id = ash_tools::EnvId::new("local-dir").unwrap();
    let reviewer: Arc<dyn ToolExecutorReviewer> = Arc::new(LocalExecutorReviewer {
        shell_policy: shell_sandbox(),
        authorization: authorization.clone(),
        ripgrep: ripgrep.clone(),
        action_policy_revision: local_policy_revision(),
        dir_grants: Arc::new(crate::dir_grants::DirGrants::default()),
    });
    let shell =
        LocalShellToolService::new(authorization.clone(), ripgrep.clone(), PassThroughBackend)
            .unwrap();
    let agent_grep = Arc::new(
        AgentGrepService::new(ash_config::AgentGrepBackend::Tgrep, ripgrep.clone(), None).unwrap(),
    );
    let composition = LocalToolComposition {
        tools: Arc::new(LocalToolSuite::new(
            shell,
            ripgrep.clone(),
            Arc::clone(&agent_grep),
            Arc::new(crate::dir_grants::DirGrants::default()),
            dir.grant(),
        )),
        policy: Arc::new(LocalShellPolicy::default()),
        ripgrep,
        agent_grep,
        action_policy_revision: local_policy_revision(),
        executors: vec![
            LocalExecutorContribution {
                executor: Arc::new(
                    ShellCommandTool::new(
                        environment_id.clone(),
                        authorization.dir().clone(),
                        PassThroughBackend,
                        CoreAuthorized,
                        ShellCommandLimits {
                            timeout: DEFAULT_TIMEOUT,
                            max_output_bytes: DEFAULT_OUTPUT_BYTES,
                        },
                    )
                    .unwrap(),
                ),
                environment_id: environment_id.clone(),
                reviewer: Arc::clone(&reviewer),
            },
            LocalExecutorContribution {
                executor: Arc::new(
                    ApplyPatchTool::new(
                        environment_id.clone(),
                        authorization.dir().clone(),
                        ApplyPatchLimits::default(),
                    )
                    .unwrap(),
                ),
                environment_id,
                reviewer,
            },
        ],
    };
    let combined =
        crate::tool_composition::combine_tool_ports(vec![composition.tool_port().unwrap()])
            .unwrap()
            .unwrap();

    let visible = combined
        .tools
        .model_definitions(&std::collections::BTreeSet::new())
        .unwrap()
        .into_iter()
        .map(|definition| definition.name.to_string())
        .collect::<Vec<_>>();

    assert_eq!(
        visible,
        vec![
            "apply_patch",
            "edit",
            "glob",
            "grep",
            "read_file",
            "shell-command",
            "shell-session",
            "write_file"
        ]
    );
}

#[test]
fn agent_edit_refreshes_an_existing_tgrep_generation_before_returning() {
    let dir = TestDir::new();
    fs::create_dir_all(dir.path().join("src")).unwrap();
    let path = dir.path().join("src/current.rs");
    fs::write(&path, "before_immediate_marker\n").unwrap();
    let ripgrep = RipgrepExecutable::from_path(dir.ripgrep()).unwrap();
    let shell =
        LocalShellToolService::new(dir.authorization(), ripgrep.clone(), PassThroughBackend)
            .unwrap();
    let agent_grep = Arc::new(
        AgentGrepService::new(ash_config::AgentGrepBackend::Tgrep, ripgrep.clone(), None).unwrap(),
    );
    let suite = LocalToolSuite::new(
        shell,
        ripgrep,
        agent_grep,
        Arc::new(crate::dir_grants::DirGrants::default()),
        dir.grant(),
    );
    let authorization = ToolAuthorization::Sandboxed(read_only_sandbox());
    let cancellation = CancellationSource::new().token();
    let grep = |pattern: &str| ToolCall {
        id: ToolCallId::new(format!("grep-{pattern}")).unwrap(),
        name: ToolName::new("grep").unwrap(),
        arguments: json!({
            "pattern": pattern,
            "path": null,
            "glob": null,
            "case_insensitive": false,
        }),
    };
    assert!(matches!(
        suite
            .execute(&grep("before_immediate_marker"), &authorization, &cancellation)
            .unwrap(),
        ToolExecutionOutput::Success(text) if text.contains("before_immediate_marker")
    ));
    suite
        .execute(
            &ToolCall {
                id: ToolCallId::new("read-before-edit").unwrap(),
                name: ToolName::new("read_file").unwrap(),
                arguments: json!({"path": path, "offset": null, "limit": null}),
            },
            &authorization,
            &cancellation,
        )
        .unwrap();

    suite
        .execute(
            &ToolCall {
                id: ToolCallId::new("edit-immediate").unwrap(),
                name: ToolName::new("edit").unwrap(),
                arguments: json!({
                    "path": path,
                    "old_string": "before_immediate_marker",
                    "new_string": "after_immediate_marker",
                    "replace_all": false,
                }),
            },
            &authorization,
            &cancellation,
        )
        .unwrap();

    assert!(matches!(
        suite
            .execute(&grep("after_immediate_marker"), &authorization, &cancellation)
            .unwrap(),
        ToolExecutionOutput::Success(text) if text.contains("after_immediate_marker")
    ));
}

#[test]
fn local_suite_reads_and_edits_with_spec_errors() {
    let dir = TestDir::new();
    let ripgrep = RipgrepExecutable::from_path(dir.ripgrep()).unwrap();
    let shell =
        LocalShellToolService::new(dir.authorization(), ripgrep.clone(), PassThroughBackend)
            .unwrap();
    let agent_grep = Arc::new(
        AgentGrepService::new(ash_config::AgentGrepBackend::Ripgrep, ripgrep.clone(), None)
            .unwrap(),
    );
    let suite = LocalToolSuite::new(
        shell,
        ripgrep,
        agent_grep,
        Arc::new(crate::dir_grants::DirGrants::default()),
        dir.grant(),
    );
    let path = dir.path().join("src/main.rs");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "fn main() {\n    println!(\"old\");\n}\n").unwrap();
    let cancellation = CancellationSource::new().token();
    let authorization = ToolAuthorization::Sandboxed(read_only_sandbox());

    let unread_edit = suite
        .execute(
            &ToolCall {
                id: ToolCallId::new("edit-unread").unwrap(),
                name: ToolName::new("edit").unwrap(),
                arguments: json!({
                    "path": path.clone(),
                    "old_string": "old",
                    "new_string": "new",
                    "replace_all": false
                }),
            },
            &authorization,
            &cancellation,
        )
        .unwrap();
    assert!(
        matches!(unread_edit, ToolExecutionOutput::Failure(message) if message.contains("has not been read"))
    );

    let read = suite
        .execute(
            &ToolCall {
                id: ToolCallId::new("read").unwrap(),
                name: ToolName::new("read_file").unwrap(),
                arguments: json!({"path": path.clone(), "offset": null, "limit": null}),
            },
            &authorization,
            &cancellation,
        )
        .unwrap();
    assert!(matches!(read, ToolExecutionOutput::Success(text) if text.contains("println")));

    let edit = suite
        .execute(
            &ToolCall {
                id: ToolCallId::new("edit").unwrap(),
                name: ToolName::new("edit").unwrap(),
                arguments: json!({
                    "path": path.clone(),
                    "old_string": "old",
                    "new_string": "new",
                    "replace_all": false
                }),
            },
            &authorization,
            &cancellation,
        )
        .unwrap();
    assert!(matches!(edit, ToolExecutionOutput::Success(text) if text.contains("new")));
    assert!(fs::read_to_string(&path).unwrap().contains("new"));

    fs::write(&path, "fn main() { println!(\"external\"); }\n").unwrap();
    let stale_edit = suite
        .execute(
            &ToolCall {
                id: ToolCallId::new("stale-edit").unwrap(),
                name: ToolName::new("edit").unwrap(),
                arguments: json!({
                    "path": path.clone(),
                    "old_string": "external",
                    "new_string": "overwritten",
                    "replace_all": false
                }),
            },
            &authorization,
            &cancellation,
        )
        .unwrap();
    assert!(
        matches!(stale_edit, ToolExecutionOutput::Failure(message) if message.contains("changed on disk"))
    );
    assert!(fs::read_to_string(path).unwrap().contains("external"));
}

fn tool_call(arguments: serde_json::Value) -> ToolCall {
    ToolCall {
        id: ToolCallId::new("call-1").unwrap(),
        name: ToolName::new("shell-command").unwrap(),
        arguments,
    }
}

static NEXT_DIR: AtomicUsize = AtomicUsize::new(0);

struct TestDir {
    path: PathBuf,
}

impl TestDir {
    fn new() -> Self {
        let sequence = NEXT_DIR.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "ash-local-tools-tests-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn root(&self) -> Dir {
        Dir::open_local(&self.path).unwrap()
    }

    fn grant(&self) -> Grant {
        Grant::for_environment(
            self.root(),
            GrantSource::HostConfiguration,
            Permissions::new([
                Permission::ExecuteCommands,
                Permission::ReadFiles,
                Permission::WriteFiles,
                Permission::InspectRepository,
                Permission::MutateRepository,
            ]),
        )
    }

    fn authorization(&self) -> Authorization {
        self.grant().authorize(Permission::ExecuteCommands).unwrap()
    }

    fn ripgrep(&self) -> PathBuf {
        let path = self.path.join("rg");
        fs::write(&path, "#!/bin/sh\nprintf '%s' \"$*\"\n").unwrap();
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&path).unwrap().permissions();
        permissions.set_mode(0o755);
        fs::set_permissions(&path, permissions).unwrap();
        path
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(self.path());
    }
}

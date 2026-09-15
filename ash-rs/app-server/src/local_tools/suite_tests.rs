use super::*;
use crate::local_tools::LocalShellToolService;
use ash_action_policy::ActionPolicyRevision;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use ash_protocol::ToolCallId;
use ash_protocol::ToolName;
use ash_sandboxing::PreparedCommand;
use ash_sandboxing::SandboxBackend;
use ash_sandboxing::SandboxCommand;
use ash_sandboxing::SandboxError;
use ash_sandboxing::SandboxKind;
use ash_sandboxing::SandboxPolicy;

struct PassThroughBackend;

impl SandboxBackend for PassThroughBackend {
    fn kind(&self) -> SandboxKind {
        SandboxKind::Unrestricted
    }

    fn prepare(
        &self,
        command: &SandboxCommand,
        _: SandboxPolicy,
        _: &Dir,
    ) -> Result<PreparedCommand, SandboxError> {
        Ok(PreparedCommand::unrestricted(command))
    }

    fn prepare_scoped(
        &self,
        command: &SandboxCommand,
        _: SandboxPolicy,
        _: &ash_sandboxing::SandboxScope,
    ) -> Result<PreparedCommand, SandboxError> {
        Ok(PreparedCommand::unrestricted(command))
    }
}

#[test]
fn dir_resolution_is_bound_to_the_exact_session_and_grant() {
    let cwd_dir = tempfile::tempdir().unwrap();
    let session_dir = tempfile::tempdir().unwrap();
    let session_file = session_dir.path().join("extra.txt");
    std::fs::write(&session_file, "extra").unwrap();
    let cwd_grant = authorization(cwd_dir.path());
    let session_grant = authorization(session_dir.path());
    let dir = session_grant.dir().clone();
    let cwd_authorization = cwd_grant.authorize(Permission::ExecuteCommands).unwrap();
    let access = Arc::new(crate::dir_grants::DirGrants::default());
    let session_id = SessionId::new("session-with-extra").unwrap();
    access
        .add_dir(
            session_id.clone(),
            Grant::for_session_tree(
                session_id.clone(),
                session_grant.dir().clone(),
                session_grant.source(),
                session_grant.permissions().clone(),
            ),
        )
        .unwrap();
    let ripgrep = RipgrepExecutable::from_path(std::env::current_exe().unwrap()).unwrap();
    let shell = LocalShellToolService::new_with_action_policy_revision(
        cwd_authorization,
        ripgrep.clone(),
        PassThroughBackend,
        ActionPolicyRevision::new("test-policy-v1"),
        super::super::shell_sandbox(),
    )
    .unwrap();
    let agent_grep = Arc::new(
        AgentGrepService::new(ash_config::AgentGrepBackend::Ripgrep, ripgrep.clone(), None)
            .unwrap(),
    );
    let suite = LocalToolSuite::new(shell, ripgrep, agent_grep, Arc::clone(&access), cwd_grant);

    let resolved = suite
        .resolve(
            &session_file.display().to_string(),
            true,
            Some(&session_id),
            None,
            Permission::InspectRepository,
        )
        .unwrap();
    assert_eq!(
        resolved.absolute,
        dunce::canonicalize(&session_file).unwrap()
    );
    let read = suite
        .read_file(
            &tool_call(
                "read_file",
                serde_json::json!({
                    "path": session_file.display().to_string(),
                    "offset": null,
                    "limit": null,
                }),
            ),
            "thread",
            Some(&session_id),
            None,
        )
        .unwrap();
    assert!(matches!(read, ToolExecutionOutput::Success(text) if text.contains("extra")));
    let created = session_dir.path().join("created.txt");
    let write = suite
        .write_file(
            &tool_call(
                "write_file",
                serde_json::json!({
                    "path": created.display().to_string(),
                    "content": "created"
                }),
            ),
            "thread",
            Some(&session_id),
            None,
        )
        .unwrap();
    assert!(matches!(write, ToolExecutionOutput::Success(_)));
    assert_eq!(std::fs::read_to_string(created).unwrap(), "created");
    let denied = session_dir.path().join(".env");
    std::fs::write(&denied, "secret").unwrap();
    for permission in [Permission::InspectRepository, Permission::MutateRepository] {
        let Err(error) = suite.resolve(
            &denied.display().to_string(),
            true,
            Some(&session_id),
            None,
            permission,
        ) else {
            panic!("denied path unexpectedly resolved")
        };
        assert!(error.contains("denied by the local filesystem policy"));
    }
    let alias = session_dir.path().join("alias");
    std::fs::hard_link(&denied, &alias).unwrap();
    let Err(error) = suite.resolve(
        &alias.display().to_string(),
        true,
        Some(&session_id),
        None,
        Permission::InspectRepository,
    ) else {
        panic!("hard-link alias unexpectedly resolved")
    };
    assert!(error.contains("hard links"));
    std::fs::remove_file(alias).unwrap();
    assert!(
        suite
            .resolve(
                &session_file.display().to_string(),
                true,
                Some(&SessionId::new("other-session").unwrap()),
                None,
                Permission::InspectRepository,
            )
            .is_err()
    );

    assert_eq!(
        access.remove_dir(&session_id, dir.canonical_path()),
        ash_file_access::Mutation::RemovedDir
    );
    assert!(
        suite
            .resolve(
                &session_file.display().to_string(),
                true,
                Some(&session_id),
                None,
                Permission::InspectRepository,
            )
            .is_err()
    );
}

#[test]
fn shell_session_tool_returns_early_then_drives_the_same_process() {
    let cwd_dir = tempfile::tempdir().unwrap();
    let grant = authorization(cwd_dir.path());
    let shell_authorization = grant.authorize(Permission::ExecuteCommands).unwrap();
    let access = Arc::new(crate::dir_grants::DirGrants::default());
    let session_id = SessionId::new("session-command").unwrap();
    let thread_id = ThreadId::new("thread-command").unwrap();
    access
        .add_dir(
            session_id.clone(),
            Grant::for_session_tree(
                session_id.clone(),
                grant.dir().clone(),
                grant.source(),
                grant.permissions().clone(),
            ),
        )
        .unwrap();
    let ripgrep = RipgrepExecutable::from_path(std::env::current_exe().unwrap()).unwrap();
    let shell = LocalShellToolService::new_with_action_policy_revision(
        shell_authorization,
        ripgrep.clone(),
        PassThroughBackend,
        ActionPolicyRevision::new("test-policy-v1"),
        super::super::shell_sandbox(),
    )
    .unwrap();
    let agent_grep = Arc::new(
        AgentGrepService::new(ash_config::AgentGrepBackend::Ripgrep, ripgrep.clone(), None)
            .unwrap(),
    );
    let suite = LocalToolSuite::new(
        shell,
        ripgrep,
        agent_grep,
        access,
        authorization(cwd_dir.path()),
    );
    #[cfg(windows)]
    let (program, arguments) = (
        std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe")
            .display()
            .to_string(),
        vec![
            "-NoLogo".to_owned(),
            "-NoProfile".to_owned(),
            "-NonInteractive".to_owned(),
            "-Command".to_owned(),
            "$line=[Console]::In.ReadLine(); [Console]::Out.Write(\"got:$line\")".to_owned(),
        ],
    );
    #[cfg(unix)]
    let (program, arguments) = (
        "/bin/sh".to_owned(),
        vec![
            "-c".to_owned(),
            "read line; printf 'got:%s' \"$line\"".to_owned(),
        ],
    );
    let cancellation = ash_async_utils::CancellationSource::new();
    let authority = ToolAuthorization::Sandboxed(super::super::shell_sandbox());
    let start = suite
        .shell_session(
            &tool_call(
                "shell-session",
                serde_json::json!({
                    "action": "start",
                    "session_id": null,
                    "program": program,
                    "arguments": arguments,
                    "working_directory": cwd_dir.path().display().to_string(),
                    "input": null,
                    "stdout_cursor": null,
                    "stderr_cursor": null,
                    "wait_ms": 0,
                }),
            ),
            &authority,
            &cancellation.token(),
            &session_id,
            &thread_id,
            None,
        )
        .unwrap();
    let ToolExecutionOutput::Success(start) = start else {
        panic!("session start failed")
    };
    let start: serde_json::Value = serde_json::from_str(&start).unwrap();
    assert_eq!(start["status"], "running");
    let command_id = start["session_id"].as_str().unwrap();
    suite
        .shell_session(
            &tool_call(
                "shell-session",
                serde_json::json!({"action":"write","session_id":command_id,"input":"hello\n"}),
            ),
            &authority,
            &cancellation.token(),
            &session_id,
            &thread_id,
            None,
        )
        .unwrap();
    let mut stdout = String::new();
    let mut stdout_cursor = 0;
    let mut stderr_cursor = 0;
    loop {
        let read = suite
            .shell_session(
                &tool_call(
                    "shell-session",
                    serde_json::json!({
                        "action":"wait",
                        "session_id":command_id,
                        "stdout_cursor":stdout_cursor,
                        "stderr_cursor":stderr_cursor,
                        "wait_ms":1000,
                    }),
                ),
                &authority,
                &cancellation.token(),
                &session_id,
                &thread_id,
                None,
            )
            .unwrap();
        let ToolExecutionOutput::Success(read) = read else {
            panic!("session read failed")
        };
        let read: serde_json::Value = serde_json::from_str(&read).unwrap();
        stdout.push_str(read["stdout"]["text"].as_str().unwrap());
        stdout_cursor = read["stdout"]["next_cursor"].as_u64().unwrap();
        stderr_cursor = read["stderr"]["next_cursor"].as_u64().unwrap();
        if read["status"] != "running" {
            assert_eq!(read["status"], "exited");
            break;
        }
    }
    assert_eq!(stdout, "got:hello");
}

fn authorization(path: &std::path::Path) -> Grant {
    Grant::for_environment(
        Dir::open_local(path).unwrap(),
        GrantSource::ExplicitUser,
        Permissions::new([
            Permission::ReadFiles,
            Permission::WriteFiles,
            Permission::ExecuteCommands,
            Permission::SearchFiles,
            Permission::InspectRepository,
            Permission::MutateRepository,
        ]),
    )
}

fn tool_call(name: &str, arguments: serde_json::Value) -> ToolCall {
    ToolCall {
        id: ToolCallId::new(format!("{name}-call")).unwrap(),
        name: ToolName::new(name).unwrap(),
        arguments,
    }
}

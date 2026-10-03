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
use ash_shell_command::RipgrepExecutable;

struct PassThroughBackend;

#[test]
fn patch_move_review_checks_both_paths_and_preserves_the_move_header() {
    let directory = tempfile::tempdir().unwrap();
    fs::write(directory.path().join("old.txt"), "old\n").unwrap();
    let grant = authorization(directory.path());
    let authorized = grant.authorize(Permission::MutateRepository).unwrap();
    let source = directory.path().join("old.txt");
    let target = directory.path().join("new.txt");
    let patch = format!(
        "*** Begin Patch\n*** Update File: {}\n*** Move to: {}\n*** End Patch\n",
        source.display(),
        target.display()
    );
    let (_, rewritten, targets) =
        super::super::materialize_patch_targets(std::slice::from_ref(&authorized), &patch, &[])
            .unwrap();
    assert!(rewritten.contains("*** Update File: old.txt"));
    assert!(rewritten.contains("*** Move to: new.txt"));
    assert_eq!(targets.len(), 2);
    assert!(targets.iter().any(|path| path.ends_with("old.txt")));
    assert!(targets.iter().any(|path| path.ends_with("new.txt")));
    let outside = tempfile::tempdir().unwrap();
    let escaping = patch.replace(
        &target.display().to_string(),
        &outside.path().join("new.txt").display().to_string(),
    );
    assert!(super::super::materialize_patch_targets(&[authorized], &escaping, &[]).is_err());
    assert_eq!(fs::read_to_string(source).unwrap(), "old\n");
    assert!(!target.exists());
}

fn text_edit_suite(path: &std::path::Path) -> LocalToolSuite<PassThroughBackend> {
    let grant = authorization(path);
    let ripgrep = RipgrepExecutable::from_path(std::env::current_exe().unwrap()).unwrap();
    let shell = LocalShellToolService::new_with_action_policy_revision(
        grant.authorize(Permission::ExecuteCommands).unwrap(),
        ripgrep.clone(),
        PassThroughBackend,
        ActionPolicyRevision::new("test-policy-v1"),
        super::super::shell_sandbox(),
    )
    .unwrap();
    LocalToolSuite::new(
        shell,
        Arc::new(grep::Service::new(grep::Backend::Ripgrep, ripgrep, None).unwrap()),
        Arc::new(file_search::Service),
        Arc::new(crate::dir_grants::DirGrants::default()),
        grant,
    )
}

#[test]
fn agent_text_edits_preserve_file_format_and_allow_subsequent_writes() {
    for file_eol in ["\n", "\r\n"] {
        for model_eol in ["\n", "\r\n"] {
            for eof in ["", file_eol] {
                let dir = tempfile::tempdir().unwrap();
                let path = dir.path().join("file.txt");
                fs::write(&path, format!("first{file_eol}old{file_eol}last{eof}")).unwrap();
                let suite = text_edit_suite(dir.path());
                let authority = ToolAuthorization::Sandboxed(super::super::read_only_sandbox());
                let cancellation = ash_async_utils::CancellationSource::new().token();
                for call in [
                    tool_call(
                        "read_file",
                        json!({"path": path, "offset": null, "limit": null}),
                    ),
                    tool_call(
                        "edit",
                        json!({"path": path, "old_string": format!("old{model_eol}last"), "new_string": format!("new{model_eol}last"), "replace_all": false}),
                    ),
                ] {
                    assert!(matches!(
                        suite.execute(&call, &authority, &cancellation).unwrap(),
                        ToolExecutionOutput::Success(_)
                    ));
                }
                assert_eq!(
                    fs::read_to_string(&path).unwrap(),
                    format!("first{file_eol}new{file_eol}last{eof}")
                );
                // The normalized bytes, rather than the model input, must be the
                // revision recorded for the next mutation in this conversation.
                let rewrite = tool_call(
                    "write_file",
                    json!({"path": path, "content": format!("rewritten{model_eol}last{model_eol}")}),
                );
                assert!(matches!(
                    suite.execute(&rewrite, &authority, &cancellation).unwrap(),
                    ToolExecutionOutput::Success(_)
                ));
                assert_eq!(
                    fs::read_to_string(&path).unwrap(),
                    format!("rewritten{file_eol}last{eof}")
                );
                let edit = tool_call(
                    "edit",
                    json!({"path": path, "old_string": "rewritten", "new_string": "final", "replace_all": false}),
                );
                assert!(matches!(
                    suite.execute(&edit, &authority, &cancellation).unwrap(),
                    ToolExecutionOutput::Success(_)
                ));
                assert_eq!(
                    fs::read_to_string(&path).unwrap(),
                    format!("final{file_eol}last{eof}")
                );
            }
        }
    }
}

#[test]
fn agent_replacements_match_mixed_endings_without_rewriting_untouched_bytes() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("file.txt");
    fs::write(&path, "头🙂\n旧🙂\r\nmore\n旧🙂\nmore\r\n尾🙂\r\n").unwrap();
    let suite = text_edit_suite(dir.path());
    let authority = ToolAuthorization::Sandboxed(super::super::read_only_sandbox());
    let cancellation = ash_async_utils::CancellationSource::new().token();
    let read = tool_call(
        "read_file",
        json!({"path": path, "offset": null, "limit": null}),
    );
    assert!(matches!(
        suite.execute(&read, &authority, &cancellation).unwrap(),
        ToolExecutionOutput::Success(_)
    ));
    let edit = tool_call(
        "edit",
        json!({"path": path, "old_string": "旧🙂\nmore", "new_string": "changed\r\nnext", "replace_all": true}),
    );
    assert!(matches!(
        suite.execute(&edit, &authority, &cancellation).unwrap(),
        ToolExecutionOutput::Success(_)
    ));
    assert_eq!(
        fs::read_to_string(&path).unwrap(),
        "头🙂\nchanged\nnext\nchanged\nnext\r\n尾🙂\r\n"
    );
}

#[test]
fn agent_new_file_writes_follow_editorconfig_and_existing_content_takes_precedence() {
    let dir = tempfile::tempdir().unwrap();
    fs::write(dir.path().join(".editorconfig"), "root = true\n[*]\nend_of_line = lf\ninsert_final_newline = true\n[{*.bat,*.cmd}]\nend_of_line = crlf\n").unwrap();
    let suite = text_edit_suite(dir.path());
    let authority = ToolAuthorization::Sandboxed(super::super::read_only_sandbox());
    let cancellation = ash_async_utils::CancellationSource::new().token();
    for (name, expected) in [("new.txt", "one\ntwo\n"), ("new.bat", "one\r\ntwo\r\n")] {
        let path = dir.path().join("new").join(name);
        let write = tool_call("write_file", json!({"path": path, "content": "one\r\ntwo"}));
        assert!(matches!(
            suite.execute(&write, &authority, &cancellation).unwrap(),
            ToolExecutionOutput::Success(_)
        ));
        assert_eq!(fs::read_to_string(&path).unwrap(), expected);
    }
    let path = dir.path().join("existing.txt");
    fs::write(&path, "one\r\ntwo").unwrap();
    for call in [
        tool_call(
            "read_file",
            json!({"path": path, "offset": null, "limit": null}),
        ),
        tool_call(
            "write_file",
            json!({"path": path, "content": "changed\nlast\n"}),
        ),
    ] {
        assert!(matches!(
            suite.execute(&call, &authority, &cancellation).unwrap(),
            ToolExecutionOutput::Success(_)
        ));
    }
    assert_eq!(fs::read_to_string(path).unwrap(), "changed\r\nlast");
}

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
    let grep = Arc::new(grep::Service::new(grep::Backend::Ripgrep, ripgrep.clone(), None).unwrap());
    let suite = LocalToolSuite::new(
        shell,
        grep,
        Arc::new(file_search::Service),
        Arc::clone(&access),
        cwd_grant,
    );

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

#[cfg(target_os = "macos")]
#[test]
fn file_tools_read_a_large_workspace_without_scanning_every_entry() {
    let dir = tempfile::tempdir().unwrap();
    let build = dir.path().join("build");
    fs::create_dir(&build).unwrap();
    for index in 0..50_001 {
        fs::File::create(build.join(format!("entry-{index}"))).unwrap();
    }
    let public = dir.path().join("public.txt");
    fs::write(&public, "public-value").unwrap();
    let nested = dir.path().join("config");
    fs::create_dir(&nested).unwrap();
    let private = nested.join(".env");
    fs::write(&private, "private-value").unwrap();
    let grant = authorization(dir.path());
    let ripgrep = RipgrepExecutable::from_path(std::env::current_exe().unwrap()).unwrap();
    let shell = LocalShellToolService::new(
        grant.authorize(Permission::ExecuteCommands).unwrap(),
        ripgrep.clone(),
        PassThroughBackend,
    )
    .unwrap();
    let grep = Arc::new(grep::Service::new(grep::Backend::Ripgrep, ripgrep, None).unwrap());
    let suite = LocalToolSuite::new(
        shell,
        grep,
        Arc::new(file_search::Service),
        Arc::new(crate::dir_grants::DirGrants::default()),
        grant,
    );
    let read = suite
        .read_file(
            &tool_call(
                "read_file",
                serde_json::json!({"path": public, "offset": null, "limit": null}),
            ),
            "thread",
            None,
            None,
        )
        .unwrap();
    assert!(matches!(read, ToolExecutionOutput::Success(text) if text.contains("public-value")));
    let denied = suite.read_file(
        &tool_call(
            "read_file",
            serde_json::json!({"path": private, "offset": null, "limit": null}),
        ),
        "thread",
        None,
        None,
    );
    assert!(
        matches!(denied, Err(error) if error.to_string().contains("denied by the local filesystem policy"))
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
    let grep = Arc::new(grep::Service::new(grep::Backend::Ripgrep, ripgrep.clone(), None).unwrap());
    let suite = LocalToolSuite::new(
        shell,
        grep,
        Arc::new(file_search::Service),
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

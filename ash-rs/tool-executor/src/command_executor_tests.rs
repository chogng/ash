use super::*;
use ash_async_utils::CancellationSource;
use ash_protocol::ProcessExitStatus;
use ash_sandboxing::SandboxProcessExitStatus;
use ash_sandboxing::{FileSystemAccess, NetworkAccess, SandboxCommand, SandboxPolicy};
use ash_sandboxing::{PreparedCommand, SandboxError, SandboxKind};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicUsize, Ordering};
#[cfg(target_os = "macos")]
use std::thread;

struct AllowAll;

#[cfg(target_os = "macos")]
#[test]
fn managed_command_can_reach_only_its_authorized_proxy_destinations() {
    assert_managed_command(mxc_sandbox::MxcSandbox::new(
        ash_install_context::InstallContext::current(),
    ));
}

#[cfg(target_os = "macos")]
#[test]
fn shared_proxy_execution_enforces_the_same_destination_and_file_policy() {
    struct SharedProxyBackend;
    impl SandboxBackend for SharedProxyBackend {
        fn prepare_scoped(
            &self,
            command: &SandboxCommand,
            policy: SandboxPolicy,
            scope: &ash_sandboxing::SandboxScope,
        ) -> Result<PreparedCommand, SandboxError> {
            let ports = command.network_proxy().unwrap().ports();
            assert_eq!(ports[0], ports[1]);
            mxc_sandbox::MxcSandbox::new(ash_install_context::InstallContext::current())
                .prepare_scoped(command, policy, scope)
        }
        fn kind(&self) -> SandboxKind {
            SandboxKind::Restricted
        }
        fn requires_shared_network_proxy(&self) -> bool {
            true
        }
        fn prepare(
            &self,
            command: &SandboxCommand,
            policy: SandboxPolicy,
            dir: &Dir,
        ) -> Result<PreparedCommand, SandboxError> {
            let ports = command.network_proxy().unwrap().ports();
            assert_eq!(ports[0], ports[1]);
            mxc_sandbox::MxcSandbox::new(ash_install_context::InstallContext::current())
                .prepare(command, policy, dir)
        }
    }
    assert_managed_command(SharedProxyBackend);
}

#[cfg(target_os = "macos")]
fn assert_managed_command(backend: impl SandboxBackend) {
    use std::io::Read;
    use std::io::Write;
    use std::net::TcpListener;
    let origin = TcpListener::bind("127.0.0.1:0").unwrap();
    let allowed_port = origin.local_addr().unwrap().port();
    let denied = TcpListener::bind("127.0.0.1:0").unwrap();
    denied.set_nonblocking(true).unwrap();
    let denied_port = denied.local_addr().unwrap().port();
    let foreign_calls = std::sync::Arc::new(AtomicUsize::new(0));
    let observed_foreign = std::sync::Arc::clone(&foreign_calls);
    let foreign = network_proxy::NetworkProxy::start(
        network_proxy::NetworkPolicyHandle::new(move |_, _| {
            observed_foreign.fetch_add(1, Ordering::Relaxed);
            async { network_proxy::NetworkDecision::Allow }
        }),
        &CancellationSource::new().token(),
    )
    .unwrap();
    let foreign_port = foreign.http_port();
    let upstream = thread::spawn(move || {
        let (mut stream, _) = origin.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut bytes = [0; 2048];
        assert!(stream.read(&mut bytes).unwrap() > 0);
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nConnection: close\r\n\r\napproved")
            .unwrap();
    });
    let requests = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let observed = std::sync::Arc::clone(&requests);
    let policy = network_proxy::NetworkPolicyHandle::new(
        move |request: network_proxy::NetworkRequest, _| {
            let allow = request.port() == allowed_port;
            observed.lock().unwrap().push(request);
            async move {
                if allow {
                    network_proxy::NetworkDecision::Allow
                } else {
                    network_proxy::NetworkDecision::Deny("test denied target".into())
                }
            }
        },
    );
    let dir = TestDir::new();
    let executor = CommandExecutor::new(dir.root(), backend, AllowAll, test_limits());
    let script = format!(
        "/usr/bin/curl -fsS --max-time 3 http://127.0.0.1:{allowed_port}/ || exit 10\n\
         if /usr/bin/curl -fsS --max-time 3 http://127.0.0.1:{denied_port}/; then exit 11; fi\n\
         if NO_PROXY='*' /usr/bin/curl -fsS --max-time 3 http://127.0.0.1:{denied_port}/; then exit 12; fi\n\
         if /usr/bin/curl --noproxy '*' -fsS --max-time 3 http://127.0.0.1:{denied_port}/; then exit 13; fi\n\
         if /usr/bin/curl --proxy http://127.0.0.1:{foreign_port} -fsS --max-time 3 http://127.0.0.1:{denied_port}/; then exit 14; fi\n\
         if /usr/bin/touch forbidden-write; then exit 15; fi\n\
         printf '\nrestricted'"
    );
    let outcome = executor
        .execute_scoped_with_network(
            CommandRequest {
                program: "/bin/sh".into(),
                arguments: vec!["-c".into(), script],
                working_directory: ".".into(),
                input: CommandInput::Closed,
            },
            CommandExecutionAuthority::Sandboxed(SandboxPolicy::new(
                FileSystemAccess::ReadOnly,
                NetworkAccess::Managed,
            )),
            &CancellationSource::new().token(),
            None,
            Some(&policy),
        )
        .unwrap();
    let CommandExecutionOutcome::Completed(output) = outcome else {
        panic!("managed command did not complete: {outcome:?}");
    };
    assert_eq!(output.exit_code, Some(0), "{output:?}");
    assert_eq!(output.stdout, "approved\nrestricted");
    assert_eq!(requests.lock().unwrap().len(), 2);
    assert_eq!(foreign_calls.load(Ordering::Relaxed), 0);
    assert!(!dir.root().canonical_path().join("forbidden-write").exists());
    assert_eq!(
        denied.accept().unwrap_err().kind(),
        std::io::ErrorKind::WouldBlock
    );
    upstream.join().unwrap();
}

impl ApprovalPolicy for AllowAll {
    fn requirement_for(&self, _: &str) -> ApprovalRequirement {
        ApprovalRequirement::NotRequired
    }
}

struct ReplacingBackend;

impl SandboxBackend for ReplacingBackend {
    fn prepare_scoped(
        &self,
        command: &SandboxCommand,
        policy: SandboxPolicy,
        scope: &ash_sandboxing::SandboxScope,
    ) -> Result<PreparedCommand, SandboxError> {
        self.prepare(command, policy, scope.command_dir())
    }
    fn kind(&self) -> SandboxKind {
        SandboxKind::Unrestricted
    }

    fn prepare(
        &self,
        command: &SandboxCommand,
        policy: SandboxPolicy,
        _: &Dir,
    ) -> Result<PreparedCommand, SandboxError> {
        assert_eq!(
            policy,
            SandboxPolicy::new(FileSystemAccess::ReadOnly, NetworkAccess::Denied)
        );
        // Build cmd.exe paths from components; forward slashes in its argv[0]
        // can be interpreted as command switches.
        #[cfg(windows)]
        let (program, arguments) = (
            PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                .join("System32")
                .join("cmd.exe"),
            vec!["/d", "/c", "echo", "prepared-by-backend"],
        );
        #[cfg(not(windows))]
        let (program, arguments) = (
            std::path::PathBuf::from("/bin/sh"),
            vec!["-c", "printf prepared-by-backend"],
        );
        Ok(PreparedCommand::new(
            SandboxKind::Unrestricted,
            program,
            arguments,
            command.working_directory(),
        ))
    }
}

struct MissingSandboxLauncher;

struct PassThroughBackend;

#[test]
fn executor_uses_the_selected_backend_to_classify_the_actual_process_result() {
    struct Unsupported;
    impl SandboxBackend for Unsupported {
        fn kind(&self) -> SandboxKind {
            SandboxKind::Restricted
        }
        fn prepare(
            &self,
            _: &SandboxCommand,
            _: SandboxPolicy,
            _: &Dir,
        ) -> Result<PreparedCommand, SandboxError> {
            Err(SandboxError::UnsupportedPolicy(
                "required capability is absent".into(),
            ))
        }
        fn classify_denial(
            &self,
            _: SandboxProcessExitStatus,
            _: &str,
            _: &str,
        ) -> Option<ash_sandboxing::SandboxProcessDenial> {
            panic!("an unselected backend must not classify this process")
        }
    }
    struct Selected;
    impl SandboxBackend for Selected {
        fn prepare_scoped(
            &self,
            command: &SandboxCommand,
            policy: SandboxPolicy,
            scope: &ash_sandboxing::SandboxScope,
        ) -> Result<PreparedCommand, SandboxError> {
            self.prepare(command, policy, scope.command_dir())
        }
        fn kind(&self) -> SandboxKind {
            SandboxKind::Restricted
        }
        fn prepare(
            &self,
            command: &SandboxCommand,
            _: SandboxPolicy,
            _: &Dir,
        ) -> Result<PreparedCommand, SandboxError> {
            #[cfg(windows)]
            let (program, arguments) = (
                PathBuf::from(std::env::var_os("SystemRoot").unwrap())
                    .join("System32/WindowsPowerShell/v1.0/powershell.exe"),
                vec![
                    "-NoLogo",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    "[Console]::Out.Write('selected'); exit 7",
                ],
            );
            #[cfg(not(windows))]
            let (program, arguments) = (
                PathBuf::from("/bin/sh"),
                vec!["-c", "printf selected; exit 7"],
            );
            Ok(PreparedCommand::new(
                SandboxKind::Restricted,
                program,
                arguments,
                command.working_directory(),
            ))
        }
        fn classify_denial(
            &self,
            status: SandboxProcessExitStatus,
            _: &str,
            _: &str,
        ) -> Option<ash_sandboxing::SandboxProcessDenial> {
            assert_eq!(status, SandboxProcessExitStatus::Code(7));
            Some(
                ash_sandboxing::SandboxProcessDenial::process_may_have_started(
                    "selected backend evidence",
                ),
            )
        }
    }
    let dir = TestDir::new();
    let backends = ash_sandboxing::SandboxBackends::new(vec![
        ("unsupported", std::sync::Arc::new(Unsupported)),
        ("selected", std::sync::Arc::new(Selected)),
    ]);
    let executor = CommandExecutor::new(dir.root(), backends, AllowAll, test_limits());
    let outcome = executor
        .execute(
            CommandRequest {
                program: "must-not-run".into(),
                arguments: Vec::new(),
                working_directory: ".".into(),
                input: CommandInput::Closed,
            },
            CommandExecutionAuthority::Sandboxed(SandboxPolicy::new(
                FileSystemAccess::ReadOnly,
                NetworkAccess::Denied,
            )),
            &CancellationSource::new().token(),
        )
        .unwrap();
    let CommandExecutionOutcome::SandboxDenied(denial) = outcome else {
        panic!("{outcome:?}")
    };
    assert_eq!(
        denial.replay_safety(),
        ash_protocol::ToolReplaySafety::MayHaveSideEffects
    );
    assert_eq!(
        denial.output().exit_status(),
        ash_protocol::ProcessExitStatus::Code(7)
    );
    assert_eq!(denial.output().stdout(), "selected");
}

#[test]
fn managed_network_rejects_an_unrestricted_backend_before_spawn() {
    let dir = TestDir::new();
    let executor = CommandExecutor::new(dir.root(), PassThroughBackend, AllowAll, test_limits());
    let policy = network_proxy::NetworkPolicyHandle::new(|_, _| async {
        network_proxy::NetworkDecision::Allow
    });
    let outcome = executor.execute_scoped_with_network(
        CommandRequest {
            program: "must-not-start".into(),
            arguments: Vec::new(),
            working_directory: ".".into(),
            input: CommandInput::Closed,
        },
        CommandExecutionAuthority::Sandboxed(SandboxPolicy::new(
            FileSystemAccess::ReadOnly,
            NetworkAccess::Managed,
        )),
        &CancellationSource::new().token(),
        None,
        Some(&policy),
    );
    assert!(matches!(outcome, Err(ExecutionError::Network(_))));
}

impl SandboxBackend for PassThroughBackend {
    fn prepare_scoped(
        &self,
        command: &SandboxCommand,
        policy: SandboxPolicy,
        scope: &ash_sandboxing::SandboxScope,
    ) -> Result<PreparedCommand, SandboxError> {
        self.prepare(command, policy, scope.command_dir())
    }
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
}

impl SandboxBackend for MissingSandboxLauncher {
    fn kind(&self) -> SandboxKind {
        SandboxKind::Restricted
    }

    fn prepare(
        &self,
        command: &SandboxCommand,
        _: SandboxPolicy,
        _: &Dir,
    ) -> Result<PreparedCommand, SandboxError> {
        Ok(PreparedCommand::new(
            SandboxKind::Restricted,
            "/ash-test/missing-sandbox-launcher",
            Vec::<String>::new(),
            command.working_directory(),
        ))
    }
}

#[test]
fn command_session_keeps_one_process_for_later_input_and_output_reads() {
    let dir = TestDir::new();
    let executor = CommandExecutor::new(dir.root(), PassThroughBackend, AllowAll, test_limits());
    let owner = CommandSessionOwner::new("connection-1", "thread-1", "local");
    #[cfg(windows)]
    let request = CommandRequest {
        program: PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe")
            .display()
            .to_string(),
        arguments: vec![
            "-NoLogo".into(),
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-Command".into(),
            "$line=[Console]::In.ReadLine(); [Console]::Out.Write(\"got:$line\")".into(),
        ],
        working_directory: ".".into(),
        input: CommandInput::Closed,
    };
    #[cfg(unix)]
    let request = CommandRequest {
        program: "/bin/sh".into(),
        arguments: vec!["-c".into(), "read line; printf 'got:%s' \"$line\"".into()],
        working_directory: ".".into(),
        input: CommandInput::Closed,
    };

    let started = executor
        .start_session_scoped_with_network(
            request,
            CommandExecutionAuthority::Unrestricted,
            &CancellationSource::new().token(),
            None,
            None,
            owner.clone(),
            super::CommandSessionOptions {
                execution_timeout: Duration::from_secs(5),
                wait_budget: Duration::from_millis(10),
                terminal: None,
            },
        )
        .unwrap();
    let CommandSessionStart::Running(initial) = started else {
        panic!("input-blocked command must remain running")
    };
    executor
        .write_session(&owner, &initial.session_id, b"hello\n".to_vec())
        .unwrap();
    executor
        .close_session_input(&owner, &initial.session_id)
        .unwrap();
    let mut cursor = CommandSessionCursor {
        stdout: initial.stdout.next_cursor,
        stderr: initial.stderr.next_cursor,
    };
    let mut stdout = String::new();
    let update = loop {
        let update = executor
            .read_session(&owner, &initial.session_id, cursor, Duration::from_secs(1))
            .unwrap();
        stdout.push_str(&update.stdout.text);
        cursor = CommandSessionCursor {
            stdout: update.stdout.next_cursor,
            stderr: update.stderr.next_cursor,
        };
        if update.status != CommandSessionStatus::Running {
            break update;
        }
    };

    assert_eq!(
        update.status,
        CommandSessionStatus::Exited(ProcessExitStatus::Code(0))
    );
    assert_eq!(stdout, "got:hello");
    assert!(
        executor
            .read_session(
                &CommandSessionOwner::new("connection-2", "thread-1", "local"),
                &initial.session_id,
                CommandSessionCursor::default(),
                Duration::ZERO,
            )
            .is_err()
    );
    executor
        .release_session(&owner, &initial.session_id)
        .unwrap();
}

#[test]
fn command_session_wait_budget_does_not_terminate_the_process() {
    let dir = TestDir::new();
    let executor = CommandExecutor::new(dir.root(), PassThroughBackend, AllowAll, test_limits());
    let owner = CommandSessionOwner::new("connection", "thread", "local");
    #[cfg(windows)]
    let request = CommandRequest {
        program: PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32/WindowsPowerShell/v1.0/powershell.exe")
            .display()
            .to_string(),
        arguments: vec![
            "-NoLogo".into(),
            "-NoProfile".into(),
            "-NonInteractive".into(),
            "-Command".into(),
            "Start-Sleep -Seconds 5".into(),
        ],
        working_directory: ".".into(),
        input: CommandInput::Closed,
    };
    #[cfg(unix)]
    let request = CommandRequest {
        program: "/bin/sh".into(),
        arguments: vec!["-c".into(), "sleep 5".into()],
        working_directory: ".".into(),
        input: CommandInput::Closed,
    };

    let CommandSessionStart::Running(initial) = executor
        .start_session_scoped_with_network(
            request,
            CommandExecutionAuthority::Unrestricted,
            &CancellationSource::new().token(),
            None,
            None,
            owner.clone(),
            super::CommandSessionOptions {
                execution_timeout: Duration::from_secs(5),
                wait_budget: Duration::ZERO,
                terminal: None,
            },
        )
        .unwrap()
    else {
        panic!("sleeping command must remain running")
    };
    let update = executor
        .read_session(
            &owner,
            &initial.session_id,
            CommandSessionCursor::default(),
            Duration::from_millis(10),
        )
        .unwrap();
    assert_eq!(update.status, CommandSessionStatus::Running);
    executor
        .terminate_session(&owner, &initial.session_id)
        .unwrap();
    let terminal = executor
        .read_session(
            &owner,
            &initial.session_id,
            CommandSessionCursor::default(),
            Duration::from_secs(2),
        )
        .unwrap();
    assert_eq!(terminal.status, CommandSessionStatus::Terminated);
}

#[test]
fn executor_spawns_only_the_command_prepared_by_the_sandbox_backend() {
    let dir = TestDir::new();
    let executor = CommandExecutor::new(dir.root(), ReplacingBackend, AllowAll, test_limits());

    let outcome = executor
        .execute(
            CommandRequest {
                program: "must-not-run".into(),
                arguments: Vec::new(),
                working_directory: ".".into(),
                input: CommandInput::Closed,
            },
            CommandExecutionAuthority::Sandboxed(SandboxPolicy::new(
                FileSystemAccess::ReadOnly,
                NetworkAccess::Denied,
            )),
            &CancellationSource::new().token(),
        )
        .unwrap();
    let CommandExecutionOutcome::Completed(output) = outcome else {
        panic!("unrestricted test backend should complete normally");
    };

    assert_eq!(output.exit_code, Some(0), "{output:?}");
    #[cfg(windows)]
    assert_eq!(output.stdout, "prepared-by-backend\r\n", "{output:?}");
    #[cfg(not(windows))]
    assert_eq!(output.stdout, "prepared-by-backend", "{output:?}");
}

#[test]
fn missing_sandbox_launcher_is_safe_to_retry_because_the_action_never_started() {
    let dir = TestDir::new();
    let executor =
        CommandExecutor::new(dir.root(), MissingSandboxLauncher, AllowAll, test_limits());

    let outcome = executor
        .execute(
            CommandRequest {
                program: "must-not-run".into(),
                arguments: Vec::new(),
                working_directory: ".".into(),
                input: CommandInput::Closed,
            },
            CommandExecutionAuthority::Sandboxed(SandboxPolicy::new(
                FileSystemAccess::ReadOnly,
                NetworkAccess::Denied,
            )),
            &CancellationSource::new().token(),
        )
        .unwrap();

    let CommandExecutionOutcome::SandboxDenied(denial) = outcome else {
        panic!("sandbox launcher spawn failure should be a structured denial");
    };
    assert_eq!(
        denial.replay_safety(),
        ash_protocol::ToolReplaySafety::SafeToRetry
    );
    assert_eq!(
        denial.output().exit_status(),
        ash_protocol::ProcessExitStatus::Terminated
    );
}

#[cfg(unix)]
#[test]
fn executor_returns_bounded_output_with_explicit_truncation_markers() {
    let dir = TestDir::new();
    let executor = CommandExecutor::new(
        dir.root(),
        PassThroughBackend,
        AllowAll,
        ExecutionLimits {
            timeout: Duration::from_secs(3),
            max_output_bytes: 5,
        },
    );

    let outcome = executor
        .execute(
            CommandRequest {
                program: "/bin/sh".into(),
                arguments: vec!["-c".into(), "printf 123456789; printf abc >&2".into()],
                working_directory: ".".into(),
                input: CommandInput::Closed,
            },
            CommandExecutionAuthority::Unrestricted,
            &CancellationSource::new().token(),
        )
        .unwrap();
    let CommandExecutionOutcome::Completed(output) = outcome else {
        panic!("pass-through command should complete");
    };

    assert_eq!(output.stdout, "12345");
    assert!(output.stderr.is_empty());
    assert!(output.stdout_truncated);
    assert!(output.stderr_truncated);
}

#[cfg(unix)]
#[test]
fn executor_writes_explicit_bytes_to_child_stdin() {
    let dir = TestDir::new();
    let executor = CommandExecutor::new(dir.root(), PassThroughBackend, AllowAll, test_limits());

    let outcome = executor
        .execute(
            CommandRequest {
                program: "/bin/sh".into(),
                arguments: vec!["-c".into(), "cat".into()],
                working_directory: ".".into(),
                input: CommandInput::Bytes(b"ash-hook-payload".to_vec()),
            },
            CommandExecutionAuthority::Unrestricted,
            &CancellationSource::new().token(),
        )
        .unwrap();
    let CommandExecutionOutcome::Completed(output) = outcome else {
        panic!("pass-through command should complete");
    };

    assert_eq!(output.exit_code, Some(0));
    assert_eq!(output.stdout, "ash-hook-payload");
}

#[cfg(unix)]
#[test]
fn executor_terminates_a_running_process_when_cancelled() {
    let dir = TestDir::new();
    let executor = CommandExecutor::new(dir.root(), PassThroughBackend, AllowAll, test_limits());
    let cancellation = CancellationSource::new();
    let token = cancellation.token();
    let running = std::thread::spawn(move || {
        executor.execute(
            CommandRequest {
                program: "/bin/sleep".into(),
                arguments: vec!["10".into()],
                working_directory: ".".into(),
                input: CommandInput::Closed,
            },
            CommandExecutionAuthority::Unrestricted,
            &token,
        )
    });

    std::thread::sleep(Duration::from_millis(50));
    cancellation.cancel();
    let result = running.join().unwrap();
    assert!(matches!(
        result,
        Err(ExecutionError::CancelledAfterStart(_))
    ));
}

#[cfg(unix)]
#[test]
fn executor_kills_background_descendants_before_returning() {
    let dir = TestDir::new();
    let marker = dir.path.join("late-write");
    let executor = CommandExecutor::new(dir.root(), PassThroughBackend, AllowAll, test_limits());

    let outcome = executor
        .execute(
            CommandRequest {
                program: "/bin/sh".into(),
                arguments: vec![
                    "-c".into(),
                    "(sleep 0.2; touch \"$1\") &".into(),
                    "ash-background-test".into(),
                    marker.display().to_string(),
                ],
                working_directory: ".".into(),
                input: CommandInput::Closed,
            },
            CommandExecutionAuthority::Unrestricted,
            &CancellationSource::new().token(),
        )
        .unwrap();

    assert!(matches!(outcome, CommandExecutionOutcome::Completed(_)));
    std::thread::sleep(Duration::from_millis(400));
    assert!(!marker.exists());
}

fn test_limits() -> ExecutionLimits {
    ExecutionLimits {
        timeout: Duration::from_secs(3),
        max_output_bytes: 16 * 1024,
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
            "ash-tool-executor-tests-{}-{sequence}",
            std::process::id()
        ));
        fs::create_dir_all(&path).unwrap();
        Self { path }
    }

    fn root(&self) -> Dir {
        Dir::open_local(&self.path).unwrap()
    }
}

impl Drop for TestDir {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.path);
    }
}

#[cfg(unix)]
#[test]
fn command_wait_ignores_output_and_preserves_process_on_expiry_and_cancellation() {
    let dir = TestDir::new();
    let executor = CommandExecutor::new(dir.root(), PassThroughBackend, AllowAll, test_limits());
    let owner = CommandSessionOwner::new("connection", "thread", "local");
    let process = CancellationSource::new();
    let CommandSessionStart::Running(initial) = executor
        .start_session_scoped_with_network(
            CommandRequest {
                program: "/bin/sh".into(),
                arguments: vec![
                    "-c".into(),
                    "printf 'progress\\n'; read answer; printf 'done:%s\\n' \"$answer\"".into(),
                ],
                working_directory: ".".into(),
                input: CommandInput::Open,
            },
            CommandExecutionAuthority::Unrestricted,
            &process.token(),
            None,
            None,
            owner.clone(),
            super::CommandSessionOptions {
                execution_timeout: Duration::from_secs(5),
                wait_budget: Duration::ZERO,
                terminal: None,
            },
        )
        .unwrap()
    else {
        panic!("command should wait for input")
    };
    let id = &initial.session_id;
    let cursor = CommandSessionCursor::default();
    let observation = CancellationSource::new();
    let token = observation.token();
    let mut pending =
        Box::pin(executor.wait_session(&owner, id, cursor, Duration::from_secs(5), &token));
    use std::future::Future;
    use std::task::Context;
    use std::task::Waker;
    assert!(
        pending
            .as_mut()
            .poll(&mut Context::from_waker(Waker::noop()))
            .is_pending()
    );
    observation.cancel();
    assert!(matches!(
        pollster::block_on(pending),
        Err(ExecutionError::CancelledBeforeStart(_))
    ));
    let expired = pollster::block_on(executor.wait_session(
        &owner,
        id,
        cursor,
        Duration::from_millis(10),
        &CancellationSource::new().token(),
    ))
    .unwrap();
    assert_eq!(expired.status, CommandSessionStatus::Running);
    let stranger = CommandSessionOwner::new("connection", "another-thread", "local");
    assert!(
        pollster::block_on(executor.wait_session(
            &stranger,
            id,
            cursor,
            Duration::ZERO,
            &process.token()
        ))
        .is_err()
    );
    executor
        .write_session(&owner, id, b"accepted\n".to_vec())
        .unwrap();
    let completed = pollster::block_on(executor.wait_session(
        &owner,
        id,
        cursor,
        Duration::from_secs(5),
        &process.token(),
    ))
    .unwrap();
    assert_eq!(
        completed.status,
        CommandSessionStatus::Exited(ProcessExitStatus::Code(0))
    );
    assert!(completed.stdout.text.contains("progress"));
    assert!(completed.stdout.text.contains("done:accepted"));
    let repeated = pollster::block_on(executor.wait_session(
        &owner,
        id,
        cursor,
        Duration::ZERO,
        &process.token(),
    ))
    .unwrap();
    assert_eq!(repeated, completed);
}

#[test]
fn approval_rejection_never_reaches_process_preparation() {
    struct Gate(ApprovalRequirement);
    impl ApprovalPolicy for Gate {
        fn requirement_for(&self, _: &str) -> ApprovalRequirement {
            self.0
        }
    }
    struct MustNotPrepare;
    impl SandboxBackend for MustNotPrepare {
        fn kind(&self) -> SandboxKind {
            SandboxKind::Restricted
        }
        fn prepare(
            &self,
            _: &SandboxCommand,
            _: SandboxPolicy,
            _: &Dir,
        ) -> Result<PreparedCommand, SandboxError> {
            panic!("unapproved action reached execution service")
        }
    }
    let dir = TestDir::new();
    for requirement in [ApprovalRequirement::Required, ApprovalRequirement::Denied] {
        let executor =
            CommandExecutor::new(dir.root(), MustNotPrepare, Gate(requirement), test_limits());
        let cancellation = CancellationSource::new();
        let request = CommandRequest {
            program: "must-not-start".into(),
            arguments: vec![],
            working_directory: dir.path.clone(),
            input: CommandInput::Closed,
        };
        let authority = CommandExecutionAuthority::Sandboxed(SandboxPolicy::new(
            FileSystemAccess::ReadOnly,
            NetworkAccess::Denied,
        ));
        let single = executor.execute(request.clone(), authority, &cancellation.token());
        let session = executor.start_session_scoped_with_network(
            request,
            authority,
            &cancellation.token(),
            None,
            None,
            CommandSessionOwner::new("caller", "thread", "environment"),
            CommandSessionOptions {
                execution_timeout: Duration::from_secs(1),
                wait_budget: Duration::ZERO,
                terminal: None,
            },
        );
        match requirement {
            ApprovalRequirement::Required => {
                assert!(matches!(single, Err(ExecutionError::ApprovalRequired)));
                assert!(matches!(session, Err(ExecutionError::ApprovalRequired)));
            }
            ApprovalRequirement::Denied => {
                assert!(matches!(single, Err(ExecutionError::Denied)));
                assert!(matches!(session, Err(ExecutionError::Denied)));
            }
            _ => unreachable!(),
        }
    }
}

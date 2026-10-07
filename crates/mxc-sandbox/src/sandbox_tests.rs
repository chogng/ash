use super::*;
use ash_sandboxing::FileSystemAccess;
#[cfg(target_os = "windows")]
use ash_sandboxing::FileSystemIsolation;
use ash_sandboxing::ManagedNetworkAccess;
use ash_sandboxing::NetworkAccess;
#[cfg(target_os = "windows")]
use ash_sandboxing::SandboxBackends;

#[test]
fn managed_execution_requires_a_single_owned_endpoint() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let backend = MxcSandbox::new(InstallContext::current());
    let policy = SandboxPolicy::new(FileSystemAccess::ReadOnly, NetworkAccess::Managed);
    for access in [
        None,
        Some(ManagedNetworkAccess::new(
            3128.try_into().unwrap(),
            8081.try_into().unwrap(),
        )),
    ] {
        let command = SandboxCommand::new("must-not-start", ["argument"], dir.canonical_path());
        let command = match access {
            Some(access) => command.with_network_proxy(access),
            None => command,
        };
        assert!(backend.prepare(&command, policy, &dir).is_err());
    }
}

#[cfg(target_os = "windows")]
#[test]
fn managed_execution_rejects_psec_when_private_network_ingress_cannot_stay_denied() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let backend = MxcSandbox::new(InstallContext::current());
    let policy = SandboxPolicy::new(FileSystemAccess::ReadOnly, NetworkAccess::Managed);
    let proxy = ManagedNetworkAccess::new(3128.try_into().unwrap(), 3128.try_into().unwrap());
    let command = SandboxCommand::new(
        "must-not-start",
        std::iter::empty::<&str>(),
        dir.canonical_path(),
    )
    .with_network_proxy(proxy);

    let error = backend.prepare(&command, policy, &dir).unwrap_err();

    assert!(matches!(error, SandboxError::UnsupportedPolicy(_)));
    assert!(error.to_string().contains("inbound private-network"));
}

#[cfg(target_os = "windows")]
#[test]
fn managed_psec_rejection_keeps_the_policy_unchanged_for_the_account_candidate() {
    struct AccountCandidate {
        seen: std::sync::Arc<std::sync::Mutex<Vec<SandboxPolicy>>>,
    }

    impl SandboxBackend for AccountCandidate {
        fn kind(&self) -> SandboxKind {
            SandboxKind::Restricted
        }

        fn prepare(
            &self,
            command: &SandboxCommand,
            policy: SandboxPolicy,
            _: &Dir,
        ) -> Result<PreparedCommand, SandboxError> {
            self.seen.lock().unwrap().push(policy);
            if policy.file_system_isolation() == FileSystemIsolation::Strict {
                return Err(SandboxError::UnsupportedPolicy(
                    "the account candidate cannot satisfy Strict".into(),
                ));
            }
            Ok(PreparedCommand::new(
                SandboxKind::Restricted,
                command.program(),
                command.arguments(),
                command.working_directory(),
            ))
        }
    }

    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let proxy = ManagedNetworkAccess::new(3128.try_into().unwrap(), 3128.try_into().unwrap());
    let command = SandboxCommand::new(
        "must-not-start",
        std::iter::empty::<&str>(),
        dir.canonical_path(),
    )
    .with_network_proxy(proxy);
    let seen = std::sync::Arc::new(std::sync::Mutex::new(Vec::new()));
    let backends = SandboxBackends::new(vec![
        (
            "mxc",
            std::sync::Arc::new(MxcSandbox::new(InstallContext::current())),
        ),
        (
            "windows",
            std::sync::Arc::new(AccountCandidate {
                seen: std::sync::Arc::clone(&seen),
            }),
        ),
    ]);
    let account_policy = SandboxPolicy::new(FileSystemAccess::ReadOnly, NetworkAccess::Managed)
        .with_file_system_isolation(FileSystemIsolation::WindowsAccount);

    let prepared = backends.prepare(&command, account_policy, &dir).unwrap();

    assert_eq!(prepared.kind(), SandboxKind::Restricted);
    assert_eq!(seen.lock().unwrap().as_slice(), &[account_policy]);

    let strict_policy = SandboxPolicy::new(FileSystemAccess::ReadOnly, NetworkAccess::Managed);
    let error = backends.prepare(&command, strict_policy, &dir).unwrap_err();
    assert!(matches!(error, SandboxError::BackendUnavailable { .. }));
    assert_eq!(
        seen.lock().unwrap().as_slice(),
        &[account_policy, strict_policy]
    );
}

#[test]
fn processcontainer_requires_its_proxy_constraints_without_relaxing_the_request() {
    let config = serde_json::json!({
        "version": "1.0.0",
        "containment": "processcontainer",
        "process": {"commandLine": "cmd.exe /c exit 0"},
        "network": {"egress": {"default": "deny"}, "ingress": {"default": "deny", "hostLoopback": "deny"}},
        "runtimeConfig": {"networkProxy": "http://127.0.0.1:3128"}
    });
    let mut logger =
        mxc_sdk::mxc_common::logger::Logger::new(mxc_sdk::mxc_common::logger::Mode::Buffer);
    let error = mxc_sdk::mxc_common::config_parser::load_mxc_request_from_json(
        &config.to_string(),
        &mut logger,
    )
    .unwrap_err();
    let message = format!("{error:?}").to_ascii_lowercase();
    assert!(
        message.contains("proxy") && (message.contains("ingress") || message.contains("peer")),
        "{error:?}"
    );
}

#[cfg(target_os = "macos")]
mod execution {
    use super::*;
    use ash_async_utils::CancellationSource;
    use ash_sandboxing::PatternMatchTiming;
    use ash_sandboxing::SandboxDirAccess;
    use ash_sandboxing::SandboxDirGrant;
    use ash_sandboxing::SandboxPathAccess;
    use ash_sandboxing::SandboxPathRule;
    use ash_tool_executor::ApprovalPolicy;
    use ash_tool_executor::ApprovalRequirement;
    use ash_tool_executor::CommandExecutionAuthority;
    use ash_tool_executor::CommandExecutionOutcome;
    use ash_tool_executor::CommandExecutor;
    use ash_tool_executor::CommandInput;
    use ash_tool_executor::CommandOutput;
    use ash_tool_executor::CommandRequest;
    use ash_tool_executor::ExecutionLimits;
    use std::fs;
    use std::time::Duration;
    use std::time::Instant;

    struct Approved;
    impl ApprovalPolicy for Approved {
        fn requirement_for(&self, _: &str) -> ApprovalRequirement {
            ApprovalRequirement::NotRequired
        }
    }

    fn run(
        scope: &SandboxScope,
        policy: SandboxPolicy,
        program: &str,
        arguments: &[String],
    ) -> CommandOutput {
        let executor = CommandExecutor::new(
            scope.command_dir().clone(),
            MxcSandbox::new(InstallContext::current()),
            Approved,
            ExecutionLimits {
                timeout: Duration::from_secs(5),
                max_output_bytes: 16384,
            },
        );
        let result = executor
            .execute_scoped(
                CommandRequest {
                    program: program.into(),
                    arguments: arguments.to_vec(),
                    working_directory: ".".into(),
                    input: CommandInput::Closed,
                },
                CommandExecutionAuthority::Sandboxed(policy),
                &CancellationSource::new().token(),
                Some(scope),
            )
            .unwrap();
        match result {
            CommandExecutionOutcome::Completed(output) => output,
            CommandExecutionOutcome::SandboxDenied(denial) => {
                assert_eq!(
                    denial.replay_safety(),
                    ash_protocol::ToolReplaySafety::MayHaveSideEffects
                );
                CommandOutput {
                    exit_code: match denial.output().exit_status() {
                        ash_protocol::ProcessExitStatus::Code(code) => Some(code),
                        _ => None,
                    },
                    stdout: denial.output().stdout().to_owned(),
                    stderr: denial.output().stderr().to_owned(),
                    stdout_truncated: false,
                    stderr_truncated: false,
                }
            }
        }
    }

    #[test]
    fn workspace_git_runs_with_a_continuous_env_denial() {
        let temp = tempfile::tempdir().unwrap();
        let initialized = std::process::Command::new("/usr/bin/git")
            .args(["init", "--quiet"])
            .current_dir(temp.path())
            .output()
            .unwrap();
        assert!(initialized.status.success(), "{initialized:?}");
        fs::write(temp.path().join(".gitignore"), "build/\n").unwrap();
        let build = temp.path().join("build");
        fs::create_dir(&build).unwrap();
        for index in 0..50_001 {
            fs::File::create(build.join(format!("entry-{index}"))).unwrap();
        }
        let dir = Dir::open_local(temp.path()).unwrap();
        let scope = SandboxScope::single(dir.clone())
            .with_path_rules(vec![
                SandboxPathRule::pattern(
                    dir,
                    "**/.env",
                    SandboxPathAccess::Denied,
                    PatternMatchTiming::Continuous,
                )
                .unwrap(),
            ])
            .unwrap();
        let policy = SandboxPolicy::new(FileSystemAccess::DirectoryWrite, NetworkAccess::Denied);
        let status = run(
            &scope,
            policy,
            "/usr/bin/git",
            &["status".into(), "--short".into()],
        );
        assert_eq!(status.exit_code, Some(0), "{status:?}");
        let device = run(
            &scope,
            policy,
            "/bin/sh",
            &["-c".into(), "printf output >/dev/null".into()],
        );
        assert_eq!(device.exit_code, Some(0), "{device:?}");

        let path = temp.path().join(".env");
        let gate = temp.path().join("ready");
        let started = temp.path().join("started");
        let writer = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(4);
            while !started.exists() {
                assert!(Instant::now() < deadline, "sandboxed shell did not start");
                std::thread::sleep(Duration::from_millis(10));
            }
            fs::write(path, "private-value").unwrap();
            fs::write(gate, "ready").unwrap();
        });
        let late_read = run(
            &scope,
            policy,
            "/bin/sh",
            &[
                "-c".into(),
                "touch started; while [ ! -e ready ]; do sleep 0.05; done; cat .env".into(),
            ],
        );
        writer.join().unwrap();
        assert_ne!(late_read.exit_code, Some(0), "{late_read:?}");
        assert!(!late_read.stdout.contains("private-value"), "{late_read:?}");

        let linked_read = run(
            &scope,
            policy,
            "/bin/sh",
            &["-c".into(), "ln .env alias && cat alias".into()],
        );
        assert_ne!(linked_read.exit_code, Some(0), "{linked_read:?}");
        assert!(
            !linked_read.stdout.contains("private-value"),
            "{linked_read:?}"
        );
        fs::hard_link(temp.path().join(".env"), temp.path().join("alias-host")).unwrap();
        let command = SandboxCommand::new(
            "/bin/cat",
            ["alias-host"],
            scope.command_dir().canonical_path(),
        );
        let error = MxcSandbox::new(InstallContext::current())
            .prepare_scoped(&command, policy, &scope)
            .unwrap_err();
        assert!(error.to_string().contains("hard links"), "{error:?}");
    }

    #[test]
    fn sdk_preserves_argv_and_cannot_turn_child_output_into_a_launch_denial() {
        let temp = tempfile::tempdir().unwrap();
        let scope = SandboxScope::single(Dir::open_local(temp.path()).unwrap());
        let policy = SandboxPolicy::new(FileSystemAccess::DirectoryWrite, NetworkAccess::Denied);
        let args = vec![
            "%s\\n".into(),
            "argument with spaces".into(),
            "quoted'\"value".into(),
            "$(touch injected)".into(),
            "中文".into(),
        ];
        let output = run(&scope, policy, "/usr/bin/printf", &args);
        assert_eq!(output.exit_code, Some(0), "{output:?}");
        assert_eq!(
            output.stdout,
            "argument with spaces\nquoted'\"value\n$(touch injected)\n中文\n"
        );
        assert!(!temp.path().join("injected").exists());
        let output = run(
            &scope,
            policy,
            "/bin/sh",
            &[
                "-c".into(),
                "printf 'bwrap: sandbox-exec: denied'; exit 125".into(),
            ],
        );
        assert_eq!(output.exit_code, Some(125));
    }

    #[test]
    fn writable_workspace_keeps_an_existing_env_file_unreadable() {
        let temp = tempfile::tempdir().unwrap();
        fs::write(temp.path().join(".env"), "private-value").unwrap();
        fs::write(temp.path().join("public.txt"), "public-value").unwrap();
        let dir = Dir::open_local(temp.path()).unwrap();
        let scope = SandboxScope::single(dir.clone())
            .with_path_rules(vec![
                SandboxPathRule::pattern(
                    dir,
                    "**/.env",
                    SandboxPathAccess::Denied,
                    PatternMatchTiming::PreparationSnapshot,
                )
                .unwrap(),
            ])
            .unwrap();
        let policy = SandboxPolicy::new(FileSystemAccess::DirectoryWrite, NetworkAccess::Denied);

        let public = run(&scope, policy, "/bin/cat", &["public.txt".into()]);
        assert_eq!(
            (public.exit_code, public.stdout.as_str()),
            (Some(0), "public-value")
        );

        let private = run(&scope, policy, "/bin/cat", &[".env".into()]);
        assert!(!private.stdout.contains("private-value"), "{private:?}");
        assert_ne!(private.exit_code, Some(0), "{private:?}");

        let approved = SandboxPolicy::new(FileSystemAccess::FullAccess, NetworkAccess::Allowed);
        let approved_private = run(&scope, approved, "/bin/cat", &[".env".into()]);
        assert!(
            !approved_private.stdout.contains("private-value"),
            "{approved_private:?}"
        );
        assert_ne!(approved_private.exit_code, Some(0), "{approved_private:?}");

        let write = run(
            &scope,
            policy,
            "/bin/sh",
            &["-c".into(), "printf allowed > created.txt".into()],
        );
        assert_eq!(write.exit_code, Some(0), "{write:?}");
        assert_eq!(
            fs::read_to_string(temp.path().join("created.txt")).unwrap(),
            "allowed"
        );
    }

    #[test]
    fn sdk_reopens_only_grants_beneath_hidden_storage_and_protects_metadata() {
        let temp = tempfile::tempdir().unwrap();
        for name in ["work", "reference", "other"] {
            fs::create_dir(temp.path().join(name)).unwrap();
        }
        fs::create_dir(temp.path().join("work/.git")).unwrap();
        fs::write(temp.path().join("reference/input"), "reference").unwrap();
        fs::write(temp.path().join("other/secret"), "secret").unwrap();
        std::os::unix::fs::symlink(temp.path().join("other"), temp.path().join("work/link"))
            .unwrap();
        let work = Dir::open_local(temp.path().join("work")).unwrap();
        let reference = Dir::open_local(temp.path().join("reference")).unwrap();
        let storage = Dir::open_local(temp.path()).unwrap();
        let scope = SandboxScope::new(
            work.clone(),
            vec![
                SandboxDirGrant::new(work.clone(), SandboxDirAccess::ReadWrite),
                SandboxDirGrant::new(reference.clone(), SandboxDirAccess::ReadOnly),
            ],
            vec![storage],
        )
        .unwrap();
        let policy = SandboxPolicy::new(FileSystemAccess::DirectoryWrite, NetworkAccess::Denied);
        let read = run(
            &scope,
            policy,
            "/bin/cat",
            &[reference
                .canonical_path()
                .join("input")
                .display()
                .to_string()],
        );
        assert_eq!(
            (read.exit_code, read.stdout.as_str()),
            (Some(0), "reference"),
            "{read:?}"
        );
        for path in [
            temp.path().join("other/secret"),
            work.canonical_path().join("link/secret"),
        ] {
            assert_ne!(
                run(&scope, policy, "/bin/cat", &[path.display().to_string()]).exit_code,
                Some(0)
            );
        }
        for path in [
            reference.canonical_path().join("write"),
            work.canonical_path().join(".git/write"),
        ] {
            assert_ne!(
                run(
                    &scope,
                    policy,
                    "/usr/bin/touch",
                    &[path.display().to_string()]
                )
                .exit_code,
                Some(0)
            );
            assert!(!path.exists());
        }
        let allowed = work.canonical_path().join("output");
        assert_eq!(
            run(
                &scope,
                policy,
                "/usr/bin/touch",
                &[allowed.display().to_string()]
            )
            .exit_code,
            Some(0)
        );
        assert!(allowed.exists());
    }

    #[test]
    fn sdk_keeps_unix_sockets_closed_even_in_writable_directories() {
        use std::os::unix::net::UnixListener;
        let temp = tempfile::tempdir().unwrap();
        let dir = Dir::open_local(temp.path()).unwrap();
        let path = dir.canonical_path().join("service.sock");
        let listener = UnixListener::bind(&path).unwrap();
        listener.set_nonblocking(true).unwrap();
        let output = run(
            &SandboxScope::single(dir),
            SandboxPolicy::new(FileSystemAccess::DirectoryWrite, NetworkAccess::Denied),
            "/usr/bin/nc",
            &[
                "-w".into(),
                "1".into(),
                "-U".into(),
                path.display().to_string(),
            ],
        );
        assert_ne!(output.exit_code, Some(0));
        assert_eq!(
            listener.accept().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
    }

    #[test]
    fn sdk_process_handle_terminates_background_children_before_proxy_release() {
        let temp = tempfile::tempdir().unwrap();
        let scope = SandboxScope::single(Dir::open_local(temp.path()).unwrap());
        let output = run(
            &scope,
            SandboxPolicy::new(FileSystemAccess::DirectoryWrite, NetworkAccess::Denied),
            "/bin/sh",
            &[
                "-c".into(),
                "(sleep 0.3; touch escaped) & printf completed".into(),
            ],
        );
        assert_eq!(output.exit_code, Some(0), "{output:?}");
        assert_eq!(output.stdout, "completed");
        std::thread::sleep(Duration::from_millis(450));
        assert!(!temp.path().join("escaped").exists());
    }
    #[test]
    fn sdk_cancellation_and_timeout_stop_the_process_tree() {
        for cancel in [true, false] {
            let temp = tempfile::tempdir().unwrap();
            let dir = Dir::open_local(temp.path()).unwrap();
            let marker = temp.path().join("ready");
            let executor = CommandExecutor::new(
                dir,
                MxcSandbox::new(InstallContext::current()),
                Approved,
                ExecutionLimits {
                    timeout: if cancel {
                        Duration::from_secs(4)
                    } else {
                        Duration::from_millis(150)
                    },
                    max_output_bytes: 4096,
                },
            );
            let source = CancellationSource::new();
            let token = source.token();
            let thread = std::thread::spawn(move || {
                executor.execute(
                    CommandRequest {
                        program: "/bin/sh".into(),
                        arguments: vec![
                            "-c".into(),
                            "(sleep 0.5; touch escaped) & touch ready; sleep 10".into(),
                        ],
                        working_directory: ".".into(),
                        input: CommandInput::Closed,
                    },
                    CommandExecutionAuthority::Sandboxed(SandboxPolicy::new(
                        FileSystemAccess::DirectoryWrite,
                        NetworkAccess::Denied,
                    )),
                    &token,
                )
            });
            if cancel {
                let deadline = std::time::Instant::now() + Duration::from_secs(3);
                while !marker.exists() {
                    assert!(std::time::Instant::now() < deadline);
                    std::thread::sleep(Duration::from_millis(5));
                }
                source.cancel();
            }
            let result = thread.join().unwrap();
            if cancel {
                assert!(
                    matches!(
                        result,
                        Err(ash_tool_executor::ExecutionError::CancelledAfterStart(_))
                    ),
                    "{result:?}"
                );
            } else {
                assert!(
                    matches!(result, Err(ash_tool_executor::ExecutionError::TimedOut)),
                    "{result:?}"
                );
            }
            std::thread::sleep(Duration::from_millis(550));
            assert!(!temp.path().join("escaped").exists());
        }
    }
    #[test]
    fn sdk_proxy_environment_keeps_socks_routing_and_explicitly_clears_bypass() {
        let temp = tempfile::tempdir().unwrap();
        let dir = Dir::open_local(temp.path()).unwrap();
        let executor = CommandExecutor::new(
            dir,
            MxcSandbox::new(InstallContext::current()),
            Approved,
            ExecutionLimits {
                timeout: Duration::from_secs(3),
                max_output_bytes: 4096,
            },
        );
        let network = network_proxy::NetworkPolicyHandle::new(|_, _| async {
            network_proxy::NetworkDecision::Deny("no request expected".into())
        });
        let outcome = executor.execute_scoped_with_network(CommandRequest {
            program: "/bin/sh".into(),
            arguments: vec!["-c".into(), "test \"${NO_PROXY+x}\" = x || exit 7; printf '%s\\n' \"$HTTP_PROXY\" \"$HTTPS_PROXY\" \"$ALL_PROXY\" \"$NO_PROXY\" \"$WS_PROXY\"".into()],
            working_directory: ".".into(), input: CommandInput::Closed,
        }, CommandExecutionAuthority::Sandboxed(SandboxPolicy::new(FileSystemAccess::ReadOnly, NetworkAccess::Managed)), &CancellationSource::new().token(), None, Some(&network)).unwrap();
        let CommandExecutionOutcome::Completed(output) = outcome else {
            panic!("{outcome:?}");
        };
        assert_eq!(output.exit_code, Some(0), "{output:?}");
        let values = output.stdout.lines().collect::<Vec<_>>();
        assert_eq!(values.len(), 5, "{output:?}");
        let endpoint = values[0].strip_prefix("http://").unwrap();
        assert_eq!(
            values,
            [
                values[0],
                values[0],
                &format!("socks5h://{endpoint}"),
                "",
                values[0]
            ]
        );
    }

    #[test]
    fn nested_readonly_paths_cannot_move_out_of_their_restrictions() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join(".github/workflows")).unwrap();
        fs::create_dir(temp.path().join("free")).unwrap();
        fs::write(
            temp.path().join(".github/workflows/release.yml"),
            "original",
        )
        .unwrap();
        let dir = Dir::open_local(temp.path()).unwrap();
        let scope = SandboxScope::single(dir.clone())
            .with_path_rules(vec![
                SandboxPathRule::exact(
                    dir,
                    ".github/workflows/release.yml",
                    SandboxPathAccess::ReadOnly,
                    ash_sandboxing::MissingPathBehavior::Reject,
                )
                .unwrap(),
            ])
            .unwrap();
        let policy = SandboxPolicy::new(FileSystemAccess::DirectoryWrite, NetworkAccess::Denied);
        let output = run(&scope, policy, "/bin/sh", &["-c".into(),
            "mv free free-renamed || exit 1; if mv .github/workflows .github/moved; then exit 2; fi; if mv .github moved; then exit 3; fi; test \"$(cat .github/workflows/release.yml)\" = original".into()]);
        assert_eq!(output.exit_code, Some(0), "{output:?}");
        assert!(temp.path().join("free-renamed").exists());
    }

    #[test]
    fn metadata_names_remain_readonly_before_their_first_creation() {
        let temp = tempfile::tempdir().unwrap();
        let dir = Dir::open_local(temp.path()).unwrap();
        let scope = SandboxScope::single(dir);
        let output = run(&scope, SandboxPolicy::new(FileSystemAccess::DirectoryWrite, NetworkAccess::Denied), "/bin/sh", &["-c".into(),
            "mkdir ordinary || exit 1; for name in .git .agents .codex .ash; do if mkdir \"$name\"; then exit 2; fi; if printf forbidden >\"$name\"; then exit 3; fi; done".into()]);
        assert_eq!(output.exit_code, Some(0), "{output:?}");
        assert!(temp.path().join("ordinary").is_dir());
        for name in ash_sandboxing::PROTECTED_DIR_METADATA_NAMES {
            assert!(!temp.path().join(name).exists());
        }
    }

    #[test]
    fn general_continuous_globs_cover_late_files_and_pin_matching_ancestors() {
        let temp = tempfile::tempdir().unwrap();
        fs::create_dir_all(temp.path().join("config/nested")).unwrap();
        fs::create_dir(temp.path().join("free")).unwrap();
        let dir = Dir::open_local(temp.path()).unwrap();
        let scope = SandboxScope::single(dir.clone())
            .with_path_rules(vec![
                SandboxPathRule::pattern(
                    dir,
                    "config/**/*.{key,pem}",
                    SandboxPathAccess::Denied,
                    PatternMatchTiming::Continuous,
                )
                .unwrap(),
            ])
            .unwrap();
        let root = temp.path().to_owned();
        let writer = std::thread::spawn(move || {
            let deadline = Instant::now() + Duration::from_secs(4);
            while !root.join("started").exists() {
                assert!(Instant::now() < deadline);
                std::thread::sleep(Duration::from_millis(10));
            }
            fs::write(root.join("config/nested/late.key"), "secret").unwrap();
            fs::write(root.join("ready"), "ready").unwrap();
        });
        let output = run(&scope, SandboxPolicy::new(FileSystemAccess::DirectoryWrite, NetworkAccess::Denied), "/bin/sh", &["-c".into(),
            "mv free free-renamed || exit 1; touch started; while [ ! -e ready ]; do sleep 0.05; done; if cat config/nested/late.key; then exit 2; fi; if mv config/nested moved; then exit 3; fi; if printf bad >config/new.pem; then exit 4; fi; printf allowed >config/nested/ordinary.txt".into()]);
        writer.join().unwrap();
        assert_eq!(output.exit_code, Some(0), "{output:?}");
        assert!(!output.stdout.contains("secret"), "{output:?}");
        assert_eq!(
            fs::read_to_string(temp.path().join("config/nested/late.key")).unwrap(),
            "secret"
        );
        assert_eq!(
            fs::read_to_string(temp.path().join("config/nested/ordinary.txt")).unwrap(),
            "allowed"
        );
    }

    // The test process invokes the platform syscalls through Python, keeping
    // unsafe FFI outside this crate's forbid(unsafe_code) boundary.
    const FCNTL_PROBE: &str = r#"
import ctypes, errno, os, sys
lib = ctypes.CDLL(None, use_errno=True)
# Darwin arm64 distinguishes fixed arguments from the variadic argument.
lib.fcntl.argtypes = [ctypes.c_int, ctypes.c_int]
if len(sys.argv) > 1 and sys.argv[1] == 'prepare':
    class Store(ctypes.Structure):
        _fields_ = [('flags', ctypes.c_uint32), ('position', ctypes.c_int),
                    ('offset', ctypes.c_int64), ('length', ctypes.c_int64), ('allocated', ctypes.c_int64)]
    fd = os.open('donor', os.O_RDWR)
    store = Store(4, 3, 0, 65536, 0)
    assert lib.fcntl(fd, 42, ctypes.byref(store)) == 0, ctypes.get_errno()
    os.close(fd)
    sys.exit(0)
denied = open('expectation').read() == 'deny'
fds = [os.open(path, os.O_RDONLY if denied else os.O_RDWR) for path in ['../canary', 'donor', '../receiver']]
if denied:
    try:
        os.open('../canary', os.O_WRONLY)
    except OSError as error:
        assert error.errno == errno.EPERM, error
    else:
        raise AssertionError('ordinary canary write was allowed')
class Attributes(ctypes.Structure):
    _fields_ = [('count', ctypes.c_uint16), ('reserved', ctypes.c_uint16),
                ('common', ctypes.c_uint32), ('volume', ctypes.c_uint32),
                ('directory', ctypes.c_uint32), ('file', ctypes.c_uint32), ('fork', ctypes.c_uint32)]
attributes = Attributes(5, 0, 0x00080000, 0, 0, 0, 0)
generation = (ctypes.c_uint32 * 2)()
assert lib.fgetattrlist(fds[0], ctypes.byref(attributes), generation, ctypes.c_size_t(8), 0x20) == 0, ctypes.get_errno()
assert generation[0] == 8
for fd, selector, argument in [(fds[0], 80, generation[1]), (fds[1], 110, fds[2])]:
    result = lib.fcntl(fd, selector, ctypes.c_uint32(argument))
    error = ctypes.get_errno()
    if denied:
        assert (result, error) == (-1, errno.EPERM), (selector, result, error)
    elif selector == 110 and result == -1 and error == errno.ENOTSUP:
        print('transfer positive control unsupported')
    else:
        assert result == 0, (selector, result, error)
print('fcntl probes completed')
"#;

    #[test]
    fn restricted_filesystems_deny_mutating_fcntls_through_readonly_descriptors() {
        use std::os::macos::fs::MetadataExt;
        #[derive(Debug, PartialEq, Eq)]
        struct Snapshot {
            bytes: Vec<u8>,
            blocks: u64,
            flags: u32,
            modified: (i64, i64),
            changed: (i64, i64),
        }
        fn snapshot(root: &std::path::Path) -> Vec<Snapshot> {
            ["canary", "work/donor", "receiver"]
                .map(|name| {
                    let path = root.join(name);
                    let metadata = fs::metadata(&path).unwrap();
                    Snapshot {
                        bytes: fs::read(path).unwrap(),
                        blocks: metadata.st_blocks(),
                        flags: metadata.st_flags(),
                        modified: (metadata.st_mtime(), metadata.st_mtime_nsec()),
                        changed: (metadata.st_ctime(), metadata.st_ctime_nsec()),
                    }
                })
                .into()
        }
        for access in [
            None,
            Some(FileSystemAccess::ReadOnly),
            Some(FileSystemAccess::DirectoryWrite),
            Some(FileSystemAccess::FullAccess),
        ] {
            let temp = tempfile::tempdir().unwrap();
            fs::create_dir(temp.path().join("work")).unwrap();
            fs::write(temp.path().join("canary"), "outside canary").unwrap();
            fs::write(temp.path().join("receiver"), []).unwrap();
            fs::write(
                temp.path().join("work/expectation"),
                if access.is_some() { "deny" } else { "allow" },
            )
            .unwrap();
            // Retain the file until after verification so closing the helper
            // does not release its unused preallocation beyond EOF.
            let donor = fs::File::create(temp.path().join("work/donor")).unwrap();
            let prepared = std::process::Command::new("/usr/bin/python3")
                .args(["-c", FCNTL_PROBE, "prepare"])
                .current_dir(temp.path().join("work"))
                .output()
                .unwrap();
            assert!(prepared.status.success(), "{prepared:?}");
            let before = snapshot(temp.path());
            assert!(before[1].blocks > 0);
            let arguments = ["-c".into(), FCNTL_PROBE.into()];
            let (status, stdout, stderr) = match access {
                None => {
                    let output = std::process::Command::new("/usr/bin/python3")
                        .args(&arguments)
                        .current_dir(temp.path().join("work"))
                        .output()
                        .unwrap();
                    (
                        output.status.code(),
                        String::from_utf8(output.stdout).unwrap(),
                        String::from_utf8(output.stderr).unwrap(),
                    )
                }
                Some(access) => {
                    let (scope, arguments) = if access == FileSystemAccess::FullAccess {
                        let dir = Dir::open_local(temp.path()).unwrap();
                        let scope = SandboxScope::single(dir.clone())
                            .with_path_rules(vec![
                                SandboxPathRule::pattern(
                                    dir,
                                    "**/{canary,donor,receiver}",
                                    SandboxPathAccess::ReadOnly,
                                    PatternMatchTiming::Continuous,
                                )
                                .unwrap(),
                            ])
                            .unwrap();
                        (
                            scope,
                            [
                                "-c".into(),
                                format!("import os; os.chdir('work')\n{FCNTL_PROBE}"),
                            ],
                        )
                    } else {
                        let dir = Dir::open_local(temp.path().join("work")).unwrap();
                        (SandboxScope::single(dir), arguments)
                    };
                    let output = run(
                        &scope,
                        SandboxPolicy::new(access, NetworkAccess::Denied),
                        "/usr/bin/python3",
                        &arguments,
                    );
                    (output.exit_code, output.stdout, output.stderr)
                }
            };
            assert_eq!(status, Some(0), "{access:?}: {stdout}; {stderr}");
            assert!(stdout.contains("fcntl probes completed"));
            let after = snapshot(temp.path());
            if access.is_some() {
                assert_eq!(after, before, "restricted fcntls changed canaries");
            } else {
                assert!(
                    after[0].bytes.is_empty(),
                    "positive compression control must truncate"
                );
            }
            drop(donor);
        }
    }
}

#[cfg(target_os = "macos")]
#[test]
fn restricted_pty_uses_the_sdk_without_a_host_helper() {
    let temp = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(temp.path()).unwrap();
    let backend = MxcSandbox::new(InstallContext::current());
    let command = SandboxCommand::new(
        "/bin/sh",
        ["-c", "test -t 0 && test -t 1"],
        dir.canonical_path(),
    )
    .with_pty(ash_utils_pty::TerminalSize { rows: 24, cols: 80 });
    let policy = SandboxPolicy::new(FileSystemAccess::ReadOnly, NetworkAccess::Denied);
    let mut process = backend
        .prepare(&command, policy, &dir)
        .unwrap()
        .spawn(&[])
        .unwrap();
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    let status = loop {
        if let Some(status) = process.try_wait().unwrap() {
            break status;
        }
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(std::time::Duration::from_millis(10));
    };
    assert_eq!(status, ash_sandboxing::SandboxProcessExitStatus::Code(0));
}

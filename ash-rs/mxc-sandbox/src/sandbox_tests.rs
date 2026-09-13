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
    let mut egress = mxc_sdk::NetworkEgressSection::default();
    egress.default = Some(mxc_sdk::NetworkAction::Deny);
    let mut ingress = mxc_sdk::NetworkIngressSection::default();
    ingress.default = Some(mxc_sdk::NetworkAction::Deny);
    ingress.host_loopback = Some(mxc_sdk::NetworkAction::Deny);
    let mut runtime = mxc_sdk::RuntimeConfigSection::default();
    runtime.network_proxy = Some("http://127.0.0.1:3128".into());
    let mut network = mxc_sdk::policy::NetworkSection::default();
    network.egress = Some(egress);
    network.ingress = Some(ingress);
    network.runtime_config = Some(runtime);
    let policy = mxc_sdk::SandboxPolicy {
        version: "0.8.0-alpha".into(),
        filesystem: None,
        network: Some(network),
        ui: None,
        timeout_ms: None,
    };
    let error = mxc_sdk::build_request_with_containment(
        &policy,
        &mxc_sdk::Containment::ProcessContainer(Default::default()),
        None,
    )
    .unwrap_err();
    let message = error.to_string().to_ascii_lowercase();
    assert!(
        message.contains("proxy") && (message.contains("ingress") || message.contains("peer")),
        "{error}"
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
}

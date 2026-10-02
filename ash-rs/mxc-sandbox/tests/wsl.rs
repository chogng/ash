//! Real WSL2 execution, including Windows-drive grants and executable interop.
#![cfg(target_os = "linux")]

use ash_async_utils::CancellationSource;
use ash_file_access::Dir;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::SandboxDirAccess;
use ash_sandboxing::SandboxDirGrant;
use ash_sandboxing::SandboxPolicy;
use ash_sandboxing::SandboxScope;
use ash_tool_executor::ApprovalPolicy;
use ash_tool_executor::ApprovalRequirement;
use ash_tool_executor::CommandExecutionAuthority;
use ash_tool_executor::CommandExecutionOutcome;
use ash_tool_executor::CommandExecutor;
use ash_tool_executor::CommandInput;
use ash_tool_executor::CommandRequest;
use ash_tool_executor::ExecutionError;
use ash_tool_executor::ExecutionLimits;
use mxc_sandbox::MxcSandbox;
use network_proxy::NetworkDecision;
use network_proxy::NetworkPolicyHandle;
use std::path::Path;
use std::time::Duration;

struct Approved;
impl ApprovalPolicy for Approved {
    fn requirement_for(&self, _: &str) -> ApprovalRequirement {
        ApprovalRequirement::NotRequired
    }
}

fn executor(scope: &SandboxScope, timeout: Duration) -> CommandExecutor<Approved, MxcSandbox> {
    CommandExecutor::new(
        scope.command_dir().clone(),
        MxcSandbox::new(ash_install_context::InstallContext::current()),
        Approved,
        ExecutionLimits {
            timeout,
            max_output_bytes: 16384,
        },
    )
}

fn shell(script: String) -> CommandRequest {
    CommandRequest {
        program: "/bin/sh".into(),
        arguments: vec!["-c".into(), script],
        working_directory: ".".into(),
        input: CommandInput::Closed,
    }
}

fn literal(path: &Path) -> String {
    format!("'{}'", path.to_str().unwrap().replace('\'', "'\"'\"'"))
}

#[test]
#[ignore = "requires WSL2, Bubblewrap and a configured TMPDIR on the filesystem under test"]
fn scoped_files_metadata_and_exit_code_survive_wsl_mounts() {
    let temp = tempfile::tempdir().unwrap();
    for name in ["work", "reference", "other"] {
        std::fs::create_dir(temp.path().join(name)).unwrap();
    }
    std::fs::create_dir(temp.path().join("work/.git")).unwrap();
    std::fs::write(temp.path().join("work/.git/config"), "metadata").unwrap();
    std::fs::write(temp.path().join("reference/input"), "reference").unwrap();
    std::fs::write(temp.path().join("other/secret"), "private").unwrap();
    std::os::unix::fs::symlink(temp.path().join("other"), temp.path().join("work/link")).unwrap();
    let work = Dir::open_local(temp.path().join("work")).unwrap();
    let reference = Dir::open_local(temp.path().join("reference")).unwrap();
    let scope = SandboxScope::new(
        work.clone(),
        vec![
            SandboxDirGrant::new(work.clone(), SandboxDirAccess::ReadWrite),
            SandboxDirGrant::new(reference.clone(), SandboxDirAccess::ReadOnly),
        ],
        vec![Dir::open_local(temp.path()).unwrap()],
    )
    .unwrap();
    let script = format!(
        "set -eu; printf allowed >output; test \"$(cat {})\" = reference; \
         if cat {} 2>/dev/null; then exit 10; fi; \
         if cat link/secret 2>/dev/null; then exit 11; fi; \
         if (printf bad >{}) 2>/dev/null; then exit 12; fi; \
         if (printf bad >.git/config) 2>/dev/null; then exit 13; fi; \
         test \"$(cat .git/config)\" = metadata; printf scoped-wsl-ok; exit 125",
        literal(&reference.canonical_path().join("input")),
        literal(&temp.path().join("other/secret")),
        literal(&reference.canonical_path().join("modified")),
    );
    let result = executor(&scope, Duration::from_secs(15))
        .execute_scoped(
            shell(script),
            CommandExecutionAuthority::Sandboxed(SandboxPolicy::new(
                FileSystemAccess::DirectoryWrite,
                NetworkAccess::Denied,
            )),
            &CancellationSource::new().token(),
            Some(&scope),
        )
        .unwrap();
    let CommandExecutionOutcome::Completed(output) = result else {
        panic!("{result:?}");
    };
    assert_eq!(output.exit_code, Some(125), "{output:?}");
    assert!(output.stdout.contains("scoped-wsl-ok"), "{output:?}");
    assert_eq!(
        std::fs::read_to_string(work.canonical_path().join("output")).unwrap(),
        "allowed"
    );
    assert_eq!(
        std::fs::read_to_string(work.canonical_path().join(".git/config")).unwrap(),
        "metadata"
    );
    assert_eq!(
        std::fs::read_to_string(temp.path().join("other/secret")).unwrap(),
        "private"
    );
    assert!(!reference.canonical_path().join("modified").exists());
}

#[test]
#[ignore = "requires WSL2 and Bubblewrap"]
fn normal_exit_timeout_and_cancellation_reap_wsl_descendants() {
    for mode in ["exit", "timeout", "cancel"] {
        let temp = tempfile::tempdir().unwrap();
        let scope = SandboxScope::single(Dir::open_local(temp.path()).unwrap());
        let timeout = if mode == "timeout" {
            Duration::from_secs(1)
        } else {
            Duration::from_secs(10)
        };
        let executor = executor(&scope, timeout);
        let source = CancellationSource::new();
        let token = source.token();
        let script = format!(
            "(sleep 2; printf escaped >late) & printf ready >ready; {}",
            if mode == "exit" { "exit 0" } else { "sleep 20" }
        );
        // PID values inside the sandbox belong to its private namespace. A
        // delayed write checks that descendants cannot keep acting after close.
        let task = std::thread::spawn(move || {
            executor.execute(
                shell(script),
                CommandExecutionAuthority::Sandboxed(SandboxPolicy::new(
                    FileSystemAccess::DirectoryWrite,
                    NetworkAccess::Denied,
                )),
                &token,
            )
        });
        if mode == "cancel" {
            let deadline = std::time::Instant::now() + Duration::from_secs(8);
            while !temp.path().join("ready").exists() {
                assert!(
                    std::time::Instant::now() < deadline,
                    "WSL workload did not start"
                );
                std::thread::sleep(Duration::from_millis(10));
            }
            source.cancel();
        }
        let result = task.join().unwrap();
        match (mode, result) {
            ("exit", Ok(CommandExecutionOutcome::Completed(output))) => {
                assert_eq!(output.exit_code, Some(0), "{output:?}")
            }
            ("timeout", Err(ExecutionError::TimedOut))
            | ("cancel", Err(ExecutionError::CancelledAfterStart(_))) => {}
            (_, result) => panic!("{mode}: {result:?}"),
        }
        assert!(
            temp.path().join("ready").exists(),
            "the lifecycle assertion requires a started workload"
        );
        std::thread::sleep(Duration::from_millis(2200));
        assert!(
            !temp.path().join("late").exists(),
            "{mode} left a WSL descendant running"
        );
    }
}

#[test]
#[ignore = "requires WSL2 executable interop, Bubblewrap and ASH_WSL_WINDOWS_PROGRAM"]
fn readable_windows_executable_cannot_escape_linux_sandbox_via_interop() {
    let program =
        std::env::var("ASH_WSL_WINDOWS_PROGRAM").expect("provide the Windows cmd.exe path in WSL");
    let program = Path::new(&program);
    let control = std::process::Command::new(program)
        .args(["/d", "/c", "echo windows-interop-started"])
        .output()
        .unwrap();
    assert!(control.status.success(), "{control:?}");
    assert!(String::from_utf8_lossy(&control.stdout).contains("windows-interop-started"));
    let temp = tempfile::tempdir().unwrap();
    let work = Dir::open_local(temp.path()).unwrap();
    let scope = SandboxScope::new(
        work.clone(),
        vec![
            SandboxDirGrant::new(work, SandboxDirAccess::ReadWrite),
            SandboxDirGrant::new(
                Dir::open_local(program.parent().unwrap()).unwrap(),
                SandboxDirAccess::ReadOnly,
            ),
        ],
        vec![],
    )
    .unwrap();
    // The executable is readable by an explicit grant. Rejection must come from
    // the execution boundary, not merely from hiding the Windows drive mount.
    let script = format!(
        "test -r {0} || exit 8; if {0} /d /c 'echo windows-interop-started'; then exit 9; fi; printf interop-denied",
        literal(program)
    );
    // Bubblewrap supports Ash's denied and managed network policies. Allowed
    // also requires unrestricted ingress, which this SDK backend rejects.
    for network in [NetworkAccess::Denied, NetworkAccess::Managed] {
        let network_policy = (network == NetworkAccess::Managed).then(|| {
            NetworkPolicyHandle::new(|_, _| async {
                NetworkDecision::Deny("interop test denies external traffic".into())
            })
        });
        let result = executor(&scope, Duration::from_secs(15))
            .execute_scoped_with_network(
                shell(script.clone()),
                CommandExecutionAuthority::Sandboxed(SandboxPolicy::new(
                    FileSystemAccess::DirectoryWrite,
                    network,
                )),
                &CancellationSource::new().token(),
                Some(&scope),
                network_policy.as_ref(),
            )
            .unwrap();
        let CommandExecutionOutcome::Completed(output) = result else {
            panic!("{result:?}")
        };
        assert_eq!(output.exit_code, Some(0), "{output:?}");
        assert!(output.stdout.contains("interop-denied"), "{output:?}");
        assert!(
            !output.stdout.contains("windows-interop-started"),
            "{output:?}"
        );
    }
}

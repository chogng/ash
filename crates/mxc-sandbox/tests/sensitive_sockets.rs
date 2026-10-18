//! Opt-in checks against real services, with an ordinary-process control first.
#![cfg(unix)]

use ash_async_utils::CancellationSource;
use ash_file_access::Dir;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::SandboxBackend;
use ash_sandboxing::SandboxCommand;
use ash_sandboxing::SandboxPolicy;
use ash_sandboxing::SandboxProcessExitStatus;
use ash_tool_executor::ApprovalPolicy;
use ash_tool_executor::ApprovalRequirement;
use ash_tool_executor::CommandExecutionAuthority;
use ash_tool_executor::CommandExecutionOutcome;
use ash_tool_executor::CommandExecutor;
use ash_tool_executor::CommandInput;
use ash_tool_executor::CommandRequest;
use ash_tool_executor::ExecutionLimits;
use mxc_sandbox::MxcSandbox;
use std::io::Read;
use std::process::Command;
use std::time::Duration;

struct Approved;

impl ApprovalPolicy for Approved {
    fn requirement_for(&self, _: &str) -> ApprovalRequirement {
        ApprovalRequirement::NotRequired
    }
}

fn assert_service_denied(program: &str, arguments: Vec<String>, expected: &str) {
    let ordinary = Command::new(program).args(&arguments).output().unwrap();
    assert!(
        ordinary.status.success(),
        "ordinary service control: {ordinary:?}"
    );
    assert!(
        String::from_utf8_lossy(&ordinary.stdout).contains(expected),
        "ordinary service response: {ordinary:?}"
    );

    let directory = tempfile::tempdir().unwrap();
    let executor = CommandExecutor::new(
        Dir::open_local(directory.path()).unwrap(),
        MxcSandbox::new(ash_install_context::InstallContext::current()),
        Approved,
        ExecutionLimits {
            timeout: Duration::from_secs(10),
            max_output_bytes: 8192,
        },
    );
    let outcome = executor
        .execute(
            CommandRequest {
                program: program.into(),
                arguments,
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
    let (succeeded, stderr) = match &outcome {
        CommandExecutionOutcome::Completed(output) => {
            (output.exit_code == Some(0), output.stderr.as_str())
        }
        CommandExecutionOutcome::SandboxDenied(denial) => (
            denial.output().exit_status() == ash_protocol::ProcessExitStatus::Code(0),
            denial.output().stderr(),
        ),
    };
    assert!(!succeeded, "service escaped sandbox: {outcome:?}");
    assert!(
        stderr.contains("connect"),
        "probe failed before connecting: {outcome:?}"
    );
}

#[test]
#[ignore = "requires a real reachable Docker daemon at /var/run/docker.sock"]
fn docker_daemon_is_reachable_only_outside_the_sandbox() {
    assert_service_denied(
        "/usr/bin/curl",
        [
            "--silent",
            "--show-error",
            "--fail",
            "--max-time",
            "5",
            "--noproxy",
            "*",
            "--unix-socket",
            "/var/run/docker.sock",
            "http://localhost/_ping",
        ]
        .map(str::to_owned)
        .to_vec(),
        "OK",
    );
}

#[test]
#[ignore = "requires an isolated real GPG agent and ASH_SANDBOX_GPG_SOCKET set to its socket"]
fn gpg_agent_is_reachable_only_outside_the_sandbox() {
    let socket = std::env::var("ASH_SANDBOX_GPG_SOCKET")
        .expect("set ASH_SANDBOX_GPG_SOCKET to the test agent socket");
    assert_service_denied(
        "/usr/bin/gpg-connect-agent",
        vec![
            "--raw-socket".into(),
            socket,
            "GETINFO version".into(),
            "/bye".into(),
        ],
        "OK",
    );
}

#[test]
#[ignore = "requires an isolated real GPG agent and ASH_SANDBOX_GPG_SOCKET set to its socket"]
fn gpg_agent_remains_denied_without_legacy_agent_info() {
    // Isolate environment changes from the parallel test harness. Modern GPG
    // clients locate their agent without the deprecated GPG_AGENT_INFO variable.
    let child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "gpg_agent_is_reachable_only_outside_the_sandbox",
            "--ignored",
            "--nocapture",
        ])
        .env_remove("GPG_AGENT_INFO")
        .output()
        .unwrap();
    assert!(child.status.success(), "modern GPG socket probe: {child:?}");
}

#[test]
#[ignore = "requires an isolated real GPG agent and ASH_SANDBOX_GPG_SOCKET set to its socket"]
fn gpg_agent_from_the_final_workload_environment_stays_denied() {
    const CHILD: &str = "ASH_SANDBOX_GPG_SPAWN_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "gpg_agent_from_the_final_workload_environment_stays_denied",
                "--ignored",
                "--nocapture",
            ])
            .env_remove("GPG_AGENT_INFO")
            .env_remove("GNUPGHOME")
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(child.status.success(), "spawn environment probe: {child:?}");
        return;
    }
    let socket = std::path::PathBuf::from(std::env::var_os("ASH_SANDBOX_GPG_SOCKET").unwrap());
    let arguments = [
        "--raw-socket",
        socket.to_str().unwrap(),
        "GETINFO version",
        "/bye",
    ];
    let ordinary = Command::new("/usr/bin/gpg-connect-agent")
        .args(arguments)
        .output()
        .unwrap();
    assert!(
        ordinary.status.success(),
        "ordinary agent control: {ordinary:?}"
    );
    assert!(String::from_utf8_lossy(&ordinary.stdout).contains("OK"));
    let work = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(work.path()).unwrap();
    let command = SandboxCommand::new(
        "/usr/bin/gpg-connect-agent",
        arguments,
        dir.canonical_path(),
    );
    let prepared = MxcSandbox::new(ash_install_context::InstallContext::current())
        .prepare(
            &command,
            SandboxPolicy::new(FileSystemAccess::ReadOnly, NetworkAccess::Denied),
            &dir,
        )
        .unwrap();
    // The service has no GNUPGHOME. Only the final workload environment names
    // this agent, so prepare-time environment discovery cannot protect it.
    let mut child = prepared
        .spawn(&[(
            "GNUPGHOME".into(),
            socket.parent().unwrap().to_str().unwrap().into(),
        )])
        .unwrap();
    drop(child.take_stdin());
    let mut stderr = child.take_stderr().unwrap();
    let errors = std::thread::spawn(move || {
        let mut text = String::new();
        stderr.read_to_string(&mut text).unwrap();
        text
    });
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    let status = loop {
        if let Some(status) = child.try_wait().unwrap() {
            break status;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "agent probe did not exit"
        );
        std::thread::sleep(Duration::from_millis(10));
    };
    let errors = errors.join().unwrap();
    assert_ne!(status, SandboxProcessExitStatus::Code(0), "{errors}");
    assert!(errors.contains("connect"), "{errors}");
}

use ash_async_utils::CancellationSource;
use ash_file_access::Dir;
use ash_install_context::InstallContext;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::NetworkAccess;
use ash_sandboxing::SandboxPolicy;
use ash_sandboxing::SandboxScope;
use ash_tool_executor::ApprovalPolicy;
use ash_tool_executor::ApprovalRequirement;
use ash_tool_executor::CommandExecutionAuthority;
use ash_tool_executor::CommandExecutionOutcome;
use ash_tool_executor::CommandExecutor;
use ash_tool_executor::CommandInput;
use ash_tool_executor::CommandOutput;
use ash_tool_executor::CommandRequest;
use ash_tool_executor::ExecutionLimits;
use mxc_sandbox::MxcSandbox;
use std::path::Path;
use std::process::Command;
use std::time::Duration;
use std::time::Instant;

struct Approved;

impl ApprovalPolicy for Approved {
    fn requirement_for(&self, _: &str) -> ApprovalRequirement {
        ApprovalRequirement::NotRequired
    }
}

pub(super) fn scope(path: &Path) -> SandboxScope {
    SandboxScope::single(Dir::open_local(path).unwrap())
}

pub(super) fn run(
    scope: &SandboxScope,
    access: FileSystemAccess,
    program: &Path,
    arguments: Vec<String>,
    input: CommandInput,
) -> Result<CommandOutput, String> {
    run_authorized(
        scope,
        CommandExecutionAuthority::Sandboxed(SandboxPolicy::new(access, NetworkAccess::Denied)),
        program,
        arguments,
        input,
    )
}

pub(super) fn run_control(
    scope: &SandboxScope,
    program: &Path,
    arguments: Vec<String>,
    input: CommandInput,
) -> Result<CommandOutput, String> {
    run_authorized(
        scope,
        CommandExecutionAuthority::Unrestricted,
        program,
        arguments,
        input,
    )
}

fn run_authorized(
    scope: &SandboxScope,
    authority: CommandExecutionAuthority,
    program: &Path,
    arguments: Vec<String>,
    input: CommandInput,
) -> Result<CommandOutput, String> {
    let executor = CommandExecutor::new(
        scope.command_dir().clone(),
        MxcSandbox::new(InstallContext::current()),
        Approved,
        ExecutionLimits {
            timeout: Duration::from_secs(5),
            max_output_bytes: 16384,
        },
    );
    let started = Instant::now();
    let result = executor.execute_scoped(
        CommandRequest {
            program: program.to_str().unwrap().into(),
            arguments,
            working_directory: ".".into(),
            input,
        },
        authority,
        &CancellationSource::new().token(),
        Some(scope),
    );
    eprintln!(
        "sandbox probe {program:?} ({authority:?}): {:?}",
        started.elapsed()
    );
    match result {
        Ok(CommandExecutionOutcome::Completed(output)) => Ok(output),
        Ok(CommandExecutionOutcome::SandboxDenied(denial)) => Err(format!("{denial:?}")),
        Err(error) => Err(format!("{program:?} ({authority:?}): {error:?}")),
    }
}

// Sample outside confinement so diagnostics do not require widening the child
// policy. The completion channel stops the monitor on every success/error path.
pub(super) fn diagnose_slow_run<T>(run: impl FnOnce() -> T) -> T {
    std::thread::scope(|threads| {
        let (finished, waiting) = std::sync::mpsc::channel();
        threads.spawn(move || {
            if waiting.recv_timeout(Duration::from_secs(2)).is_ok() {
                return;
            }
            let listing = Command::new("/bin/ps")
                .args(["-axo", "pid,ppid,comm"])
                .output()
                .unwrap();
            let listing = String::from_utf8_lossy(&listing.stdout);
            let parent = std::process::id().to_string();
            let records: Vec<_> = listing
                .lines()
                .map(|line| line.split_whitespace().collect::<Vec<_>>())
                .filter(|fields| fields.len() >= 3)
                .collect();
            let mut descendants = vec![parent.as_str()];
            loop {
                let before = descendants.len();
                for fields in &records {
                    if descendants.contains(&fields[1]) && !descendants.contains(&fields[0]) {
                        descendants.push(fields[0]);
                    }
                }
                if descendants.len() == before {
                    break;
                }
            }
            eprintln!("slow process tree:");
            for fields in &records {
                if descendants.contains(&fields[0]) {
                    eprintln!("{} {} {}", fields[0], fields[1], fields[2..].join(" "));
                }
            }
            // Sample the pipe's producer before its waiting parent; sampling a
            // wrapper alone only shows the blocked read, not why it is waiting.
            for pid in descendants.into_iter().skip(1).rev().take(4) {
                for (tool, arguments) in [
                    ("/usr/sbin/lsof", vec!["-n", "-P", "-p", pid]),
                    ("/usr/bin/sample", vec![pid, "1"]),
                ] {
                    let output = Command::new(tool).args(arguments).output().unwrap();
                    eprintln!(
                        "slow child {} via {tool}:\n{}\n{}",
                        pid,
                        String::from_utf8_lossy(&output.stdout),
                        String::from_utf8_lossy(&output.stderr)
                    );
                }
            }
        });
        let result = run();
        let _ = finished.send(());
        result
    })
}

#[cfg(unix)]
use futures::executor::block_on;

use super::ProcessCommand;
use super::ProcessFileSystemAccess;
#[cfg(unix)]
use super::ProcessHandle;
use super::ProcessNetworkAccess;
use super::ProcessSandbox;
use super::ProcessSandboxError;
use super::ProcessSandboxPolicy;
use super::ProcessService;
use super::SystemProcesses;

#[test]
fn process_commands_preserve_literal_program_and_argument_boundaries() {
    let command = ProcessCommand::new("tool")
        .with_argument("argument with spaces")
        .with_argument("$(not-a-shell)")
        .with_clean_environment();
    assert_eq!(command.program().to_string_lossy(), "tool");
    assert_eq!(command.arguments()[0], "argument with spaces");
    assert_eq!(command.arguments()[1], "$(not-a-shell)");
}

#[cfg(unix)]
#[test]
fn system_processes_report_successful_child_completion() {
    let process = block_on(
        ProcessHandle::new(SystemProcesses::default()).spawn(ProcessCommand::new("/usr/bin/true")),
    )
    .unwrap();
    let exit = block_on(process.wait()).unwrap();
    assert!(exit.success);
    assert_eq!(exit.code, Some(0));
}

#[cfg(unix)]
#[test]
fn asynchronous_wait_does_not_prevent_process_termination() {
    let process = SystemProcesses::default()
        .spawn(ProcessCommand::new("/bin/sleep").with_argument("10"))
        .unwrap();
    let exit = process.wait();

    std::thread::sleep(std::time::Duration::from_millis(30));
    process.terminate().unwrap();

    assert!(!block_on(exit).unwrap().success);
}

#[test]
fn restricted_policy_cannot_silently_fall_back_to_an_unrestricted_process() {
    let directory = tempfile::tempdir().unwrap();
    let command = ProcessCommand::new("unused")
        .with_current_directory(directory.path())
        .with_sandbox(ProcessSandboxPolicy::new(
            ProcessFileSystemAccess::ReadOnly,
            ProcessNetworkAccess::Denied,
        ));
    let result = SystemProcesses::new()
        .with_sandbox(WeakSandbox)
        .spawn(command);
    assert!(result.is_err());
}

#[test]
fn bubblewrap_preparation_materializes_mount_and_network_authority() {
    let directory = tempfile::tempdir().unwrap();
    let working_directory = directory.path().canonicalize().unwrap();
    let command = ProcessCommand::new("tool")
        .with_argument("literal argument")
        .with_current_directory(&working_directory);
    let prepared = super::sandbox::prepare_linux(
        std::path::Path::new("/usr/bin/bwrap"),
        &command,
        ProcessSandboxPolicy::new(
            ProcessFileSystemAccess::WorkingDirectoryWrite,
            ProcessNetworkAccess::Denied,
        ),
        working_directory.clone(),
    );
    assert_eq!(prepared.kind(), super::ProcessSandboxKind::LinuxBubblewrap);
    assert_eq!(prepared.program(), std::path::Path::new("/usr/bin/bwrap"));
    assert!(prepared.arguments().contains(&"--ro-bind".into()));
    assert!(prepared.arguments().contains(&"--bind".into()));
    assert!(prepared.arguments().contains(&"--unshare-net".into()));
    assert!(prepared.arguments().contains(&"literal argument".into()));
    assert_eq!(
        prepared.current_directory(),
        Some(working_directory.as_path())
    );
}

struct WeakSandbox;

impl ProcessSandbox for WeakSandbox {
    fn prepare(
        &self,
        command: &ProcessCommand,
        _policy: ProcessSandboxPolicy,
    ) -> Result<super::PreparedProcessCommand, ProcessSandboxError> {
        Ok(super::PreparedProcessCommand::unrestricted(command))
    }
}

#[cfg(target_os = "macos")]
#[test]
fn platform_sandbox_materializes_seatbelt_authority_without_parsing_arguments() {
    let directory = tempfile::tempdir().unwrap();
    let command = ProcessCommand::new("tool")
        .with_argument("$(literal)")
        .with_current_directory(directory.path());
    let prepared = super::PlatformProcessSandbox::default()
        .prepare(
            &command,
            ProcessSandboxPolicy::new(
                ProcessFileSystemAccess::WorkingDirectoryWrite,
                ProcessNetworkAccess::Denied,
            ),
        )
        .unwrap();
    assert_eq!(prepared.kind(), super::ProcessSandboxKind::MacOsSeatbelt);
    assert_eq!(
        prepared.program(),
        std::path::Path::new("/usr/bin/sandbox-exec")
    );
    assert!(prepared.arguments().contains(&"$(literal)".into()));
    let profile = prepared.arguments()[1].to_string_lossy();
    assert!(profile.contains("deny network"));
    assert!(profile.contains("deny file-write"));
    assert!(profile.contains("require-not (subpath"));
}

#[cfg(target_os = "macos")]
#[test]
fn system_processes_enforce_read_only_seatbelt_before_reporting_isolation() {
    let directory = tempfile::tempdir().unwrap();
    let denied_path = directory.path().join("denied");
    let process = SystemProcesses::default()
        .spawn(
            ProcessCommand::new("/usr/bin/touch")
                .with_argument(denied_path.as_os_str())
                .with_current_directory(directory.path())
                .with_sandbox(ProcessSandboxPolicy::new(
                    ProcessFileSystemAccess::ReadOnly,
                    ProcessNetworkAccess::Allowed,
                )),
        )
        .unwrap();
    assert_eq!(
        process.sandbox_kind(),
        super::ProcessSandboxKind::MacOsSeatbelt
    );
    assert!(!block_on(process.wait()).unwrap().success);
    assert!(!denied_path.exists());
}

#[cfg(target_os = "macos")]
#[test]
fn seatbelt_workspace_write_allows_only_the_canonical_working_directory() {
    // Bazel already wraps this test in Seatbelt, so its outer profile can reject the nested
    // sandbox's allowed write before the ZUI profile is evaluated.
    if std::env::var_os("TEST_TMPDIR").is_some() {
        return;
    }
    let workspace = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let allowed_path = workspace.path().join("allowed");
    let denied_path = outside.path().join("denied");
    let policy = ProcessSandboxPolicy::new(
        ProcessFileSystemAccess::WorkingDirectoryWrite,
        ProcessNetworkAccess::Allowed,
    );
    let allowed = SystemProcesses::default()
        .spawn(
            ProcessCommand::new("/usr/bin/touch")
                .with_argument(allowed_path.as_os_str())
                .with_current_directory(workspace.path())
                .with_sandbox(policy),
        )
        .unwrap();
    assert!(block_on(allowed.wait()).unwrap().success);
    assert!(allowed_path.is_file());

    let denied = SystemProcesses::default()
        .spawn(
            ProcessCommand::new("/usr/bin/touch")
                .with_argument(denied_path.as_os_str())
                .with_current_directory(workspace.path())
                .with_sandbox(policy),
        )
        .unwrap();
    assert!(!block_on(denied.wait()).unwrap().success);
    assert!(!denied_path.exists());
}

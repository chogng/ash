//! Windows account acceptance against operational WSL entry points.
#![cfg(windows)]

#[path = "support/windows.rs"]
mod support;
use support::executor;
use support::sandbox_policy;

use ash_async_utils::CancellationSource;
use ash_file_access::Dir;
use ash_sandboxing::FileSystemAccess;
use ash_sandboxing::NetworkAccess;
use ash_tool_executor::CommandExecutionAuthority;
use ash_tool_executor::CommandExecutionOutcome;
use ash_tool_executor::CommandInput;
use ash_tool_executor::CommandRequest;
use std::path::Path;
use std::time::Duration;

#[test]
#[ignore = "requires provisioned Windows sandbox, working WSL2 and ASH_WSL_DISTRO"]
fn restricted_accounts_cannot_enter_caller_or_system_wsl() {
    let distro = std::env::var("ASH_WSL_DISTRO").expect("provide the caller's WSL2 distribution");
    let wsl = Path::new(&std::env::var_os("SystemRoot").unwrap()).join("System32/wsl.exe");
    for entry in [
        vec!["--distribution".into(), distro],
        vec!["--system".into()],
    ] {
        let mut arguments = entry;
        arguments.extend([
            "--exec".into(),
            "/bin/sh".into(),
            "-c".into(),
            "printf 'wsl-workload-started'".into(),
        ]);
        let temp = tempfile::tempdir().unwrap();
        let dir = Dir::open_local(temp.path()).unwrap();
        // A successful host control prevents a missing distribution or broken
        // WSL installation from being mistaken for account isolation.
        let control = std::process::Command::new(&wsl)
            .args(&arguments)
            .env("WSL_UTF8", "1")
            .current_dir(temp.path())
            .output()
            .unwrap();
        assert!(control.status.success(), "{control:?}");
        assert!(String::from_utf8_lossy(&control.stdout).contains("wsl-workload-started"));
        for network in [NetworkAccess::Denied, NetworkAccess::Allowed] {
            let result = executor(&dir, Duration::from_secs(20))
                .execute(
                    CommandRequest {
                        program: wsl.to_str().unwrap().into(),
                        arguments: arguments.clone(),
                        working_directory: ".".into(),
                        input: CommandInput::Closed,
                    },
                    CommandExecutionAuthority::Sandboxed(sandbox_policy(
                        FileSystemAccess::DirectoryWrite,
                        network,
                    )),
                    &CancellationSource::new().token(),
                )
                .unwrap();
            let CommandExecutionOutcome::Completed(output) = result else {
                panic!("{result:?}");
            };
            assert_ne!(output.exit_code, Some(0), "{output:?}");
            assert!(
                !output.stdout.contains("wsl-workload-started"),
                "{output:?}"
            );
        }
    }
}

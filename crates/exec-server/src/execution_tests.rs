use super::CommandExecutionAuthority;
use super::CommandExecutionOutcome;
use super::CommandInput;
use super::CommandRequest;
use super::ExecutionLimits;
use super::ProcessExecutor;
use ash_async_utils::CancellationSource;
use ash_file_access::Dir;
use ash_sandboxing::SandboxBackends;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;

#[test]
fn commands_preserve_msvc_toolchain_environment() {
    const CHILD: &str = "ASH_TEST_MSVC_ENV_CHILD";
    if std::env::var_os(CHILD).is_none() {
        let output = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "execution::tests::commands_preserve_msvc_toolchain_environment",
                "--nocapture",
            ])
            .env(CHILD, "1")
            .env("INCLUDE", r"C:\toolchain\include;C:\SDK headers")
            .env("LIB", r"C:\toolchain\lib;C:\SDK libraries")
            .env("LIBPATH", r"C:\toolchain\references")
            .output()
            .unwrap();
        assert!(output.status.success(), "{output:?}");
        return;
    }

    let root = tempfile::tempdir().unwrap();
    let executor = ProcessExecutor::new(
        Dir::open_local(root.path()).unwrap(),
        SandboxBackends::new(Vec::new()),
        ExecutionLimits {
            timeout: Duration::from_secs(30),
            max_output_bytes: 4096,
        },
    );
    let powershell = PathBuf::from(std::env::var_os("SystemRoot").unwrap())
        .join("System32/WindowsPowerShell/v1.0/powershell.exe");
    let CommandExecutionOutcome::Completed(output) = executor
        .execute(
            CommandRequest {
                program: powershell.to_string_lossy().into_owned(),
                arguments: vec![
                    "-NoProfile".into(),
                    "-NonInteractive".into(),
                    "-Command".into(),
                    "@($env:INCLUDE, $env:LIB, $env:LIBPATH) | ConvertTo-Json -Compress".into(),
                ],
                working_directory: ".".into(),
                input: CommandInput::Closed,
            },
            CommandExecutionAuthority::Unrestricted,
            &CancellationSource::new().token(),
        )
        .unwrap()
    else {
        panic!("unrestricted toolchain probe was denied");
    };
    assert_eq!(output.exit_code, Some(0), "{output:?}");
    assert_eq!(
        serde_json::from_str::<Vec<String>>(output.stdout.trim()).unwrap(),
        [
            r"C:\toolchain\include;C:\SDK headers",
            r"C:\toolchain\lib;C:\SDK libraries",
            r"C:\toolchain\references",
        ]
    );
}

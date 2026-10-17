use super::background_command;
#[cfg(windows)]
use std::process::Command;

#[tokio::test]
async fn std_and_tokio_background_commands_preserve_output_without_console_window() {
    const TEST_NAME: &str = "background_command_tests::std_and_tokio_background_commands_preserve_output_without_console_window";
    const PHASE: &str = "ASH_TEST_BACKGROUND_COMMAND_PHASE";
    let executable = std::env::current_exe().expect("test executable");
    if std::env::var(PHASE).as_deref() == Ok("probe") {
        println!("background stdout");
        eprintln!("background stderr");
        return;
    }
    #[cfg(windows)]
    if std::env::var(PHASE).as_deref() != Ok("detached") {
        use std::os::windows::process::CommandExt;

        // A detached parent exposes accidental console allocation even when the
        // outer test runner already has a console that children could inherit.
        let output = Command::new(&executable)
            .args(["--exact", TEST_NAME, "--nocapture"])
            .env(PHASE, "detached")
            .creation_flags(0x0000_0008) // DETACHED_PROCESS
            .output()
            .expect("spawn detached parent");
        assert!(
            output.status.success(),
            "detached parent failed: {output:?}"
        );
        return;
    }
    for asynchronous in [false, true] {
        #[cfg(windows)]
        let mut command = {
            let powershell = std::path::PathBuf::from(
                std::env::var_os("SystemRoot").expect("Windows system directory"),
            )
            .join("System32/WindowsPowerShell/v1.0/powershell.exe");
            let mut command = background_command(powershell);
            // Query the window itself: console device handles can exist without
            // a window. The OS-provided probe keeps Rust's unsafe ban intact.
            command.args([
                "-NoLogo",
                "-NoProfile",
                "-NonInteractive",
                "-Command",
                r#"
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition 'using System;
using System.Runtime.InteropServices;
public static class WindowProbe {
    [DllImport("kernel32.dll")]
    public static extern IntPtr GetConsoleWindow();
}'
if ([WindowProbe]::GetConsoleWindow() -ne [IntPtr]::Zero) {
    throw 'background child unexpectedly has a console window'
}
[Console]::Out.WriteLine('background stdout')
[Console]::Error.WriteLine('background stderr')
"#,
            ]);
            command
        };
        #[cfg(not(windows))]
        let mut command = background_command(&executable);
        #[cfg(not(windows))]
        command
            .args(["--exact", TEST_NAME, "--nocapture"])
            .env(PHASE, "probe");
        let output = if asynchronous {
            tokio::process::Command::from(command).output().await
        } else {
            command.output()
        }
        .expect("run background command");
        assert!(output.status.success(), "probe failed: {output:?}");
        assert!(String::from_utf8_lossy(&output.stdout).contains("background stdout"));
        assert!(String::from_utf8_lossy(&output.stderr).contains("background stderr"));
    }
}

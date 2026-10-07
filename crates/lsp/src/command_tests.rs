use std::ffi::OsStr;

use crate::LanguageServerCommand;

const PROBE_ENVIRONMENT: &str = "ASH_LSP_ARGV0_PROBE";

#[tokio::test]
async fn canonical_program_can_preserve_a_proxy_invocation_name() {
    let executable = std::env::current_exe().expect("current test executable");
    let expected_argv0 = "rust-analyzer";
    let command = LanguageServerCommand::new(&executable)
        .with_argv0(expected_argv0)
        .with_arguments([
            "--exact",
            "command_tests::argv0_probe_helper",
            "--nocapture",
        ])
        .with_environment(PROBE_ENVIRONMENT, expected_argv0);

    assert_eq!(command.program(), executable.as_os_str());
    assert_eq!(command.argv0(), Some(OsStr::new(expected_argv0)));

    let output = command
        .into_tokio_command()
        .output()
        .await
        .expect("run argv0 probe");
    assert!(
        output.status.success(),
        "argv0 probe failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[test]
fn argv0_probe_helper() {
    let Some(expected) = std::env::var_os(PROBE_ENVIRONMENT) else {
        return;
    };
    assert_eq!(
        std::env::args_os().next().as_deref(),
        Some(expected.as_os_str())
    );
}

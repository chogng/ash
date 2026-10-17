#![cfg(unix)]

use std::fs;
use std::io::Write;
use std::os::unix::fs::PermissionsExt;
use std::os::unix::process::ExitStatusExt;
use std::process::Command;
use std::process::Stdio;

fn backend(root: &std::path::Path, source: &str) -> std::path::PathBuf {
    let executable = root.join("selected backend");
    fs::write(&executable, format!("#!/bin/sh\n{source}")).unwrap();
    fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    executable
}

#[test]
fn diagnostic_handoff_preserves_configuration_stdio_and_exit_status() {
    let root = tempfile::tempdir().unwrap();
    let profile = root
        .path()
        .canonicalize()
        .unwrap()
        .join("profile with spaces");
    let workspace = root.path().join("workspace with spaces");
    let services = root.path().join("services with spaces.json");
    let executable = backend(
        root.path(),
        "printf '%s\\n' \"$@\" \"$ASH_HOME\" \"$ASH_WORKSPACE_ROOT\" \"$ASH_DIR_GRANT_SOURCE\"\nprintf 'backend stderr\\n' >&2\ncat\nexit 37\n",
    );
    let mut child = Command::new(env!("CARGO_BIN_EXE_ash-remote-server"))
        .args(["app-server", "--listen", "stdio://"])
        .env("ASH_APP_SERVER_PATH", executable)
        .env("ASH_HOME", &profile)
        .env("ASH_WORKSPACE_ROOT", &workspace)
        .env("ASH_DIR_GRANT_SOURCE", "userConfig")
        .env("ASH_REMOTE_SERVER_PRODUCT_SERVICES_PATH", &services)
        .env_remove("ASH_PRODUCT_SERVICES_PATH")
        .env_remove("ASH_PROFILE_ROOT")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"stdio payload\n")
        .unwrap();
    let output = child.wait_with_output().unwrap();
    assert_eq!(output.status.code(), Some(37));
    assert_eq!(output.stderr, b"backend stderr\n");
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        format!(
            "--remote-stdio\n--product-services\n{}\n{}\n{}\nhostConfiguration\nstdio payload\n",
            services.display(),
            profile.display(),
            workspace.display(),
        )
    );
    assert!(!profile.exists(), "connector opened backend profile state");
}

#[test]
fn history_export_handoff_keeps_an_empty_directory_grant_and_binary_stdout() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("profile");
    let receiver = "ab".repeat(32);
    let executable = backend(
        root.path(),
        "printf '%s\\n' \"$@\" \"${ASH_WORKSPACE_ROOT-unset}\" >&2\nprintf '\\000archive\\377'\n",
    );
    let output = Command::new(env!("CARGO_BIN_EXE_ash-remote-server"))
        .args(["history-export", &receiver])
        .env("ASH_APP_SERVER_PATH", executable)
        .env("ASH_HOME", &profile)
        .env_remove("ASH_WORKSPACE_ROOT")
        .env_remove("ASH_PROFILE_ROOT")
        .output()
        .unwrap();
    assert!(output.status.success());
    assert_eq!(output.stdout, b"\0archive\xff");
    assert_eq!(
        String::from_utf8(output.stderr).unwrap(),
        format!("history-export\n{receiver}\nunset\n")
    );
    assert!(!profile.exists(), "connector opened backend profile state");
}

#[test]
fn diagnostic_handoff_preserves_backend_signal_termination() {
    let root = tempfile::tempdir().unwrap();
    let executable = backend(root.path(), "kill -TERM \"$$\"\n");
    let output = Command::new(env!("CARGO_BIN_EXE_ash-remote-server"))
        .args(["app-server", "--listen", "stdio://"])
        .env("ASH_APP_SERVER_PATH", executable)
        .env("ASH_HOME", root.path().join("profile"))
        .env_remove("ASH_WORKSPACE_ROOT")
        .env_remove("ASH_PROFILE_ROOT")
        .output()
        .unwrap();
    assert_eq!(output.status.signal(), Some(15));
}

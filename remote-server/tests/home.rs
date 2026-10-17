use std::fs;
use std::path::Path;
use std::process::Command;

use ash_app_server_client::AppServerSession;
use ash_app_server_client::StdioAppServerCommand;
use ash_app_server_protocol::protocol::common::ClientCapabilities;
use ash_app_server_protocol::protocol::common::ClientInfo;

fn command(user: &Path, dir: &Path) -> StdioAppServerCommand {
    StdioAppServerCommand::new(env!("CARGO_BIN_EXE_ash-remote-server"))
        .with_argument("app-server")
        .with_argument("--listen")
        .with_argument("stdio://")
        .with_environment_variable("ASH_WORKSPACE_ROOT", dir)
        .with_environment_variable("HOME", user)
        .with_environment_variable("USERPROFILE", user)
        .with_environment_variable("LOCALAPPDATA", user.join("local"))
        .with_environment_variable("XDG_STATE_HOME", user.join("state"))
        .without_environment_variable("ASH_HOME")
        .without_environment_variable("ASH_PROFILE_ROOT")
}

fn initialize(command: StdioAppServerCommand) {
    let session = AppServerSession::start_stdio(
        command,
        ClientInfo {
            name: "home-test".into(),
            version: "1".into(),
        },
        ClientCapabilities::default(),
    )
    .unwrap();
    assert!(
        session
            .client()
            .list_sessions()
            .unwrap()
            .sessions
            .is_empty()
    );
    session.shutdown().unwrap();
}

#[test]
fn remote_startup_uses_the_remote_users_home() {
    let root = tempfile::tempdir().unwrap();
    let user = root.path().join("user");
    let dir = root.path().join("workspace");
    fs::create_dir(&user).unwrap();
    fs::create_dir(&dir).unwrap();
    initialize(command(&user, &dir));
    assert!(user.join(".ash").is_dir());
    assert!(!dir.join(".ash").exists());
}

#[test]
fn startup_reports_legacy_data_and_accepts_its_explicit_selection() {
    let root = tempfile::tempdir().unwrap();
    let user = root.path().join("user");
    let dir = root.path().join("workspace");
    #[cfg(target_os = "macos")]
    let legacy = user.join("Library/Application Support/Ash/remote-server");
    #[cfg(target_os = "windows")]
    let legacy = user.join("local/Ash/remote-server");
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let legacy = user.join("state/ash/remote-server");
    fs::create_dir_all(&legacy).unwrap();
    fs::create_dir(&dir).unwrap();
    fs::write(legacy.join("history-marker"), b"retained").unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_ash-remote-server"))
        .args(["app-server", "--listen", "stdio://"])
        .env("ASH_WORKSPACE_ROOT", &dir)
        .env("HOME", &user)
        .env("USERPROFILE", &user)
        .env("LOCALAPPDATA", user.join("local"))
        .env("XDG_STATE_HOME", user.join("state"))
        .env_remove("ASH_HOME")
        .env_remove("ASH_PROFILE_ROOT")
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("Set ASH_HOME on the remote host"));
    assert!(!user.join(".ash").exists());
    initialize(command(&user, &dir).with_environment_variable("ASH_HOME", &legacy));
    assert_eq!(
        fs::read(legacy.join("history-marker")).unwrap(),
        b"retained"
    );
}

#[test]
fn startup_rejects_the_retired_environment_variable() {
    let root = tempfile::tempdir().unwrap();
    let result = Command::new(env!("CARGO_BIN_EXE_ash-remote-server"))
        .args(["app-server", "--listen", "stdio://"])
        .env("ASH_WORKSPACE_ROOT", root.path())
        .env("ASH_HOME", root.path())
        .env("ASH_PROFILE_ROOT", root.path())
        .output()
        .unwrap();
    assert!(!result.status.success());
    assert!(String::from_utf8_lossy(&result.stderr).contains("remove ASH_PROFILE_ROOT"));
}

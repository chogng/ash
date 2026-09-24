#![cfg(unix)]

use std::fs;
use std::os::unix::fs::PermissionsExt;
use std::process::Command;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use ash_app_server_protocol::protocol::initialize::{
    APP_SERVER_CAPABILITY_VERSION, APP_SERVER_PROTOCOL_MAJOR, APP_SERVER_PROTOCOL_REVISION,
};
use ash_app_server_protocol::schema_hash;
use serde_json::json;

#[test]
fn ash_code_cli_exposes_the_host_owned_remote_platform_probe() {
    let root = std::env::temp_dir().join(format!(
        "ash-cli-remote-probe-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    fs::create_dir_all(&root).unwrap();
    let fake_ssh = root.join("fake-ssh");
    fs::write(
        &fake_ssh,
        "#!/bin/sh\nprintf '%s\\n' '__ASH_REMOTE_PLATFORM__:linux:x86_64:musl'\n",
    )
    .unwrap();
    let mut permissions = fs::metadata(&fake_ssh).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(&fake_ssh, permissions).unwrap();

    let output = Command::new(env!("CARGO_BIN_EXE_ash"))
        .args(["remote", "probe", "--host", "build-linux", "--ssh"])
        .arg(&fake_ssh)
        .output()
        .unwrap();

    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert_eq!(
        String::from_utf8(output.stdout).unwrap(),
        "x86_64-unknown-linux-musl\n"
    );
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn ash_code_cli_owns_shared_remote_profile_persistence() {
    let root = std::env::temp_dir().join(format!(
        "ash-cli-remote-profile-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    fs::create_dir_all(&root).unwrap();
    let activate = Command::new(env!("CARGO_BIN_EXE_ash"))
        .args([
            "remote",
            "profile",
            "activate",
            "--host",
            "build-linux",
            "--dir",
            "/srv/project",
            "--runtime",
            "/srv/ash/runtime/one/bin/ash-remote-server",
        ])
        .env("ASH_HOME", &root)
        .output()
        .unwrap();
    assert!(
        activate.status.success(),
        "{}",
        String::from_utf8_lossy(&activate.stderr)
    );
    assert_eq!(
        String::from_utf8(activate.stdout).unwrap(),
        "{\"activeRuntime\":\"/srv/ash/runtime/one/bin/ash-remote-server\"}\n"
    );

    let activate_second = Command::new(env!("CARGO_BIN_EXE_ash"))
        .args([
            "remote",
            "profile",
            "activate",
            "--host",
            "build-linux",
            "--dir",
            "/srv/project",
            "--runtime",
            "/srv/ash/runtime/two/bin/ash-remote-server",
        ])
        .env("ASH_HOME", &root)
        .output()
        .unwrap();
    assert!(activate_second.status.success());

    let get = Command::new(env!("CARGO_BIN_EXE_ash"))
        .args([
            "remote",
            "profile",
            "get",
            "--host",
            "build-linux",
            "--dir",
            "/srv/project",
        ])
        .env("ASH_HOME", &root)
        .output()
        .unwrap();
    assert!(get.status.success());
    assert_eq!(
        String::from_utf8(get.stdout).unwrap(),
        "{\"activeRuntime\":\"/srv/ash/runtime/two/bin/ash-remote-server\",\"previousRuntime\":\"/srv/ash/runtime/one/bin/ash-remote-server\"}\n"
    );

    let fake_ssh = root.join("fake-ssh");
    let response = initialize_response(&schema_hash());
    fs::write(
        &fake_ssh,
        format!(
            "#!/bin/sh\ncommand=''\nfor argument in \"$@\"; do command=$argument; done\ncase \"$command\" in\n  *\"'connect'\"*) IFS= read -r request || exit 65; printf '%s\\n' '{}' ;;\n  *) printf '%s\\n' '__ASH_REMOTE_RUNTIME_FOUND__:/srv/ash/runtime/one/bin/ash-remote-server' ;;\nesac\n",
            response,
        ),
    )
    .unwrap();
    make_executable(&fake_ssh);
    let rollback = Command::new(env!("CARGO_BIN_EXE_ash"))
        .args([
            "remote",
            "profile",
            "rollback",
            "--host",
            "build-linux",
            "--dir",
            "/srv/project",
            "--ssh",
        ])
        .arg(&fake_ssh)
        .env("ASH_HOME", &root)
        .output()
        .unwrap();
    assert!(
        rollback.status.success(),
        "{}",
        String::from_utf8_lossy(&rollback.stderr)
    );
    assert_eq!(
        String::from_utf8(rollback.stdout).unwrap(),
        "{\"activeRuntime\":\"/srv/ash/runtime/one/bin/ash-remote-server\",\"previousRuntime\":\"/srv/ash/runtime/two/bin/ash-remote-server\"}\n"
    );
    assert!(root.join("remote/connections.json").is_file());
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn ash_code_cli_owns_shared_named_remote_connections() {
    let root = std::env::temp_dir().join(format!(
        "ash-cli-remote-connections-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ));
    fs::create_dir_all(&root).unwrap();

    let save = Command::new(env!("CARGO_BIN_EXE_ash"))
        .args([
            "remote",
            "connections",
            "save",
            "--name",
            "Build",
            "--host",
            "build-linux",
            "--dir",
            "/srv/project",
        ])
        .env("ASH_HOME", &root)
        .output()
        .unwrap();
    assert!(
        save.status.success(),
        "{}",
        String::from_utf8_lossy(&save.stderr)
    );
    assert_eq!(
        String::from_utf8(save.stdout).unwrap(),
        "{\"name\":\"build\",\"host\":\"build-linux\",\"dir\":\"/srv/project\"}\n"
    );

    let update = Command::new(env!("CARGO_BIN_EXE_ash"))
        .args([
            "remote",
            "connections",
            "update",
            "--name",
            "build",
            "--new-name",
            "production",
            "--host",
            "production-linux",
            "--dir",
            "/srv/production",
        ])
        .env("ASH_HOME", &root)
        .output()
        .unwrap();
    assert!(
        update.status.success(),
        "{}",
        String::from_utf8_lossy(&update.stderr)
    );
    assert_eq!(
        String::from_utf8(update.stdout).unwrap(),
        "{\"name\":\"production\",\"host\":\"production-linux\",\"dir\":\"/srv/production\"}\n"
    );

    let list = Command::new(env!("CARGO_BIN_EXE_ash"))
        .args(["remote", "connections", "list"])
        .env("ASH_HOME", &root)
        .output()
        .unwrap();
    assert!(list.status.success());
    assert_eq!(
        String::from_utf8(list.stdout).unwrap(),
        "[{\"name\":\"production\",\"host\":\"production-linux\",\"dir\":\"/srv/production\"}]\n"
    );
    assert!(root.join("remote/targets.json").is_file());

    let get = Command::new(env!("CARGO_BIN_EXE_ash"))
        .args(["remote", "connections", "get", "--name", "PRODUCTION"])
        .env("ASH_HOME", &root)
        .output()
        .unwrap();
    assert!(get.status.success());
    assert_eq!(
        String::from_utf8(get.stdout).unwrap(),
        "{\"name\":\"production\",\"host\":\"production-linux\",\"dir\":\"/srv/production\"}\n"
    );

    let remove = Command::new(env!("CARGO_BIN_EXE_ash"))
        .args(["remote", "connections", "remove", "--name", "production"])
        .env("ASH_HOME", &root)
        .output()
        .unwrap();
    assert!(remove.status.success());
    assert_eq!(
        String::from_utf8(remove.stdout).unwrap(),
        "{\"name\":\"production\",\"host\":\"production-linux\",\"dir\":\"/srv/production\"}\n"
    );

    let missing = Command::new(env!("CARGO_BIN_EXE_ash"))
        .args(["remote", "connections", "get", "--name", "production"])
        .env("ASH_HOME", &root)
        .output()
        .unwrap();
    assert!(missing.status.success());
    assert_eq!(String::from_utf8(missing.stdout).unwrap(), "null\n");
    fs::remove_dir_all(root).unwrap();
}

fn initialize_response(server_schema_hash: &str) -> String {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "result": {
            "serverInfo": { "name": "fake-remote", "version": "1" },
            "protocolVersion": {
                "major": APP_SERVER_PROTOCOL_MAJOR,
                "revision": APP_SERVER_PROTOCOL_REVISION
            },
            "schemaHash": server_schema_hash,
            "capabilities": {
                "agentInteractions": false,
                "documentCollaboration": false,
                "sessions": true,
                "threads": true,
                "turns": true,
                "projects": false,
                "memories": false,
                "resources": false,
                "attachments": false,
                "fileSystem": false,
                "git": false,
                "contentSearch": false,
                "codebase": false,
                "cloudCodebase": false,
                "terminal": false,
                "debugAdapter": false,
                "typst": false,
                "updateReplay": false,
                "extensions": false,
                "extensionHost": false,
                "connectors": false,
                "plugins": false,
                "marketplace": false,
                "mcp": false,
                "mcpOAuth": false,
                "contracts": {
                    "sessions": { "version": APP_SERVER_CAPABILITY_VERSION },
                    "threads": { "version": APP_SERVER_CAPABILITY_VERSION },
                    "turns": { "version": APP_SERVER_CAPABILITY_VERSION }
                }
            },
            "slashCommands": []
        }
    })
    .to_string()
}

fn make_executable(path: &std::path::Path) {
    let mut permissions = fs::metadata(path).unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).unwrap();
}

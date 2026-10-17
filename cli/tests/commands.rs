use ash_app_server_client::AppServerSession;
use ash_app_server_client::StdioAppServerCommand;
use ash_app_server_protocol::protocol::common::ClientCapabilities;
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_app_server_protocol::protocol::session::SessionCreateParams;
use ash_protocol::CommandId;
use serde_json::Value;
use std::io::Write;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::Output;
use std::process::Stdio;
use std::time::Duration;
use std::time::Instant;
use tempfile::TempDir;

#[path = "support/account_server.rs"]
mod account_server;

struct Harness {
    root: TempDir,
    profile: PathBuf,
    backend: PathBuf,
    server: Option<Child>,
}

impl Harness {
    fn new() -> Self {
        let root = tempfile::tempdir().unwrap();
        let profile = root.path().join("profile");
        std::fs::create_dir(root.path().join("codex")).unwrap();
        let backend = cargo_bin::cargo_bin!("ash")
            .unwrap()
            .with_file_name(format!("ash-app-server{}", std::env::consts::EXE_SUFFIX));
        assert!(
            backend.is_file(),
            "build ash-app-server before running CLI integration tests"
        );
        Self {
            root,
            profile,
            backend,
            server: None,
        }
    }

    fn start_server(&mut self) {
        let mut command = Command::new(&self.backend);
        command.arg("--managed");
        self.start_server_command(command);
    }

    fn start_account_server(&mut self, keyring: account_server::KeyringMode) {
        // The subprocess uses the production application composition and managed endpoint,
        // with an explicitly injected fixture keyring instead of the host's credential facility.
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args([
                "--exact",
                "account_server_fixture",
                "--ignored",
                "--nocapture",
            ])
            .env("ASH_CLI_ACCOUNT_FIXTURE_KEYRING", keyring.argument());
        self.start_server_command(command);
    }

    fn start_server_command(&mut self, mut command: Command) {
        // The fixture owns the daemon lifetime, including under Cargo's Windows job.
        let log_path = self.root.path().join("server.log");
        let log = std::fs::File::create(&log_path).unwrap();
        let error_log = log.try_clone().unwrap();
        self.server = Some(
            command
                .current_dir(self.root.path())
                // Account discovery also reads the host home; removing HOME selects the OS
                // user's real home on Unix rather than isolating it from this fixture.
                .env("HOME", self.root.path())
                .env("USERPROFILE", self.root.path())
                // ZCode can override the home directory with its own credential root.
                .env("ZCODE_DATA_BASE_DIR", self.root.path())
                .env("ASH_HOME", &self.profile)
                .env("CODEX_HOME", self.root.path().join("codex"))
                .env_remove("ASH_WORKSPACE_ROOT")
                .env_remove("ASH_DIR_GRANT_SOURCE")
                .env_remove("ASH_PRODUCT_SERVICES_PATH")
                .stdin(Stdio::null())
                .stdout(log)
                .stderr(error_log)
                .spawn()
                .unwrap(),
        );
        let deadline = Instant::now() + Duration::from_secs(30);
        loop {
            let log = std::fs::read_to_string(&log_path).unwrap();
            let exited = self.server.as_mut().unwrap().try_wait().unwrap();
            assert!(
                exited.is_none(),
                "test App Server exited: {exited:?}\n{log}"
            );
            if log.contains("managed App Server endpoint ready:") {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "test App Server did not become ready:\n{log}"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(
            self.json(&["app-server", "daemon", "version"])["status"],
            "running"
        );
    }

    fn command(&self, arguments: &[&str]) -> Command {
        let mut command = Command::new(cargo_bin::cargo_bin!("ash").unwrap());
        command
            .args(arguments)
            .current_dir(self.root.path())
            .env("HOME", self.root.path())
            .env("USERPROFILE", self.root.path())
            .env("ZCODE_DATA_BASE_DIR", self.root.path())
            .env("ASH_HOME", &self.profile)
            .env("CODEX_HOME", self.root.path().join("codex"))
            .env("ASH_APP_SERVER_PATH", &self.backend)
            .env_remove("ASH_APP_SERVER_SHA256")
            .env_remove("ASH_PRODUCT_SERVICES_PATH")
            .env_remove("ASH_WORKSPACE_ROOT");
        command
    }

    fn output(&self, arguments: &[&str]) -> Output {
        self.command(arguments).output().unwrap()
    }

    fn json(&self, arguments: &[&str]) -> Value {
        let output = self.output(arguments);
        assert!(
            output.status.success(),
            "{arguments:?}: {}\n{}",
            String::from_utf8_lossy(&output.stderr),
            String::from_utf8_lossy(&output.stdout)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }

    fn session(&self) -> AppServerSession {
        AppServerSession::start_stdio(
            StdioAppServerCommand::new(cargo_bin::cargo_bin!("ash").unwrap())
                .with_argument("app-server")
                .with_argument("connect")
                .with_environment_variable("HOME", self.root.path().as_os_str())
                .with_environment_variable("USERPROFILE", self.root.path().as_os_str())
                .with_environment_variable("ZCODE_DATA_BASE_DIR", self.root.path().as_os_str())
                .with_environment_variable("ASH_HOME", self.profile.as_os_str())
                .with_environment_variable(
                    "CODEX_HOME",
                    self.root.path().join("codex").into_os_string(),
                )
                .with_environment_variable("ASH_APP_SERVER_PATH", self.backend.as_os_str())
                .without_environment_variable("ASH_APP_SERVER_SHA256")
                .without_environment_variable("ASH_WORKSPACE_ROOT"),
            ClientInfo {
                name: "cli-command-test".into(),
                version: "1".into(),
            },
            ClientCapabilities::default(),
        )
        .unwrap()
    }
}

impl Drop for Harness {
    fn drop(&mut self) {
        if let Some(mut server) = self.server.take() {
            let output = self.output(&["app-server", "daemon", "stop"]);
            if !output.status.success() {
                let _ = server.kill();
            }
            let status = server.wait().unwrap();
            assert!(
                status.success() || std::thread::panicking(),
                "test daemon exited unsuccessfully: {status}"
            );
            assert!(
                output.status.success() || std::thread::panicking(),
                "could not stop test daemon: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }
}

#[test]
fn help_version_and_usage_errors_do_not_open_the_profile() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("unused-profile");
    for (args, code) in [
        (vec!["--help"], 0),
        (vec!["--version"], 0),
        (vec!["exec", "--help"], 0),
        (vec!["app", "--help"], 0),
        (vec!["app", "--app-path"], 2),
        (vec!["mcp", "add", "--help"], 0),
        (vec!["login", "status", "--help"], 0),
        (vec!["not-a-command"], 2),
        (vec!["tcp-tunnel"], 2),
        (vec!["resume", "session"], 2),
        (vec!["exec", "--unknown", "task"], 2),
        (
            vec![
                "exec",
                "--auto-review",
                "--dangerously-bypass-permissions",
                "task",
            ],
            2,
        ),
        (vec!["update", "--channel", "unexpected"], 2),
    ] {
        let output = Command::new(cargo_bin::cargo_bin!("ash").unwrap())
            .args(&args)
            .env("ASH_HOME", &profile)
            .env("ASH_APP_SERVER_PATH", root.path().join("missing-backend"))
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(code),
            "{args:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        if code == 0 {
            assert!(output.stderr.is_empty());
        } else {
            assert!(output.stdout.is_empty());
        }
        assert!(!profile.exists(), "{args:?} opened the profile");
    }
}

#[test]
fn app_help_and_errors_use_the_terminal_locale_without_opening_the_profile() {
    let root = tempfile::tempdir().unwrap();
    let profile = root.path().join("unused-profile");
    let mut command = Command::new(cargo_bin::cargo_bin!("ash").unwrap());
    command
        .current_dir(root.path())
        .env("ASH_HOME", &profile)
        .env("LC_ALL", "zh_CN.UTF-8");
    let output = command.args(["app", "--help"]).output().unwrap();
    assert!(output.status.success());
    let help = String::from_utf8(output.stdout).unwrap();
    assert!(help.contains("打开 Ash 桌面应用"), "{help}");
    assert!(help.contains("要打开的目录、文件或工作区文件"));
    assert!(help.contains("--app-path"));
    let output = Command::new(cargo_bin::cargo_bin!("ash").unwrap())
        .args(["app", "--app-path", "missing-app", "."])
        .current_dir(root.path())
        .env("ASH_HOME", &profile)
        .env("LC_ALL", "zh_CN.UTF-8")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(output.stdout.is_empty());
    assert!(String::from_utf8_lossy(&output.stderr).contains("无效的 Ash 桌面应用路径"));
    assert!(!profile.exists());
}

#[cfg(unix)]
#[test]
fn app_launch_forwards_default_and_relative_targets_without_starting_backend() {
    use std::os::unix::fs::PermissionsExt;

    let root = tempfile::tempdir().unwrap();
    let directory = root.path().canonicalize().unwrap();
    let executable = directory.join("Ash test launcher");
    std::fs::write(
        &executable,
        "#!/bin/sh\nprintf '%s\\n' \"$PWD\" \"${ELECTRON_RUN_AS_NODE-unset}\" \"$@\" > \"$APP_CAPTURE\"\n",
    )
    .unwrap();
    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o755)).unwrap();
    let workspace = directory.join("-project with 'quotes' and {0}");
    std::fs::create_dir(&workspace).unwrap();
    let profile = directory.join("unused-profile");
    for (index, target) in [None, Some(workspace.file_name().unwrap())]
        .into_iter()
        .enumerate()
    {
        let capture = directory.join(format!("capture-{index}"));
        let mut command = Command::new(cargo_bin::cargo_bin!("ash").unwrap());
        command
            .args(["app", "--app-path"])
            .arg(&executable)
            .current_dir(&directory)
            .env("ASH_HOME", &profile)
            .env("ASH_APP_SERVER_PATH", directory.join("missing-backend"))
            .env("ELECTRON_RUN_AS_NODE", "1")
            .env("APP_CAPTURE", &capture);
        if let Some(target) = target {
            command.arg("--").arg(target);
        }
        let output = command.output().unwrap();
        assert!(output.status.success(), "{output:?}");
        assert!(output.stdout.is_empty());
        assert!(output.stderr.is_empty());
        let expected = format!(
            "{}\nunset\n--\n{}\n",
            directory.display(),
            if target.is_some() {
                &workspace
            } else {
                &directory
            }
            .display()
        );
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if std::fs::read_to_string(&capture).ok().as_deref() == Some(&expected) {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "desktop launch did not forward {expected:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(!profile.exists());
    }
    let output = Command::new(cargo_bin::cargo_bin!("ash").unwrap())
        .arg("app")
        .arg("missing-workspace")
        .arg("--app-path")
        .arg(&executable)
        .current_dir(&directory)
        .env("ASH_HOME", &profile)
        .env("LC_ALL", "C")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(String::from_utf8_lossy(&output.stderr).contains("Could not open workspace path"));
    assert!(!profile.exists());

    std::fs::set_permissions(&executable, std::fs::Permissions::from_mode(0o644)).unwrap();
    let output = Command::new(cargo_bin::cargo_bin!("ash").unwrap())
        .args(["app", "--app-path"])
        .arg(&executable)
        .current_dir(&directory)
        .env("ASH_HOME", &profile)
        .env("LC_ALL", "C")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("Could not launch the Ash desktop app")
    );
    assert!(!profile.exists());
}

#[cfg(unix)]
#[test]
fn daemon_entrypoints_and_internal_clients_use_the_packaged_connector() {
    use std::os::unix::fs::PermissionsExt;

    let root = tempfile::tempdir().unwrap();
    let binaries = root.path().join("package with 空格/bin");
    std::fs::create_dir_all(&binaries).unwrap();
    let executable = binaries.join("ash");
    cargo_bin::copy_executable(&cargo_bin::cargo_bin!("ash").unwrap(), &executable).unwrap();
    let daemon = binaries.join("ash-app-server-daemon");
    std::fs::write(
        &daemon,
        "#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$ASH_TEST_DAEMON_ARGUMENTS\"\nexit 29\n",
    )
    .unwrap();
    std::fs::set_permissions(&daemon, std::fs::Permissions::from_mode(0o755)).unwrap();
    let record = root.path().join("arguments");
    for (arguments, expected, code) in [
        (vec!["app-server", "connect"], "connect\n", 29),
        (
            vec![
                "app-server",
                "daemon",
                "version",
                "--product-services",
                "配置 with spaces.json",
            ],
            "version\n--product-services\n配置 with spaces.json\n",
            29,
        ),
        (vec!["sessions"], "connect\n", 1),
        (vec!["ask", "hello"], "connect\n", 1),
    ] {
        let output = Command::new(&executable)
            .args(arguments)
            .current_dir(root.path())
            .env("ASH_HOME", root.path().join("profile"))
            .env("ASH_TEST_DAEMON_ARGUMENTS", &record)
            .env_remove("ASH_WORKSPACE_ROOT")
            .output()
            .unwrap();
        assert_eq!(
            output.status.code(),
            Some(code),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(std::fs::read_to_string(&record).unwrap(), expected);
        std::fs::remove_file(&record).unwrap();
    }
}

#[test]
fn exec_reuses_the_profile_daemon_without_a_local_backend_executable() {
    let mut harness = Harness::new();
    harness.start_server();
    let running = harness.json(&["app-server", "daemon", "version"]);
    let output = harness
        .command(&[
            "exec",
            "--resume",
            "missing-session",
            "missing-thread",
            "task",
        ])
        .env(
            "ASH_APP_SERVER_PATH",
            harness.root.path().join("missing-backend"),
        )
        .output()
        .unwrap();

    assert_eq!(output.status.code(), Some(1));
    assert!(
        String::from_utf8_lossy(&output.stderr).contains("read Session failed"),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let after = harness.json(&["app-server", "daemon", "version"]);
    assert_eq!(after["pid"], running["pid"]);
    assert_eq!(after["instanceId"], running["instanceId"]);
}

#[test]
fn selected_managed_cli_ensures_the_local_daemon_without_a_pinned_cli_switching_it_back() {
    use sha2::Digest;

    let mut harness = Harness::new();
    harness.start_server();
    let initial = harness.json(&["app-server", "daemon", "version"]);
    let install = harness.root.path().join("install");
    let old_package = install.join("versions/old");
    let selected_package = install.join("versions/selected");
    let cli_name = format!("ash{}", std::env::consts::EXE_SUFFIX);
    let backend_name = format!("ash-app-server{}", std::env::consts::EXE_SUFFIX);
    let daemon_name = format!("ash-app-server-daemon{}", std::env::consts::EXE_SUFFIX);
    let mut selected_build_id = String::new();
    for (package, version) in [(&old_package, "0.1.0"), (&selected_package, "0.2.0")] {
        let binaries = package.join("bin");
        std::fs::create_dir_all(&binaries).unwrap();
        cargo_bin::copy_executable(
            &cargo_bin::cargo_bin!("ash").unwrap(),
            &binaries.join(&cli_name),
        )
        .unwrap();
        cargo_bin::copy_executable(&harness.backend, &binaries.join(&backend_name)).unwrap();
        cargo_bin::copy_executable(
            &harness.backend.with_file_name(&daemon_name),
            &binaries.join(&daemon_name),
        )
        .unwrap();
        let files = [
            cli_name.as_str(),
            backend_name.as_str(),
            daemon_name.as_str(),
        ]
        .into_iter()
        .map(|name| {
            (
                format!("bin/{name}"),
                format!(
                    "{:x}",
                    sha2::Sha256::digest(std::fs::read(binaries.join(name)).unwrap())
                ),
            )
        })
        .collect::<std::collections::BTreeMap<_, _>>();
        let mut metadata = serde_json::json!({
            "version": version,
            "buildProfile": "dev-small",
            "javascriptRuntime": { "kind": "packagedNode" },
            "protocol": { "major": 1, "schemaHash": format!("sha256:{}", "a".repeat(64)) },
            "target": build_info::TARGET,
        });
        metadata.sort_all_objects();
        // Package-store validates the complete v2 identity before publishing this fixture.
        let mut digest = sha2::Sha256::new();
        digest.update(b"ash-package-build-v2\0");
        digest.update(serde_json::to_vec(&metadata).unwrap());
        digest.update(b"\0");
        for (path, file_digest) in &files {
            digest.update(path.as_bytes());
            digest.update(b"\0");
            digest.update(file_digest.as_bytes());
            digest.update(b"\0");
        }
        let build_id = format!("sha256:{:x}", digest.finalize());
        if package == &selected_package {
            selected_build_id = build_id.clone();
        }
        metadata["buildId"] = build_id.into();
        metadata["files"] = serde_json::to_value(files).unwrap();
        std::fs::write(
            package.join("ash-package.json"),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
    }
    std::fs::write(
        install.join("install.json"),
        br#"{"schemaVersion":1,"repository":"chogng/ash"}"#,
    )
    .unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink("versions/selected", install.join("current")).unwrap();
    #[cfg(windows)]
    std::fs::write(install.join("current"), "selected").unwrap();

    let command = |package: &PathBuf, arguments: &[&str]| {
        Command::new(package.join("bin").join(&cli_name))
            .args(arguments)
            .current_dir(harness.root.path())
            .env("HOME", harness.root.path())
            .env("USERPROFILE", harness.root.path())
            .env("ZCODE_DATA_BASE_DIR", harness.root.path())
            .env("ASH_HOME", &harness.profile)
            .env("CODEX_HOME", harness.root.path().join("codex"))
            .env(
                "ASH_APP_SERVER_PATH",
                package.join("bin").join(&backend_name),
            )
            .env_remove("ASH_APP_SERVER_SHA256")
            .env_remove("ASH_PRODUCT_SERVICES_PATH")
            .env_remove("ASH_WORKSPACE_ROOT")
            .output()
            .unwrap()
    };

    // Selecting the installed package's backend is explicit; reading sessions only connects
    // to the profile's current daemon and must not replace it.
    let ensured = command(
        &selected_package,
        &["app-server", "daemon", "ensure-selected"],
    );
    assert!(
        ensured.status.success(),
        "{}",
        String::from_utf8_lossy(&ensured.stderr)
    );

    let mut selected_pid = None;
    for package in [&selected_package, &old_package, &selected_package] {
        let output = command(package, &["sessions"]);
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&output.stdout).unwrap()["sessions"],
            serde_json::json!([])
        );
        let running = harness.json(&["app-server", "daemon", "version"]);
        if let Some(pid) = &selected_pid {
            assert_eq!(&running["pid"], pid);
        } else {
            assert_ne!(running["pid"], initial["pid"]);
            selected_pid = Some(running["pid"].clone());
        }
    }
    let record_path = ash_app_server_daemon::daemon_endpoint_path(&harness.profile)
        .unwrap()
        .with_extension("pid.json");
    let record: Value = serde_json::from_slice(&std::fs::read(record_path).unwrap()).unwrap();
    assert_eq!(
        record["executableIdentity"]["packageBuildId"],
        selected_build_id
    );
}

#[test]
fn mcp_commands_persist_declarations_and_enablement_across_processes() {
    let mut harness = Harness::new();
    harness.start_server();
    assert_eq!(harness.json(&["mcp", "list"]), serde_json::json!({}));
    harness.json(&[
        "mcp",
        "add",
        "user:mcp:example",
        "--url",
        "http://127.0.0.1:1/mcp",
        "--disabled",
    ]);
    let server = harness.json(&["mcp", "get", "user:mcp:example"]);
    assert_eq!(server["enablement"], "disabled");
    assert_eq!(server["transport"]["url"], "http://127.0.0.1:1/mcp");
    let duplicate = harness.output(&[
        "mcp",
        "add",
        "user:mcp:example",
        "--url",
        "https://different.test/mcp",
    ]);
    assert_eq!(duplicate.status.code(), Some(2));
    assert_eq!(harness.json(&["mcp", "get", "user:mcp:example"]), server);
    harness.json(&["mcp", "enable", "user:mcp:example"]);
    assert_eq!(
        harness.json(&["mcp", "get", "user:mcp:example"])["enablement"],
        "enabled"
    );
    harness.json(&["mcp", "disable", "user:mcp:example"]);
    assert_eq!(
        harness.json(&["mcp", "get", "user:mcp:example"])["enablement"],
        "disabled"
    );
    harness.json(&["mcp", "remove", "user:mcp:example"]);
    assert_eq!(harness.json(&["mcp", "list"]), serde_json::json!({}));
    assert_eq!(
        harness
            .output(&["mcp", "get", "user:mcp:example"])
            .status
            .code(),
        Some(2)
    );
    harness.json(&[
        "mcp",
        "add",
        "user:mcp:stdio",
        "--disabled",
        "--",
        cargo_bin::cargo_bin!("ash").unwrap().to_str().unwrap(),
        "--version",
    ]);
    assert_eq!(
        harness.json(&["mcp", "get", "user:mcp:stdio"])["transport"]["args"],
        serde_json::json!(["--version"])
    );
}

#[test]
fn session_commands_fork_archive_and_restore_the_exact_session() {
    let mut harness = Harness::new();
    harness.start_server();
    assert_eq!(
        harness.json(&["sessions"])["sessions"],
        serde_json::json!([])
    );
    let connection = harness.session();
    let created = connection
        .client()
        .create_session(SessionCreateParams {
            branch_name: None,
            agent_id: None,
            agent: Default::default(),
            command_id: CommandId::new("create-cli-fixture").unwrap(),
            title: "Original".into(),
            execution_target: None,
        })
        .unwrap();
    connection.shutdown().unwrap();
    let session_id = created.session.session_id.as_str();
    let thread_id = created.session.threads[0].thread_id.as_str();
    let fork = harness.json(&["fork", session_id, thread_id, "--title", "Independent copy"]);
    let copy_id = fork["value"]["session"]["sessionId"].as_str().unwrap();
    assert_ne!(copy_id, session_id);
    assert_eq!(fork["value"]["session"]["title"], "Independent copy");
    let archived = harness.json(&["archive", copy_id]);
    assert_eq!(archived["value"]["session"]["status"], "archived");
    let sessions = harness.json(&["sessions"]);
    let original = sessions["sessions"]
        .as_array()
        .unwrap()
        .iter()
        .find(|session| session["sessionId"] == session_id)
        .unwrap();
    assert_eq!(original["status"], "active");
    let restored = harness.json(&["unarchive", copy_id]);
    assert_eq!(restored["value"]["session"]["status"], "active");
}

#[test]
fn plugin_commands_preserve_version_and_permission_boundaries() {
    let mut harness = Harness::new();
    let authority =
        core_plugins::PluginActivationAuthority::open(harness.profile.join("plugins")).unwrap();
    for version in ["1.0.0", "2.0.0"] {
        let root = harness.root.path().join(version);
        std::fs::create_dir_all(root.join(".ash-plugin")).unwrap();
        std::fs::create_dir_all(root.join("skills/review")).unwrap();
        std::fs::write(
            root.join("skills/review/SKILL.md"),
            "---\nname: review\ndescription: Test review skill\n---\nReview the change.\n",
        )
        .unwrap();
        std::fs::write(
            root.join(".ash-plugin/plugin.json"),
            serde_json::to_vec(&serde_json::json!({
                "schemaVersion": 1, "id": "acme/review", "version": version,
                "displayName": "Review", "compatibility": { "ash": ">=0.1.0" },
                "contributions": { "skills": [{ "id": "review", "path": "skills/review" }] }
            }))
            .unwrap(),
        )
        .unwrap();
        let package = plugin::LocalPluginPackage::load(&root).unwrap();
        authority
            .install_local(
                core_plugins::PluginAuthorityCommandId::new(format!("install-{version}")).unwrap(),
                authority.snapshot().revision(),
                &package,
            )
            .unwrap();
    }
    drop(authority);
    harness.start_server();
    assert_eq!(
        harness.json(&["plugin", "list"])["packages"]
            .as_array()
            .unwrap()
            .len(),
        2
    );
    assert_eq!(
        harness
            .output(&["plugin", "enable", "acme/review"])
            .status
            .code(),
        Some(2)
    );
    harness.json(&["plugin", "enable", "acme/review", "--version", "1.0.0"]);
    let packages = harness.json(&["plugin", "list"]);
    let package = packages["packages"]
        .as_array()
        .unwrap()
        .iter()
        .find(|package| package["version"] == "1.0.0")
        .unwrap();
    assert_eq!(package["enabled"], true);
    assert_eq!(package["granted"], false);
    assert_eq!(package["effective"], false);
    harness.json(&["plugin", "grant", "acme/review", "--version", "1.0.0"]);
    harness.json(&["plugin", "revoke", "acme/review", "--version", "1.0.0"]);
    harness.json(&["plugin", "disable", "acme/review", "--version", "1.0.0"]);
    harness.json(&["plugin", "uninstall", "acme/review", "--version", "1.0.0"]);
    let remaining = harness.json(&["plugin", "list"]);
    assert_eq!(remaining["packages"].as_array().unwrap().len(), 1);
    assert_eq!(remaining["packages"][0]["version"], "2.0.0");
}

#[test]
fn account_status_and_doctor_read_the_shared_server() {
    let mut harness = Harness::new();
    harness.start_account_server(account_server::KeyringMode::Available);
    assert_eq!(
        harness.json(&["login", "status"])["accounts"],
        serde_json::json!([])
    );
    let report = harness.json(&["doctor", "--json"]);
    assert!(
        report["checks"]
            .as_array()
            .unwrap()
            .iter()
            .all(|check| check["status"] != "failed")
    );
    assert!(
        report["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|check| check["name"] == "runtime diagnostics")
    );
}

#[test]
fn api_key_input_is_stored_without_appearing_in_command_output() {
    let mut harness = Harness::new();
    let empty = harness.output(&["login", "api-key", "openai"]);
    assert_eq!(empty.status.code(), Some(2));
    assert!(!harness.profile.exists());
    harness.start_account_server(account_server::KeyringMode::Available);
    let mut child = harness
        .command(&["login", "api-key", "openai"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let key = "cli-test-not-a-real-key";
    writeln!(child.stdin.take().unwrap(), "{key}").unwrap();
    let output = child.wait_with_output().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(!String::from_utf8_lossy(&output.stdout).contains(key));
    assert!(!String::from_utf8_lossy(&output.stderr).contains(key));
    let result: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(result["apiKeyConfigured"], true);
    let values = harness.profile.join("secrets/encrypted/values");
    let encrypted: Vec<_> = std::fs::read_dir(values).unwrap().collect();
    assert!(!encrypted.is_empty(), "the key must be persisted on disk");
    for entry in encrypted {
        let bytes = std::fs::read(entry.unwrap().path()).unwrap();
        assert!(bytes.starts_with(b"ASHSEC\0\x01"));
        assert!(
            !bytes
                .windows(key.len())
                .any(|bytes| bytes == key.as_bytes())
        );
    }
    assert_eq!(
        std::fs::read_dir(harness.profile.join("secrets/values"))
            .unwrap()
            .count(),
        0
    );
    assert!(
        !std::fs::read_to_string(harness.root.path().join("server.log"))
            .unwrap()
            .contains(key)
    );
    let session = harness.session();
    let providers = session.client().list_providers().unwrap();
    assert!(
        providers
            .providers
            .iter()
            .any(|provider| provider.provider == "openai" && provider.api_key_configured)
    );
    session.shutdown().unwrap();
    assert_eq!(
        harness.json(&["logout", "chatgpt-subscription"])["status"],
        "alreadyLoggedOut"
    );
}

#[test]
fn doctor_reports_missing_backend_and_fails() {
    let root = tempfile::tempdir().unwrap();
    let output = Command::new(cargo_bin::cargo_bin!("ash").unwrap())
        .args(["doctor", "--json"])
        .env("ASH_HOME", root.path().join("profile"))
        .env("ASH_APP_SERVER_PATH", root.path().join("missing-backend"))
        .env_remove("ASH_APP_SERVER_SHA256")
        .output()
        .unwrap();
    assert_eq!(output.status.code(), Some(1));
    let report: Value = serde_json::from_slice(&output.stdout).unwrap();
    assert!(
        report["checks"]
            .as_array()
            .unwrap()
            .iter()
            .any(|check| check["name"] == "app-server executable" && check["status"] == "failed")
    );
}

#[test]
fn unavailable_keyring_reports_account_and_api_key_failures_without_plaintext_fallback() {
    for (keyring, expected_error) in [
        (
            account_server::KeyringMode::Unavailable,
            "SecretStorageUnavailable",
        ),
        (
            account_server::KeyringMode::Failed,
            "SecretStorageOperationFailed",
        ),
    ] {
        let mut harness = Harness::new();
        harness.start_account_server(keyring);
        let status = harness.output(&["login", "status"]);
        assert_eq!(status.status.code(), Some(1));
        assert!(String::from_utf8_lossy(&status.stderr).contains("AccountUnavailable"));
        let key = "unavailable-keyring-not-a-real-key";
        let mut child = harness
            .command(&["login", "api-key", "openai"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        writeln!(child.stdin.take().unwrap(), "{key}").unwrap();
        let output = child.wait_with_output().unwrap();
        assert_eq!(output.status.code(), Some(1));
        assert!(
            String::from_utf8_lossy(&output.stderr).contains(expected_error),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(!String::from_utf8_lossy(&output.stdout).contains(key));
        assert!(!String::from_utf8_lossy(&output.stderr).contains(key));
        for path in ["secrets/values", "secrets/encrypted/values"] {
            assert_eq!(
                std::fs::read_dir(harness.profile.join(path))
                    .unwrap()
                    .count(),
                0
            );
        }
        assert!(
            !std::fs::read_to_string(harness.root.path().join("server.log"))
                .unwrap()
                .contains(key)
        );
    }
}

#[test]
#[ignore = "subprocess fixture launched by account command tests"]
fn account_server_fixture() {
    account_server::run();
}

#[test]
fn credential_storage_commands_select_files_without_a_keyring_and_authorize_explicitly() {
    let mut harness = Harness::new();
    harness.start_account_server(account_server::KeyringMode::Unavailable);
    assert_eq!(
        harness.json(&["secrets", "status"])["status"],
        "unavailable"
    );
    assert_eq!(
        harness.json(&["secrets", "authorize"])["status"],
        "unavailable"
    );
    assert_eq!(
        harness.json(&["secrets", "mode", "file"]),
        serde_json::json!({"status":"available","mode":"file"})
    );
    assert_eq!(
        harness.json(&["secrets", "status"]),
        serde_json::json!({"status":"available","mode":"file"})
    );
    let failed = harness.output(&["secrets", "mode", "encrypted"]);
    assert!(!failed.status.success());
    assert_eq!(harness.json(&["secrets", "status"])["mode"], "file");
    let help = harness.output(&["secrets", "mode", "--help"]);
    assert!(help.status.success());
    assert!(String::from_utf8_lossy(&help.stdout).contains("unencrypted"));
    let chinese_help = harness
        .command(&["secrets", "mode", "--help"])
        .env("LC_ALL", "zh_CN.UTF-8")
        .output()
        .unwrap();
    assert!(chinese_help.status.success());
    assert!(String::from_utf8_lossy(&chinese_help.stdout).contains("未加密凭据"));
}

#[test]
fn managed_installer_reinstalls_and_launches_from_unicode_paths() {
    use sha2::Digest;

    let directory = TempDir::new().unwrap();
    let root = directory.path();
    let cli = cargo_bin::cargo_bin!("ash").unwrap();
    let binary_name = format!("ash{}", std::env::consts::EXE_SUFFIX);
    let install_root = root.join("安装 %! with spaces");
    let launchers = root.join("命令 with spaces");
    let mut previous = None;
    for generation in ["first", "second"] {
        let package = root.join(generation);
        let binary = package.join("bin").join(&binary_name);
        std::fs::create_dir_all(binary.parent().unwrap()).unwrap();
        cargo_bin::copy_executable(&cli, &binary).unwrap();
        std::fs::write(package.join("generation.txt"), generation).unwrap();
        let files = [format!("bin/{binary_name}"), "generation.txt".to_owned()]
            .into_iter()
            .map(|path| {
                let hash = format!(
                    "{:x}",
                    sha2::Sha256::digest(std::fs::read(package.join(&path)).unwrap())
                );
                (path, hash)
            })
            .collect::<std::collections::BTreeMap<_, _>>();
        let mut metadata = serde_json::json!({
            "layoutVersion": 2, "version": env!("CARGO_PKG_VERSION"), "target": build_info::TARGET,
            "buildProfile": "release", "javascriptRuntime": {"kind": "packagedNode"},
            "protocol": {"major": 1, "schemaHash": format!("sha256:{}", "0".repeat(64))},
            "components": {"cli": {"binarySha256": files[&format!("bin/{binary_name}")], "updatePublicKey": "01".repeat(32)}}
        });
        metadata.sort_all_objects();
        let mut digest = sha2::Sha256::new();
        digest.update(b"ash-package-build-v2\0");
        digest.update(serde_json::to_vec(&metadata).unwrap());
        digest.update(b"\0");
        for (path, hash) in &files {
            digest.update(path.as_bytes());
            digest.update(b"\0");
            digest.update(hash.as_bytes());
            digest.update(b"\0");
        }
        metadata["buildId"] = format!("sha256:{:x}", digest.finalize()).into();
        metadata["files"] = serde_json::to_value(files).unwrap();
        std::fs::write(
            package.join("ash-package.json"),
            serde_json::to_vec(&metadata).unwrap(),
        )
        .unwrap();
        let output = Command::new(&binary)
            .arg("install-managed")
            .arg("--package")
            .arg(&package)
            .arg("--install-root")
            .arg(&install_root)
            .arg("--bin-dir")
            .arg(&launchers)
            .env("LC_ALL", "zh_CN.UTF-8")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout).contains("Ash 已安装到"));
        #[cfg(unix)]
        let selected = std::fs::canonicalize(install_root.join("current")).unwrap();
        #[cfg(windows)]
        let selected = install_root
            .join("versions")
            .join(std::fs::read_to_string(install_root.join("current")).unwrap());
        assert_eq!(
            std::fs::read_to_string(selected.join("generation.txt")).unwrap(),
            generation
        );
        if let Some(previous) = &previous {
            assert_ne!(&selected, previous);
        }
        previous = Some(selected);
    }
    let launch = || {
        #[cfg(unix)]
        let mut command = Command::new(launchers.join("ash"));
        #[cfg(windows)]
        let mut command = {
            use std::os::windows::process::CommandExt;
            let mut command = Command::new("cmd.exe");
            // No console: the launcher must not rely on chcp or an OEM encoding.
            command
                .creation_flags(0x08000000)
                .args(["/D", "/S", "/C"])
                .raw_arg(format!(
                    "\"\"{}\" --version\"",
                    launchers.join("ash.cmd").display()
                ));
            command
        };
        #[cfg(unix)]
        command.arg("--version");
        command.output()
    };
    let output = launch().unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let expected = Command::new(&cli).arg("--version").output().unwrap();
    assert_eq!(output.stdout, expected.stdout);
    // The stable Windows adapter must execute the selected CLI, rather than run
    // the product code from its original immutable hard link.
    std::fs::remove_file(previous.unwrap().join("bin").join(binary_name)).unwrap();
    assert!(launch().map_or(true, |output| !output.status.success()));
}

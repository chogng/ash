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
        let backend = PathBuf::from(env!("CARGO_BIN_EXE_ash"))
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
        // The fixture owns the daemon lifetime, including under Cargo's Windows job.
        let log_path = self.root.path().join("server.log");
        let log = std::fs::File::create(&log_path).unwrap();
        let error_log = log.try_clone().unwrap();
        self.server = Some(
            Command::new(&self.backend)
                .arg("--managed")
                .current_dir(self.root.path())
                // Grok login discovery uses the host home separately from ASH_HOME.
                .env_remove("HOME")
                .env_remove("USERPROFILE")
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
        let mut command = Command::new(env!("CARGO_BIN_EXE_ash"));
        command
            .args(arguments)
            .current_dir(self.root.path())
            .env_remove("HOME")
            .env_remove("USERPROFILE")
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
            "{arguments:?}: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        serde_json::from_slice(&output.stdout).unwrap()
    }

    fn session(&self) -> AppServerSession {
        AppServerSession::start_stdio(
            StdioAppServerCommand::new(env!("CARGO_BIN_EXE_ash"))
                .with_argument("app-server")
                .with_argument("connect")
                .without_environment_variable("HOME")
                .without_environment_variable("USERPROFILE")
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
            let _ = server.wait();
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
        (vec!["mcp", "add", "--help"], 0),
        (vec!["login", "status", "--help"], 0),
        (vec!["not-a-command"], 2),
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
        let output = Command::new(env!("CARGO_BIN_EXE_ash"))
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
        env!("CARGO_BIN_EXE_ash"),
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
    harness.start_server();
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
    harness.start_server();
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
        harness.json(&["logout", "openai-chatgpt"])["status"],
        "alreadyLoggedOut"
    );
}

#[test]
fn doctor_reports_missing_backend_and_fails() {
    let root = tempfile::tempdir().unwrap();
    let output = Command::new(env!("CARGO_BIN_EXE_ash"))
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

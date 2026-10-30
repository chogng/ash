//! Installed-CLI cache boundary for the opt-in macOS subscription PTY scenario.

use ash_app_server_client::AppServerEvent;
use ash_app_server_client::AppServerEvents;
use ash_app_server_client::ServerNotification;
use ash_app_server_protocol::protocol::provider::ProviderModelsUpdated;
use serde_json::Value;
use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::process::Command;
use std::time::Duration;
use std::time::Instant;

const CLI: &str =
    "/Applications/ChatGPT.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
const CLI_VERSION: &str = "0.165.0-alpha.1.2";
const CACHE_VERSION: &str = "0.165.0";

#[derive(Clone, Copy)]
pub enum Account {
    A,
    B,
}

impl Account {
    pub fn id(self) -> &'static str {
        match self {
            Self::A => "tui-catalog-account-a",
            Self::B => "tui-catalog-account-b",
        }
    }

    fn user(self) -> &'static str {
        match self {
            Self::A => "tui-catalog-user-a",
            Self::B => "tui-catalog-user-b",
        }
    }

    fn email(self) -> &'static str {
        match self {
            Self::A => "tui-catalog-a@example.invalid",
            Self::B => "tui-catalog-b@example.invalid",
        }
    }

    fn jwt_payload(self) -> &'static str {
        // Unsigned synthetic claims; these accounts never authenticate to an endpoint.
        match self {
            Self::A => {
                "eyJlbWFpbCI6InR1aS1jYXRhbG9nLWFAZXhhbXBsZS5pbnZhbGlkIiwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS9hdXRoIjp7ImNoYXRncHRfdXNlcl9pZCI6InR1aS1jYXRhbG9nLXVzZXItYSIsImNoYXRncHRfYWNjb3VudF9pZCI6InR1aS1jYXRhbG9nLWFjY291bnQtYSIsImNoYXRncHRfcGxhbl90eXBlIjoicGx1cyJ9fQ"
            }
            Self::B => {
                "eyJlbWFpbCI6InR1aS1jYXRhbG9nLWJAZXhhbXBsZS5pbnZhbGlkIiwiaHR0cHM6Ly9hcGkub3BlbmFpLmNvbS9hdXRoIjp7ImNoYXRncHRfdXNlcl9pZCI6InR1aS1jYXRhbG9nLXVzZXItYiIsImNoYXRncHRfYWNjb3VudF9pZCI6InR1aS1jYXRhbG9nLWFjY291bnQtYiIsImNoYXRncHRfcGxhbl90eXBlIjoicGx1cyJ9fQ"
            }
        }
    }
}

pub struct Catalog {
    home: PathBuf,
    cache: Value,
}

impl Catalog {
    pub fn new(home: PathBuf) -> Self {
        let version = Command::new(CLI).arg("--version").output().unwrap();
        assert!(version.status.success());
        assert_eq!(
            String::from_utf8(version.stdout).unwrap().trim(),
            format!("codex-cli {CLI_VERSION}")
        );
        fs::create_dir_all(&home).unwrap();
        fs::write(
            home.join("config.toml"),
            "cli_auth_credentials_store = \"file\"\n[features]\nsecret_auth_storage = false\n",
        )
        .unwrap();
        Self {
            home,
            cache: Value::Null,
        }
    }

    pub fn switch_account(&mut self, account: Account) {
        // Publish the matching cache before credentials so discovery never uses another scope.
        self.cache["identity"] = identity(account).into();
        self.renew();
        atomic_json(
            &self.home.join("auth.json"),
            &json!({
                "auth_mode": "chatgpt",
                "OPENAI_API_KEY": null,
                "tokens": {
                    "id_token": format!("eyJhbGciOiJub25lIn0.{}.fixture", account.jwt_payload()),
                    "access_token": "eyJhbGciOiJub25lIn0.eyJleHAiOjQxMDI0NDQ4MDB9.fixture",
                    "refresh_token": "synthetic-never-used",
                    "account_id": account.id(),
                },
                "last_refresh": chrono::Utc::now().to_rfc3339(),
            }),
        );
    }

    pub fn set_model(&mut self, slug: &str, name: &str, effort: &str) {
        self.cache = json!({
            "fetched_at": chrono::Utc::now().to_rfc3339(),
            "client_version": CACHE_VERSION,
            "identity": self.cache.get("identity").cloned().unwrap_or(Value::Null),
            "models": [{
                "slug": slug,
                "display_name": name,
                "description": "Offline PTY fixture",
                "default_reasoning_level": effort,
                "supported_reasoning_levels": [
                    { "effort": "low", "description": "Quick fixture" },
                    { "effort": effort, "description": "Deep fixture" },
                ],
                "shell_type": "shell_command",
                "visibility": "list",
                "minimal_client_version": "0.1.0",
                "supported_in_api": true,
                "priority": 0,
                "upgrade": null,
                "base_instructions": "Synthetic fixture instructions",
                "model_messages": {
                    "instructions_template": "Synthetic fixture instructions",
                    "approvals": null,
                    "auto_review": null,
                    "permissions": null,
                },
                "support_verbosity": false,
                "default_verbosity": null,
                "apply_patch_tool_type": null,
                "truncation_policy": { "mode": "bytes", "limit": 10000 },
                "supports_image_detail_original": false,
                "context_window": 272000,
                "max_context_window": 272000,
                "experimental_supported_tools": [],
            }],
        });
        self.renew();
    }

    fn renew(&mut self) {
        self.cache["fetched_at"] = chrono::Utc::now().to_rfc3339().into();
        atomic_json(&self.home.join("models_cache.json"), &self.cache);
    }

    pub fn wait_for(
        &mut self,
        events: &AppServerEvents,
        timeout: Duration,
        accept: impl Fn(&ProviderModelsUpdated) -> bool,
    ) -> ProviderModelsUpdated {
        let deadline = Instant::now() + timeout;
        loop {
            assert!(
                Instant::now() < deadline,
                "subscription observer notification timed out"
            );
            // Freshness is renewed without changing account or metadata; observer timers stay real.
            self.renew();
            match events.recv_timeout(Duration::from_secs(1)) {
                Ok(AppServerEvent::Notification(ServerNotification::ProviderModelsUpdated(
                    update,
                ))) => {
                    println!(
                        "subscription notification: {}",
                        json!({
                            "at": chrono::Utc::now().to_rfc3339(),
                            "update": update,
                        })
                    );
                    if accept(&update) {
                        return update;
                    }
                }
                Ok(AppServerEvent::ConnectionClosed(reason)) => {
                    panic!("observer disconnected: {reason:?}")
                }
                Ok(_) | Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {}
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    panic!("observer event stream closed")
                }
            }
        }
    }
}

fn atomic_json(path: &Path, value: &Value) {
    let temporary = path.with_extension("fixture.json");
    fs::write(&temporary, serde_json::to_vec(value).unwrap()).unwrap();
    fs::rename(temporary, path).unwrap();
}

fn identity(account: Account) -> String {
    // Verified against this exact installed CLI with OS-level network denial. Its prerelease
    // header uses the full version, while cache eligibility uses the whole semver version.
    let values = vec![
        b"models-cache-v1".to_vec(),
        b"OpenAI".to_vec(),
        b"https://chatgpt.com/backend-api/codex".to_vec(),
        0_u64.to_le_bytes().to_vec(),
        vec![1],
        vec![0],
        b"Some(Chatgpt)".to_vec(),
        format!("Some({:?})", account.id()).into_bytes(),
        format!("Some({:?})", account.user()).into_bytes(),
        format!("Some({:?})", account.email()).into_bytes(),
        b"Some(Plus)".to_vec(),
        b"Some(\"plus\")".to_vec(),
        vec![0],
        1_u64.to_le_bytes().to_vec(),
        b"version".to_vec(),
        CLI_VERSION.as_bytes().to_vec(),
    ];
    let mut digest = Sha256::new();
    for value in values {
        digest.update((value.len() as u64).to_le_bytes());
        digest.update(value);
    }
    format!("{:x}", digest.finalize())
}

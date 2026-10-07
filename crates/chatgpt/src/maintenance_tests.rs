use super::*;
use crate::ChatGptOAuth;
use ash_client::ClientError;
use ash_client::ClientResponse;
use ash_login::AccountStatus;
use ash_login::InteractiveLoginDriver;
use ash_login::LoginMethod;
use ash_login::LoginService;
use ash_secrets::MemorySecretStore;
use base64::Engine;
use std::collections::VecDeque;
use std::sync::Arc;

struct Client {
    responses: Mutex<VecDeque<(u16, serde_json::Value)>>,
    requests: Mutex<Vec<(String, serde_json::Value)>>,
    during_request: Mutex<Option<Box<dyn FnOnce() + Send>>>,
}

impl Client {
    fn new(responses: impl IntoIterator<Item = (u16, serde_json::Value)>) -> Arc<Self> {
        Arc::new(Self {
            responses: Mutex::new(responses.into_iter().collect()),
            requests: Mutex::new(Vec::new()),
            during_request: Mutex::new(None),
        })
    }
}

impl OperationClient for Client {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        self.requests.lock().unwrap().push((
            request.url().into(),
            serde_json::from_slice(request.body()).unwrap_or_default(),
        ));
        if let Some(action) = self.during_request.lock().unwrap().take() {
            action();
        }
        let (status, body) = self
            .responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected authentication request");
        Ok(ClientResponse::new(
            status,
            Vec::new(),
            serde_json::to_vec(&body).unwrap(),
        ))
    }
}

fn jwt(value: serde_json::Value) -> String {
    format!(
        "e30.{}.signature",
        base64::engine::general_purpose::URL_SAFE_NO_PAD
            .encode(serde_json::to_vec(&value).unwrap())
    )
}

fn access(expiry: u64, version: &str) -> String {
    jwt(serde_json::json!({"exp":expiry,"jti":version}))
}

fn document(token: &str) -> serde_json::Value {
    serde_json::json!({"auth_mode":"chatgpt","OPENAI_API_KEY":null,
        "tokens":{"id_token":jwt(serde_json::json!({"https://api.openai.com/auth":{"chatgpt_user_id":"user-1","chatgpt_account_id":"account-1","chatgpt_plan_type":"pro"}})),"access_token":token,"refresh_token":"old-refresh","account_id":"account-1"},
        "last_refresh":"2020-01-01T00:00:00Z","other_metadata":{"preserve":true}})
}

fn runtime(home: &Path, client: Arc<Client>, mode: ChatGptAuthManagement) -> Arc<ChatGptOAuth> {
    ChatGptOAuth::with_client(
        home.into(),
        Arc::new(MemorySecretStore::default()),
        client,
        mode,
    )
}

#[test]
fn managed_refresh_rotates_tokens_and_preserves_omitted_fields_and_metadata() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("auth.json");
    let old = document(&access(1, "old"));
    std::fs::write(&path, serde_json::to_vec(&old).unwrap()).unwrap();
    let new_access = access(4_000_000_000, "new");
    let client = Client::new([(
        200,
        serde_json::json!({"access_token":new_access,"refresh_token":"rotated-refresh"}),
    )]);
    let auth = runtime(home.path(), client.clone(), ChatGptAuthManagement::Ash);
    auth.api_target().unwrap();
    auth.api_target().unwrap();
    let saved: serde_json::Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
    assert_eq!(saved["tokens"]["id_token"], old["tokens"]["id_token"]);
    assert_eq!(saved["tokens"]["account_id"], "account-1");
    assert_eq!(saved["other_metadata"], old["other_metadata"]);
    assert_eq!(saved["tokens"]["access_token"], new_access);
    assert_eq!(saved["tokens"]["refresh_token"], "rotated-refresh");
    assert_ne!(saved["last_refresh"], old["last_refresh"]);
    assert_eq!(
        *client.requests.lock().unwrap(),
        vec![(
            "https://auth.openai.com/oauth/token".into(),
            serde_json::json!({"client_id":CLIENT_ID,"grant_type":"refresh_token","refresh_token":"old-refresh"})
        )]
    );
    assert_eq!(
        auth.read_account().unwrap().unwrap().status,
        AccountStatus::Ready
    );
}

#[test]
fn expiration_window_and_unknown_expiry_age_match_codex() {
    let now = crate::credential::now_epoch_seconds();
    for (token, last, refreshes) in [
        (
            "opaque-access-token".into(),
            "2020-01-01T00:00:00Z".into(),
            true,
        ),
        (
            access(now + 240, "near"),
            chrono::Utc::now().to_rfc3339(),
            true,
        ),
        (
            access(now + 3600, "valid"),
            "2020-01-01T00:00:00Z".into(),
            false,
        ),
        (
            jwt(serde_json::json!({"jti":"no-exp"})),
            "2020-01-01T00:00:00Z".into(),
            true,
        ),
        (
            jwt(serde_json::json!({"jti":"no-exp"})),
            chrono::Utc::now().to_rfc3339(),
            false,
        ),
    ] {
        let home = tempfile::tempdir().unwrap();
        let mut auth = document(&token);
        auth["last_refresh"] = last.into();
        std::fs::write(
            home.path().join("auth.json"),
            serde_json::to_vec(&auth).unwrap(),
        )
        .unwrap();
        let client = Client::new([(
            200,
            serde_json::json!({"access_token":access(now+3600,"renewed")}),
        )]);
        runtime(home.path(), client.clone(), ChatGptAuthManagement::Ash)
            .api_target()
            .unwrap();
        assert_eq!(
            client.requests.lock().unwrap().len(),
            usize::from(refreshes)
        );
    }
}

#[test]
fn two_managers_share_one_refresh_and_codex_handoff_stops_new_refreshes() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("auth.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&document(&access(1, "old"))).unwrap(),
    )
    .unwrap();
    let client = Client::new([(
        200,
        serde_json::json!({"access_token":access(4_000_000_000,"new")}),
    )]);
    let first = runtime(home.path(), client.clone(), ChatGptAuthManagement::Ash);
    let second = runtime(home.path(), client.clone(), ChatGptAuthManagement::Ash);
    let barrier = Arc::new(std::sync::Barrier::new(3));
    let workers: Vec<_> = [first, second]
        .into_iter()
        .map(|auth| {
            let barrier = barrier.clone();
            std::thread::spawn(move || {
                barrier.wait();
                auth.api_target().unwrap();
            })
        })
        .collect();
    barrier.wait();
    for worker in workers {
        worker.join().unwrap();
    }
    assert_eq!(client.requests.lock().unwrap().len(), 1);
    let old = serde_json::to_vec(&document(&access(1, "expired-after-handoff"))).unwrap();
    std::fs::write(&path, &old).unwrap();
    assert!(
        runtime(home.path(), client.clone(), ChatGptAuthManagement::Codex)
            .api_target()
            .is_err()
    );
    assert_eq!(client.requests.lock().unwrap().len(), 1);
    assert_eq!(std::fs::read(path).unwrap(), old);
}

#[test]
fn temporary_failure_keeps_valid_access_and_permanent_failure_allows_new_login() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("auth.json");
    let initial = serde_json::to_vec(&document(&access(
        crate::credential::now_epoch_seconds() + 200,
        "valid",
    )))
    .unwrap();
    std::fs::write(&path, &initial).unwrap();
    let fresh = document(&access(4_000_000_000, "reauthenticated"));
    let client = Client::new([
        (503, serde_json::json!({"error":"temporary"})),
        (400, serde_json::json!({"error":"invalid_grant"})),
        (
            200,
            serde_json::json!({"device_auth_id":"device-1","user_code":"ABCD-EFGH","interval":"1"}),
        ),
        (
            200,
            serde_json::json!({"authorization_code":"code","code_verifier":"verifier"}),
        ),
        (200, fresh["tokens"].clone()),
    ]);
    let auth = runtime(home.path(), client.clone(), ChatGptAuthManagement::Ash);
    auth.api_target().unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), initial);
    std::fs::write(
        &path,
        serde_json::to_vec(&document(&access(1, "expired"))).unwrap(),
    )
    .unwrap();
    assert!(auth.api_target().is_err());
    assert!(auth.api_target().is_err());
    assert_eq!(client.requests.lock().unwrap().len(), 2);
    assert_eq!(
        auth.read_account().unwrap().unwrap().status,
        AccountStatus::ReauthenticationRequired
    );
    let service = Arc::new(LoginService::new(auth.clone()).unwrap());
    auth.install_login_service(&service).unwrap();
    assert!(matches!(
        service.begin(LoginMethod::OpenAiChatGptDeviceCode).unwrap(),
        ash_login::BeginLogin::DeviceCode { .. }
    ));
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
    while service
        .read()
        .unwrap()
        .accounts
        .first()
        .is_none_or(|account| account.status != AccountStatus::Ready)
    {
        assert!(std::time::Instant::now() < deadline);
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    auth.api_target().unwrap();
    assert_eq!(client.requests.lock().unwrap().len(), 5);
}

#[test]
fn refresh_does_not_overwrite_an_external_update() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("auth.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&document(&access(1, "old"))).unwrap(),
    )
    .unwrap();
    let external = serde_json::to_vec(&document(&access(4_000_000_000, "external"))).unwrap();
    let client = Client::new([(
        200,
        serde_json::json!({"access_token":access(4_000_000_000,"ours")}),
    )]);
    let write_path = path.clone();
    let bytes = external.clone();
    *client.during_request.lock().unwrap() = Some(Box::new(move || {
        std::fs::write(write_path, bytes).unwrap();
    }));
    let auth = runtime(home.path(), client.clone(), ChatGptAuthManagement::Ash);
    assert!(auth.api_target().is_err());
    assert_eq!(std::fs::read(path).unwrap(), external);
    auth.api_target().unwrap();
    assert_eq!(client.requests.lock().unwrap().len(), 1);
}

#[test]
fn refresh_rejects_another_user_in_the_same_workspace_without_committing_tokens() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("auth.json");
    let original = serde_json::to_vec(&document(&access(1, "old"))).unwrap();
    std::fs::write(&path, &original).unwrap();
    let client = Client::new([(
        200,
        serde_json::json!({
            "id_token":jwt(serde_json::json!({"https://api.openai.com/auth":{
                "chatgpt_user_id":"user-2","chatgpt_account_id":"account-1"
            }})),
            "access_token":access(4_000_000_000, "new"),"refresh_token":"rotated"
        }),
    )]);
    let auth = runtime(home.path(), client.clone(), ChatGptAuthManagement::Ash);
    assert!(auth.api_target().is_err());
    assert_eq!(std::fs::read(path).unwrap(), original);
    assert_eq!(client.requests.lock().unwrap().len(), 1);
}

#[test]
fn incomplete_identity_cannot_authorize_a_request_or_refresh() {
    for user in [serde_json::Value::Null, serde_json::json!(" ")] {
        let home = tempfile::tempdir().unwrap();
        let mut value = document(&access(1, "expired"));
        value["tokens"]["id_token"] = jwt(serde_json::json!({"https://api.openai.com/auth":{
            "chatgpt_user_id":user,"chatgpt_account_id":"account-1"
        }}))
        .into();
        std::fs::write(
            home.path().join("auth.json"),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
        let client = Client::new([]);
        let auth = runtime(home.path(), client.clone(), ChatGptAuthManagement::Ash);
        assert!(auth.api_target().is_err());
        assert_eq!(
            auth.read_account().unwrap().unwrap().status,
            AccountStatus::ReauthenticationRequired
        );
        assert!(client.requests.lock().unwrap().is_empty());
    }
}

#[test]
fn discovery_uses_executable_files_and_observes_installation_changes() {
    let root = tempfile::tempdir().unwrap();
    let bin = root.path().join("platform");
    std::fs::create_dir(&bin).unwrap();
    assert!(!executable_in(root.path(), 4));
    let path = bin.join(if cfg!(windows) { "codex.exe" } else { "codex" });
    std::fs::write(&path, b"test fixture").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(!executable_in(root.path(), 4));
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    assert!(executable_in(root.path(), 4));
    std::fs::remove_file(path).unwrap();
    assert!(!executable_in(root.path(), 4));
}

#[test]
fn recovery_reloads_new_tokens_and_never_changes_accounts() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("auth.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&document(&access(4_000_000_000, "old"))).unwrap(),
    )
    .unwrap();
    let store = CodexAuthStore::new(home.path().into());
    let original = store.load().unwrap().unwrap();
    let manager = AuthMaintenance::new(ChatGptAuthManagement::Ash);
    let client = Client::new([]);
    std::fs::write(
        &path,
        serde_json::to_vec(&document(&access(4_000_000_000, "external"))).unwrap(),
    )
    .unwrap();
    let adopted = manager
        .resolve(
            &store,
            client.as_ref(),
            RefreshReason::Unauthorized {
                identity: original.identity().unwrap(),
                revision: original.storage_revision,
            },
        )
        .unwrap()
        .unwrap();
    assert_ne!(adopted.access_token, original.access_token);
    let mut other = document(&access(4_000_000_000, "other-account"));
    other["tokens"]["account_id"] = "account-2".into();
    std::fs::write(&path, serde_json::to_vec(&other).unwrap()).unwrap();
    assert!(
        manager
            .resolve(
                &store,
                client.as_ref(),
                RefreshReason::Unauthorized {
                    identity: original.identity().unwrap(),
                    revision: original.storage_revision
                }
            )
            .is_err()
    );
    assert!(client.requests.lock().unwrap().is_empty());
}

#[test]
fn terminal_refresh_errors_are_classified_without_returning_provider_details() {
    for (status, body, permanent) in [
        (401, serde_json::json!({}), true),
        (400, serde_json::json!({"error":"invalid_grant"}), true),
        (
            400,
            serde_json::json!({"error":{"code":"REFRESH_TOKEN_EXPIRED"}}),
            true,
        ),
        (
            400,
            serde_json::json!({"code":"refresh_token_reused"}),
            true,
        ),
        (
            400,
            serde_json::json!({"error":{"code":"refresh_token_invalidated"}}),
            true,
        ),
        (
            503,
            serde_json::json!({"error":{"message":"private diagnostic"}}),
            false,
        ),
    ] {
        let client = Client::new([(status, body)]);
        let failure = request_refresh(client.as_ref(), "test-refresh")
            .err()
            .unwrap();
        assert_eq!(matches!(failure, RefreshFailure::Permanent), permanent);
    }
}

#[test]
#[ignore = "Requires official Codex CLI; checks only synthetic refreshed credentials, no model"]
fn codex_cli_accepts_refreshed_credentials() {
    let home = tempfile::tempdir().unwrap();
    let path = home.path().join("auth.json");
    std::fs::write(
        &path,
        serde_json::to_vec(&document(&access(1, "expired"))).unwrap(),
    )
    .unwrap();
    let client = Client::new([(
        200,
        serde_json::json!({"access_token":access(4_000_000_000,"updated"),"refresh_token":"updated-refresh"}),
    )]);
    runtime(home.path(), client, ChatGptAuthManagement::Ash)
        .api_target()
        .unwrap();
    let before = std::fs::read(&path).unwrap();
    let output = std::process::Command::new("codex")
        .args(["login", "status"])
        .env("CODEX_HOME", home.path())
        .env_remove("OPENAI_API_KEY")
        .env_remove("CODEX_API_KEY")
        .current_dir(home.path())
        .output()
        .unwrap();
    assert!(output.status.success());
    assert!(String::from_utf8_lossy(&output.stderr).contains("Logged in using ChatGPT"));
    assert!(std::fs::read(path).unwrap() == before);
}

#[test]
fn managed_logout_clears_auth_but_codex_owned_disconnect_preserves_it() {
    for mode in [ChatGptAuthManagement::Ash, ChatGptAuthManagement::Codex] {
        let home = tempfile::tempdir().unwrap();
        let path = home.path().join("auth.json");
        let original = serde_json::to_vec(&document(&access(4_000_000_000, "valid"))).unwrap();
        std::fs::write(&path, &original).unwrap();
        let client = Client::new([]);
        let auth = runtime(home.path(), client.clone(), mode);
        let account = auth.read_account().unwrap().unwrap().account;
        auth.logout(&account).unwrap();
        assert!(auth.read_account().unwrap().is_none());
        assert!(client.requests.lock().unwrap().is_empty());
        if mode == ChatGptAuthManagement::Ash {
            assert!(!path.exists());
        } else {
            assert_eq!(std::fs::read(path).unwrap(), original);
        }
    }
}

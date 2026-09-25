use super::credential::TokenResponse;
use super::storage::CodexAuthStore;
use super::*;
use ash_client::ClientError;
use ash_client::ClientRequest;
use ash_client::ClientResponse;
use ash_client::OperationClient;
use ash_http_client::HttpResponse;
use ash_login::AccountStatus;
use ash_login::BeginLogin;
use ash_login::InteractiveLoginDriver;
use ash_login::LoginMethod;
use ash_login::LoginService;
use ash_secrets::MemorySecretStore;
use base64::Engine;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;

struct ScriptedClient {
    responses: Mutex<VecDeque<ClientResponse>>,
    requests: Mutex<Vec<ClientRequest>>,
}

impl ScriptedClient {
    fn new(responses: impl IntoIterator<Item = ClientResponse>) -> Self {
        Self {
            responses: Mutex::new(responses.into_iter().collect()),
            requests: Mutex::new(Vec::new()),
        }
    }
}

impl OperationClient for ScriptedClient {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        self.requests.lock().unwrap().push(request.clone());
        self.responses
            .lock()
            .unwrap()
            .pop_front()
            .ok_or_else(|| ClientError::Transport("script exhausted".into()))
    }
}

#[test]
fn device_flow_creates_codex_compatible_credentials_and_subscription_headers() {
    let id_token = jwt(serde_json::json!({
        "email": "person@example.com",
        "https://api.openai.com/auth": {
            "chatgpt_plan_type": "plus",
            "chatgpt_user_id": "user-1",
            "chatgpt_account_id": "account-1"
        }
    }));
    let access_token = jwt(serde_json::json!({ "exp": 4_000_000_000_u64 }));
    let client = Arc::new(ScriptedClient::new([
        response(
            200,
            r#"{"device_auth_id":"device-1","user_code":"ABCD-EFGH","interval":"1"}"#,
        ),
        response(
            200,
            r#"{"authorization_code":"auth-code","code_challenge":"unused","code_verifier":"verifier"}"#,
        ),
        response(
            200,
            &format!(
                r#"{{"id_token":"{id_token}","access_token":"{access_token}","refresh_token":"refresh-secret"}}"#
            ),
        ),
    ]));
    let secrets = Arc::new(MemorySecretStore::default());
    let home = tempfile::tempdir().unwrap();
    let runtime = ChatGptOAuth::with_client(
        home.path().to_path_buf(),
        secrets.clone(),
        client.clone(),
        ChatGptAuthManagement::Codex,
    );
    let driver: Arc<dyn InteractiveLoginDriver> = runtime.clone();
    let service = Arc::new(LoginService::new(driver).unwrap());
    runtime.install_login_service(&service).unwrap();

    let started = service.begin(LoginMethod::OpenAiChatGptDeviceCode).unwrap();
    assert!(matches!(
        started,
        BeginLogin::DeviceCode {
            ref verification_url,
            ref user_code,
            ..
        } if verification_url == "https://auth.openai.com/codex/device"
            && user_code == "ABCD-EFGH"
    ));
    for _ in 0..100 {
        if !service.read().unwrap().accounts.is_empty() {
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    let account = service.read().unwrap().accounts[0].clone();
    assert_eq!(account.account.provider, CHATGPT_SUBSCRIPTION_PROVIDER_ID);
    assert_eq!(account.email.as_deref(), Some("person@example.com"));
    assert_eq!(account.plan.as_deref(), Some("plus"));
    assert_eq!(account.status, AccountStatus::Ready);

    let target = runtime.api_target().unwrap().into_api_target();
    assert_eq!(target.base_url, CHATGPT_RESPONSES_BASE_URL);
    assert!(target.headers.iter().any(|header| {
        header.name() == "Authorization" && header.value() == format!("Bearer {access_token}")
    }));
    assert!(
        target.headers.iter().any(|header| {
            header.name() == "ChatGPT-Account-ID" && header.value() == "account-1"
        })
    );
    assert!(
        target
            .headers
            .iter()
            .any(|header| header.name() == "Originator" && header.value() == "ash")
    );
    let stored: serde_json::Value =
        serde_json::from_slice(&std::fs::read(home.path().join("auth.json")).unwrap()).unwrap();
    assert_eq!(stored["auth_mode"], "chatgpt");
    assert_eq!(stored["tokens"]["refresh_token"], "refresh-secret");
    assert_eq!(stored["tokens"]["account_id"], "account-1");
    assert!(stored.get("last_refresh").is_some());

    let requests = client.requests.lock().unwrap();
    assert_eq!(
        requests[0].url(),
        "https://auth.openai.com/api/accounts/deviceauth/usercode"
    );
    assert_eq!(
        requests[1].url(),
        "https://auth.openai.com/api/accounts/deviceauth/token"
    );
    assert_eq!(requests[2].url(), "https://auth.openai.com/oauth/token");
    let exchange = std::str::from_utf8(requests[2].body()).unwrap();
    assert!(exchange.contains("code=auth-code"));
    assert!(
        exchange.contains("redirect_uri=https%3A%2F%2Fauth.openai.com%2Fdeviceauth%2Fcallback")
    );
}

#[test]
fn existing_codex_tokens_are_read_only_and_expiration_never_refreshes() {
    let home = tempfile::tempdir().unwrap();
    let client = Arc::new(ScriptedClient::new([]));
    let secrets = Arc::new(MemorySecretStore::default());
    let runtime = ChatGptOAuth::with_client(
        home.path().into(),
        secrets,
        client.clone(),
        ChatGptAuthManagement::Codex,
    );
    let tokens = test_tokens(4_000_000_000);
    CodexAuthStore::new(home.path().into())
        .create(&tokens)
        .unwrap();
    let auth = home.path().join("auth.json");
    let original = std::fs::read(&auth).unwrap();
    runtime.api_target().unwrap();
    assert_eq!(std::fs::read(&auth).unwrap(), original);
    let mut encoded: serde_json::Value = serde_json::from_slice(&original).unwrap();
    encoded["tokens"]["access_token"] = jwt(serde_json::json!({"exp":1})).into();
    std::fs::write(&auth, serde_json::to_vec(&encoded).unwrap()).unwrap();
    let expired = std::fs::read(&auth).unwrap();
    assert_eq!(
        runtime.read_account().unwrap().unwrap().status,
        AccountStatus::ReauthenticationRequired
    );
    assert!(runtime.api_target().is_err());
    assert_eq!(std::fs::read(&auth).unwrap(), expired);
    assert!(client.requests.lock().unwrap().is_empty());
}

#[test]
fn disconnect_and_reconnect_leave_codex_unchanged_and_external_logout_is_observed() {
    let home = tempfile::tempdir().unwrap();
    let client = Arc::new(ScriptedClient::new([]));
    let secrets = Arc::new(MemorySecretStore::default());
    CodexAuthStore::new(home.path().into())
        .create(&test_tokens(4_000_000_000))
        .unwrap();
    let auth = home.path().join("auth.json");
    let original = std::fs::read(&auth).unwrap();
    let runtime = ChatGptOAuth::with_client(
        home.path().into(),
        secrets.clone(),
        client.clone(),
        ChatGptAuthManagement::Codex,
    );
    let service = Arc::new(LoginService::new(runtime.clone()).unwrap());
    runtime.install_login_service(&service).unwrap();
    service
        .logout_provider(CHATGPT_SUBSCRIPTION_PROVIDER_ID)
        .unwrap();
    assert!(runtime.read_account().unwrap().is_none());
    assert!(runtime.api_target().is_err());
    let restarted = ChatGptOAuth::with_client(
        home.path().into(),
        secrets,
        client.clone(),
        ChatGptAuthManagement::Codex,
    );
    assert!(restarted.read_account().unwrap().is_none());
    assert!(matches!(
        service.begin(LoginMethod::OpenAiChatGptDeviceCode).unwrap(),
        BeginLogin::Connected { .. }
    ));
    assert_eq!(
        service.read().unwrap().accounts[0].status,
        AccountStatus::Ready
    );
    assert_eq!(std::fs::read(&auth).unwrap(), original);
    assert!(client.requests.lock().unwrap().is_empty());
    std::fs::remove_file(auth).unwrap();
    assert!(runtime.read_account().unwrap().is_none());
    assert!(runtime.api_target().is_err());
}

fn test_tokens(expiry: u64) -> TokenResponse {
    TokenResponse {
        id_token: jwt(
            serde_json::json!({"email":"person@example.com", "https://api.openai.com/auth":{"chatgpt_user_id":"user-1","chatgpt_account_id":"account-1", "chatgpt_plan_type":"plus"}}),
        ),
        access_token: jwt(serde_json::json!({"exp":expiry})),
        refresh_token: "test-refresh-never-used".into(),
    }
}

struct LateTokenClient {
    scripted: ScriptedClient,
    entered: std::sync::mpsc::SyncSender<()>,
    gate: (Mutex<bool>, std::sync::Condvar),
}

impl OperationClient for LateTokenClient {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        if request.url() == "https://auth.openai.com/oauth/token" {
            self.entered.send(()).unwrap();
            let (released, timeout) = self
                .gate
                .1
                .wait_timeout_while(
                    self.gate.0.lock().unwrap(),
                    Duration::from_secs(5),
                    |released| !*released,
                )
                .unwrap();
            assert!(
                *released && !timeout.timed_out(),
                "test must release token exchange"
            );
        }
        self.scripted.execute(request)
    }
}

#[test]
fn cancellation_and_shutdown_prevent_late_tokens_from_creating_auth_json() {
    for shutdown in [false, true] {
        let home = tempfile::tempdir().unwrap();
        let tokens = test_tokens(4_000_000_000);
        let (entered, waiting) = std::sync::mpsc::sync_channel(1);
        let client = Arc::new(LateTokenClient {
            scripted: ScriptedClient::new([
                response(200, r#"{"device_auth_id":"device-1","user_code":"ABCD-EFGH","interval":"1"}"#),
                response(200, r#"{"authorization_code":"auth-code","code_verifier":"verifier"}"#),
                response(200, &serde_json::json!({"id_token":tokens.id_token,"access_token":tokens.access_token,"refresh_token":tokens.refresh_token}).to_string()),
            ]),
            entered,
            gate: (Mutex::new(false), std::sync::Condvar::new()),
        });
        let runtime = ChatGptOAuth::with_client(
            home.path().into(),
            Arc::new(MemorySecretStore::default()),
            client.clone(),
            ChatGptAuthManagement::Codex,
        );
        let weak = Arc::downgrade(&runtime);
        let service = Arc::new(LoginService::new(runtime.clone()).unwrap());
        runtime.install_login_service(&service).unwrap();
        let started = service.begin(LoginMethod::OpenAiChatGptDeviceCode).unwrap();
        waiting.recv_timeout(Duration::from_secs(5)).unwrap();
        if !shutdown {
            assert_eq!(
                service.cancel(started.login_id()).unwrap(),
                ash_login::CancelLoginOutcome::Cancelled
            );
        }
        drop(service);
        drop(runtime);
        assert!(
            weak.upgrade().is_none(),
            "a waiting login must not keep the backend alive"
        );
        *client.gate.0.lock().unwrap() = true;
        client.gate.1.notify_all();
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while Arc::strong_count(&client) > 1 {
            assert!(
                std::time::Instant::now() < deadline,
                "login worker must finish after cancellation"
            );
            thread::sleep(Duration::from_millis(5));
        }
        assert!(!home.path().join("auth.json").exists());
    }
}

fn jwt(payload: serde_json::Value) -> String {
    let payload = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .encode(serde_json::to_vec(&payload).unwrap());
    format!("e30.{payload}.signature")
}

fn response(status: u16, body: &str) -> ClientResponse {
    HttpResponse::new(status, Vec::new(), body.as_bytes().to_vec())
}

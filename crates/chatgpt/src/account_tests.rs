use super::*;
use crate::ChatGptAuthManagement;
use ash_async_utils::CancellationSource;
use ash_client::ClientError;
use ash_client::ClientRequest;
use ash_client::ClientResponse;
use ash_client::OperationClient;
use ash_secrets::MemorySecretStore;
use base64::Engine;
use std::collections::VecDeque;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

struct Client {
    responses: Mutex<VecDeque<(u16, serde_json::Value)>>,
    requests: Mutex<Vec<ClientRequest>>,
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
        self.requests.lock().unwrap().push(request.clone());
        if let Some(action) = self.during_request.lock().unwrap().take() {
            action();
        }
        let (status, body) = self
            .responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected request");
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

fn credentials(path: &Path, account: &str, expiry: u64) {
    std::fs::write(path.join("auth.json"), serde_json::to_vec(&serde_json::json!({
        "auth_mode":"chatgpt", "tokens": {
            "id_token":jwt(serde_json::json!({"https://api.openai.com/auth":{"chatgpt_user_id":"user-1","chatgpt_account_id":account,"chatgpt_plan_type":"plus","chatgpt_account_is_fedramp":true}})),
            "access_token":jwt(serde_json::json!({"exp":expiry})),
            "refresh_token":"refresh-secret", "account_id":account
        }, "last_refresh":"2026-09-01T00:00:00Z"
    })).unwrap()).unwrap();
}

fn runtime(path: &Path, client: Arc<Client>, management: ChatGptAuthManagement) -> ChatGptAccount {
    ChatGptAccount::new(ChatGptOAuth::with_client(
        path.into(),
        Arc::new(MemorySecretStore::default()),
        client,
        management,
    ))
}

fn usage() -> serde_json::Value {
    serde_json::json!({"account_id":"account-1","plan_type":"plus","rate_limit":{"allowed":true,"limit_reached":false,
        "primary_window":{"used_percent":25,"limit_window_seconds":18000,"reset_at":2000000000}}})
}

#[test]
fn usage_reuses_credentials_read_only_and_preserves_account_routing() {
    let home = tempfile::tempdir().unwrap();
    credentials(home.path(), "account-1", 4_000_000_000);
    let original = std::fs::read(home.path().join("auth.json")).unwrap();
    let client = Client::new([(200, usage())]);
    let auth = runtime(home.path(), client.clone(), ChatGptAuthManagement::Codex);
    let result = auth
        .read_rate_limits("account-1", &CancellationSource::new().token())
        .unwrap();
    assert_eq!(result.limits[0].primary.as_ref().unwrap().used_percent, 25);
    assert_eq!(
        std::fs::read(home.path().join("auth.json")).unwrap(),
        original
    );
    let requests = client.requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].url(),
        "https://chatgpt.com/backend-api/wham/usage"
    );
    for (name, value) in [
        ("ChatGPT-Account-ID", "account-1"),
        ("X-OpenAI-Fedramp", "true"),
        ("Originator", "ash"),
    ] {
        assert!(
            requests[0]
                .headers()
                .iter()
                .any(|header| header.name() == name && header.value() == value)
        );
    }
    assert!(
        requests[0]
            .headers()
            .iter()
            .any(|header| header.name() == "Authorization")
    );
}

#[test]
fn rejected_codex_credentials_are_not_refreshed_or_retried() {
    let home = tempfile::tempdir().unwrap();
    credentials(home.path(), "account-1", 4_000_000_000);
    let original = std::fs::read(home.path().join("auth.json")).unwrap();
    let client = Client::new([(401, serde_json::json!({"error":"secret"}))]);
    let auth = runtime(home.path(), client.clone(), ChatGptAuthManagement::Codex);
    assert_eq!(
        auth.read_rate_limits("account-1", &CancellationSource::new().token()),
        Err(ChatGptUsageError::AuthenticationRequired)
    );
    assert_eq!(client.requests.lock().unwrap().len(), 1);
    assert_eq!(
        std::fs::read(home.path().join("auth.json")).unwrap(),
        original
    );
}

#[test]
fn ash_managed_credentials_recover_once_on_the_same_backend_route() {
    for final_status in [200, 401] {
        let home = tempfile::tempdir().unwrap();
        credentials(home.path(), "account-1", 4_000_000_000);
        let refreshed = jwt(serde_json::json!({"exp":4_000_000_000_u64,"jti":"new"}));
        let client = Client::new([
            (401, serde_json::json!({})),
            (200, serde_json::json!({"access_token":refreshed})),
            (final_status, usage()),
        ]);
        let auth = runtime(home.path(), client.clone(), ChatGptAuthManagement::Ash);
        let result = auth.read_rate_limits("account-1", &CancellationSource::new().token());
        if final_status == 200 {
            assert!(result.is_ok());
        } else {
            assert_eq!(result, Err(ChatGptUsageError::AuthenticationRequired));
        }
        let requests = client.requests.lock().unwrap();
        assert_eq!(
            requests.iter().map(|r| r.url()).collect::<Vec<_>>(),
            vec![
                "https://chatgpt.com/backend-api/wham/usage",
                "https://auth.openai.com/oauth/token",
                "https://chatgpt.com/backend-api/wham/usage"
            ]
        );
        assert!(
            requests[2]
                .headers()
                .iter()
                .any(|header| header.name() == "Authorization"
                    && header.value() == format!("Bearer {refreshed}"))
        );
    }
}

#[test]
fn usage_rejects_stale_account_ids_and_account_changes_during_a_request() {
    for status in [200, 401] {
        let home = tempfile::tempdir().unwrap();
        credentials(home.path(), "account-1", 4_000_000_000);
        let client = Client::new([(status, usage())]);
        let auth = runtime(home.path(), client.clone(), ChatGptAuthManagement::Codex);
        assert_eq!(
            auth.read_rate_limits("account-2", &CancellationSource::new().token()),
            Err(ChatGptUsageError::AccountChanged)
        );
        assert!(client.requests.lock().unwrap().is_empty());
        let path = home.path().to_owned();
        *client.during_request.lock().unwrap() = Some(Box::new(move || {
            credentials(&path, "account-2", 4_000_000_000)
        }));
        assert_eq!(
            auth.read_rate_limits("account-1", &CancellationSource::new().token()),
            Err(ChatGptUsageError::AccountChanged)
        );
        assert_eq!(client.requests.lock().unwrap().len(), 1);
    }
}

#[test]
fn external_rotation_for_the_same_account_retries_without_refreshing_codex_tokens() {
    let home = tempfile::tempdir().unwrap();
    credentials(home.path(), "account-1", 4_000_000_000);
    let client = Client::new([(401, serde_json::json!({})), (200, usage())]);
    let auth = runtime(home.path(), client.clone(), ChatGptAuthManagement::Codex);
    let path = home.path().to_owned();
    *client.during_request.lock().unwrap() = Some(Box::new(move || {
        credentials(&path, "account-1", 4_000_000_100);
    }));
    assert!(
        auth.read_rate_limits("account-1", &CancellationSource::new().token())
            .is_ok()
    );
    let requests = client.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(
        requests
            .iter()
            .all(|request| request.url() == "https://chatgpt.com/backend-api/wham/usage")
    );
    let expected = format!(
        "Bearer {}",
        jwt(serde_json::json!({"exp":4_000_000_100_u64}))
    );
    assert!(
        requests[1]
            .headers()
            .iter()
            .any(|header| header.name() == "Authorization" && header.value() == expected)
    );
}

#[test]
fn a_response_for_another_account_is_not_returned_to_the_caller() {
    let home = tempfile::tempdir().unwrap();
    credentials(home.path(), "account-1", 4_000_000_000);
    let client = Client::new([(
        200,
        serde_json::json!({"account_id":"account-2","plan_type":"plus"}),
    )]);
    let auth = runtime(home.path(), client, ChatGptAuthManagement::Codex);
    assert_eq!(
        auth.read_rate_limits("account-1", &CancellationSource::new().token()),
        Err(ChatGptUsageError::AccountChanged)
    );
}

#[test]
fn usage_rejects_a_user_switch_within_the_same_workspace_before_returning_or_retrying() {
    for status in [200, 401] {
        let home = tempfile::tempdir().unwrap();
        credentials(home.path(), "account-1", 4_000_000_000);
        let client = Client::new([(status, usage())]);
        let auth = runtime(home.path(), client.clone(), ChatGptAuthManagement::Codex);
        let path = home.path().to_owned();
        *client.during_request.lock().unwrap() = Some(Box::new(move || {
            let file = path.join("auth.json");
            let mut value: serde_json::Value =
                serde_json::from_slice(&std::fs::read(&file).unwrap()).unwrap();
            value["tokens"]["id_token"] = jwt(serde_json::json!({
                "https://api.openai.com/auth":{"chatgpt_user_id":"user-2","chatgpt_account_id":"account-1"}
            })).into();
            value["tokens"]["access_token"] =
                jwt(serde_json::json!({"exp":4_000_000_000_u64,"sub":"user-2"})).into();
            std::fs::write(file, serde_json::to_vec(&value).unwrap()).unwrap();
        }));
        assert_eq!(
            auth.read_rate_limits("account-1", &CancellationSource::new().token()),
            Err(ChatGptUsageError::AccountChanged)
        );
        assert_eq!(client.requests.lock().unwrap().len(), 1);
    }
}

#[test]
fn usage_rejects_a_response_for_another_user_in_the_same_workspace() {
    let home = tempfile::tempdir().unwrap();
    credentials(home.path(), "account-1", 4_000_000_000);
    let mut body = usage();
    body["user_id"] = "user-2".into();
    let auth = runtime(
        home.path(),
        Client::new([(200, body)]),
        ChatGptAuthManagement::Codex,
    );
    assert_eq!(
        auth.read_rate_limits("account-1", &CancellationSource::new().token()),
        Err(ChatGptUsageError::AccountChanged)
    );
}

#[test]
fn cancellation_stops_usage_after_any_started_credential_refresh_commits() {
    for expiry in [1, 4_000_000_000] {
        let home = tempfile::tempdir().unwrap();
        credentials(home.path(), "account-1", expiry);
        let client = Client::new([if expiry == 1 {
            (
                200,
                serde_json::json!({"access_token":jwt(serde_json::json!({"exp":4_000_000_000_u64})),"refresh_token":"rotated-refresh"}),
            )
        } else {
            (401, serde_json::json!({}))
        }]);
        let auth = runtime(home.path(), client.clone(), ChatGptAuthManagement::Ash);
        let cancellation = CancellationSource::new();
        let source = cancellation.clone();
        *client.during_request.lock().unwrap() = Some(Box::new(move || {
            source.cancel();
        }));
        assert_eq!(
            auth.read_rate_limits("account-1", &cancellation.token()),
            Err(ChatGptUsageError::Cancelled)
        );
        assert_eq!(client.requests.lock().unwrap().len(), 1);
        if expiry == 1 {
            let stored: serde_json::Value =
                serde_json::from_slice(&std::fs::read(home.path().join("auth.json")).unwrap())
                    .unwrap();
            assert_eq!(stored["tokens"]["refresh_token"], "rotated-refresh");
        }
    }
}

#[test]
fn missing_or_cancelled_account_queries_do_not_send_requests() {
    let home = tempfile::tempdir().unwrap();
    let client = Client::new([]);
    let auth = runtime(home.path(), client.clone(), ChatGptAuthManagement::Codex);
    let cancellation = CancellationSource::new();
    assert_eq!(
        auth.read_rate_limits("account-1", &cancellation.token()),
        Err(ChatGptUsageError::AccountUnavailable)
    );
    assert_eq!(
        auth.read_rate_limits(" ", &cancellation.token()),
        Err(ChatGptUsageError::InvalidAccount)
    );
    cancellation.cancel();
    assert_eq!(
        auth.read_rate_limits("account-1", &cancellation.token()),
        Err(ChatGptUsageError::Cancelled)
    );
    assert!(client.requests.lock().unwrap().is_empty());
}

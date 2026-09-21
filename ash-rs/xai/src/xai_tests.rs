use super::*;
use ash_client::ClientError;
use ash_client::ClientResponse;
use ash_http_client::HttpResponse;
use ash_secrets::MemorySecretStore;
use std::collections::VecDeque;

const DEVICE: &str = r#"{"device_code":"device-secret","user_code":"ABCD-EFGH","verification_uri":"https://auth.x.ai/device","expires_in":60,"interval":0}"#;
const TOKEN: &str = r#"{"access_token":"access-secret","refresh_token":"rotated-secret","token_type":"Bearer","expires_in":3600}"#;

struct ScriptedClient {
    responses: Mutex<VecDeque<ClientResponse>>,
    requests: Mutex<Vec<ClientRequest>>,
}

impl ScriptedClient {
    fn new(responses: &[(u16, &str)]) -> Arc<Self> {
        Arc::new(Self {
            responses: Mutex::new(
                responses
                    .iter()
                    .map(|(status, body)| {
                        HttpResponse::new(*status, Vec::new(), body.as_bytes().to_vec())
                    })
                    .collect(),
            ),
            requests: Mutex::new(Vec::new()),
        })
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

fn credential(expires_at: u64) -> TokenCredential {
    TokenCredential {
        access_token: "old-access".into(),
        refresh_token: "old-refresh".into(),
        token_type: "Bearer".into(),
        scope: String::new(),
        expires_at: Some(expires_at),
        account_id: "account-a".into(),
        credential_revision: 1,
    }
}

#[test]
fn device_login_handles_http_pending_and_keeps_oauth_separate_from_proxy_headers() {
    let dir = tempfile::tempdir().unwrap();
    let client = ScriptedClient::new(&[
        (200, DEVICE),
        (400, r#"{"error":"authorization_pending"}"#),
        (200, TOKEN),
    ]);
    let secrets = Arc::new(MemorySecretStore::default());
    let auth = XaiOAuth::with_client_and_poll_interval(
        secrets,
        client.clone(),
        dir.path().join("lock"),
        Duration::from_millis(1),
    );
    let service = Arc::new(LoginService::new(auth.clone()).unwrap());
    auth.install_login_service(&service).unwrap();
    assert!(
        matches!(service.begin(LoginMethod::XaiDeviceCode).unwrap(), BeginLogin::DeviceCode { user_code, .. } if user_code == "ABCD-EFGH")
    );
    let deadline = std::time::Instant::now() + Duration::from_secs(2);
    while service.read().unwrap().accounts.is_empty() && std::time::Instant::now() < deadline {
        thread::sleep(Duration::from_millis(5));
    }
    assert_eq!(
        service.read().unwrap().accounts[0].status,
        AccountStatus::Ready
    );
    let target = auth.api_target().unwrap();
    assert_eq!(target.target.base_url, XAI_SUBSCRIPTION_API_BASE_URL);
    assert!(
        target
            .target
            .headers
            .iter()
            .any(|header| header.name() == "Authorization"
                && header.value() == "Bearer access-secret")
    );
    assert!(
        target
            .target
            .headers
            .iter()
            .any(|header| header.name() == "x-grok-client-identifier" && header.value() == "ash")
    );
    for (name, value) in [
        ("x-grok-client-version", "1.0.38".to_owned()),
        ("User-Agent", format!("Ash/{}", env!("CARGO_PKG_VERSION"))),
    ] {
        assert!(
            target.target.headers.iter().any(|header| {
                header.name().eq_ignore_ascii_case(name) && header.value() == value
            })
        );
    }
    let requests = client.requests.lock().unwrap();
    assert_eq!(requests.len(), 3);
    assert_eq!(requests[0].url(), DEVICE_AUTHORIZATION_URL);
    assert!(requests.iter().all(|request| {
        request
            .headers()
            .iter()
            .any(|header| header.name() == "x-grok-client-version" && header.value() == "1.0.38")
    }));
    let body = String::from_utf8_lossy(requests[0].body());
    assert!(
        body.contains(CLIENT_ID)
            && body.contains("grok-cli%3Aaccess")
            && body.contains("referrer=ash")
    );
    assert!(
        requests
            .iter()
            .all(|request| request.headers().iter().all(|header| !header
                .name()
                .eq_ignore_ascii_case("Authorization")
                && header.name() != "X-XAI-Token-Auth"))
    );
}

#[test]
fn cancelling_device_login_prevents_token_polling_and_storage() {
    let dir = tempfile::tempdir().unwrap();
    let client = ScriptedClient::new(&[(200, DEVICE)]);
    let auth = XaiOAuth::with_client(
        Arc::new(MemorySecretStore::default()),
        client.clone(),
        dir.path().join("lock"),
    );
    let service = Arc::new(LoginService::new(auth.clone()).unwrap());
    auth.install_login_service(&service).unwrap();
    let login = service.begin(LoginMethod::XaiDeviceCode).unwrap();
    assert_eq!(
        service.cancel(login.login_id()).unwrap(),
        CancelLoginOutcome::Cancelled
    );
    assert!(auth.account_id().unwrap().is_none());
    assert_eq!(client.requests.lock().unwrap().len(), 1);
}

#[test]
fn concurrent_runtimes_refresh_a_rotating_token_once_and_observe_logout() {
    let dir = tempfile::tempdir().unwrap();
    let client = ScriptedClient::new(&[(200, TOKEN)]);
    let secrets = Arc::new(MemorySecretStore::default());
    let first = XaiOAuth::with_client(secrets.clone(), client.clone(), dir.path().join("lock"));
    let second = XaiOAuth::with_client(secrets, client.clone(), dir.path().join("lock"));
    first.store_credential(&credential(0)).unwrap();
    thread::scope(|scope| {
        let a = scope.spawn(|| first.api_target().unwrap());
        let b = scope.spawn(|| second.api_target().unwrap());
        assert_eq!(a.join().unwrap().account_id, b.join().unwrap().account_id);
    });
    assert_eq!(client.requests.lock().unwrap().len(), 1);
    let stored = first.load_credential().unwrap().unwrap();
    assert_eq!(stored.refresh_token, "rotated-secret");
    assert_eq!(stored.credential_revision, 2);
    second
        .logout(&second.read_account().unwrap().unwrap().account)
        .unwrap();
    assert!(first.api_target().is_err());
}

#[test]
fn invalid_grant_requires_login_without_reusing_rejected_refresh_token() {
    let dir = tempfile::tempdir().unwrap();
    let client = ScriptedClient::new(&[(
        400,
        r#"{"error":"invalid_grant","error_description":"sensitive provider detail"}"#,
    )]);
    let auth = XaiOAuth::with_client(
        Arc::new(MemorySecretStore::default()),
        client.clone(),
        dir.path().join("lock"),
    );
    auth.store_credential(&credential(0)).unwrap();
    assert!(
        !auth
            .api_target()
            .err()
            .unwrap()
            .to_string()
            .contains("sensitive")
    );
    assert!(auth.api_target().is_err());
    assert_eq!(
        auth.read_account().unwrap().unwrap().status,
        AccountStatus::ReauthenticationRequired
    );
    assert_eq!(client.requests.lock().unwrap().len(), 1);
}

#[test]
fn unauthorized_recovery_never_switches_to_a_new_account() {
    let dir = tempfile::tempdir().unwrap();
    let client = ScriptedClient::new(&[]);
    let auth = XaiOAuth::with_client(
        Arc::new(MemorySecretStore::default()),
        client.clone(),
        dir.path().join("lock"),
    );
    auth.store_credential(&credential(now_epoch_seconds() + 3600))
        .unwrap();
    let rejected = auth.api_target().unwrap();
    let mut replacement = credential(now_epoch_seconds() + 3600);
    replacement.account_id = "account-b".into();
    auth.store_credential(&replacement).unwrap();
    assert!(auth.recover_unauthorized(&rejected).unwrap().is_none());
    auth.note_rejected(&rejected);
    assert_eq!(
        auth.read_account().unwrap().unwrap().status,
        AccountStatus::Ready
    );
    assert!(client.requests.lock().unwrap().is_empty());
}

#[test]
fn interrupted_refresh_is_not_submitted_again_by_another_runtime() {
    let dir = tempfile::tempdir().unwrap();
    let client = ScriptedClient::new(&[]);
    let secrets = Arc::new(MemorySecretStore::default());
    let first = XaiOAuth::with_client(secrets.clone(), client.clone(), dir.path().join("lock"));
    first.store_credential(&credential(0)).unwrap();
    assert!(first.api_target().is_err());
    let second = XaiOAuth::with_client(secrets, client.clone(), dir.path().join("lock"));
    assert!(second.api_target().is_err());
    assert_eq!(client.requests.lock().unwrap().len(), 1);
    assert_eq!(
        second.read_account().unwrap().unwrap().status,
        AccountStatus::ReauthenticationRequired
    );
}

#[test]
fn official_optional_device_and_token_fields_are_accepted() {
    let device: DeviceAuthorizationResponse = serde_json::from_str(r#"{"device_code":"d","user_code":"U-1","verification_uri":"https://accounts.x.ai/device","verification_uri_complete":null}"#).unwrap();
    assert_eq!(device.verification_uri(), "https://accounts.x.ai/device");
    let response: TokenResponse = serde_json::from_str(
        r#"{"access_token":"access","refresh_token":null,"expires_in":null,"scope":null}"#,
    )
    .unwrap();
    let credential = response.into_credential("account".into(), 1).unwrap();
    assert!(credential.is_usable());
    assert!(!credential.needs_refresh());
    assert_eq!(credential.token_type, "Bearer");
}

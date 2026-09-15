use super::*;
use ash_client::ClientError;
use ash_client::ClientResponse;
use ash_http_client::HttpResponse;
use ash_secrets::MemorySecretStore;
use std::collections::VecDeque;
use std::sync::Mutex;

struct ScriptedClient {
    responses: Mutex<VecDeque<ClientResponse>>,
    requests: Mutex<Vec<ClientRequest>>,
}

impl ScriptedClient {
    fn new(bodies: impl IntoIterator<Item = &'static str>) -> Self {
        Self {
            responses: Mutex::new(
                bodies
                    .into_iter()
                    .map(|body| HttpResponse::new(200, Vec::new(), body.as_bytes().to_vec()))
                    .collect(),
            ),
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
fn device_flow_persists_tokens_and_projects_an_authenticated_api_target() {
    let client = Arc::new(ScriptedClient::new([
        r#"{"device_code":"device-secret","user_code":"ABCD-EFGH","verification_uri":"https://kimi.com/device","verification_uri_complete":"https://kimi.com/device?code=ABCD-EFGH","expires_in":60,"interval":0}"#,
        r#"{"error":"authorization_pending"}"#,
        r#"{"access_token":"access-secret","refresh_token":"refresh-secret","token_type":"Bearer","scope":"coding","expires_in":3600}"#,
    ]));
    let secrets = Arc::new(MemorySecretStore::default());
    let runtime = KimiOAuth::with_client_and_poll_interval(
        secrets.clone(),
        client.clone(),
        Duration::from_millis(1),
    );
    let driver: Arc<dyn InteractiveLoginDriver> = runtime.clone();
    let service = Arc::new(LoginService::new(driver).unwrap());
    runtime.install_login_service(&service).unwrap();

    let started = service.begin(LoginMethod::KimiDeviceCode).unwrap();
    assert!(matches!(
        started,
        BeginLogin::DeviceCode {
            ref verification_url,
            ref user_code,
            ..
        } if verification_url == "https://kimi.com/device?code=ABCD-EFGH"
            && user_code == "ABCD-EFGH"
    ));
    for _ in 0..100 {
        if !service.read().unwrap().accounts.is_empty() {
            break;
        }
        thread::sleep(Duration::from_millis(5));
    }
    let state = service.read().unwrap();
    assert_eq!(state.accounts.len(), 1);
    assert_eq!(state.accounts[0].account.provider, KIMI_PROVIDER_ID);
    assert_eq!(state.accounts[0].status, AccountStatus::Ready);

    let target = runtime.api_target().unwrap();
    assert_eq!(target.base_url, KIMI_CODE_API_BASE_URL);
    assert!(target.headers.iter().any(|header| {
        header.name() == "Authorization" && header.value() == "Bearer access-secret"
    }));
    assert!(
        target
            .headers
            .iter()
            .any(|header| { header.name() == "X-Msh-Platform" && header.value() == "Ash" })
    );

    let requests = client.requests.lock().unwrap();
    assert_eq!(requests[0].url(), DEVICE_AUTHORIZATION_URL);
    assert_eq!(requests[1].url(), TOKEN_URL);
    assert!(
        std::str::from_utf8(requests[1].body())
            .unwrap()
            .contains("grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code")
    );
    let device_ids = requests
        .iter()
        .flat_map(|request| request.headers())
        .filter(|header| header.name() == "X-Msh-Device-Id")
        .map(HttpHeader::value)
        .collect::<Vec<_>>();
    assert!(device_ids.windows(2).all(|pair| pair[0] == pair[1]));
    assert!(
        secrets
            .load(&KimiOAuth::credential_key())
            .unwrap()
            .is_some()
    );
}

#[test]
fn api_target_refreshes_expiring_credentials_and_rotates_the_stored_revision() {
    let client = Arc::new(ScriptedClient::new([
        r#"{"access_token":"new-access","refresh_token":"new-refresh","token_type":"Bearer","scope":"coding","expires_in":3600}"#,
    ]));
    let secrets = Arc::new(MemorySecretStore::default());
    let runtime = KimiOAuth::with_client(secrets, client.clone());
    runtime
        .store_credential(&TokenCredential {
            access_token: "old-access".into(),
            refresh_token: "old-refresh".into(),
            token_type: "Bearer".into(),
            scope: "coding".into(),
            expires_at: Some(now_epoch_seconds()),
            device_id: "device-id".into(),
            credential_revision: 7,
        })
        .unwrap();
    let driver: Arc<dyn InteractiveLoginDriver> = runtime.clone();
    let login = Arc::new(LoginService::new(driver).unwrap());
    runtime.install_login_service(&login).unwrap();

    let target = runtime.api_target().unwrap();
    assert!(target.headers.iter().any(|header| {
        header.name() == "Authorization" && header.value() == "Bearer new-access"
    }));
    let account = runtime.read_account().unwrap().unwrap();
    assert_eq!(account.credential_revision, 8);
    assert_eq!(login.read().unwrap().accounts[0].credential_revision, 8);
    let requests = client.requests.lock().unwrap();
    let body = std::str::from_utf8(requests[0].body()).unwrap();
    assert!(body.contains("grant_type=refresh_token"));
    assert!(body.contains("refresh_token=old-refresh"));
}

#[test]
fn logout_removes_only_the_local_kimi_oauth_envelope() {
    let client = Arc::new(ScriptedClient::new([]));
    let secrets = Arc::new(MemorySecretStore::default());
    let runtime = KimiOAuth::with_client(secrets.clone(), client);
    runtime
        .store_credential(&TokenCredential {
            access_token: "access".into(),
            refresh_token: "refresh".into(),
            token_type: "Bearer".into(),
            scope: "coding".into(),
            expires_at: Some(now_epoch_seconds() + 3600),
            device_id: "device-id".into(),
            credential_revision: 1,
        })
        .unwrap();

    runtime
        .logout(&AccountRef {
            provider: KIMI_PROVIDER_ID.into(),
            account_id: "current".into(),
        })
        .unwrap();

    assert!(
        secrets
            .load(&KimiOAuth::credential_key())
            .unwrap()
            .is_none()
    );
}

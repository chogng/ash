use super::*;
use ash_http_client::HttpClientError;
use ash_http_client::HttpResponse;
use ash_secrets::MemorySecretStore;
use std::collections::VecDeque;

#[derive(Default)]
struct FakeHttp {
    responses: Mutex<VecDeque<HttpResponse>>,
    requests: Mutex<Vec<(String, String)>>,
}

impl FakeHttp {
    fn push(&self, body: &str) {
        self.responses.lock().unwrap().push_back(HttpResponse::new(
            200,
            vec![],
            body.as_bytes().to_vec(),
        ));
    }
}

impl HttpClient for FakeHttp {
    fn execute(&self, request: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        self.requests.lock().unwrap().push((
            request.url().into(),
            String::from_utf8_lossy(request.body()).into_owned(),
        ));
        Ok(self
            .responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected GitHub request"))
    }
}

fn driver() -> (Arc<GitHubOAuth>, Arc<FakeHttp>, Arc<MemorySecretStore>) {
    let http = Arc::new(FakeHttp::default());
    let secrets = Arc::new(MemorySecretStore::default());
    let driver =
        GitHubOAuth::new("Ov23publicclient".into(), http.clone(), secrets.clone()).unwrap();
    (driver, http, secrets)
}

#[test]
fn device_authorization_stores_only_the_account_projection_and_reuses_it() {
    let (driver, http, _) = driver();
    http.push(r#"{"device_code":"private-device","user_code":"ABCD-EFGH","verification_uri":"https://github.com/login/device","expires_in":900,"interval":0}"#);
    let grant = driver.request_device_code().unwrap();
    http.push(r#"{"error":"authorization_pending"}"#);
    http.push(r#"{"access_token":"private-access","refresh_token":"private-refresh","expires_in":28800,"refresh_token_expires_in":15724800,"token_type":"bearer"}"#);
    http.push(r#"{"id":42,"login":"octocat"}"#);
    let credential = driver
        .poll(&grant, &AtomicBool::new(false), Duration::ZERO)
        .unwrap();
    driver.store_credential(&credential).unwrap();
    let snapshot = driver.read_account().unwrap().unwrap();
    assert_eq!(snapshot.account.provider, "github");
    assert_eq!(snapshot.account.account_id, "42");
    assert_eq!(snapshot.display_name.as_deref(), Some("octocat"));
    assert_eq!(snapshot.status, AccountStatus::Ready);
    assert!(!format!("{snapshot:?}").contains("private-access"));
    let requests = http.requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert!(requests[0].1.contains("scope=read%3Auser"));
    assert!(requests[1].1.contains("device_code=private-device"));
    assert!(requests[2].1.contains("device_code=private-device"));
}

#[test]
fn expired_access_token_refreshes_and_logout_removes_the_credential() {
    let (driver, http, _) = driver();
    driver
        .store_credential(&Credential {
            access_token: "expired-access".into(),
            refresh_token: "old-refresh".into(),
            expires_at: Some(now().saturating_sub(1)),
            refresh_expires_at: Some(now() + 3600),
            account_id: "42".into(),
            login: "octocat".into(),
            credential_revision: 1,
        })
        .unwrap();
    http.push(r#"{"access_token":"new-access","refresh_token":"new-refresh","expires_in":28800,"refresh_token_expires_in":15724800,"token_type":"bearer"}"#);
    http.push(r#"{"id":42,"login":"octocat"}"#);
    let account = driver.read_account().unwrap().unwrap();
    assert_eq!(account.credential_revision, 2);
    assert_eq!(account.status, AccountStatus::Ready);
    assert!(
        http.requests.lock().unwrap()[0]
            .1
            .contains("refresh_token=old-refresh")
    );
    driver.logout(&account.account).unwrap();
    assert!(driver.read_account().unwrap().is_none());
}

#[test]
fn cancellation_stops_polling_before_a_token_request() {
    let (driver, http, _) = driver();
    let grant = DeviceGrant {
        device_code: "private-device".into(),
        user_code: "ABCD-EFGH".into(),
        verification_uri: "https://github.com/login/device".into(),
        expires_in: 900,
        interval: 0,
    };
    let cancelled = AtomicBool::new(true);
    assert!(driver.poll(&grant, &cancelled, Duration::ZERO).is_err());
    assert!(http.requests.lock().unwrap().is_empty());
}

#[test]
fn login_service_receives_the_completed_github_account() {
    let (driver, http, _) = driver();
    http.push(r#"{"device_code":"private-device","user_code":"ABCD-EFGH","verification_uri":"https://github.com/login/device","expires_in":900,"interval":0}"#);
    http.push(r#"{"access_token":"private-access","refresh_token":"private-refresh","expires_in":28800,"refresh_token_expires_in":15724800,"token_type":"bearer"}"#);
    http.push(r#"{"id":42,"login":"octocat"}"#);
    let service = Arc::new(LoginService::deferred(driver.clone()));
    driver.install_login_service(&service).unwrap();
    let started = service.begin(LoginMethod::GitHubDeviceCode).unwrap();
    assert!(matches!(started, BeginLogin::DeviceCode { .. }));
    let deadline = std::time::Instant::now() + Duration::from_secs(8);
    loop {
        let state = service.read().unwrap();
        if !state.accounts.is_empty() {
            assert_eq!(state.accounts[0].account.provider, GITHUB_PROVIDER_ID);
            assert_eq!(state.accounts[0].display_name.as_deref(), Some("octocat"));
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "GitHub login did not complete"
        );
        thread::sleep(Duration::from_millis(20));
    }
    assert_eq!(
        driver.read_account().unwrap().unwrap().account.account_id,
        "42"
    );
}

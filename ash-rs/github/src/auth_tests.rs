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
    let driver = GitHubOAuth::new(
        "Iv23publicclient".into(),
        Url::parse("https://broker.example/").unwrap(),
        http.clone(),
        secrets.clone(),
    )
    .unwrap();
    (driver, http, secrets)
}

#[test]
fn browser_authorization_uses_pkce_and_stores_only_the_account_projection() {
    let (driver, http, _) = driver();
    let grant = driver.authorize().unwrap();
    let authorization_url = Url::parse(&grant.authorization_url).unwrap();
    assert_eq!(
        authorization_url.origin().ascii_serialization(),
        "https://broker.example"
    );
    assert_eq!(authorization_url.path(), "/v1/oauth/github/authorize");
    assert_eq!(
        authorization_url
            .query_pairs()
            .find(|(key, _)| key == "code_challenge_method")
            .unwrap()
            .1,
        "S256"
    );
    http.push(r#"{"access_token":"private-access","refresh_token":"private-refresh","expires_in":28800,"refresh_token_expires_in":15724800,"token_type":"bearer"}"#);
    http.push(r#"{"id":42,"login":"octocat"}"#);
    let state = grant.state.clone();
    let address = grant.listener.local_addr().unwrap();
    let path = grant.path.clone();
    let driver_for_thread = driver.clone();
    let result = thread::spawn(move || {
        driver_for_thread.await_authorization(grant, &AtomicBool::new(false))
    });
    let mut stream = TcpStream::connect(address).unwrap();
    stream
        .write_all(
            format!(
                "GET {path}?state={state}&code=private-code HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n"
            )
            .as_bytes(),
        )
        .unwrap();
    let mut response = String::new();
    stream.read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200 OK"));
    let credential = result.join().unwrap().unwrap();
    driver.store_credential(&credential).unwrap();
    let account = driver.read_account().unwrap().unwrap();
    assert_eq!(account.account.account_id, "42");
    assert_eq!(account.display_name.as_deref(), Some("octocat"));
    assert!(!format!("{account:?}").contains("private-access"));
    let requests = http.requests.lock().unwrap();
    assert!(requests[0].0.ends_with("/v1/oauth/github/token"));
    assert!(requests[0].1.contains("code=private-code"));
    assert!(requests[0].1.contains("code_verifier="));
}

#[test]
fn expired_access_token_refreshes_and_logout_removes_the_credential() {
    let (driver, http, _) = driver();
    driver
        .store_credential(&Credential {
            client_id: driver.client_id.clone(),
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
    assert!(
        http.requests.lock().unwrap()[0]
            .1
            .contains("refresh_token=old-refresh")
    );
    driver.logout(&account.account).unwrap();
    assert!(driver.read_account().unwrap().is_none());
}

#[test]
fn callback_requires_matching_state_and_cancellation_stops_exchange() {
    let (driver, http, _) = driver();
    let grant = driver.authorize().unwrap();
    let mut stream = TcpStream::connect(grant.listener.local_addr().unwrap()).unwrap();
    stream
        .write_all(
            format!(
                "GET {}?state=wrong&code=stolen HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
                grant.path
            )
            .as_bytes(),
        )
        .unwrap();
    let (mut incoming, _) = grant.listener.accept().unwrap();
    assert!(
        read_callback(&mut incoming, &grant.path, &grant.state)
            .unwrap()
            .is_none()
    );
    let cancelled = AtomicBool::new(true);
    assert!(driver.await_authorization(grant, &cancelled).is_err());
    assert!(http.requests.lock().unwrap().is_empty());
}

#[test]
fn login_service_receives_the_completed_github_account() {
    let (driver, http, _) = driver();
    http.push(r#"{"access_token":"private-access","refresh_token":"private-refresh","expires_in":28800,"refresh_token_expires_in":15724800,"token_type":"bearer"}"#);
    http.push(r#"{"id":42,"login":"octocat"}"#);
    let service = Arc::new(LoginService::deferred(driver.clone()));
    driver.install_login_service(&service).unwrap();
    let started = service.begin(LoginMethod::GitHubBrowser).unwrap();
    let BeginLogin::Browser {
        authorization_url, ..
    } = started
    else {
        panic!("expected browser authorization")
    };
    let url = Url::parse(&authorization_url).unwrap();
    let redirect_uri = url
        .query_pairs()
        .find(|(key, _)| key == "redirect_uri")
        .unwrap()
        .1
        .into_owned();
    let state = url
        .query_pairs()
        .find(|(key, _)| key == "state")
        .unwrap()
        .1
        .into_owned();
    let callback = Url::parse(&redirect_uri).unwrap();
    let mut stream = TcpStream::connect(("127.0.0.1", callback.port().unwrap())).unwrap();
    stream
        .write_all(
            format!(
                "GET {}?state={state}&code=private-code HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
                callback.path()
            )
            .as_bytes(),
        )
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        let accounts = service.read().unwrap().accounts;
        if !accounts.is_empty() {
            assert_eq!(accounts[0].account.provider, GITHUB_PROVIDER_ID);
            assert_eq!(accounts[0].display_name.as_deref(), Some("octocat"));
            break;
        }
        assert!(Instant::now() < deadline, "GitHub login did not complete");
        thread::sleep(Duration::from_millis(20));
    }
}

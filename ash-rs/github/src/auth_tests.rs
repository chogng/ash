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
            host: "github.com".into(),
            client_id: driver.browser.as_ref().unwrap().client_id.clone(),
            access_token: "expired-access".into(),
            refresh_token: "old-refresh".into(),
            expires_at: Some(now().saturating_sub(1)),
            refresh_expires_at: Some(now() + 3600),
            account_id: "42".into(),
            login: "octocat".into(),
            credential_revision: 1,
            grant_nonce: String::new(),
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
fn repository_authorization_requires_a_live_ash_grant_and_does_not_survive_relogin() {
    let (driver, _, _) = driver();
    assert_eq!(
        driver.authorization().unwrap_err().kind(),
        LoginErrorKind::ExternalLoginRequired
    );
    let mut credential = Credential {
        host: "github.com".into(),
        client_id: driver.browser.as_ref().unwrap().client_id.clone(),
        access_token: "first-access".into(),
        refresh_token: String::new(),
        expires_at: Some(now() + 3600),
        refresh_expires_at: None,
        account_id: "42".into(),
        login: "octocat".into(),
        credential_revision: 1,
        grant_nonce: String::new(),
    };
    driver.store_credential(&credential).unwrap();
    let authorization = driver.authorization().unwrap();
    assert_eq!(
        driver.token(&authorization).unwrap().expose(),
        b"first-access"
    );
    assert!(!format!("{authorization:?}").contains("first-access"));
    let mut foreign = authorization.clone();
    foreign.host = "github.enterprise.example".into();
    assert_eq!(
        driver.token(&foreign).unwrap_err().kind(),
        LoginErrorKind::ExternalLoginRequired
    );
    driver.logout(&credential.snapshot().account).unwrap();
    assert_eq!(
        driver.token(&authorization).unwrap_err().kind(),
        LoginErrorKind::ExternalLoginRequired
    );
    credential.access_token = "second-access".into();
    driver.store_credential(&credential).unwrap();
    let replacement = driver.authorization().unwrap();
    assert_ne!(authorization.grant_id, replacement.grant_id);
    assert_eq!(
        driver.token(&authorization).unwrap_err().kind(),
        LoginErrorKind::ExternalLoginRequired
    );
    assert_eq!(
        driver.token(&replacement).unwrap().expose(),
        b"second-access"
    );
}

#[test]
fn callback_reads_complete_headers_from_an_accepted_nonblocking_socket() {
    let (driver, _, _) = driver();
    let grant = driver.authorize().unwrap();
    let mut client = TcpStream::connect(grant.listener.local_addr().unwrap()).unwrap();
    let (mut incoming, _) = grant.listener.accept().unwrap();
    incoming.set_nonblocking(true).unwrap();
    client
        .write_all(
            format!(
                "GET {}?state={}&code=valid HTTP/1.1\r\n",
                grant.path, grant.state
            )
            .as_bytes(),
        )
        .unwrap();
    let reader = thread::spawn(move || read_callback(&mut incoming, &grant.path, &grant.state));
    // Headers may arrive after the request line, even on a loopback connection.
    thread::sleep(Duration::from_millis(20));
    client.write_all(b"Host: 127.0.0.1\r\n\r\n").unwrap();
    assert_eq!(reader.join().unwrap().unwrap().as_deref(), Some("valid"));
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

#[test]
fn account_catalog_keeps_cloud_and_enterprise_grants_independent_and_logout_is_exact() {
    let (driver, http, _) = driver();
    let service = Arc::new(LoginService::deferred(driver.clone()));
    driver.install_login_service(&service).unwrap();
    let cancellation = ash_async_utils::CancellationSource::new().token();
    http.push(r#"{"id":42,"login":"cloud-user"}"#);
    let cloud = driver
        .connect_token(
            "github.com",
            SecretValue::new(b"cloud-secret".to_vec()),
            &cancellation,
        )
        .unwrap();
    let cloud_grant = driver.authorization_for(&cloud.id).unwrap();
    http.push(r#"{"id":42,"login":"enterprise-user"}"#);
    let enterprise = driver
        .connect_token(
            "GHE.example",
            SecretValue::new(b"enterprise-secret".to_vec()),
            &cancellation,
        )
        .unwrap();
    assert_eq!(enterprise.id, "ghe.example/42");
    assert_eq!(
        http.requests.lock().unwrap()[1].0,
        "https://ghe.example/api/v3/user"
    );
    assert_eq!(
        driver.token(&cloud_grant).unwrap().expose(),
        b"cloud-secret"
    );
    let enterprise_grant = driver.authorization_for(&enterprise.id).unwrap();
    assert_eq!(
        driver.token(&enterprise_grant).unwrap().expose(),
        b"enterprise-secret"
    );
    assert_eq!(service.read().unwrap().accounts.len(), 2);
    assert!(!format!("{:?}", driver.accounts().unwrap()).contains("secret"));
    http.push(r#"{"id":42,"login":"enterprise-user"}"#);
    let renewed = driver
        .connect_token(
            "ghe.example",
            SecretValue::new(b"rotated-secret".to_vec()),
            &cancellation,
        )
        .unwrap();
    assert_eq!(renewed.credential_revision, 2);
    assert_eq!(
        service
            .read()
            .unwrap()
            .accounts
            .iter()
            .find(|account| account.account.account_id == enterprise.id)
            .unwrap()
            .credential_revision,
        2
    );
    assert!(driver.token(&enterprise_grant).is_err());
    assert_eq!(
        driver.token(&cloud_grant).unwrap().expose(),
        b"cloud-secret"
    );
    service
        .logout_account(&AccountRef {
            provider: GITHUB_PROVIDER_ID.into(),
            account_id: cloud.id,
        })
        .unwrap();
    assert!(driver.token(&cloud_grant).is_err());
    assert_eq!(service.read().unwrap().accounts.len(), 1);
    assert_eq!(driver.accounts().unwrap()[0].id, enterprise.id);
    service.refresh().unwrap();
    assert_eq!(service.read().unwrap().accounts.len(), 1);
    service.logout_provider(GITHUB_PROVIDER_ID).unwrap();
    assert!(driver.accounts().unwrap().is_empty());
}

#[test]
fn legacy_credential_migrates_once_and_a_connected_account_can_start_another_browser_login() {
    let (driver, http, secrets) = driver();
    let credential = Credential::new(
        Token {
            access_token: "legacy-secret".into(),
            refresh_token: String::new(),
            expires_at: None,
            refresh_expires_at: None,
        },
        GitHubUser {
            id: 42,
            login: "alice".into(),
        },
        driver.browser.as_ref().unwrap().client_id.clone(),
    );
    secrets
        .store(
            &GitHubOAuth::credential_key(),
            &SecretValue::new(serde_json::to_vec(&credential).unwrap()),
        )
        .unwrap();
    assert_eq!(driver.accounts().unwrap()[0].id, "42");
    assert!(
        secrets
            .load(&GitHubOAuth::credential_key())
            .unwrap()
            .is_none()
    );
    assert!(
        secrets
            .load(&GitHubOAuth::accounts_key())
            .unwrap()
            .is_some()
    );
    http.push(r#"{"id":43,"login":"bob"}"#);
    driver
        .connect_token(
            "github.com",
            SecretValue::new(b"another-secret".to_vec()),
            &ash_async_utils::CancellationSource::new().token(),
        )
        .unwrap();
    assert_eq!(driver.read_accounts().unwrap().len(), 2);
    let service = LoginService::new(driver.clone()).unwrap();
    let started = service.begin(LoginMethod::GitHubBrowser).unwrap();
    assert!(matches!(started, BeginLogin::Browser { .. }));
    service.cancel(started.login_id()).unwrap();
    assert_eq!(driver.accounts().unwrap().len(), 2);
}

#[test]
fn token_connection_rejects_invalid_hosts_and_cancelled_requests_before_storing_credentials() {
    let (driver, http, _) = driver();
    for host in [
        "https://ghe.example",
        "ghe.example/path",
        "ghe.example:8443",
    ] {
        assert!(
            driver
                .connect_token(
                    host,
                    SecretValue::new(b"secret".to_vec()),
                    &ash_async_utils::CancellationSource::new().token()
                )
                .is_err()
        );
    }
    assert!(http.requests.lock().unwrap().is_empty());
    let source = ash_async_utils::CancellationSource::new();
    source.cancel();
    let cancelled = source.token();
    assert!(
        driver
            .connect_token(
                "ghe.example",
                SecretValue::new(b"secret".to_vec()),
                &cancelled
            )
            .is_err()
    );
    assert!(driver.accounts().unwrap().is_empty());
}

#[test]
fn token_accounts_work_without_browser_configuration_and_primary_catalog_matches_the_grant() {
    let http = Arc::new(FakeHttp::default());
    let secrets = Arc::new(MemorySecretStore::default());
    let driver = GitHubOAuth::tokens(http.clone(), secrets.clone());
    let cancellation = ash_async_utils::CancellationSource::new().token();
    for (host, id, login) in [
        ("ghe.example", 1, "enterprise"),
        ("github.com", 9, "first-cloud"),
        ("github.com", 8, "last-cloud"),
    ] {
        http.push(&format!(r#"{{"id":{id},"login":"{login}"}}"#));
        driver
            .connect_token(
                host,
                SecretValue::new(format!("secret-{id}").into_bytes()),
                &cancellation,
            )
            .unwrap();
    }
    assert_eq!(driver.authorization().unwrap().account_id, "8");
    assert_eq!(driver.accounts().unwrap()[0].id, "8");
    assert!(driver.authorize().is_err());
    driver
        .logout(&AccountRef {
            provider: GITHUB_PROVIDER_ID.into(),
            account_id: "8".into(),
        })
        .unwrap();
    assert_eq!(driver.authorization().unwrap().account_id, "9");
    assert_eq!(driver.accounts().unwrap()[0].id, "9");
    let reopened = GitHubOAuth::tokens(http, secrets);
    assert_eq!(reopened.accounts().unwrap().len(), 2);
    assert_eq!(reopened.authorization().unwrap().account_id, "9");
}

#[test]
fn logout_and_reconnecting_with_the_same_token_never_revives_an_old_grant() {
    let (driver, http, _) = driver();
    let cancellation = ash_async_utils::CancellationSource::new().token();
    http.push(r#"{"id":42,"login":"same-user"}"#);
    let account = driver
        .connect_token(
            "github.com",
            SecretValue::new(b"same-token".to_vec()),
            &cancellation,
        )
        .unwrap();
    let before = driver.authorization().unwrap();
    driver
        .logout(&AccountRef {
            provider: GITHUB_PROVIDER_ID.into(),
            account_id: account.id,
        })
        .unwrap();
    http.push(r#"{"id":42,"login":"same-user"}"#);
    driver
        .connect_token(
            "github.com",
            SecretValue::new(b"same-token".to_vec()),
            &cancellation,
        )
        .unwrap();
    assert_ne!(before.grant_id, driver.authorization().unwrap().grant_id);
    assert!(driver.token(&before).is_err());
}

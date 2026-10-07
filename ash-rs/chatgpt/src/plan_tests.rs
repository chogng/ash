use super::*;
use crate::ChatGptAuthManagement;
use crate::ChatGptOAuth;
use ash_client::ClientError;
use ash_client::ClientRequest;
use ash_client::ClientResponse;
use ash_http_client::HttpResponse;
use ash_login::AccountStatus;
use ash_secrets::MemorySecretStore;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use storage::State;
use storage::Tokens;

struct RefreshClient {
    refreshes: AtomicUsize,
}

impl OperationClient for RefreshClient {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        match request.url() {
            "https://auth.openai.com/api/accounts/oauth/token" => {
                self.refreshes.fetch_add(1, Ordering::SeqCst);
                assert!(String::from_utf8_lossy(request.body()).contains("client_id=oaiapp_ash"));
                Ok(response(
                    r#"{"access_token":"ash-new","refresh_token":"ash-new-refresh","token_type":"Bearer","expires_in":3600}"#,
                ))
            }
            "https://auth.openai.com/.well-known/openid-configuration" => Ok(response(
                r#"{"issuer":"https://auth.openai.com","jwks_uri":"https://auth.openai.com/.well-known/jwks.json","revocation_endpoint":"https://auth.openai.com/revoke"}"#,
            )),
            "https://auth.openai.com/revoke" => Ok(response("{}")),
            _ => panic!("unexpected authorization destination"),
        }
    }
}

fn response(body: &str) -> ClientResponse {
    HttpResponse::new(200, Vec::new(), body.as_bytes().to_vec())
}

fn registration() -> Registration {
    Registration {
        client_id: "oaiapp_ash".into(),
        subject: "ash-user".into(),
        email: None,
        revision: 1,
        tokens: Some(Tokens {
            access_token: "ash-old".into(),
            refresh_token: "ash-refresh".into(),
            id_token: "ash-id".into(),
            scopes: vec!["chatgpt.tokens.use.direct".into(), "resource.invoke".into()],
            expires_at: storage::now() - 1,
            earliest_refresh_at: 0,
        }),
    }
}

fn seed(auth: &ChatGptPlanOAuth) -> String {
    let registration = registration();
    let id = registration.id();
    auth.store
        .save(&State {
            host_id: "urn:uuid:ash-host".into(),
            selection_revision: 0,
            active: Some(id.clone()),
            accounts: BTreeMap::from([(id.clone(), registration)]),
        })
        .unwrap();
    id
}

#[test]
fn concurrent_instances_rotate_once_and_logout_stays_out_of_codex() {
    let directory = tempfile::tempdir().unwrap();
    let codex_bytes = b"external Codex authentication";
    std::fs::write(directory.path().join("auth.json"), codex_bytes).unwrap();
    let secrets = Arc::new(MemorySecretStore::default());
    let client = Arc::new(RefreshClient {
        refreshes: AtomicUsize::new(0),
    });
    let runtimes: Vec<_> = (0..2)
        .map(|_| {
            ChatGptPlanOAuth::with_client(
                secrets.clone(),
                directory.path().join("plan.lock"),
                client.clone(),
            )
        })
        .collect();
    let id = seed(&runtimes[0]);
    let threads: Vec<_> = runtimes
        .iter()
        .map(|runtime| {
            let runtime = runtime.clone();
            std::thread::spawn(move || runtime.api_target().unwrap())
        })
        .collect();
    for thread in threads {
        let target = thread.join().unwrap();
        assert_eq!(target.base_url(), RESOURCE);
        assert_eq!(target.headers()[0].value(), "Bearer ash-new");
        assert!(
            matches!(target.binding().identity(), RequestIdentity::Account { connection, account_id, .. }
            if connection == CHATGPT_PLAN_PROVIDER_ID && account_id == &id)
        );
        assert!(
            target
                .validate_destination("https://chatgpt.com/backend-api/codex/responses")
                .is_err()
        );
    }
    assert_eq!(client.refreshes.load(Ordering::SeqCst), 1);
    runtimes[1]
        .logout(&AccountRef {
            provider: CHATGPT_PLAN_PROVIDER_ID.into(),
            account_id: id,
        })
        .unwrap();
    assert!(runtimes[0].api_target().is_err());
    assert_eq!(
        std::fs::read(directory.path().join("auth.json")).unwrap(),
        codex_bytes
    );
    assert_eq!(
        runtimes[0].store.load().unwrap().host_id,
        "urn:uuid:ash-host"
    );
}

#[test]
fn codex_reuse_never_creates_credentials_when_codex_is_missing() {
    let directory = tempfile::tempdir().unwrap();
    let client = Arc::new(RefreshClient {
        refreshes: AtomicUsize::new(0),
    });
    let auth = ChatGptOAuth::with_client(
        directory.path().to_owned(),
        Arc::new(MemorySecretStore::default()),
        client.clone(),
        ChatGptAuthManagement::Codex,
    );
    let service = LoginService::new(auth).unwrap();
    let error = service
        .begin(LoginMethod::OpenAiChatGptDeviceCode)
        .unwrap_err();
    assert_eq!(error.kind(), LoginErrorKind::ExternalLoginRequired);
    assert!(!directory.path().join("auth.json").exists());
    assert_eq!(client.refreshes.load(Ordering::SeqCst), 0);
}

#[test]
fn late_login_cannot_reactivate_after_another_instance_logs_out() {
    let directory = tempfile::tempdir().unwrap();
    let secrets = Arc::new(MemorySecretStore::default());
    let client = Arc::new(RefreshClient {
        refreshes: AtomicUsize::new(0),
    });
    let auth = ChatGptPlanOAuth::with_client(
        secrets.clone(),
        directory.path().join("plan.lock"),
        client.clone(),
    );
    let other = ChatGptPlanOAuth::with_client(secrets, directory.path().join("plan.lock"), client);
    let id = seed(&auth);
    let login_id = LoginId::new("late").unwrap();
    auth.attempts.lock().unwrap().insert(
        login_id.clone(),
        LoginAttempt {
            cancellation: CancellationSource::new(),
            selection_revision: 0,
        },
    );
    other
        .logout(&AccountRef {
            provider: CHATGPT_PLAN_PROVIDER_ID.into(),
            account_id: id,
        })
        .unwrap();
    auth.finish(login_id, Ok(registration()), Some(1));
    assert!(auth.account_id().unwrap().is_none());
    assert!(auth.api_target().is_err());
    assert_eq!(
        auth.read_accounts().unwrap()[0].status,
        AccountStatus::ReauthenticationRequired
    );
}

#[test]
fn cancelled_login_does_not_save_or_activate_credentials() {
    let directory = tempfile::tempdir().unwrap();
    let auth = ChatGptPlanOAuth::with_client(
        Arc::new(MemorySecretStore::default()),
        directory.path().join("plan.lock"),
        Arc::new(RefreshClient {
            refreshes: AtomicUsize::new(0),
        }),
    );
    let id = LoginId::new("cancelled").unwrap();
    auth.attempts.lock().unwrap().insert(
        id.clone(),
        LoginAttempt {
            cancellation: CancellationSource::new(),
            selection_revision: 0,
        },
    );
    assert_eq!(auth.cancel(&id).unwrap(), CancelLoginOutcome::Cancelled);
    auth.finish(id, Ok(registration()), None);
    assert!(auth.read_accounts().unwrap().is_empty());
}

#[test]
fn backend_shutdown_cancels_callback_and_releases_credential_owner() {
    let directory = tempfile::tempdir().unwrap();
    let client = Arc::new(RefreshClient {
        refreshes: AtomicUsize::new(0),
    });
    let auth = ChatGptPlanOAuth::with_client(
        Arc::new(MemorySecretStore::default()),
        directory.path().join("plan.lock"),
        client.clone(),
    );
    let weak = Arc::downgrade(&auth);
    let service = Arc::new(LoginService::new(auth.clone()).unwrap());
    auth.install_login_service(&service).unwrap();
    let BeginLogin::Browser {
        login_id,
        authorization_url,
    } = service
        .begin(LoginMethod::ChatGptPlanBrowser { account_id: None })
        .unwrap()
    else {
        panic!("expected independent browser login");
    };
    let url = url::Url::parse(&authorization_url).unwrap();
    let redirect = url
        .query_pairs()
        .find(|(key, _)| key == "redirect_uri")
        .unwrap()
        .1;
    let callback = url::Url::parse(&redirect).unwrap();
    let address = ("127.0.0.1", callback.port().unwrap());
    let cancellation = auth.attempts.lock().unwrap()[&login_id]
        .cancellation
        .token();
    assert!(std::net::TcpListener::bind(address).is_err());
    drop(service);
    drop(auth);
    assert!(weak.upgrade().is_none());
    assert!(cancellation.is_cancelled());
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
    loop {
        if std::net::TcpListener::bind(address).is_ok() {
            break;
        }
        assert!(
            std::time::Instant::now() < deadline,
            "callback listener retained after shutdown"
        );
        std::thread::sleep(std::time::Duration::from_millis(10));
    }
    assert_eq!(client.refreshes.load(Ordering::SeqCst), 0);
}

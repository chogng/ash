//! Runs the App Server's actual provider adapter against the Cargo-built extension executable.
#[path = "../../../crates/app-server/src/github_authentication.rs"]
mod host;

use ash_http_client::HttpClient;
use ash_http_client::HttpClientError;
use ash_http_client::HttpRequest;
use ash_http_client::HttpResponse;
use ash_login::AccountState;
use ash_login::BeginLogin;
use ash_login::CancelLoginOutcome;
use ash_login::LoginCompletion;
use ash_login::LoginErrorKind;
use ash_login::LoginEvents;
use ash_login::LoginMethod;
use ash_login::LoginService;
use ash_secrets::MemorySecretStore;
use ash_secrets::SecretValue;
use github::GitHubAccountManager;
use github::GitHubBrowserConfig;
use github::GitHubCredentialProvider;
use host::GitHubAuthenticationProvider;
use host::GitHubAuthenticationRuntime;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::Duration;

#[derive(Default)]
struct Http {
    calls: Mutex<Vec<String>>,
}
impl HttpClient for Http {
    fn execute(&self, request: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        self.calls.lock().unwrap().push(request.url().into());
        let body = if request.url().ends_with("/token") {
            br#"{"access_token":"browser-token","refresh_token":"refresh-token","expires_in":28800,"token_type":"bearer"}"#.to_vec()
        } else {
            br#"{"id":42,"login":"alice"}"#.to_vec()
        };
        Ok(HttpResponse::new(200, Vec::new(), body))
    }
}
struct Events(mpsc::Sender<AccountState>, mpsc::Sender<LoginCompletion>);
impl LoginEvents for Events {
    fn account_updated(&self, account: AccountState) {
        let _ = self.0.send(account);
    }
    fn login_completed(&self, completion: LoginCompletion) {
        let _ = self.1.send(completion);
    }
}
fn runtime() -> (Arc<GitHubAuthenticationRuntime>, Arc<Http>) {
    let http = Arc::new(Http::default());
    let runtime = GitHubAuthenticationRuntime::open(
        env!("CARGO_BIN_EXE_ash-github-authentication").into(),
        vec![GitHubBrowserConfig {
            host: "github.com".into(),
            client_id: "client".into(),
            broker_base_url: url::Url::parse("https://auth.example.com/").unwrap(),
        }],
        http.clone(),
        Arc::new(MemorySecretStore::default()),
    )
    .unwrap();
    (runtime, http)
}
fn window(
    runtime: Arc<GitHubAuthenticationRuntime>,
) -> (
    Arc<GitHubAuthenticationProvider>,
    Arc<LoginService>,
    mpsc::Receiver<AccountState>,
    mpsc::Receiver<LoginCompletion>,
) {
    let provider = GitHubAuthenticationProvider::new(runtime);
    let service = Arc::new(LoginService::deferred(provider.clone()));
    provider.install_login_service(&service);
    let (updated_tx, updated_rx) = mpsc::channel();
    let (completed_tx, completed_rx) = mpsc::channel();
    service
        .install_events(Arc::new(Events(updated_tx, completed_tx)))
        .unwrap();
    (provider, service, updated_rx, completed_rx)
}
#[test]
fn two_windows_share_one_session_and_logout_invalidates_captured_grants() {
    let (runtime, http) = runtime();
    assert!(runtime.matches(
        std::path::Path::new(env!("CARGO_BIN_EXE_ash-github-authentication")),
        &[GitHubBrowserConfig {
            host: "github.com".into(),
            client_id: "client".into(),
            broker_base_url: url::Url::parse("https://auth.example.com/").unwrap()
        }]
    ));
    let (first, first_login, first_updates, _) = window(runtime.clone());
    let (second, second_login, second_updates, _) = window(runtime);
    assert!(first_login.refresh().unwrap().accounts.is_empty());
    assert!(second_login.refresh().unwrap().accounts.is_empty());
    let source = ash_async_utils::CancellationSource::new();
    let account = first
        .connect_token(
            "github.com",
            SecretValue::new(b"account-token".to_vec()),
            &source.token(),
        )
        .unwrap();
    assert_eq!(first.accounts().unwrap(), second.accounts().unwrap());
    assert_eq!(http.calls.lock().unwrap().len(), 1);
    let grant = second.authorization_for(&account.id).unwrap();
    assert_eq!(second.token(&grant).unwrap().expose(), b"account-token");
    assert!(
        first_updates
            .try_iter()
            .any(|state| state.accounts.len() == 1)
    );
    assert!(
        second_updates
            .try_iter()
            .any(|state| state.accounts.len() == 1)
    );
    second_login
        .logout_account(&ash_login::AccountRef {
            provider: "github".into(),
            account_id: account.id,
        })
        .unwrap();
    assert!(first_login.read().unwrap().accounts.is_empty());
    assert!(second_login.read().unwrap().accounts.is_empty());
    assert_eq!(
        first.token(&grant).unwrap_err().kind(),
        LoginErrorKind::ExternalLoginRequired
    );
}
#[test]
fn browser_login_has_one_owner_and_completion_updates_both_windows() {
    use std::io::Read;
    use std::io::Write;
    let (runtime, _) = runtime();
    let (_, first, _, first_completed) = window(runtime.clone());
    let (_, second, second_updates, second_completed) = window(runtime);
    let BeginLogin::Browser {
        login_id,
        authorization_url,
    } = first.begin(LoginMethod::GitHubBrowser).unwrap()
    else {
        panic!("browser login expected")
    };
    assert_eq!(
        second.begin(LoginMethod::GitHubBrowser).unwrap_err().kind(),
        LoginErrorKind::Conflict
    );
    assert_eq!(
        second.cancel(&login_id).unwrap(),
        CancelLoginOutcome::NotFound
    );
    let authorization = url::Url::parse(&authorization_url).unwrap();
    let params: std::collections::BTreeMap<_, _> =
        authorization.query_pairs().into_owned().collect();
    let callback = url::Url::parse(&params["redirect_uri"]).unwrap();
    let mut socket = std::net::TcpStream::connect(("127.0.0.1", callback.port().unwrap())).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(5)))
        .unwrap();
    write!(
        socket,
        "GET {}?state={}&code=code HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n",
        callback.path(),
        params["state"]
    )
    .unwrap();
    let mut response = String::new();
    socket.read_to_string(&mut response).unwrap();
    assert!(response.contains("200 OK"));
    assert_eq!(
        first_completed
            .recv_timeout(Duration::from_secs(5))
            .unwrap()
            .login_id,
        login_id
    );
    let until = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let state = second_updates
            .recv_timeout(until.saturating_duration_since(std::time::Instant::now()))
            .unwrap();
        if state.accounts.len() == 1 {
            break;
        }
    }
    assert!(second_completed.try_recv().is_err());
    assert_eq!(
        first.read().unwrap().accounts,
        second.read().unwrap().accounts
    );
}
#[test]
fn cancelling_the_origin_attempt_allows_another_window_to_start() {
    let (runtime, _) = runtime();
    let (_, first, _, completed) = window(runtime.clone());
    let (_, second, _, _) = window(runtime);
    let started = first.begin(LoginMethod::GitHubBrowser).unwrap();
    assert_eq!(
        first.cancel(started.login_id()).unwrap(),
        CancelLoginOutcome::Cancelled
    );
    let next = second.begin(LoginMethod::GitHubBrowser).unwrap();
    second.cancel(next.login_id()).unwrap();
    assert!(completed.try_recv().is_err());
}

#[test]
fn unbundled_client_has_no_authentication_executable_fallback() {
    let installation = ash_install_context::InstallContext::current();
    if let Some(layout) = installation.package_layout() {
        assert!(
            host::product_executable()
                .unwrap()
                .starts_with(layout.binary_directory())
        );
    } else {
        assert!(host::product_executable().is_none());
    }
}

#[test]
fn cancellation_during_token_validation_does_not_save_an_account() {
    struct WaitingHttp(mpsc::Sender<()>, Mutex<mpsc::Receiver<()>>);
    impl HttpClient for WaitingHttp {
        fn execute(&self, _: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
            unreachable!("the host must pass cancellation")
        }
        fn execute_with_cancellation(
            &self,
            _: &HttpRequest,
            cancellation: &ash_async_utils::CancellationToken,
        ) -> Result<HttpResponse, HttpClientError> {
            self.0.send(()).unwrap();
            loop {
                if cancellation.is_cancelled() {
                    return Err(HttpClientError::Transport("cancelled".into()));
                }
                match self
                    .1
                    .lock()
                    .unwrap()
                    .recv_timeout(Duration::from_millis(10))
                {
                    Ok(()) => {
                        return Ok(HttpResponse::new(
                            200,
                            Vec::new(),
                            br#"{"id":42,"login":"alice"}"#.to_vec(),
                        ));
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        return Err(HttpClientError::Transport("test ended".into()));
                    }
                }
            }
        }
    }
    let (entered, entered_rx) = mpsc::channel();
    let (_release, release_rx) = mpsc::channel();
    let runtime = GitHubAuthenticationRuntime::open(
        env!("CARGO_BIN_EXE_ash-github-authentication").into(),
        Vec::new(),
        Arc::new(WaitingHttp(entered, Mutex::new(release_rx))),
        Arc::new(MemorySecretStore::default()),
    )
    .unwrap();
    let (provider, _, _, _) = window(runtime);
    let source = ash_async_utils::CancellationSource::new();
    let calling_provider = provider.clone();
    let cancellation = source.token();
    let call = std::thread::spawn(move || {
        calling_provider.connect_token(
            "github.com",
            SecretValue::new(b"cancel-token".to_vec()),
            &cancellation,
        )
    });
    entered_rx.recv_timeout(Duration::from_secs(5)).unwrap();
    source.cancel();
    assert!(call.join().unwrap().is_err());
    assert!(provider.accounts().unwrap().is_empty());
}

#[test]
fn logout_stops_another_windows_pending_login_with_one_terminal_event() {
    let (runtime, _) = runtime();
    let (provider, first, _, completed) = window(runtime.clone());
    let (_, second, _, _) = window(runtime);
    let cancellation = ash_async_utils::CancellationSource::new();
    let account = provider
        .connect_token(
            "github.com",
            SecretValue::new(b"initial-token".to_vec()),
            &cancellation.token(),
        )
        .unwrap();
    let started = first.begin(LoginMethod::GitHubBrowser).unwrap();
    second
        .logout_account(&ash_login::AccountRef {
            provider: "github".into(),
            account_id: account.id,
        })
        .unwrap();
    let completion = completed.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(completion.login_id, *started.login_id());
    assert!(matches!(
        completion.outcome,
        ash_login::LoginCompletionOutcome::Failed { .. }
    ));
    assert!(completed.try_recv().is_err());
    assert!(provider.accounts().unwrap().is_empty());
}

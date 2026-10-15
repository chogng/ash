//! Exercises the product adapter against the actual independently built executable.
#[path = "../../../crates/app-server/src/github_extension.rs"]
mod host;

use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use ash_core_plugins::EditorExtensionPolicy;
use ash_core_plugins::EditorExtensionPolicyAction;
use ash_external_ext::BuiltInExtensionRuntime;
use ash_http_client::HttpClient;
use ash_http_client::HttpClientError;
use ash_http_client::HttpMethod;
use ash_http_client::HttpRequest;
use ash_http_client::HttpResponse;
use ash_login::LoginError;
use ash_login::LoginErrorKind;
use ash_secrets::SecretValue;
use github::Error;
use github::GitHub;
use github::GitHubAuthorization;
use github::GitHubCredentialProvider;
use github::GitHubProvider;
use github::GitHubRequest;
use github::GitHubResponse;
use github::Repository;
use host::GitHubExtensionRuntime;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;

#[derive(Default)]
struct Credentials {
    revoked: AtomicBool,
}
impl GitHubCredentialProvider for Credentials {
    fn authorization(&self) -> Result<GitHubAuthorization, LoginError> {
        if self.revoked.load(Ordering::Acquire) {
            return Err(LoginError::new(
                LoginErrorKind::ExternalLoginRequired,
                "revoked",
            ));
        }
        Ok(GitHubAuthorization {
            host: "github.com".into(),
            account_id: "42".into(),
            grant_id: "grant-1".into(),
        })
    }
    fn token(&self, grant: &GitHubAuthorization) -> Result<SecretValue, LoginError> {
        if grant != &self.authorization()? {
            return Err(LoginError::new(
                LoginErrorKind::ExternalLoginRequired,
                "different grant",
            ));
        }
        Ok(SecretValue::new(b"test-token".to_vec()))
    }
}
#[derive(Default)]
struct Http {
    responses: Mutex<VecDeque<(u16, serde_json::Value)>>,
    requests: Mutex<Vec<HttpRequest>>,
    block: AtomicBool,
    entered: AtomicBool,
    cancelled: AtomicBool,
    revoke: Mutex<Option<Arc<Credentials>>>,
}
impl HttpClient for Http {
    fn execute(&self, request: &HttpRequest) -> Result<HttpResponse, HttpClientError> {
        self.execute_with_cancellation(request, &CancellationSource::new().token())
    }
    fn execute_with_cancellation(
        &self,
        request: &HttpRequest,
        cancellation: &CancellationToken,
    ) -> Result<HttpResponse, HttpClientError> {
        self.requests.lock().unwrap().push(request.clone());
        assert!(request.rejects_redirects());
        self.entered.store(true, Ordering::Release);
        let until = Instant::now() + Duration::from_secs(10);
        while self.block.load(Ordering::Acquire) {
            if cancellation.is_cancelled() {
                self.cancelled.store(true, Ordering::Release);
                return Err(HttpClientError::Transport("cancelled".into()));
            }
            assert!(
                Instant::now() < until,
                "host did not cancel its HTTP worker"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
        if let Some(credentials) = self.revoke.lock().unwrap().take() {
            credentials.revoked.store(true, Ordering::Release);
        }
        let queued = self.responses.lock().unwrap().pop_front();
        let (status, body) = if let Some(response) = queued {
            response
        } else if request.method() == HttpMethod::Post {
            (
                201,
                serde_json::json!({"id":1,"body":"reply","html_url":"https://github.com/team/repo/issues/7#issuecomment-1","updated_at":"now"}),
            )
        } else if request.url().contains("search/issues") {
            (
                200,
                serde_json::json!({"items":[{"number":7,"title":"Bug","state":"open","html_url":"https://github.com/team/repo/issues/7"}]}),
            )
        } else {
            (200, serde_json::json!([]))
        };
        Ok(HttpResponse::new(
            status,
            vec![],
            serde_json::to_vec(&body).unwrap(),
        ))
    }
}
struct Fixture {
    _profile: tempfile::TempDir,
    policy: Arc<EditorExtensionPolicy>,
    runtime: Arc<GitHubExtensionRuntime>,
    provider: Arc<dyn GitHubProvider>,
    credentials: Arc<Credentials>,
    http: Arc<Http>,
}
impl Fixture {
    fn new() -> Self {
        let profile = tempfile::tempdir().unwrap();
        let policy =
            Arc::new(EditorExtensionPolicy::open(profile.path().join("policy.json")).unwrap());
        let runtime = GitHubExtensionRuntime::open(
            env!("CARGO_BIN_EXE_ash-github-extension").into(),
            policy.clone(),
        )
        .unwrap();
        assert!(runtime.matches(std::path::Path::new(env!(
            "CARGO_BIN_EXE_ash-github-extension"
        ))));
        let credentials = Arc::new(Credentials::default());
        let http = Arc::new(Http::default());
        let provider = runtime.provider(Some(credentials.clone()), http.clone());
        // Resolution is restricted to an installed product; this test uses an explicit executable.
        let _ = host::product_executable();
        Self {
            _profile: profile,
            policy,
            runtime,
            provider,
            credentials,
            http,
        }
    }
    fn request(&self, request: GitHubRequest) -> github::Result<GitHubResponse> {
        self.provider.call(
            Some(self.credentials.authorization().unwrap()),
            request,
            &CancellationSource::new().token(),
        )
    }
    fn set_enabled(&self, enabled: bool, revision: u64) {
        self.policy
            .set_built_in_enablement(
                "ash.github",
                if enabled {
                    EditorExtensionPolicyAction::Enable
                } else {
                    EditorExtensionPolicyAction::Disable
                },
                revision,
            )
            .unwrap();
        self.runtime.reconcile_enablement().unwrap();
    }
    fn wait_for_http(&self) {
        let until = Instant::now() + Duration::from_secs(5);
        while !self.http.entered.load(Ordering::Acquire) {
            assert!(Instant::now() < until, "extension did not request HTTP");
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
fn repository() -> Repository {
    Repository::new("github.com".into(), "team".into(), "repo".into()).unwrap()
}
fn read() -> GitHubRequest {
    GitHubRequest::Comments {
        repository: repository(),
        number: 7,
        page: 1,
    }
}
fn write() -> GitHubRequest {
    GitHubRequest::CreateComment {
        repository: repository(),
        number: 7,
        body: "reply".into(),
    }
}

#[test]
fn actual_executable_registers_lazily_and_serves_shared_consumers() {
    let f = Fixture::new();
    assert!(!f.runtime.is_running());
    assert!(matches!(f.request(read()), Ok(GitHubResponse::Comments(_))));
    assert!(f.runtime.is_running());
    let other = f
        .runtime
        .provider(Some(f.credentials.clone()), f.http.clone());
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_time()
        .build()
        .unwrap();
    runtime.block_on(async {
        let client = GitHub::for_account(
            f.credentials.clone(),
            other,
            CancellationSource::new().token(),
        )
        .unwrap();
        assert!(
            client
                .comments(&repository(), 7, 1)
                .await
                .unwrap()
                .items
                .is_empty()
        );
    });
    let requests = f.http.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    assert!(requests.iter().all(|request| {
        request.headers().iter().any(|header| {
            header.name().eq_ignore_ascii_case("authorization")
                && header.value() == "Bearer test-token"
        })
    }));
    drop(requests);
    let cached_client = GitHub::for_account(
        f.credentials.clone(),
        f.provider.clone(),
        CancellationSource::new().token(),
    )
    .unwrap();
    f.set_enabled(false, 1);
    assert!(cached_client.validate_authorization().is_err());
    assert!(!f.runtime.is_running());
    assert!(matches!(f.request(read()), Err(Error::Unavailable(_))));
    f.set_enabled(true, 2);
    assert!(!f.runtime.is_running());
    assert!(f.request(read()).is_ok());
}
#[test]
fn cancelled_reads_join_the_original_host_http_attempt() {
    let f = Fixture::new();
    f.http.block.store(true, Ordering::Release);
    let source = CancellationSource::new();
    std::thread::scope(|scope| {
        let call = scope.spawn(|| {
            f.provider.call(
                Some(f.credentials.authorization().unwrap()),
                read(),
                &source.token(),
            )
        });
        f.wait_for_http();
        source.cancel();
        assert!(matches!(call.join().unwrap(), Err(Error::Cancelled)));
    });
    assert!(f.http.cancelled.load(Ordering::Acquire));
    assert_eq!(f.http.requests.lock().unwrap().len(), 1);
}
#[test]
fn disabling_during_a_write_cancels_io_and_never_replays_the_mutation() {
    let f = Fixture::new();
    f.http.block.store(true, Ordering::Release);
    std::thread::scope(|scope| {
        let call = scope.spawn(|| f.request(write()));
        f.wait_for_http();
        f.set_enabled(false, 1);
        assert!(matches!(
            call.join().unwrap(),
            Err(Error::SubmissionUncertain)
        ));
    });
    assert!(f.http.cancelled.load(Ordering::Acquire));
    assert_eq!(f.http.requests.lock().unwrap().len(), 1);
    f.http.block.store(false, Ordering::Release);
    f.set_enabled(true, 2);
    assert!(f.request(read()).is_ok());
    assert_eq!(
        f.http
            .requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.method() == HttpMethod::Post)
            .count(),
        1
    );
}
#[test]
fn revoked_grants_discard_reads_but_keep_confirmed_writes() {
    let f = Fixture::new();
    *f.http.revoke.lock().unwrap() = Some(f.credentials.clone());
    assert!(matches!(
        f.request(read()),
        Err(Error::AuthenticationRequired)
    ));
    f.credentials.revoked.store(false, Ordering::Release);
    *f.http.revoke.lock().unwrap() = Some(f.credentials.clone());
    assert!(matches!(
        f.request(write()),
        Ok(GitHubResponse::CreateComment(_))
    ));
}
#[test]
fn anonymous_report_search_uses_the_capability_without_authentication() {
    let f = Fixture::new();
    let provider = f.runtime.provider(None, f.http.clone());
    let reporter =
        github::GitHubIssueReporter::new("https://github.com/team/repo/issues", provider).unwrap();
    assert_eq!(
        reporter
            .search("Bug", &CancellationSource::new().token())
            .unwrap()
            .len(),
        1
    );
    assert!(
        f.http.requests.lock().unwrap()[0]
            .headers()
            .iter()
            .all(|header| !header.name().eq_ignore_ascii_case("authorization"))
    );
    let mut wrong = repository();
    wrong.host = "another.example.com".into();
    assert!(matches!(
        f.request(GitHubRequest::Comments {
            repository: wrong,
            number: 7,
            page: 1
        }),
        Err(Error::AuthenticationRequired)
    ));
    assert_eq!(f.http.requests.lock().unwrap().len(), 1);
}

#[cfg(unix)]
#[test]
fn a_crashed_real_provider_recovers_without_replaying_an_in_flight_write() {
    use std::os::unix::fs::PermissionsExt;
    let profile = tempfile::tempdir().unwrap();
    let pid_file = profile.path().join("provider.pid");
    let launcher = profile.path().join("github-provider");
    let quote =
        |path: &std::path::Path| format!("'{}'", path.to_str().unwrap().replace('\'', "'\"'\"'"));
    // exec preserves the wrapper's PID, giving the test an exact process identity
    // without process-name searches or a fault-injection API in the product.
    std::fs::write(
        &launcher,
        format!(
            "#!/bin/sh\nprintf '%s' \"$$\" > {}\nexec {}\n",
            quote(&pid_file),
            quote(std::path::Path::new(env!(
                "CARGO_BIN_EXE_ash-github-extension"
            )))
        ),
    )
    .unwrap();
    std::fs::set_permissions(&launcher, std::fs::Permissions::from_mode(0o700)).unwrap();
    let policy = Arc::new(EditorExtensionPolicy::open(profile.path().join("policy.json")).unwrap());
    let runtime = GitHubExtensionRuntime::open(launcher, policy).unwrap();
    let credentials = Arc::new(Credentials::default());
    let http = Arc::new(Http::default());
    let provider = runtime.provider(Some(credentials.clone()), http.clone());
    assert!(
        provider
            .call(
                Some(credentials.authorization().unwrap()),
                read(),
                &CancellationSource::new().token()
            )
            .is_ok()
    );
    let first_pid = std::fs::read_to_string(&pid_file).unwrap();
    http.entered.store(false, Ordering::Release);
    http.block.store(true, Ordering::Release);
    std::thread::scope(|scope| {
        let call = scope.spawn(|| {
            provider.call(
                Some(credentials.authorization().unwrap()),
                write(),
                &CancellationSource::new().token(),
            )
        });
        let until = Instant::now() + Duration::from_secs(5);
        while !http.entered.load(Ordering::Acquire) {
            assert!(Instant::now() < until);
            std::thread::sleep(Duration::from_millis(5));
        }
        assert!(
            std::process::Command::new("/bin/kill")
                .args(["-KILL", &first_pid])
                .status()
                .unwrap()
                .success()
        );
        while runtime.is_running() {
            assert!(Instant::now() < until);
            std::thread::sleep(Duration::from_millis(5));
        }
        http.block.store(false, Ordering::Release);
        assert!(matches!(
            call.join().unwrap(),
            Err(Error::SubmissionUncertain)
        ));
    });
    assert!(
        provider
            .call(
                Some(credentials.authorization().unwrap()),
                read(),
                &CancellationSource::new().token()
            )
            .is_ok()
    );
    assert_ne!(first_pid, std::fs::read_to_string(pid_file).unwrap());
    assert_eq!(
        http.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|request| request.method() == HttpMethod::Post)
            .count(),
        1
    );
}

#[test]
fn new_repository_operations_cross_the_real_provider_and_share_links_need_no_grant() {
    use github::RepositoryVisibility;
    use github::ShareLink;
    use github::SharePathKind;
    use github::ShareReference;
    use github::ShareTarget;
    let f = Fixture::new();
    let remote = serde_json::json!({"full_name":"team/repo","description":null,"private":true,"default_branch":"main","html_url":"https://github.com/team/repo","clone_url":"https://github.com/team/repo.git","ssh_url":"git@github.com:team/repo.git"});
    f.http
        .responses
        .lock()
        .unwrap()
        .push_back((200, serde_json::json!([remote.clone()])));
    assert!(
        matches!(f.request(GitHubRequest::SearchRepositories { query: String::new(), page: 1 }), Ok(GitHubResponse::SearchRepositories(page)) if page.items.len()==1)
    );
    f.http.responses.lock().unwrap().push_back((201, remote));
    assert!(matches!(
        f.request(GitHubRequest::CreateRepository {
            name: "repo".into(),
            description: String::new(),
            visibility: RepositoryVisibility::Private
        }),
        Ok(GitHubResponse::CreateRepository(_))
    ));
    f.http.responses.lock().unwrap().push_back((200, serde_json::json!({"data":{"repository":{"viewerPermission":"READ","defaultBranchRef":{"name":"main"}}}})));
    assert!(
        matches!(f.request(GitHubRequest::BranchProtection {repository:repository()}),Ok(GitHubResponse::BranchProtection(value)) if value.rules.is_empty())
    );
    f.credentials.revoked.store(true, Ordering::Release);
    let anonymous = f.runtime.provider(None, f.http.clone());
    let response = anonymous
        .call(
            None,
            GitHubRequest::ShareLink(ShareLink {
                repository: repository(),
                reference: ShareReference::Commit("a".repeat(40)),
                target: ShareTarget::GitHub,
                path: Some("src/file.rs".into()),
                path_kind: SharePathKind::File,
                lines: None,
                notebook_cell: None,
            }),
            &CancellationSource::new().token(),
        )
        .unwrap();
    assert!(
        matches!(response,GitHubResponse::ShareLink(url) if url==format!("https://github.com/team/repo/blob/{}/src/file.rs","a".repeat(40)))
    );
    assert_eq!(f.http.requests.lock().unwrap().len(), 3);
}

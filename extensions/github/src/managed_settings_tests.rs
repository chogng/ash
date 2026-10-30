use crate::ApiProvider;
use crate::Error;
use crate::managed_settings::ManagedSettingsStore;
use crate::tests::Credentials;
use crate::tests::FakeHttp;
use crate::tests::github;
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use github::GitHubAuthorization;
use github::GitHubCredentialProvider;
use github::GitHubProvider;
use github::GitHubRequest;
use github::GitHubResponse;
use github::ManagedSettingsFailure;
use github::ManagedSettingsReadMode;
use github::ManagedSettingsRefresh;
use github::ManagedSettingsSnapshot;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;

#[tokio::test(flavor = "current_thread")]
async fn managed_settings_reads_the_account_endpoint_without_exposing_credentials() {
    let http = Arc::new(FakeHttp::default());
    http.push(
        200,
        json!({"permissions":{"disableBypassPermissionsMode":"disable"}}),
    );
    let settings = github(http.clone()).managed_settings().await.unwrap();
    assert_eq!(
        settings,
        Some(json!({"permissions":{"disableBypassPermissionsMode":"disable"}}))
    );
    let requests = http.requests.lock().unwrap();
    assert_eq!(
        requests[0].url(),
        "https://api.github.com/copilot_internal/managed_settings"
    );
    assert!(!format!("{:?}", requests[0]).contains("ash-test-token"));
}

#[tokio::test(flavor = "current_thread")]
async fn managed_settings_distinguishes_removal_permission_failure_and_invalid_data() {
    let http = Arc::new(FakeHttp::default());
    http.push(404, json!({}));
    http.push(403, json!({"message":"private"}));
    http.push(200, json!(["invalid"]));
    let client = github(http);
    assert_eq!(client.managed_settings().await.unwrap(), None);
    assert_eq!(
        client.managed_settings().await.unwrap_err(),
        Error::PermissionDenied
    );
    assert!(matches!(
        client.managed_settings().await.unwrap_err(),
        Error::InvalidResponse(_)
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn managed_settings_compatibility_refusal_does_not_expose_or_require_error_metadata() {
    let http = Arc::new(FakeHttp::default());
    for body in [
        json!({"error_code":"client_update_required","client_id":"vscode","minimum_client_version":"private-version","message":"private-token"}),
        json!({"unexpected":"private-token"}),
        Value::Null,
    ] {
        http.push(466, body);
    }
    http.responses
        .lock()
        .unwrap()
        .push_back(Ok(ash_http_client::HttpResponse::new(
            466,
            vec![],
            b"not-json-private-token".to_vec(),
        )));
    http.push(200, json!({"model":"allowed-model"}));
    let client = github(http);
    for _ in 0..4 {
        let error = client.managed_settings().await.unwrap_err();
        assert_eq!(error, Error::ManagedSettingsUpdateRequired);
        assert!(!format!("{error:?}: {error}").contains("private"));
        let encoded = serde_json::to_value(&error).unwrap();
        assert_eq!(serde_json::from_value::<Error>(encoded).unwrap(), error);
    }
    assert_eq!(
        client.managed_settings().await.unwrap(),
        Some(json!({"model":"allowed-model"}))
    );
}

fn read(
    provider: &ApiProvider,
    grant: GitHubAuthorization,
    mode: ManagedSettingsReadMode,
    cancellation: &CancellationToken,
) -> crate::Result<ManagedSettingsSnapshot> {
    match provider.call(
        Some(grant),
        GitHubRequest::ManagedSettings { mode },
        cancellation,
    )? {
        GitHubResponse::ManagedSettings(snapshot) => Ok(snapshot),
        _ => panic!("unexpected managed settings result"),
    }
}

#[test]
fn windows_share_results_failures_and_explicit_retry_with_authoritative_withdrawal() {
    let http = Arc::new(FakeHttp::default());
    http.push(200, json!({"model":"managed"}));
    http.push(466, json!({"private":"not-forwarded"}));
    http.push(404, Value::Null);
    let store = Arc::new(ManagedSettingsStore::default());
    let credentials = Arc::new(Credentials);
    let first =
        ApiProvider::with_managed_settings(credentials.clone(), http.clone(), store.clone());
    let second = ApiProvider::with_managed_settings(credentials.clone(), http.clone(), store);
    let grant = credentials.authorization().unwrap();
    let source = CancellationSource::new();
    let ready = read(
        &first,
        grant.clone(),
        ManagedSettingsReadMode::Automatic,
        &source.token(),
    )
    .unwrap();
    assert_eq!(ready.settings, Some(json!({"model":"managed"})));
    assert_eq!(
        read(
            &second,
            grant.clone(),
            ManagedSettingsReadMode::Automatic,
            &source.token()
        )
        .unwrap(),
        ready
    );
    let failed = read(
        &second,
        grant.clone(),
        ManagedSettingsReadMode::Retry,
        &source.token(),
    )
    .unwrap();
    assert_eq!(failed.settings, ready.settings);
    let ManagedSettingsRefresh::Ready {
        last_success_at, ..
    } = ready.refresh
    else {
        panic!("not ready")
    };
    assert!(matches!(failed.refresh, ManagedSettingsRefresh::Failed {
        failure: ManagedSettingsFailure::UpdateRequired, last_success_at: Some(at), ..
    } if at == last_success_at));
    assert_eq!(
        read(
            &first,
            grant.clone(),
            ManagedSettingsReadMode::Automatic,
            &source.token()
        )
        .unwrap(),
        failed
    );
    assert_eq!(http.requests.lock().unwrap().len(), 2);
    let absent = read(
        &first,
        grant.clone(),
        ManagedSettingsReadMode::Retry,
        &source.token(),
    )
    .unwrap();
    assert_eq!(absent.settings, None);
    assert!(matches!(
        absent.refresh,
        ManagedSettingsRefresh::Ready { .. }
    ));
    assert_eq!(
        read(
            &second,
            grant,
            ManagedSettingsReadMode::Automatic,
            &source.token()
        )
        .unwrap(),
        absent
    );
    assert_eq!(http.requests.lock().unwrap().len(), 3);
}

#[derive(Clone)]
struct AccountCredentials(GitHubAuthorization);

impl GitHubCredentialProvider for AccountCredentials {
    fn authorization(&self) -> std::result::Result<GitHubAuthorization, ash_login::LoginError> {
        Ok(self.0.clone())
    }

    fn token(
        &self,
        grant: &GitHubAuthorization,
    ) -> std::result::Result<ash_secrets::SecretValue, ash_login::LoginError> {
        if grant != &self.0 {
            return Err(ash_login::LoginError::new(
                ash_login::LoginErrorKind::ExternalLoginRequired,
                "Grant revoked",
            ));
        }
        Ok(ash_secrets::SecretValue::new(b"test-token".to_vec()))
    }
}

#[test]
fn failed_snapshots_are_isolated_by_account_host_and_exact_grant() {
    let http = Arc::new(FakeHttp::default());
    let store = Arc::new(ManagedSettingsStore::default());
    let source = CancellationSource::new();
    for (account_id, host, grant_id) in [
        ("first", "github.com", "one"),
        ("second", "github.com", "one"),
        ("first", "enterprise.example", "one"),
        ("first", "github.com", "two"),
    ] {
        http.push(403, Value::Null);
        let grant = GitHubAuthorization {
            account_id: account_id.into(),
            host: host.into(),
            grant_id: grant_id.into(),
        };
        let provider = ApiProvider::with_managed_settings(
            Arc::new(AccountCredentials(grant.clone())),
            http.clone(),
            store.clone(),
        );
        let snapshot = read(
            &provider,
            grant.clone(),
            ManagedSettingsReadMode::Automatic,
            &source.token(),
        )
        .unwrap();
        assert_eq!(snapshot.settings, None);
        assert!(matches!(
            snapshot.refresh,
            ManagedSettingsRefresh::Failed {
                last_success_at: None,
                failure: ManagedSettingsFailure::PermissionDenied,
                ..
            }
        ));
        assert_eq!(
            read(
                &provider,
                grant,
                ManagedSettingsReadMode::Automatic,
                &source.token()
            )
            .unwrap(),
            snapshot
        );
    }
    assert_eq!(http.requests.lock().unwrap().len(), 4);
}

struct HeldHttp {
    entered: std::sync::mpsc::SyncSender<()>,
    release: std::sync::Mutex<std::sync::mpsc::Receiver<()>>,
    requests: std::sync::atomic::AtomicUsize,
}

impl ash_http_client::HttpClient for HeldHttp {
    fn execute(
        &self,
        _: &ash_http_client::HttpRequest,
    ) -> std::result::Result<ash_http_client::HttpResponse, ash_http_client::HttpClientError> {
        if self
            .requests
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst)
            == 0
        {
            self.entered.send(()).unwrap();
            self.release
                .lock()
                .unwrap()
                .recv_timeout(std::time::Duration::from_secs(5))
                .unwrap();
        }
        Ok(ash_http_client::HttpResponse::new(
            200,
            vec![],
            br#"{"model":"managed"}"#.to_vec(),
        ))
    }
}

#[test]
fn cancelling_a_window_does_not_cancel_another_windows_in_flight_refresh() {
    let (entered, started) = std::sync::mpsc::sync_channel(1);
    let (release, held) = std::sync::mpsc::sync_channel(1);
    let http = Arc::new(HeldHttp {
        entered,
        release: std::sync::Mutex::new(held),
        requests: Default::default(),
    });
    let provider = Arc::new(ApiProvider::new(Arc::new(Credentials), http.clone()));
    let grant = Credentials.authorization().unwrap();
    let owner = CancellationSource::new();
    let waiting = CancellationSource::new();
    std::thread::scope(|scope| {
        let pending = scope.spawn(|| {
            read(
                &provider,
                grant.clone(),
                ManagedSettingsReadMode::Automatic,
                &owner.token(),
            )
        });
        started
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        let (joining, joined) = std::sync::mpsc::sync_channel(1);
        let provider_ref = &provider;
        let grant_ref = &grant;
        let waiting_ref = &waiting;
        let waiter = scope.spawn(move || {
            joining.send(()).unwrap();
            read(
                provider_ref,
                grant_ref.clone(),
                ManagedSettingsReadMode::Retry,
                &waiting_ref.token(),
            )
        });
        joined
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        waiting.cancel();
        assert_eq!(waiter.join().unwrap(), Err(Error::Cancelled));
        release.send(()).unwrap();
        assert!(matches!(
            pending.join().unwrap().unwrap().refresh,
            ManagedSettingsRefresh::Ready { .. }
        ));
    });
    assert_eq!(http.requests.load(std::sync::atomic::Ordering::SeqCst), 1);
}

#[test]
fn cancelled_network_attempts_do_not_become_shared_failures() {
    let (entered, started) = std::sync::mpsc::sync_channel(1);
    let (release, held) = std::sync::mpsc::sync_channel(1);
    let http = Arc::new(HeldHttp {
        entered,
        release: std::sync::Mutex::new(held),
        requests: Default::default(),
    });
    let provider = ApiProvider::new(Arc::new(Credentials), http.clone());
    let grant = Credentials.authorization().unwrap();
    let cancelled = CancellationSource::new();
    std::thread::scope(|scope| {
        let pending = scope.spawn(|| {
            read(
                &provider,
                grant.clone(),
                ManagedSettingsReadMode::Automatic,
                &cancelled.token(),
            )
        });
        started
            .recv_timeout(std::time::Duration::from_secs(5))
            .unwrap();
        cancelled.cancel();
        release.send(()).unwrap();
        assert_eq!(pending.join().unwrap(), Err(Error::Cancelled));
    });
    let source = CancellationSource::new();
    assert!(matches!(
        read(
            &provider,
            grant,
            ManagedSettingsReadMode::Automatic,
            &source.token()
        )
        .unwrap()
        .refresh,
        ManagedSettingsRefresh::Ready { .. }
    ));
    assert_eq!(http.requests.load(std::sync::atomic::Ordering::SeqCst), 2);
}

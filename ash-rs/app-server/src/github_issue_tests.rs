use super::*;
use crate::tests::call;
use crate::tests::initialize;
use crate::tests::server;
use github::GitHubAuthorization;
use github::GitHubCredentialProvider;

struct Credentials(Mutex<Option<GitHubAuthorization>>);

impl GitHubCredentialProvider for Credentials {
    fn authorization(&self) -> Result<GitHubAuthorization, ash_login::LoginError> {
        self.0.lock().unwrap().clone().ok_or_else(|| {
            ash_login::LoginError::new(
                ash_login::LoginErrorKind::ExternalLoginRequired,
                "GitHub authentication is required",
            )
        })
    }

    fn token(
        &self,
        authorization: &GitHubAuthorization,
    ) -> Result<ash_secrets::SecretValue, ash_login::LoginError> {
        if self.authorization()? != *authorization {
            return Err(ash_login::LoginError::new(
                ash_login::LoginErrorKind::ExternalLoginRequired,
                "GitHub authorization changed",
            ));
        }
        Ok(ash_secrets::SecretValue::new(
            b"fixture-only-token".to_vec(),
        ))
    }
}

fn issue_server(root: &std::path::Path, origin: &str) -> AppServer {
    for arguments in [
        vec!["init", "--quiet"],
        vec!["remote", "add", "origin", origin],
    ] {
        let output = std::process::Command::new("git")
            .current_dir(root)
            .args(arguments)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let mut server = server().with_config_store(Arc::new(
        ConfigStore::open(root.join("config.sqlite3")).unwrap(),
    ));
    server.issue_runtime = Some(crate::server::issue_runtime::IssueRuntime::open(root).unwrap());
    server.issue_cache = Some(Arc::new(Mutex::new(
        ash_state::SqliteIssueCache::open(&root.join("state.sqlite3")).unwrap(),
    )));
    server
}

#[test]
fn issue_rpc_reads_only_the_current_accounts_cache_and_rejects_revoked_credentials() {
    let directory = tempfile::tempdir().unwrap();
    let first = GitHubAuthorization {
        host: "github.com".into(),
        account_id: "42".into(),
        grant_id: "grant-a".into(),
    };
    let second = GitHubAuthorization {
        account_id: "43".into(),
        grant_id: "grant-b".into(),
        ..first.clone()
    };
    let credentials = Arc::new(Credentials(Mutex::new(Some(first.clone()))));
    let server = issue_server(directory.path(), "https://github.com/team/repo.git")
        .with_github_credentials(credentials.clone());
    let repository =
        github::Repository::new("github.com".into(), "team".into(), "repo".into()).unwrap();
    let now = SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs();
    for (authorization, number) in [(&first, 1), (&second, 2)] {
        server
            .issue_cache
            .as_ref()
            .unwrap()
            .lock()
            .unwrap()
            .write(
                &ash_state::IssueCacheKey {
                    authorization,
                    repository: &repository,
                    state: "open",
                    query: "",
                    page: 1,
                },
                &github::IssuePage {
                    issues: vec![github::Issue {
                        labels: vec![],
                        assignees: vec![],
                        number,
                        title: format!("Private issue {number}"),
                        body: None,
                        html_url: format!("https://github.com/team/repo/issues/{number}"),
                        updated_at: "now".into(),
                        state: "open".into(),
                        pull_request: None,
                    }],
                    next_page: None,
                    notice: String::new(),
                },
                now,
            )
            .unwrap();
    }
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let mut request = serde_json::json!({"jsonrpc":"2.0","id":2,"method":"issue/list","params":{"state":"open","page":1,"query":"","mode":"cached"}});
    let initial = call(&server, &mut connection, request.clone());
    assert_eq!(initial["result"]["issues"][0]["number"], 1);
    assert_eq!(initial["result"]["cached"], true);
    *credentials.0.lock().unwrap() = Some(second);
    request["id"] = serde_json::json!(3);
    let selected = call(&server, &mut connection, request.clone());
    assert_eq!(selected["result"]["issues"][0]["number"], 2);
    *credentials.0.lock().unwrap() = None;
    request["id"] = serde_json::json!(4);
    let revoked = call(&server, &mut connection, request);
    assert_eq!(revoked["error"]["message"], "AccountAuthenticationRequired");
    assert!(revoked.get("result").is_none());
    assert!(!format!("{initial}{selected}{revoked}").contains("fixture-only-token"));
}

#[test]
fn issue_rpc_without_github_configuration_reports_account_unavailable_before_cache_access() {
    let directory = tempfile::tempdir().unwrap();
    let server = issue_server(directory.path(), "https://github.com/team/repo.git");
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let reply = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"issue/list","params":{"state":"open","page":1,"query":"","mode":"cached"}}),
    );
    assert_eq!(reply["error"]["message"], "AccountUnavailable");
}

struct ReporterHttp {
    requests: Mutex<Vec<ash_http_client::HttpRequest>>,
    status: std::sync::atomic::AtomicU16,
}

impl ReporterHttp {
    fn new() -> Self {
        Self {
            requests: Mutex::new(vec![]),
            status: std::sync::atomic::AtomicU16::new(0),
        }
    }
}

impl ash_http_client::HttpClient for ReporterHttp {
    fn execute(
        &self,
        request: &ash_http_client::HttpRequest,
    ) -> Result<ash_http_client::HttpResponse, ash_http_client::HttpClientError> {
        use ash_http_client::HttpMethod;
        self.requests.lock().unwrap().push(request.clone());
        let issue = serde_json::json!({"number":7,"html_url":"https://github.com/chogng/ash/issues/7","title":"Report title","state":"open"});
        let status = self.status.load(std::sync::atomic::Ordering::SeqCst);
        let (status, body) = if status != 0 {
            (status, serde_json::json!({"message":"fixture-only-token"}))
        } else if request.method() == HttpMethod::Get {
            (200, serde_json::json!({"items":[issue]}))
        } else {
            (201, issue)
        };
        Ok(ash_http_client::HttpResponse::new(
            status,
            vec![],
            serde_json::to_vec(&body).unwrap(),
        ))
    }
}

#[test]
fn reporter_rpc_searches_anonymously_and_submits_with_ash_authorization_to_the_product_target() {
    let http = Arc::new(ReporterHttp::new());
    let credentials = Arc::new(Credentials(Mutex::new(None)));
    let server = server()
        .with_github_credentials(credentials.clone())
        .with_issue_reporter(
            github::GitHubIssueReporter::new("https://github.com/chogng/ash/issues", http.clone())
                .unwrap(),
        );
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let context = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"issueReporter/read","params":{}}),
    );
    assert_eq!(
        context["result"]["reportIssueUrl"],
        "https://github.com/chogng/ash/issues"
    );
    let search = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"issueReporter/search","params":{"title":"Editor search bug","operationId":"search-1"}}),
    );
    assert_eq!(search["result"]["issues"][0]["number"], 7);
    {
        let requests = http.requests.lock().unwrap();
        assert_eq!(requests.len(), 1);
        assert!(
            requests[0]
                .headers()
                .iter()
                .all(|header| header.name() != "Authorization")
        );
        assert!(requests[0].rejects_redirects());
        let url = url::Url::parse(requests[0].url()).unwrap();
        assert_eq!(
            url.query_pairs().find(|(key, _)| key == "q").unwrap().1,
            "repo:chogng/ash is:issue Editor search bug in:title"
        );
    }
    let mut submit = serde_json::json!({"jsonrpc":"2.0","id":4,"method":"issueReporter/submit","params":{"title":"Report title","body":"Steps to reproduce"}});
    let signed_out = call(&server, &mut connection, submit.clone());
    assert_eq!(
        signed_out["error"]["message"],
        "AccountAuthenticationRequired"
    );
    assert_eq!(http.requests.lock().unwrap().len(), 1);
    *credentials.0.lock().unwrap() = Some(GitHubAuthorization {
        host: "github.com".into(),
        account_id: "42".into(),
        grant_id: "fixture-grant".into(),
    });
    submit["id"] = serde_json::json!(5);
    let created = call(&server, &mut connection, submit.clone());
    assert_eq!(
        created["result"]["url"],
        "https://github.com/chogng/ash/issues/7"
    );
    {
        let requests = http.requests.lock().unwrap();
        assert_eq!(requests.len(), 2);
        assert_eq!(
            requests[1].url(),
            "https://api.github.com/repos/chogng/ash/issues"
        );
        assert!(
            requests[1]
                .headers()
                .iter()
                .any(|header| header.name() == "Authorization"
                    && header.value() == "Bearer fixture-only-token")
        );
        assert_eq!(
            serde_json::from_slice::<serde_json::Value>(requests[1].body()).unwrap(),
            submit["params"]
        );
        assert!(!format!("{:?}", requests[1]).contains("fixture-only-token"));
    }
    for (id, status, error) in [
        (6, 401, "AccountAuthenticationRequired"),
        (7, 403, "IssueReporterPermissionDenied"),
        (8, 429, "IssueReporterRateLimited"),
        (9, 502, "IssueReporterSubmissionUncertain"),
    ] {
        http.status
            .store(status, std::sync::atomic::Ordering::SeqCst);
        submit["id"] = serde_json::json!(id);
        let response = call(&server, &mut connection, submit.clone());
        assert_eq!(response["error"]["message"], error);
        assert!(!response.to_string().contains("fixture-only-token"));
    }
}

#[test]
fn gitlab_workspace_rejects_github_issue_browsing_but_can_report_product_issues() {
    let directory = tempfile::tempdir().unwrap();
    let http = Arc::new(ReporterHttp::new());
    let credentials = Arc::new(Credentials(Mutex::new(None)));
    let server = issue_server(directory.path(), "https://gitlab.com/team/repo.git")
        .with_github_credentials(credentials.clone())
        .with_issue_reporter(
            github::GitHubIssueReporter::new("https://github.com/chogng/ash/issues", http.clone())
                .unwrap(),
        );
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    for request in [
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"issue/list","params":{"state":"open","page":1,"query":"","mode":"cached"}}),
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"issue/read","params":{"repository":{"host":"gitlab.com","owner":"team","name":"repo"},"number":7}}),
    ] {
        let response = call(&server, &mut connection, request);
        assert_eq!(response["error"]["data"]["kind"], "IssueOperationFailed");
        assert_eq!(
            response["error"]["message"],
            "IssueOperationFailed: GitHub issue management requires a GitHub.com origin remote"
        );
    }
    assert!(http.requests.lock().unwrap().is_empty());
    let context = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":4,"method":"issueReporter/read","params":{}}),
    );
    assert_eq!(
        context["result"]["reportIssueUrl"],
        "https://github.com/chogng/ash/issues"
    );
    let search = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":5,"method":"issueReporter/search","params":{"title":"Editor bug","operationId":"gitlab-workspace-report-search"}}),
    );
    assert_eq!(search["result"]["issues"][0]["number"], 7);
    *credentials.0.lock().unwrap() = Some(GitHubAuthorization {
        host: "github.com".into(),
        account_id: "42".into(),
        grant_id: "fixture-grant".into(),
    });
    let created = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":6,"method":"issueReporter/submit","params":{"title":"Report title","body":"Steps to reproduce"}}),
    );
    assert_eq!(
        created["result"]["url"],
        "https://github.com/chogng/ash/issues/7"
    );
    let requests = http.requests.lock().unwrap();
    assert_eq!(requests.len(), 2);
    let url = url::Url::parse(requests[0].url()).unwrap();
    assert_eq!(
        url.query_pairs().find(|(key, _)| key == "q").unwrap().1,
        "repo:chogng/ash is:issue Editor bug in:title"
    );
    assert_eq!(
        requests[1].url(),
        "https://api.github.com/repos/chogng/ash/issues"
    );
}

#[test]
fn reporter_cancel_before_search_stops_io_and_has_a_terminal_cancelled_response() {
    let http = Arc::new(ReporterHttp::new());
    let server = server().with_issue_reporter(
        github::GitHubIssueReporter::new("https://github.com/chogng/ash/issues", http.clone())
            .unwrap(),
    );
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let cancel = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"issueReporter/search/cancel","params":{"operationId":"cancelled-search"}}),
    );
    assert_eq!(cancel["result"]["status"], "requested");
    let search = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"issueReporter/search","params":{"title":"Editor bug","operationId":"cancelled-search"}}),
    );
    assert_eq!(search["error"]["message"], "RequestCancelled");
    assert!(http.requests.lock().unwrap().is_empty());
}

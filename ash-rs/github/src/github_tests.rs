use super::*;
use ash_async_utils::CancellationSource;
use ash_http_client::HttpClientError;
use ash_http_client::HttpHeader;
use ash_http_client::HttpRequest;
use ash_http_client::HttpResponse;
use std::collections::VecDeque;
use std::sync::Mutex;

pub(super) struct Credentials;
impl GitHubCredentialProvider for Credentials {
    fn authorization(&self) -> std::result::Result<GitHubAuthorization, ash_login::LoginError> {
        Ok(GitHubAuthorization {
            host: "github.com".into(),
            account_id: "42".into(),
            grant_id: "test-grant".into(),
        })
    }
    fn token(
        &self,
        grant: &GitHubAuthorization,
    ) -> std::result::Result<ash_secrets::SecretValue, ash_login::LoginError> {
        assert_eq!(grant, &self.authorization()?);
        Ok(ash_secrets::SecretValue::new(b"ash-test-token".to_vec()))
    }
}

#[derive(Default)]
pub(super) struct FakeHttp {
    pub responses: Mutex<VecDeque<std::result::Result<HttpResponse, HttpClientError>>>,
    pub requests: Mutex<Vec<HttpRequest>>,
}
impl FakeHttp {
    pub fn push(&self, status: u16, body: serde_json::Value) {
        self.responses
            .lock()
            .unwrap()
            .push_back(Ok(HttpResponse::new(
                status,
                vec![],
                serde_json::to_vec(&body).unwrap(),
            )));
    }
}
impl HttpClient for FakeHttp {
    fn execute(&self, request: &HttpRequest) -> std::result::Result<HttpResponse, HttpClientError> {
        self.requests.lock().unwrap().push(request.clone());
        self.responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected GitHub request")
    }
}
pub(super) fn github(http: Arc<dyn HttpClient>) -> GitHub {
    GitHub::for_account(
        Arc::new(Credentials),
        http,
        CancellationSource::new().token(),
    )
    .unwrap()
}
pub(super) fn repository() -> Repository {
    Repository::new("github.com".into(), "team".into(), "repo".into()).unwrap()
}

#[tokio::test(flavor = "current_thread")]
async fn pr_files_report_the_remote_limit_instead_of_claiming_a_complete_diff() {
    let http = Arc::new(FakeHttp::default());
    http.push(200, json!((0..100).map(|i| json!({"filename":format!("file-{i}.rs"),"status":"modified","additions":1,"deletions":0,"changes":1})).collect::<Vec<_>>()));
    let client = github(http.clone());
    let page = client
        .pull_request_files(&repository(), 7, 30)
        .await
        .unwrap();
    assert!(page.limit_reached);
    assert_eq!(page.next_page, None);
    assert_eq!(page.files.len(), 100);
    assert!(matches!(
        client.pull_request_files(&repository(), 7, 31).await,
        Err(Error::InvalidInput(_))
    ));
    assert_eq!(http.requests.lock().unwrap().len(), 1);
}
pub(super) fn issue(number: u64) -> serde_json::Value {
    json!({"number":number,"node_id":format!("issue{number}"),"title":"Fix it","body":"details","html_url":format!("https://github.com/team/repo/issues/{number}"),"updated_at":"now","state":"open"})
}
pub(super) fn pull_request() -> PullRequest {
    PullRequest {
        number: 7,
        node_id: "pr7".into(),
        title: "Fix it".into(),
        body: Some("details".into()),
        html_url: "https://github.com/team/repo/pull/7".into(),
        state: "open".into(),
        draft: false,
        merged_at: None,
        auto_merge: None,
        head: PullRequestBranch {
            name: "feature".into(),
            sha: "a".repeat(40),
        },
        base: PullRequestBranch {
            name: "main".into(),
            sha: "b".repeat(40),
        },
    }
}

#[test]
fn repository_identity_rejects_paths_and_option_injection() {
    for value in ["", "../repo", "-repo", "a/b", "repo?x=y", "a\nb", "a b"] {
        assert!(Repository::new("github.com".into(), "owner".into(), value.into()).is_err());
    }
    assert_eq!(repository().endpoint("issues"), "repos/team/repo/issues");
}

#[tokio::test(flavor = "current_thread")]
async fn requests_bind_the_ash_grant_and_reject_redirects() {
    let http = Arc::new(FakeHttp::default());
    http.push(200, json!([]));
    let page = github(http.clone())
        .issues(&repository(), IssueState::Open, 1)
        .await
        .unwrap();
    assert!(page.issues.is_empty());
    let requests = http.requests.lock().unwrap();
    let request = &requests[0];
    assert_eq!(
        request.url(),
        "https://api.github.com/repos/team/repo/issues?state=open&sort=updated&direction=desc&per_page=100&page=1"
    );
    assert_eq!(request.method(), HttpMethod::Get);
    assert!(request.rejects_redirects());
    assert!(request.headers().iter().any(
        |header| header.name() == "Authorization" && header.value() == "Bearer ash-test-token"
    ));
    assert!(!format!("{request:?}").contains("ash-test-token"));
}

#[tokio::test(flavor = "current_thread")]
async fn http_refusals_remain_structured_and_redacted() {
    for (status, headers, expected) in [
        (401, vec![], Error::AuthenticationRequired),
        (403, vec![], Error::PermissionDenied),
        (
            403,
            vec![HttpHeader::new("Retry-After", "60")],
            Error::RateLimited,
        ),
        (
            403,
            vec![HttpHeader::new("X-RateLimit-Remaining", "0")],
            Error::RateLimited,
        ),
        (404, vec![], Error::NotFound),
        (429, vec![], Error::RateLimited),
    ] {
        let http = Arc::new(FakeHttp::default());
        http.responses
            .lock()
            .unwrap()
            .push_back(Ok(HttpResponse::new(
                status,
                headers,
                b"private-token".to_vec(),
            )));
        assert_eq!(
            github(http)
                .issues(&repository(), IssueState::Open, 1)
                .await,
            Err(expected)
        );
    }
}

#[tokio::test(flavor = "current_thread")]
async fn invalid_input_and_cancelled_operations_do_not_send_requests() {
    let http = Arc::new(FakeHttp::default());
    let client = github(http.clone());
    assert!(matches!(
        client.issues(&repository(), IssueState::Open, 0).await,
        Err(Error::InvalidInput(_))
    ));
    assert!(matches!(
        client.issue(&repository(), 0).await,
        Err(Error::InvalidInput(_))
    ));
    assert_eq!(
        client
            .issue_metadata(
                &Repository::new("other.example".into(), "team".into(), "repo".into()).unwrap(),
                1
            )
            .await,
        Err(Error::AuthenticationRequired)
    );
    let source = CancellationSource::new();
    source.cancel();
    let client = GitHub::for_account(Arc::new(Credentials), http.clone(), source.token()).unwrap();
    assert_eq!(
        client.issues(&repository(), IssueState::Open, 1).await,
        Err(Error::Cancelled)
    );
    assert!(http.requests.lock().unwrap().is_empty());
}

#[tokio::test(flavor = "current_thread")]
async fn issue_reader_excludes_prs_and_reads_every_comment_page() {
    let http = Arc::new(FakeHttp::default());
    let mut pr = issue(4);
    pr["pull_request"] = json!({});
    http.push(200, json!([issue(3), pr]));
    http.push(200, issue(3));
    http.push(
        200,
        json!(vec![
            json!({"id":1,"body":"comment","html_url":"comment-url","updated_at":"now"});
            100
        ]),
    );
    http.push(200, json!([]));
    let client = github(http.clone());
    let page = client
        .issues(&repository(), IssueState::Open, 1)
        .await
        .unwrap();
    assert_eq!(
        page.issues
            .iter()
            .map(|issue| issue.number)
            .collect::<Vec<_>>(),
        [3]
    );
    let snapshot = client.issue(&repository(), 3).await.unwrap();
    assert_eq!(snapshot.comments.len(), 100);
    assert_eq!(snapshot.issue.body.as_deref(), Some("details"));
    assert!(http.requests.lock().unwrap()[3].url().ends_with("page=2"));
}

#[tokio::test(flavor = "current_thread")]
async fn issue_pagination_continues_after_a_full_page_of_pull_requests() {
    let http = Arc::new(FakeHttp::default());
    let mut pr = issue(1);
    pr["pull_request"] = json!({});
    http.push(200, json!(vec![pr; 100]));
    let page = github(http)
        .issues(&repository(), IssueState::Open, 25)
        .await
        .unwrap();
    assert!(page.issues.is_empty());
    assert_eq!(page.next_page, Some(26));
}

#[tokio::test(flavor = "current_thread")]
async fn issue_search_encodes_keywords_handles_numbers_and_reports_limits() {
    let http = Arc::new(FakeHttp::default());
    http.push(
        200,
        json!({"items":[issue(5001)],"total_count":1250,"incomplete_results":false}),
    );
    http.push(200, issue(5001));
    let client = github(http.clone());
    let page = client
        .search_issues(&repository(), IssueState::Open, "memory leak &", 1)
        .await
        .unwrap();
    assert_eq!(page.next_page, Some(2));
    assert!(page.notice.contains("1000"));
    let endpoint = http.requests.lock().unwrap()[0].url().to_owned();
    let url = url::Url::parse(&endpoint).unwrap();
    assert_eq!(
        url.query_pairs().find(|(key, _)| key == "q").unwrap().1,
        "repo:team/repo is:issue state:open in:title,body \"memory\" \"leak\" \"&\""
    );
    assert_eq!(
        client
            .search_issues(&repository(), IssueState::Open, "#5001", 1)
            .await
            .unwrap()
            .issues[0]
            .number,
        5001
    );
    for query in ["#0", "#abc", "x\" repo:other", "x\nrepo:other"] {
        assert!(matches!(
            client
                .search_issues(&repository(), IssueState::Open, query, 1)
                .await,
            Err(Error::InvalidInput(_))
        ));
    }
    let mut foreign = issue(9);
    foreign["html_url"] = json!("https://github.com/other/repo/issues/9");
    http.push(
        200,
        json!({"items":[foreign],"total_count":1,"incomplete_results":false}),
    );
    assert!(matches!(
        client
            .search_issues(&repository(), IssueState::Open, "memory", 1)
            .await,
        Err(Error::InvalidResponse(_))
    ));
}

#[tokio::test(flavor = "current_thread")]
async fn auto_merge_is_an_explicit_mutation_bound_to_the_reviewed_head() {
    let http = Arc::new(FakeHttp::default());
    let pr = pull_request();
    for (method, name) in [
        (MergeMethod::Merge, "MERGE"),
        (MergeMethod::Squash, "SQUASH"),
        (MergeMethod::Rebase, "REBASE"),
    ] {
        http.push(200,json!({"data":{"enablePullRequestAutoMerge":{"pullRequest":{"id":pr.node_id,"headRefOid":pr.head.sha,"autoMergeRequest":{"mergeMethod":name}}}}}));
        github(http.clone())
            .enable_auto_merge(&repository(), &pr, method)
            .await
            .unwrap();
        let request = http.requests.lock().unwrap().last().unwrap().clone();
        assert_eq!(request.url(), "https://api.github.com/graphql");
        let body: serde_json::Value = serde_json::from_slice(request.body()).unwrap();
        assert_eq!(body["variables"]["input"]["expectedHeadOid"], pr.head.sha);
        assert_eq!(body["variables"]["input"]["mergeMethod"], name);
    }
    let mut draft = pr;
    draft.draft = true;
    assert!(matches!(
        github(http.clone())
            .enable_auto_merge(&repository(), &draft, MergeMethod::Merge)
            .await,
        Err(Error::InvalidInput(_))
    ));
    assert_eq!(http.requests.lock().unwrap().len(), 3);
}

#[tokio::test(flavor = "current_thread")]
async fn write_transport_failure_is_uncertain_and_never_retried() {
    let http = Arc::new(FakeHttp::default());
    http.responses
        .lock()
        .unwrap()
        .push_back(Err(HttpClientError::Transport("private-token".into())));
    let error = github(http.clone())
        .create_pull_request(
            &repository(),
            CreatePullRequest {
                title: "Fix it",
                body: "details",
                head: "feature",
                base: "main",
                draft: false,
            },
        )
        .await
        .unwrap_err();
    assert_eq!(error, Error::SubmissionUncertain);
    assert_eq!(http.requests.lock().unwrap().len(), 1);
}

struct RevokedCredentials;
impl GitHubCredentialProvider for RevokedCredentials {
    fn authorization(&self) -> std::result::Result<GitHubAuthorization, ash_login::LoginError> {
        Credentials.authorization()
    }
    fn token(
        &self,
        _: &GitHubAuthorization,
    ) -> std::result::Result<ash_secrets::SecretValue, ash_login::LoginError> {
        Err(ash_login::LoginError::new(
            ash_login::LoginErrorKind::ExternalLoginRequired,
            "private-token",
        ))
    }
}
#[tokio::test(flavor = "current_thread")]
async fn authorization_revoked_after_client_creation_remains_an_authentication_error() {
    let http = Arc::new(FakeHttp::default());
    let client = GitHub::for_account(
        Arc::new(RevokedCredentials),
        http.clone(),
        CancellationSource::new().token(),
    )
    .unwrap();
    assert_eq!(
        client.issues(&repository(), IssueState::Open, 1).await,
        Err(Error::AuthenticationRequired)
    );
    assert!(http.requests.lock().unwrap().is_empty());
}

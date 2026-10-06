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
        .with_github_credentials(credentials.clone(), Arc::new(ReporterHttp::new()))
        .unwrap();
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
    let mut request = serde_json::json!({"jsonrpc":"2.0","id":2,"method":"issue/list","params":{"operationId":"issue-operation","state":"open","page":1,"query":"","mode":"cached"}});
    let initial = call(&server, &mut connection, request.clone());
    assert_eq!(initial["result"]["issues"][0]["number"], 1);
    assert_eq!(initial["result"]["cached"], true);
    *credentials.0.lock().unwrap() = Some(second);
    request["id"] = serde_json::json!(3);
    request["params"]["operationId"] = serde_json::json!("issue-operation-3");
    let selected = call(&server, &mut connection, request.clone());
    assert_eq!(selected["result"]["issues"][0]["number"], 2);
    *credentials.0.lock().unwrap() = None;
    request["id"] = serde_json::json!(4);
    request["params"]["operationId"] = serde_json::json!("issue-operation-4");
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
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"issue/list","params":{"operationId":"issue-operation","state":"open","page":1,"query":"","mode":"cached"}}),
    );
    assert_eq!(reply["error"]["message"], "AccountUnavailable");
}

struct ExpiredCredentials;

impl GitHubCredentialProvider for ExpiredCredentials {
    fn authorization(&self) -> Result<GitHubAuthorization, ash_login::LoginError> {
        Ok(GitHubAuthorization {
            host: "github.com".into(),
            account_id: "42".into(),
            grant_id: "expired-grant".into(),
        })
    }

    fn token(
        &self,
        _: &GitHubAuthorization,
    ) -> Result<ash_secrets::SecretValue, ash_login::LoginError> {
        Err(ash_login::LoginError::new(
            ash_login::LoginErrorKind::ExternalLoginRequired,
            "fixture-only-token",
        ))
    }
}

#[test]
fn issue_rpc_preserves_authentication_failure_during_repository_io() {
    let directory = tempfile::tempdir().unwrap();
    let server = issue_server(directory.path(), "https://github.com/team/repo.git")
        .with_github_credentials(Arc::new(ExpiredCredentials), Arc::new(ReporterHttp::new()))
        .unwrap();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    for (id, method, params) in [
        (
            2,
            "issue/list",
            serde_json::json!({"operationId":"issue-list-operation","state":"open","page":1,"query":"","mode":"refresh"}),
        ),
        (
            3,
            "issue/read",
            serde_json::json!({"operationId":"issue-read-operation","repository":{"host":"github.com","owner":"team","name":"repo"},"number":7}),
        ),
    ] {
        let response = call(
            &server,
            &mut connection,
            serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
        );
        assert_eq!(
            response["error"]["data"]["kind"],
            "AccountAuthenticationRequired"
        );
        assert_eq!(response["error"]["code"], -32030);
        assert!(response.get("result").is_none());
        assert!(!response.to_string().contains("fixture-only-token"));
    }
}

struct ReporterHttp {
    requests: Mutex<Vec<ash_http_client::HttpRequest>>,
    status: std::sync::atomic::AtomicU16,
}

#[derive(Default)]
struct RepositoryHttp {
    requests: Mutex<Vec<ash_http_client::HttpRequest>>,
    replies: Mutex<
        std::collections::VecDeque<
            Result<ash_http_client::HttpResponse, ash_http_client::HttpClientError>,
        >,
    >,
}
impl RepositoryHttp {
    fn reply(&self, status: u16, body: serde_json::Value) {
        self.replies
            .lock()
            .unwrap()
            .push_back(Ok(ash_http_client::HttpResponse::new(
                status,
                vec![],
                serde_json::to_vec(&body).unwrap(),
            )));
    }
}
impl ash_http_client::HttpClient for RepositoryHttp {
    fn execute(
        &self,
        request: &ash_http_client::HttpRequest,
    ) -> Result<ash_http_client::HttpResponse, ash_http_client::HttpClientError> {
        self.requests.lock().unwrap().push(request.clone());
        self.replies
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected repository request")
    }
}
fn repository_credentials() -> Arc<Credentials> {
    Arc::new(Credentials(Mutex::new(Some(GitHubAuthorization {
        host: "github.com".into(),
        account_id: "42".into(),
        grant_id: "repository-tests".into(),
    }))))
}

#[test]
fn github_account_rpc_connects_without_oauth_selects_host_credentials_and_logs_out_one_account() {
    let http = Arc::new(RepositoryHttp::default());
    let accounts = github::GitHubOAuth::tokens(
        http.clone(),
        Arc::new(ash_secrets::MemorySecretStore::default()),
    );
    let login = Arc::new(ash_login::LoginService::deferred(accounts.clone()));
    accounts.install_login_service(&login).unwrap();
    let server = server()
        .with_login_service(login)
        .with_github_accounts(accounts.clone())
        .with_github_credentials(accounts, http.clone())
        .unwrap();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    for (id, host, token) in [
        (2, "github.com", "fixture-cloud"),
        (3, "ghe.example", "fixture-enterprise"),
    ] {
        http.reply(200, serde_json::json!({"id":42,"login":host}));
        let reply = call(
            &server,
            &mut connection,
            serde_json::json!({"jsonrpc":"2.0","id":id,"method":"github/account/connect","params":{"operationId":format!("connect-{id}"),"host":host,"token":token}}),
        );
        assert_eq!(reply["result"]["host"], host);
        assert!(!reply.to_string().contains(token));
    }
    let catalog = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":4,"method":"github/account/list","params":{"operationId":"catalog"}}),
    );
    assert_eq!(catalog["result"]["accounts"].as_array().unwrap().len(), 2);
    assert_eq!(catalog["result"]["accounts"][0]["id"], "42");
    http.reply(200, serde_json::json!({"node_id":"repository","full_name":"team/repo","default_branch":"main","allow_merge_commit":true,"allow_squash_merge":true,"allow_rebase_merge":false,"allow_auto_merge":false}));
    let selected = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":5,"method":"github/repository/read","params":{"operationId":"enterprise-read","accountId":"ghe.example/42","repository":{"host":"ghe.example","owner":"team","name":"repo"}}}),
    );
    assert_eq!(selected["result"]["fullName"], "team/repo");
    let requests = http.requests.lock().unwrap();
    assert_eq!(
        requests[2].url(),
        "https://ghe.example/api/v3/repos/team/repo"
    );
    assert!(
        requests[2]
            .headers()
            .iter()
            .any(|header| header.name().eq_ignore_ascii_case("authorization")
                && header.value() == "Bearer fixture-enterprise")
    );
    drop(requests);
    let foreign = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":6,"method":"github/repository/read","params":{"operationId":"foreign-host","accountId":"42","repository":{"host":"ghe.example","owner":"team","name":"repo"}}}),
    );
    assert_eq!(
        foreign["error"]["data"]["kind"],
        "AccountAuthenticationRequired"
    );
    assert_eq!(http.requests.lock().unwrap().len(), 3);
    let logout = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":7,"method":"account/logout","params":{"provider":"github","accountId":"42"}}),
    );
    assert_eq!(logout["result"]["status"], "loggedOut");
    let remaining = call(
        &server,
        &mut connection,
        serde_json::json!({"jsonrpc":"2.0","id":8,"method":"github/account/list","params":{"operationId":"remaining"}}),
    );
    assert_eq!(remaining["result"]["accounts"].as_array().unwrap().len(), 1);
    assert_eq!(remaining["result"]["accounts"][0]["id"], "ghe.example/42");
}

struct CancelledRepositoryHttp {
    entered: std::sync::mpsc::Sender<()>,
    confirmed: bool,
}
impl ash_http_client::HttpClient for CancelledRepositoryHttp {
    fn execute(
        &self,
        _: &ash_http_client::HttpRequest,
    ) -> Result<ash_http_client::HttpResponse, ash_http_client::HttpClientError> {
        panic!("repository requests must use cancellable HTTP")
    }
    fn execute_with_cancellation(
        &self,
        _: &ash_http_client::HttpRequest,
        token: &ash_async_utils::CancellationToken,
    ) -> Result<ash_http_client::HttpResponse, ash_http_client::HttpClientError> {
        self.entered.send(()).unwrap();
        futures::executor::block_on(token.cancelled());
        if self.confirmed {
            Ok(ash_http_client::HttpResponse::new(201, vec![], serde_json::to_vec(&serde_json::json!({"id":9,"body":"Comment","html_url":"https://github.com/team/repo/issues/7#issuecomment-9","updated_at":"now"})).unwrap()))
        } else {
            Err(ash_http_client::HttpClientError::Transport(
                "connection closed".into(),
            ))
        }
    }
}

#[test]
fn github_stream_cancellation_keeps_the_domains_final_write_outcome() {
    use crate::server::request_dispatch::tests::Client;
    use serde_json::json;
    for (method, confirmed, expected_error) in [
        ("github/comment/create", true, None),
        (
            "github/comment/create",
            false,
            Some("GitHubSubmissionUncertain"),
        ),
        ("github/labels/list", false, Some("RequestCancelled")),
        ("github/commit/read", false, Some("RequestCancelled")),
    ] {
        let (entered, started) = std::sync::mpsc::channel();
        let backend = Arc::new(
            server()
                .with_github_credentials(
                    repository_credentials(),
                    Arc::new(CancelledRepositoryHttp { entered, confirmed }),
                )
                .unwrap(),
        );
        let serving = backend.clone();
        let (mut client, host) = Client::pair();
        let served = std::thread::spawn(move || {
            serving
                .serve_product_host_stream(std::io::BufReader::new(host.try_clone().unwrap()), host)
        });
        client.initialize();
        client.send(2, method, if method == "github/comment/create" {
            json!({"operationId":"cancelled","repository":{"host":"github.com","owner":"team","name":"repo"},"number":7,"body":"Comment"})
        } else if method == "github/commit/read" {
            json!({"operationId":"cancelled","repository":{"host":"github.com","owner":"team","name":"repo"},"sha":"a".repeat(40)})
        } else {
            json!({"operationId":"cancelled","repository":{"host":"github.com","owner":"team","name":"repo"}})
        });
        started.recv_timeout(Duration::from_secs(3)).unwrap();
        client.send(3, "github/cancel", json!({"operationId":"cancelled"}));
        let mut replies = std::collections::BTreeMap::new();
        while replies.len() < 2 {
            let reply = client.read();
            if let Some(id) = reply["id"].as_u64() {
                replies.insert(id, reply);
            }
        }
        assert_eq!(replies[&3]["result"]["status"], "requested");
        if let Some(error) = expected_error {
            assert_eq!(replies[&2]["error"]["data"]["kind"], error);
        } else {
            assert_eq!(replies[&2]["result"]["id"], 9);
        }
        client.send(4, "model/list", json!({}));
        assert!(client.read()["result"].is_object());
        client.close();
        served.join().unwrap().unwrap();
    }
}
fn repository_request(
    server: &AppServer,
    connection: &mut ConnectionState,
    id: u32,
    method: &str,
    mut params: serde_json::Value,
) -> serde_json::Value {
    params["operationId"] = serde_json::json!(format!("operation-{id}"));
    params["repository"] = serde_json::json!({"host":"github.com","owner":"team","name":"repo"});
    call(
        server,
        connection,
        serde_json::json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
    )
}

#[test]
fn github_repository_rpc_supports_issue_and_pr_management_without_a_local_checkout() {
    use serde_json::json;
    let http = Arc::new(RepositoryHttp::default());
    let server = server()
        .with_github_credentials(repository_credentials(), http.clone())
        .unwrap();
    assert!(server.issue_runtime.is_none());
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let issue = json!({"number":7,"node_id":"issue7","title":"Issue","body":"Body","html_url":"https://github.com/team/repo/issues/7","updated_at":"now","state":"open"});
    let comment = json!({"id":9,"body":"Comment","html_url":"https://github.com/team/repo/issues/7#issuecomment-9","updated_at":"now"});
    let commit = "a".repeat(40);
    let pr = json!({"number":7,"node_id":"pr7","title":"PR","body":"Body","html_url":"https://github.com/team/repo/pull/7","state":"open","draft":false,"merged_at":null,"head":{"ref":"feature","sha":commit},"base":{"ref":"main","sha":"b".repeat(40)}});
    let review = json!({"id":10,"body":"Reviewed","state":"APPROVED","html_url":"https://github.com/team/repo/pull/7#pullrequestreview-10","commit_id":commit,"submitted_at":"now"});
    let review_comment = json!({"id":"comment1","body":"Reply","url":"https://github.com/team/repo/pull/7#discussion-1","author":{"login":"alice"},"viewerCanUpdate":true,"viewerCanDelete":true});
    let thread_parent = json!({"data":{"node":{"pullRequest":{"number":7,"repository":{"name":"repo","owner":{"login":"team"}}}}}});
    let thread_comments =
        json!({"nodes":[review_comment.clone()],"pageInfo":{"hasNextPage":false,"endCursor":null}});
    let thread = json!({"id":"thread1","path":"main.rs","line":1,"diffSide":"RIGHT","isResolved":false,"isOutdated":false,"viewerCanResolve":true,"comments":thread_comments.clone()});
    let label = json!({"name":"bug","color":"ff0000","node_id":"label1"});
    let repository = json!({"node_id":"repo1","default_branch":"main","full_name":"team/repo","allow_merge_commit":true,"allow_squash_merge":true,"allow_rebase_merge":false,"allow_auto_merge":true});
    let cases = vec![
        (
            "github/pullRequest/reviewers",
            json!({"number":7}),
            vec![json!({"users":[{"login":"alice"}],"teams":[{"slug":"core"}]})],
        ),
        (
            "github/pullRequest/reviewers/change",
            json!({"number":7,"change":"request","users":["alice"],"teams":["core"]}),
            vec![
                json!({"number":7,"requested_reviewers":[{"login":"alice"}],"requested_teams":[{"slug":"core"}]}),
            ],
        ),
        (
            "github/pullRequest/comment/update",
            json!({"number":7,"commentId":"comment1","body":"Updated"}),
            vec![
                thread_parent.clone(),
                json!({"data":{"updatePullRequestReviewComment":{"pullRequestReviewComment":review_comment.clone()}}}),
            ],
        ),
        (
            "github/pullRequest/comment/delete",
            json!({"number":7,"commentId":"comment1"}),
            vec![
                thread_parent.clone(),
                json!({"data":{"deletePullRequestReviewComment":{"clientMutationId":"comment1"}}}),
            ],
        ),
        ("github/repository/read", json!({}), vec![repository]),
        (
            "github/commit/read",
            json!({"sha":&commit[..7]}),
            vec![json!({
                "sha":commit, "html_url":format!("https://github.com/team/repo/commit/{commit}"),
                "commit": { "message":"Fix links\n\nDetails", "author":{"name":"Ada","date":"2026-10-03T00:00:00Z"}, "committer":{"name":"Alex","date":"2026-10-04T00:00:00Z"} },
                "stats":{"additions":12,"deletions":3}
            })],
        ),
        (
            "github/issue/list",
            json!({"state":"open","query":"","page":1}),
            vec![json!([issue.clone()])],
        ),
        (
            "github/issue/read",
            json!({"number":7}),
            vec![issue.clone(), json!([comment.clone()])],
        ),
        (
            "github/issue/create",
            json!({"title":"Issue","body":"Body","labels":[],"assignees":[]}),
            vec![issue.clone()],
        ),
        (
            "github/issue/update",
            json!({"number":7,"title":"Edited"}),
            vec![issue.clone(), issue.clone()],
        ),
        (
            "github/comment/list",
            json!({"number":7,"page":1}),
            vec![json!([comment.clone()])],
        ),
        (
            "github/comment/create",
            json!({"number":7,"body":"Comment"}),
            vec![comment.clone()],
        ),
        (
            "github/comment/update",
            json!({"commentId":9,"body":"Edited"}),
            vec![comment],
        ),
        (
            "github/comment/delete",
            json!({"commentId":9}),
            vec![serde_json::Value::Null],
        ),
        (
            "github/pullRequest/list",
            json!({"state":"open","page":1}),
            vec![json!([pr.clone()])],
        ),
        (
            "github/pullRequest/read",
            json!({"number":7}),
            vec![pr.clone()],
        ),
        (
            "github/pullRequest/create",
            json!({"title":"PR","body":"Body","head":"feature","base":"main","draft":false}),
            vec![pr.clone()],
        ),
        (
            "github/pullRequest/update",
            json!({"number":7,"state":"closed"}),
            vec![pr.clone()],
        ),
        (
            "github/pullRequest/files",
            json!({"number":7,"page":1}),
            vec![
                json!([{"filename":"main.rs","status":"modified","additions":1,"deletions":0,"changes":1}]),
            ],
        ),
        (
            "github/pullRequest/reviews",
            json!({"number":7,"page":1}),
            vec![json!([review.clone()])],
        ),
        (
            "github/pullRequest/review",
            json!({"number":7,"commit":commit,"event":"approve","body":"Reviewed"}),
            vec![pr.clone(), review],
        ),
        (
            "github/pullRequest/diff",
            json!({"number":7,"commit":commit,"page":1}),
            vec![
                pr.clone(),
                json!({"merge_base_commit":{"sha":"b".repeat(40)}}),
                json!([{"filename":"main.rs","status":"modified","additions":1,"deletions":1,"changes":2,"patch":"@@ -1 +1 @@\n-old\n+new"}]),
                pr.clone(),
            ],
        ),
        (
            "github/file/read",
            json!({"commit":commit,"path":"main.rs"}),
            vec![json!({"type":"file","size":4,"encoding":"base64","content":"bmV3Cg=="})],
        ),
        (
            "github/pullRequest/threads",
            json!({"number":7,"cursor":null}),
            vec![
                json!({"data":{"repository":{"pullRequest":{"reviewThreads":{"nodes":[thread],"pageInfo":{"hasNextPage":false,"endCursor":null}}}}}}),
            ],
        ),
        (
            "github/pullRequest/thread/read",
            json!({"number":7,"threadId":"thread1","cursor":null}),
            vec![
                thread_parent.clone(),
                json!({"data":{"node":{"comments":thread_comments}}}),
            ],
        ),
        (
            "github/pullRequest/thread/reply",
            json!({"number":7,"threadId":"thread1","body":"Reply"}),
            vec![
                thread_parent.clone(),
                json!({"data":{"addPullRequestReviewThreadReply":{"comment":review_comment}}}),
            ],
        ),
        (
            "github/pullRequest/thread/resolve",
            json!({"number":7,"threadId":"thread1","state":"resolved"}),
            vec![
                thread_parent,
                json!({"data":{"resolveReviewThread":{"thread":{"id":"thread1","isResolved":true}}}}),
            ],
        ),
        (
            "github/pullRequest/merge",
            json!({"number":7,"commit":commit,"method":"squash"}),
            vec![json!({"sha":"b".repeat(40),"merged":true,"message":"Merged"})],
        ),
        (
            "github/pullRequest/autoMerge",
            json!({"number":7,"commit":commit,"method":"squash"}),
            vec![
                pr,
                json!({"data":{"enablePullRequestAutoMerge":{"pullRequest":{"id":"pr7","headRefOid":commit,"autoMergeRequest":{"mergeMethod":"SQUASH"}}}}}),
            ],
        ),
        (
            "github/checks",
            json!({"commit":commit,"page":1}),
            vec![
                json!({"state":"success","statuses":[],"total_count":0}),
                json!({"check_runs":[],"total_count":0}),
            ],
        ),
        (
            "github/labels/list",
            json!({}),
            vec![json!([label.clone()])],
        ),
        (
            "github/label/create",
            json!({"name":"bug","color":"ff0000"}),
            vec![label.clone()],
        ),
        (
            "github/label/update",
            json!({"name":"bug","color":"ff0000"}),
            vec![label],
        ),
        (
            "github/assignees/list",
            json!({}),
            vec![json!([{"login":"owner"}])],
        ),
    ];
    for (index, (method, params, replies)) in cases.into_iter().enumerate() {
        for reply in replies {
            http.reply(200, reply);
        }
        let response =
            repository_request(&server, &mut connection, index as u32 + 2, method, params);
        assert!(response.get("result").is_some(), "{method}: {response}");
        if method == "github/commit/read" {
            assert_eq!(
                response["result"],
                json!({
                    "sha":commit, "url":format!("https://github.com/team/repo/commit/{commit}"),
                    "message":"Fix links\n\nDetails", "author":"Ada", "committedAt":"2026-10-04T00:00:00Z",
                    "additions":12, "deletions":3
                })
            );
        }
        assert!(
            http.replies.lock().unwrap().is_empty(),
            "{method} left unread responses"
        );
        assert!(!response.to_string().contains("fixture-only-token"));
    }
    let requests = http.requests.lock().unwrap();
    let merge = requests
        .iter()
        .find(|r| r.url().ends_with("/pulls/7/merge"))
        .unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(merge.body()).unwrap(),
        json!({"sha":commit,"merge_method":"squash"})
    );
}

#[test]
fn github_rpc_preserves_refusals_and_uncertain_writes_without_retrying() {
    use serde_json::json;
    let http = Arc::new(RepositoryHttp::default());
    let server = server()
        .with_github_credentials(repository_credentials(), http.clone())
        .unwrap();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    for (index, (status, error)) in [
        (401, "AccountAuthenticationRequired"),
        (403, "GitHubPermissionDenied"),
        (404, "GitHubNotFound"),
        (409, "GitHubConflict"),
        (429, "GitHubRateLimited"),
        (500, "GitHubSubmissionUncertain"),
    ]
    .into_iter()
    .enumerate()
    {
        http.reply(status, json!({"message":"fixture-only-token"}));
        let response = repository_request(
            &server,
            &mut connection,
            index as u32 + 2,
            "github/comment/create",
            json!({"number":7,"body":"Comment"}),
        );
        assert_eq!(response["error"]["data"]["kind"], error);
        assert!(!response.to_string().contains("fixture-only-token"));
        assert_eq!(http.requests.lock().unwrap().len(), index + 1);
    }
    http.replies
        .lock()
        .unwrap()
        .push_back(Err(ash_http_client::HttpClientError::Transport(
            "fixture-only-token".into(),
        )));
    let response = repository_request(
        &server,
        &mut connection,
        9,
        "github/comment/create",
        json!({"number":7,"body":"Comment"}),
    );
    assert_eq!(
        response["error"]["data"]["kind"],
        "GitHubSubmissionUncertain"
    );
    assert_eq!(http.requests.lock().unwrap().len(), 7);
}

#[test]
fn github_rpc_cancel_before_execution_stops_io() {
    use serde_json::json;
    let http = Arc::new(RepositoryHttp::default());
    let server = server()
        .with_github_credentials(repository_credentials(), http.clone())
        .unwrap();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    let cancel = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":2,"method":"github/cancel","params":{"operationId":"operation-3"}}),
    );
    assert_eq!(cancel["result"]["status"], "requested");
    let reply = repository_request(
        &server,
        &mut connection,
        3,
        "github/comment/create",
        json!({"number":7,"body":"Comment"}),
    );
    assert_eq!(reply["error"]["data"]["kind"], "RequestCancelled");
    assert!(http.requests.lock().unwrap().is_empty());
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
        .with_github_credentials(credentials.clone(), http.clone())
        .unwrap()
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
        .with_github_credentials(credentials.clone(), http.clone())
        .unwrap()
        .with_issue_reporter(
            github::GitHubIssueReporter::new("https://github.com/chogng/ash/issues", http.clone())
                .unwrap(),
        );
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    for request in [
        serde_json::json!({"jsonrpc":"2.0","id":2,"method":"issue/list","params":{"operationId":"issue-operation","state":"open","page":1,"query":"","mode":"cached"}}),
        serde_json::json!({"jsonrpc":"2.0","id":3,"method":"issue/read","params":{"operationId":"issue-read-operation","repository":{"host":"gitlab.com","owner":"team","name":"repo"},"number":7}}),
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

#[test]
fn stalled_github_reads_run_concurrently_without_blocking_queries_or_cancellation() {
    use crate::server::request_dispatch::tests::Client;
    use serde_json::json;
    let (entered, started) = std::sync::mpsc::channel();
    let backend = Arc::new(
        server()
            .with_github_credentials(
                repository_credentials(),
                Arc::new(CancelledRepositoryHttp {
                    entered,
                    confirmed: false,
                }),
            )
            .unwrap(),
    );
    let serving = Arc::clone(&backend);
    let (mut client, host) = Client::pair();
    let (done, completed) = std::sync::mpsc::channel();
    let served =
        std::thread::spawn(move || {
            done.send(serving.serve_product_host_stream(
                std::io::BufReader::new(host.try_clone().unwrap()),
                host,
            ))
            .unwrap();
        });
    client.initialize();
    // Repository admission spans App Server instances. This fixture needs its own key
    // so another test's exclusive write cannot split the batch of held shared reads.
    for id in 2..10 {
        client.send(
            id,
            "github/labels/list",
            json!({
                "operationId":format!("held-{id}"),
                "repository":{"host":"github.com","owner":"team","name":"network-saturation"},
            }),
        );
    }
    // All eight requests must reach HTTP before any is released. This fails when
    // waiting for the first HTTP request occupies the sole background worker.
    for _ in 2..10 {
        started.recv_timeout(Duration::from_secs(3)).unwrap();
    }
    client.send(
        99,
        "github/labels/list",
        json!({
            "operationId":"over-capacity",
            "repository":{"host":"github.com","owner":"team","name":"network-saturation"},
        }),
    );
    let rejected = client.read();
    assert_eq!(rejected["id"], 99);
    assert_eq!(rejected["error"]["data"]["kind"], "ServerOverloaded");
    client.send(100, "model/list", json!({}));
    assert_eq!(client.read()["id"], 100);
    client.send(
        101,
        "session/create",
        json!({
            "commandId":"network-independent-session", "title":"ready", "executionTarget":null,
        }),
    );
    loop {
        let response = client.read();
        if response["id"] == 101 {
            assert!(response["result"].is_object());
            break;
        }
    }
    for id in 2..10 {
        client.send(
            id + 10,
            "github/cancel",
            json!({"operationId":format!("held-{id}")}),
        );
    }
    let mut replies = std::collections::BTreeMap::new();
    while replies.len() < 16 {
        let response = client.read();
        if let Some(id) = response["id"].as_u64() {
            replies.insert(id, response);
        }
    }
    for id in 2..10 {
        assert_eq!(replies[&id]["error"]["data"]["kind"], "RequestCancelled");
        assert_eq!(replies[&(id + 10)]["result"]["status"], "requested");
    }
    client.close();
    completed
        .recv_timeout(Duration::from_secs(3))
        .unwrap()
        .unwrap();
    served.join().unwrap();
}

#[test]
fn disconnect_drains_all_running_github_reads() {
    use crate::server::request_dispatch::tests::Client;
    let (entered, started) = std::sync::mpsc::channel();
    let backend = Arc::new(
        server()
            .with_github_credentials(
                repository_credentials(),
                Arc::new(CancelledRepositoryHttp {
                    entered,
                    confirmed: false,
                }),
            )
            .unwrap(),
    );
    let (mut client, host) = Client::pair();
    let (done, completed) = std::sync::mpsc::channel();
    let served =
        std::thread::spawn(move || {
            done.send(backend.serve_product_host_stream(
                std::io::BufReader::new(host.try_clone().unwrap()),
                host,
            ))
            .unwrap();
        });
    client.initialize();
    for id in 2..8 {
        client.send(
            id,
            "github/labels/list",
            serde_json::json!({
                "operationId":format!("disconnect-{id}"),
                "repository":{"host":"github.com","owner":"team","name":"disconnect-drain"},
            }),
        );
    }
    for _ in 2..8 {
        started.recv_timeout(Duration::from_secs(3)).unwrap();
    }
    client.close();
    let result = completed.recv_timeout(Duration::from_secs(3)).unwrap();
    assert!(result.as_ref().err().is_none_or(|error| matches!(
        error.kind(),
        std::io::ErrorKind::BrokenPipe
            | std::io::ErrorKind::ConnectionReset
            | std::io::ErrorKind::ConnectionAborted
    )));
    served.join().unwrap();
}

#[test]
fn github_notifications_and_fork_rpc_use_typed_account_and_repository_boundaries() {
    use serde_json::json;
    let http = Arc::new(RepositoryHttp::default());
    let server = server()
        .with_github_credentials(repository_credentials(), http.clone())
        .unwrap();
    let mut connection = server.connection();
    initialize(&server, &mut connection);
    for (id, method, params, status, body) in [
        (
            2,
            "github/notifications/list",
            json!({"operationId":"inbox","accountId":"42","filter":"unread","page":1}),
            200,
            json!([{"id":"99","subject":{"type":"Issue","title":"Mention","url":"https://api.github.com/repos/team/repo/issues/7"},"repository":{"full_name":"team/repo"},"reason":"mention","unread":true,"updated_at":"now"}]),
        ),
        (
            3,
            "github/notifications/read",
            json!({"operationId":"read-thread","accountId":"42","threadId":"99"}),
            204,
            serde_json::Value::Null,
        ),
        (
            4,
            "github/notifications/readAll",
            json!({"operationId":"read-inbox","accountId":"42"}),
            202,
            json!({"message":"accepted"}),
        ),
        (
            5,
            "github/repository/fork",
            json!({"operationId":"create-fork","accountId":"42","repository":{"host":"github.com","owner":"team","name":"repo"},"organization":null,"name":"my-fork","branches":"all"}),
            202,
            json!({"full_name":"alice/my-fork","html_url":"https://github.com/alice/my-fork","default_branch":"main"}),
        ),
    ] {
        http.reply(status, body);
        let response = call(
            &server,
            &mut connection,
            json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}),
        );
        assert!(response.get("result").is_some(), "{response}");
        if id == 2 {
            assert_eq!(
                response["result"]["notifications"][0]["url"],
                "https://github.com/team/repo/issues/7"
            );
        }
        if id == 5 {
            assert_eq!(response["result"]["fullName"], "alice/my-fork");
        }
    }
    let denied = call(
        &server,
        &mut connection,
        json!({"jsonrpc":"2.0","id":6,"method":"github/notifications/list","params":{"operationId":"wrong-account","accountId":"other","filter":"all","page":1}}),
    );
    assert_eq!(
        denied["error"]["data"]["kind"],
        "AccountAuthenticationRequired"
    );
    let requests = http.requests.lock().unwrap();
    assert_eq!(requests.len(), 4);
    assert_eq!(
        requests[0].url(),
        "https://api.github.com/notifications?all=false&participating=false&per_page=100&page=1"
    );
    assert_eq!(
        requests[3].url(),
        "https://api.github.com/repos/team/repo/forks"
    );
}

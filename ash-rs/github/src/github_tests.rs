use super::*;

struct Credentials;

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
        authorization: &GitHubAuthorization,
    ) -> std::result::Result<ash_secrets::SecretValue, ash_login::LoginError> {
        assert_eq!(authorization, &self.authorization()?);
        Ok(ash_secrets::SecretValue::new(b"ash-test-token".to_vec()))
    }
}

pub(super) fn github(executable: PathBuf) -> GitHub {
    let mut github = GitHub::for_account(Arc::new(Credentials)).unwrap();
    github.executable = executable;
    github
}

fn response_fixture(response: &str, exit_code: u8) -> (tempfile::TempDir, GitHub) {
    let directory = tempfile::tempdir().unwrap();
    std::fs::write(directory.path().join("response"), response).unwrap();
    #[cfg(windows)]
    let script = {
        let script = directory.path().join("gh.cmd");
        std::fs::write(&script, format!("@echo off\r\ntype \"%~dp0response\"\r\necho ash-test-token HTTP 401 1>&2\r\nexit /b {exit_code}\r\n")).unwrap();
        script
    };
    #[cfg(unix)]
    let script = {
        use std::os::unix::fs::PermissionsExt;
        let script = directory.path().join("gh");
        std::fs::write(
            &script,
            format!(
                "#!/bin/sh\ncat '{}'\nprintf 'ash-test-token HTTP 401' >&2\nexit {exit_code}\n",
                directory.path().join("response").display()
            ),
        )
        .unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
        script
    };
    let github = github(script);
    (directory, github)
}

#[tokio::test(flavor = "current_thread")]
async fn successful_api_responses_preserve_json_after_included_http_headers() {
    let repository = Repository::new("github.com".into(), "team".into(), "repo".into()).unwrap();
    let (_directory, github) = response_fixture("HTTP/2.0 200 OK\n\r\n[]", 0);
    let page = github
        .issues(&repository, IssueState::Open, 1)
        .await
        .unwrap();
    assert!(page.issues.is_empty());
    assert_eq!(page.next_page, None);

    let (_directory, github) = response_fixture(
        "HTTP/2.0 200 OK\n\r\n{\"data\":{\"node\":null},\"errors\":[]}",
        0,
    );
    let value: serde_json::Value = github
        .api(
            &repository,
            "POST",
            "graphql",
            Some(json!({"query":"test"})),
        )
        .await
        .unwrap();
    assert_eq!(value, json!({"data":{"node":null},"errors":[]}));
}

#[tokio::test(flavor = "current_thread")]
async fn repository_requests_classify_http_failures_even_when_gh_exits_unsuccessfully() {
    let repository = Repository::new("github.com".into(), "team".into(), "repo".into()).unwrap();
    for (status, headers, expected) in [
        (401, "", Error::AuthenticationRequired),
        (403, "", Error::PermissionDenied),
        (403, "X-RateLimit-Remaining: 0\r\n", Error::RateLimited),
        (403, "Retry-After: 60\r\n", Error::RateLimited),
        (404, "", Error::NotFound),
        (429, "", Error::RateLimited),
    ] {
        let response =
            format!("HTTP/2.0 {status} Refused\n{headers}\r\n{{\"message\":\"ash-test-token\"}}");
        let (_directory, github) = response_fixture(&response, 1);
        let error = github
            .issues(&repository, IssueState::Open, 1)
            .await
            .unwrap_err();
        assert_eq!(error, expected);
        assert!(!error.to_string().contains("ash-test-token"));
    }
}

#[tokio::test(flavor = "current_thread")]
async fn graphql_refusals_keep_types_with_successful_http_and_nonzero_cli_exit() {
    let repository = Repository::new("github.com".into(), "team".into(), "repo".into()).unwrap();
    for (kind, expected) in [
        ("FORBIDDEN", Error::PermissionDenied),
        ("RATE_LIMITED", Error::RateLimited),
        ("NOT_FOUND", Error::NotFound),
        ("UNAUTHENTICATED", Error::AuthenticationRequired),
    ] {
        let response = format!(
            "HTTP/2.0 200 OK\n\r\n{{\"errors\":[{{\"type\":\"{kind}\",\"message\":\"ash-test-token\"}}]}}"
        );
        let (_directory, github) = response_fixture(&response, 1);
        let error = github
            .api::<serde_json::Value>(
                &repository,
                "POST",
                "graphql",
                Some(serde_json::json!({"query":"test"})),
            )
            .await
            .unwrap_err();
        assert_eq!(error, expected);
        assert!(!error.to_string().contains("ash-test-token"));
    }
}

#[tokio::test(flavor = "current_thread")]
async fn malformed_response_and_cli_failure_cannot_become_success_or_expose_private_data() {
    let repository = Repository::new("github.com".into(), "team".into(), "repo".into()).unwrap();
    for response in [
        "HTTP/2.0 200 OK\n\r\nnot-json ash-test-token",
        "HTTP/2.0 200 OK\n\r\n[{\"number\":\"ash-test-token\"}]",
    ] {
        let (_directory, github) = response_fixture(response, 0);
        let error = github
            .issues(&repository, IssueState::Open, 1)
            .await
            .unwrap_err();
        assert!(matches!(error, Error::InvalidResponse(_)));
        assert!(!error.to_string().contains("ash-test-token"));
    }
    let (_directory, github) = response_fixture("HTTP/2.0 200 OK\n\r\n[]", 1);
    assert!(matches!(
        github.issues(&repository, IssueState::Open, 1).await,
        Err(Error::OperationFailed(_))
    ));
    let (_directory, github) = response_fixture("", 1);
    let error = github
        .issues(&repository, IssueState::Open, 1)
        .await
        .unwrap_err();
    assert!(matches!(error, Error::OperationFailed(_)));
    assert!(!error.to_string().contains("ash-test-token"));
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
    let github = GitHub::for_account(Arc::new(RevokedCredentials)).unwrap();
    let repository = Repository::new("github.com".into(), "team".into(), "repo".into()).unwrap();
    assert_eq!(
        github.issues(&repository, IssueState::Open, 1).await,
        Err(Error::AuthenticationRequired)
    );
}

#[test]
fn repository_identity_rejects_paths_and_option_injection() {
    for value in ["", "../repo", "-repo", "a/b", "repo?x=y", "a\nb", "a b"] {
        assert!(
            Repository::new("github.com".into(), "owner".into(), value.into()).is_err(),
            "{value:?}"
        );
    }
    assert_eq!(
        Repository::new("github.example.com".into(), "team".into(), "my-repo".into())
            .unwrap()
            .endpoint("issues"),
        "repos/team/my-repo/issues"
    );
}

#[tokio::test(flavor = "current_thread")]
async fn draft_pr_cannot_enable_auto_merge() {
    let repository = Repository::new("github.com".into(), "team".into(), "repo".into()).unwrap();
    let pr = PullRequest {
        number: 7,
        node_id: "id".into(),
        html_url: "https://github.com/team/repo/pull/7".into(),
        state: "open".into(),
        draft: true,
        merged_at: None,
        auto_merge: None,
        head: PullRequestBranch {
            name: "feature".into(),
            sha: "abc".into(),
        },
        base: PullRequestBranch {
            name: "main".into(),
            sha: "def".into(),
        },
    };
    let github = github("must-not-execute".into());
    assert_eq!(
        github
            .enable_auto_merge(&repository, &pr, MergeMethod::Squash)
            .await,
        Err(Error::InvalidInput(
            "Automatic merge requires an open, non-draft PR".into()
        ))
    );
}

#[tokio::test(flavor = "current_thread")]
async fn invalid_issue_page_does_not_start_a_process() {
    let repository = Repository::new("github.com".into(), "team".into(), "repo".into()).unwrap();
    let github = github("must-not-execute".into());
    assert!(
        github
            .issues(&repository, IssueState::Open, 0)
            .await
            .unwrap_err()
            .to_string()
            .contains("page")
    );
    assert!(
        github
            .issue(&repository, 0)
            .await
            .unwrap_err()
            .to_string()
            .contains("positive")
    );
}

#[tokio::test(flavor = "current_thread")]
async fn repository_operations_reject_a_host_outside_the_selected_grant() {
    let repository = Repository::new(
        "github.enterprise.example".into(),
        "team".into(),
        "repo".into(),
    )
    .unwrap();
    let github = github("must-not-execute".into());
    assert_eq!(
        github.issue_metadata(&repository, 7).await.unwrap_err(),
        Error::AuthenticationRequired
    );
}

#[cfg(windows)]
#[tokio::test(flavor = "current_thread")]
async fn cli_transport_sets_only_the_selected_hosts_token() {
    use ash_secrets::SecretValue;
    let executable = PathBuf::from("powershell.exe");
    let arguments = vec!["-NoProfile".into(), "-NonInteractive".into(), "-Command".into(),
        "[Console]::Write(($env:GH_HOST,$env:GH_TOKEN,$env:GH_ENTERPRISE_TOKEN,$env:GITHUB_TOKEN,$env:GITHUB_ENTERPRISE_TOKEN -join '|'))".into()];
    let token = SecretValue::new(b"selected-token".to_vec());
    for (host, expected) in [
        ("github.com", "github.com|selected-token|||"),
        ("github.example.com", "github.example.com||selected-token||"),
    ] {
        let output = process::run(&executable, &arguments, None, host, &token)
            .await
            .unwrap();
        assert_eq!(String::from_utf8(output.stdout).unwrap(), expected);
    }
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn issue_reader_excludes_prs_and_reads_every_comment_page() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let issue = serde_json::json!({"number":3,"title":"Fix it","body":"details","html_url":"https://github.com/team/repo/issues/3","updated_at":"now","state":"open"});
    let mut closed = issue.clone();
    closed["number"] = 9.into();
    closed["state"] = "closed".into();
    let mut pr = issue.clone();
    pr["number"] = 4.into();
    pr["pull_request"] = serde_json::json!({"url":"pr"});
    let comment = serde_json::json!({"body":"comment","html_url":"comment-url","updated_at":"now"});
    for (name, value) in [
        ("list", serde_json::json!([issue.clone(), pr])),
        ("closed", serde_json::json!([closed])),
        ("issue", issue),
        ("comments", serde_json::json!(vec![comment; 100])),
        ("empty", serde_json::json!([])),
    ] {
        std::fs::write(
            directory.path().join(name),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
    }
    let script = directory.path().join("gh");
    std::fs::write(&script, format!("#!/bin/sh\nprintf 'HTTP/2.0 200 OK\\nContent-Type: application/json\\r\\n\\r\\n'\ncase \"$6\" in\n*'/comments?'*'page=1') cat '{0}/comments';;\n*'/comments?'*) cat '{0}/empty';;\n*'/issues/3') cat '{0}/issue';;\n*'/issues?state=open&'*'page=1') cat '{0}/list';;\n*'/issues?state=closed&'*'page=2') cat '{0}/closed';;\n*) exit 9;;\nesac\n", directory.path().display())).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let github = github(script);
    let repository = Repository::new("github.com".into(), "team".into(), "repo".into()).unwrap();
    let page = github
        .issues(&repository, IssueState::Open, 1)
        .await
        .unwrap();
    assert_eq!(
        page.issues
            .iter()
            .map(|issue| issue.number)
            .collect::<Vec<_>>(),
        [3]
    );
    assert_eq!(page.next_page, None);
    let closed = github
        .issues(&repository, IssueState::Closed, 2)
        .await
        .unwrap();
    assert_eq!(closed.issues.len(), 1);
    assert_eq!(
        (closed.issues[0].number, closed.issues[0].state.as_str()),
        (9, "closed")
    );
    let snapshot = github.issue(&repository, 3).await.unwrap();
    assert_eq!(snapshot.comments.len(), 100);
    assert_eq!(snapshot.issue.body.as_deref(), Some("details"));
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn graphql_errors_are_failures_even_when_the_process_succeeds() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let script = directory.path().join("gh");
    std::fs::write(&script, "#!/bin/sh\ncat >/dev/null\nprintf 'HTTP/2.0 200 OK\\nContent-Type: application/json\\r\\n\\r\\n'\nprintf '%s' '{\"errors\":[{\"message\":\"Auto-merge disabled\"}]}'\n").unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let github = github(script);
    let repository = Repository::new("github.com".into(), "team".into(), "repo".into()).unwrap();
    let error = github
        .api::<serde_json::Value>(
            &repository,
            "POST",
            "graphql",
            Some(serde_json::json!({"query":"test"})),
        )
        .await
        .unwrap_err();
    assert_eq!(
        error,
        Error::OperationFailed("GitHub rejected the GraphQL request".into())
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn automatic_merge_uses_the_selected_method_and_exact_reviewed_head() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let script = directory.path().join("gh");
    let args_path = directory.path().join("args");
    std::fs::write(
        &script,
        format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n",
            args_path.display()
        ),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let github = github(script);
    let repository = Repository::new("github.com".into(), "team".into(), "repo".into()).unwrap();
    let pr = PullRequest {
        number: 7,
        node_id: "pr".into(),
        html_url: "https://github.com/team/repo/pull/7".into(),
        state: "open".into(),
        draft: false,
        merged_at: None,
        auto_merge: None,
        head: PullRequestBranch {
            name: "issue/task".into(),
            sha: "a".repeat(40),
        },
        base: PullRequestBranch {
            name: "main".into(),
            sha: "b".repeat(40),
        },
    };
    for (method, flag) in [
        (MergeMethod::Merge, "--merge"),
        (MergeMethod::Squash, "--squash"),
        (MergeMethod::Rebase, "--rebase"),
    ] {
        github
            .enable_auto_merge(&repository, &pr, method)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(&args_path)
                .unwrap()
                .lines()
                .collect::<Vec<_>>(),
            vec![
                "pr",
                "merge",
                "7",
                "--repo",
                "github.com/team/repo",
                "--auto",
                flag,
                "--match-head-commit",
                pr.head.sha.as_str()
            ]
        );
    }
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn issue_search_encodes_keywords_handles_numbers_and_reports_limits() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let issue = serde_json::json!({"number":5001,"title":"Title without search words","body":"memory leak","html_url":"https://github.com/team/repo/issues/5001","updated_at":"now","state":"open"});
    std::fs::write(
        dir.path().join("issue"),
        serde_json::to_vec(&issue).unwrap(),
    )
    .unwrap();
    std::fs::write(
        dir.path().join("search"),
        serde_json::to_vec(
            &serde_json::json!({"items":[issue], "total_count":1250, "incomplete_results":false}),
        )
        .unwrap(),
    )
    .unwrap();
    let script = dir.path().join("gh");
    std::fs::write(&script, format!("#!/bin/sh\nprintf 'HTTP/2.0 200 OK\\nContent-Type: application/json\\r\\n\\r\\n'\nprintf '%s' \"$6\" > '{0}/endpoint'\ncase \"$6\" in\nsearch/issues*) cat '{0}/search';;\nrepos/team/repo/issues/5001) cat '{0}/issue';;\n*) exit 9;;\nesac\n", dir.path().display())).unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let github = github(script);
    let repo = Repository::new("github.com".into(), "team".into(), "repo".into()).unwrap();
    let result = github
        .search_issues(&repo, IssueState::Open, "memory leak &", 1)
        .await
        .unwrap();
    assert_eq!(result.issues[0].number, 5001);
    assert_eq!(result.next_page, Some(2));
    assert!(result.notice.contains("1000"));
    let endpoint = std::fs::read_to_string(dir.path().join("endpoint")).unwrap();
    let pairs = url::form_urlencoded::parse(endpoint.split_once('?').unwrap().1.as_bytes())
        .collect::<std::collections::BTreeMap<_, _>>();
    assert_eq!(
        pairs["q"],
        "repo:team/repo is:issue state:open in:title,body \"memory\" \"leak\" \"&\""
    );
    assert_eq!(pairs["per_page"], "100");
    assert_eq!(
        github
            .search_issues(&repo, IssueState::Open, "memory", 10)
            .await
            .unwrap()
            .next_page,
        None
    );
    for query in ["#5001", "5001"] {
        assert_eq!(
            github
                .search_issues(&repo, IssueState::Open, query, 1)
                .await
                .unwrap()
                .issues[0]
                .number,
            5001
        );
    }
    assert!(
        github
            .search_issues(&repo, IssueState::Closed, "#5001", 1)
            .await
            .unwrap()
            .issues
            .is_empty()
    );
    for query in ["#0", "#abc", "x\" repo:elsewhere", "x\nrepo:elsewhere"] {
        assert!(
            github
                .search_issues(&repo, IssueState::Open, query, 1)
                .await
                .is_err()
        );
    }
    let mut foreign = serde_json::from_slice::<serde_json::Value>(
        &std::fs::read(dir.path().join("search")).unwrap(),
    )
    .unwrap();
    foreign["items"][0]["html_url"] = "https://github.com/other/repo/issues/5001".into();
    std::fs::write(
        dir.path().join("search"),
        serde_json::to_vec(&foreign).unwrap(),
    )
    .unwrap();
    assert!(
        github
            .search_issues(&repo, IssueState::Open, "memory", 1)
            .await
            .unwrap_err()
            .to_string()
            .contains("outside")
    );
}

#[cfg(unix)]
#[tokio::test(flavor = "current_thread")]
async fn issue_pagination_continues_past_a_full_page_of_pull_requests() {
    use std::os::unix::fs::PermissionsExt;
    let dir = tempfile::tempdir().unwrap();
    let issue = serde_json::json!({"number":1,"title":"PR","body":null,"html_url":"url","updated_at":"now","state":"open","pull_request":{}});
    std::fs::write(
        dir.path().join("rows"),
        serde_json::to_vec(&vec![issue; 100]).unwrap(),
    )
    .unwrap();
    let script = dir.path().join("gh");
    std::fs::write(
        &script,
        format!("#!/bin/sh\nprintf 'HTTP/2.0 200 OK\\nContent-Type: application/json\\r\\n\\r\\n'\ncat '{}/rows'\n", dir.path().display()),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let github = github(script);
    let repo = Repository::new("github.com".into(), "team".into(), "repo".into()).unwrap();
    let result = github.issues(&repo, IssueState::Open, 25).await.unwrap();
    assert!(result.issues.is_empty());
    assert_eq!(result.next_page, Some(26));
}

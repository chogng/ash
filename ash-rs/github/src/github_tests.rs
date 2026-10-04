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
        Err("Automatic merge requires an open, non-draft PR".into())
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
            .contains("page")
    );
    assert!(
        github
            .issue(&repository, 0)
            .await
            .unwrap_err()
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
        "GitHub authorization does not cover this host"
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
        assert_eq!(String::from_utf8(output).unwrap(), expected);
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
    std::fs::write(&script, format!("#!/bin/sh\ncase \"$6\" in\n*'/comments?'*'page=1') cat '{0}/comments';;\n*'/comments?'*) cat '{0}/empty';;\n*'/issues/3') cat '{0}/issue';;\n*'/issues?state=open&'*'page=1') cat '{0}/list';;\n*'/issues?state=closed&'*'page=2') cat '{0}/closed';;\n*) exit 9;;\nesac\n", directory.path().display())).unwrap();
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
    std::fs::write(&script, "#!/bin/sh\ncat >/dev/null\nprintf '%s' '{\"errors\":[{\"message\":\"Auto-merge disabled\"}]}'\n").unwrap();
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
    assert!(error.contains("Auto-merge disabled"));
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
    std::fs::write(&script, format!("#!/bin/sh\nprintf '%s' \"$6\" > '{0}/endpoint'\ncase \"$6\" in\nsearch/issues*) cat '{0}/search';;\nrepos/team/repo/issues/5001) cat '{0}/issue';;\n*) exit 9;;\nesac\n", dir.path().display())).unwrap();
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
        format!("#!/bin/sh\ncat '{}/rows'\n", dir.path().display()),
    )
    .unwrap();
    std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o700)).unwrap();
    let github = github(script);
    let repo = Repository::new("github.com".into(), "team".into(), "repo".into()).unwrap();
    let result = github.issues(&repo, IssueState::Open, 25).await.unwrap();
    assert!(result.issues.is_empty());
    assert_eq!(result.next_page, Some(26));
}

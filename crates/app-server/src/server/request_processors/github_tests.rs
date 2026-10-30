use super::*;

#[test]
fn managed_settings_snapshot_preserves_retained_data_and_provider_history() {
    let snapshot = github::ManagedSettingsSnapshot {
        settings: Some(serde_json::json!({"model":"managed"})),
        refresh: github::ManagedSettingsRefresh::Failed {
            last_attempt_at: 300,
            last_success_at: Some(200),
            failure: github::ManagedSettingsFailure::UpdateRequired,
        },
    };
    assert_eq!(
        serde_json::to_value(managed_settings_snapshot(snapshot)).unwrap(),
        serde_json::json!({
            "settings":{"model":"managed"},
            "refresh":{"state":"failed", "lastAttemptAt":300, "lastSuccessAt":200, "failure":"updateRequired"}
        })
    );
}

#[test]
fn review_threads_map_nullable_lines_and_reply_pagination_to_the_frontend_contract() {
    let thread: github::ReviewThread = serde_json::from_value(serde_json::json!({
        "id":"thread", "path":"a.rs", "line":null, "diffSide":"LEFT", "isResolved":false,
        "isOutdated":true, "viewerCanResolve":false, "comments":{"nodes":[{
            "id":"comment", "body":"Review", "url":"https://github.com/team/repo/pull/7",
            "author":null, "viewerCanUpdate":false, "viewerCanDelete":false
        }], "pageInfo":{"hasNextPage":true,"endCursor":"next"}}
    }))
    .unwrap();
    let dto = review_thread(thread).unwrap();
    assert_eq!(dto.line, None);
    assert_eq!(dto.side, GitHubDiffSide::Left);
    assert!(dto.outdated);
    assert_eq!(dto.comments.next_cursor.as_deref(), Some("next"));
    assert_eq!(dto.comments.comments[0].author, None);
    assert!(next_review_cursor(true, None).is_err());
    assert!(next_review_cursor(true, Some(String::new())).is_err());
    assert_eq!(
        next_review_cursor(false, Some("last".into())).unwrap(),
        None
    );
}

#[test]
fn github_pull_request_branches_keep_fork_identity_and_mergeability() {
    for (head_repository, expected, mergeable) in [
        (
            serde_json::json!({ "full_name": "contributor/fork" }),
            Some("contributor/fork"),
            Some(true),
        ),
        (serde_json::Value::Null, None, Some(false)),
        (serde_json::Value::Null, None, None),
    ] {
        let response: github::PullRequest = serde_json::from_value(serde_json::json!({
            "number": 7, "node_id": "PR_7", "title": "Fix links", "body": "Details",
            "html_url": "https://github.com/team/repo/pull/7", "state": "open", "draft": false,
            "merged_at": null, "auto_merge": null, "mergeable": mergeable,
            "head": { "sha": "a".repeat(40), "ref": "feature/links", "repo": head_repository },
            "base": { "sha": "b".repeat(40), "ref": "main", "repo": { "full_name": "team/repo" } }
        }))
        .unwrap();
        let result = pull_request(response);
        assert_eq!(result.head_repository.as_deref(), expected);
        assert_eq!(result.mergeable, mergeable);
        assert_eq!(result.head_branch, "feature/links");
    }
}

#[test]
fn github_error_categories_are_independent_of_product_reporter_errors() {
    for (error, name, code) in [
        (
            github::Error::InvalidInput("invalid page".into()),
            AppServerErrorName::InvalidParams,
            -32602,
        ),
        (
            github::Error::AuthenticationRequired,
            AppServerErrorName::AccountAuthenticationRequired,
            -32030,
        ),
        (
            github::Error::PermissionDenied,
            AppServerErrorName::GitHubPermissionDenied,
            -32070,
        ),
        (
            github::Error::RateLimited,
            AppServerErrorName::GitHubRateLimited,
            -32070,
        ),
        (
            github::Error::NotFound,
            AppServerErrorName::GitHubNotFound,
            -32070,
        ),
        (
            github::Error::ManagedSettingsUpdateRequired,
            AppServerErrorName::GitHubManagedSettingsUpdateRequired,
            -32070,
        ),
        (
            github::Error::Conflict("changed".into()),
            AppServerErrorName::GitHubConflict,
            -32070,
        ),
        (
            github::Error::Unavailable("network unavailable".into()),
            AppServerErrorName::GitHubUnavailable,
            -32070,
        ),
        (
            github::Error::TimedOut,
            AppServerErrorName::GitHubTimedOut,
            -32070,
        ),
        (
            github::Error::InvalidResponse("invalid JSON".into()),
            AppServerErrorName::GitHubOperationFailed,
            -32070,
        ),
        (
            github::Error::OperationFailed("request failed".into()),
            AppServerErrorName::GitHubOperationFailed,
            -32070,
        ),
        (
            github::Error::Cancelled,
            AppServerErrorName::RequestCancelled,
            -32800,
        ),
        (
            github::Error::SubmissionUncertain,
            AppServerErrorName::GitHubSubmissionUncertain,
            -32070,
        ),
    ] {
        let diagnostic = error.to_string();
        let result = github_error(error);
        assert_eq!(result.message, name);
        assert_eq!(result.code, code);
        assert_eq!(result.detail.as_deref(), Some(diagnostic.as_str()));
    }
}

#[test]
fn every_registered_github_network_method_has_execution() {
    use ash_app_server_protocol::protocol::registry::CLIENT_METHODS;
    for method in CLIENT_METHODS
        .iter()
        .filter(|method| method.method.starts_with("github/"))
    {
        match method.kind {
            ClientMethod::GitHubCancel
            | ClientMethod::GitHubAccountList
            | ClientMethod::GitHubAccountConnect
            // Session PR references belong to the local thread store, not GitHub HTTP.
            | ClientMethod::GitHubSessionPullRequests
            | ClientMethod::GitHubSessionPullRequestAttach
            | ClientMethod::GitHubSessionPullRequestDetach
            | ClientMethod::GitHubSessionIssues
            | ClientMethod::GitHubSessionIssueAttach
            | ClientMethod::GitHubSessionIssueDetach => {}
            method => assert!(
                GitHubRequestProcessor::handles(method),
                "{} has no network execution",
                method.as_str()
            ),
        }
    }
}

struct CiCredentials;
impl github::GitHubCredentialProvider for CiCredentials {
    fn authorization(&self) -> Result<github::GitHubAuthorization, ash_login::LoginError> {
        Ok(github::GitHubAuthorization {
            host: "github.com".into(),
            account_id: "42".into(),
            grant_id: "captured-grant".into(),
        })
    }
    fn token(
        &self,
        grant: &github::GitHubAuthorization,
    ) -> Result<ash_secrets::SecretValue, ash_login::LoginError> {
        assert_eq!(grant.account_id, "42");
        Ok(ash_secrets::SecretValue::new(b"fixture-only".to_vec()))
    }
}
struct CiProvider;
impl github::GitHubProvider for CiProvider {
    fn call(
        &self,
        authorization: Option<github::GitHubAuthorization>,
        request: github::GitHubRequest,
        _: &CancellationToken,
    ) -> github::Result<github::GitHubResponse> {
        assert_eq!(authorization.unwrap().grant_id, "captured-grant");
        match request {
            github::GitHubRequest::CheckDetails {
                repository,
                number,
                commit,
                check_id,
                page,
            } => {
                assert_eq!(
                    (
                        repository.owner.as_str(),
                        repository.name.as_str(),
                        number,
                        check_id,
                        page
                    ),
                    ("team", "repo", 7, 9, 2)
                );
                assert_eq!(commit, "a".repeat(40));
                Ok(github::GitHubResponse::CheckDetails(github::CheckDetails {
                    title: "Build failure".into(),
                    summary: "Compiler error".into(),
                    text: "Diagnostic output".into(),
                    next_page: None,
                    actions_job: true,
                    annotations: vec![github::CheckAnnotation {
                        path: "src/main.rs".into(),
                        start_line: 3,
                        end_line: 4,
                        annotation_level: "failure".into(),
                        message: "Error".into(),
                        title: None,
                    }],
                }))
            }
            github::GitHubRequest::CheckLog { .. } => Ok(github::GitHubResponse::CheckLog(
                "https://productionresults.blob.core.windows.net/logs".into(),
            )),
            github::GitHubRequest::RerunCheck { .. } => Err(github::Error::PermissionDenied),
            _ => panic!("Unexpected CI provider operation"),
        }
    }
}

#[test]
fn ci_requests_cross_the_real_domain_provider_and_return_generated_dto_fields() {
    let processor = GitHubRequestProcessor::new(Arc::new(CiCredentials), Arc::new(CiProvider));
    let source = ash_async_utils::CancellationSource::new();
    let params = serde_json::json!({"operationId":"ci-fixture","accountId":"42","repository":{"host":"github.com","owner":"team","name":"repo"},"number":7,"commit":"a".repeat(40),"checkId":9});
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    runtime.block_on(async {
        let mut details_params = params.clone();
        details_params["page"] = 2.into();
        let details = processor
            .request(
                ClientMethod::GitHubCheckDetails,
                &details_params,
                &source.token(),
            )
            .await
            .unwrap();
        assert_eq!(details["actionsJob"], true);
        assert_eq!(details["annotations"][0]["startLine"], 3);
        assert!(details["annotations"][0].get("start_line").is_none());
        let logs = processor
            .request(ClientMethod::GitHubCheckLog, &params, &source.token())
            .await
            .unwrap();
        assert_eq!(
            logs["url"],
            "https://productionresults.blob.core.windows.net/logs"
        );
        let refusal = processor
            .request(ClientMethod::GitHubCheckRerun, &params, &source.token())
            .await
            .unwrap_err();
        assert_eq!(refusal.message, AppServerErrorName::GitHubPermissionDenied);
    });
}

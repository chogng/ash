use super::*;
use ash_async_utils::CancellationSource;
use ash_login::LoginError;
use ash_secrets::SecretValue;
struct Credentials;
impl GitHubCredentialProvider for Credentials {
    fn authorization(&self) -> std::result::Result<GitHubAuthorization, LoginError> {
        Ok(GitHubAuthorization {
            host: "github.com".into(),
            account_id: "42".into(),
            grant_id: "grant".into(),
        })
    }
    fn token(&self, _: &GitHubAuthorization) -> std::result::Result<SecretValue, LoginError> {
        Ok(SecretValue::new(b"token".to_vec()))
    }
}
struct WrongReply;
impl GitHubProvider for WrongReply {
    fn call(
        &self,
        _: Option<GitHubAuthorization>,
        _: GitHubRequest,
        _: &CancellationToken,
    ) -> Result<GitHubResponse> {
        Ok(GitHubResponse::ManagedSettings(ManagedSettingsSnapshot {
            settings: None,
            refresh: ManagedSettingsRefresh::Ready {
                last_attempt_at: 1,
                last_success_at: 2,
            },
        }))
    }
}
#[test]
fn wrong_operation_replies_preserve_uncertainty_for_writes() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    let client = GitHub::for_account(
        Arc::new(Credentials),
        Arc::new(WrongReply),
        CancellationSource::new().token(),
    )
    .unwrap();
    let repository = Repository::new("github.com".into(), "team".into(), "repo".into()).unwrap();
    runtime.block_on(async {
        assert!(matches!(
            client.comments(&repository, 7, 1).await,
            Err(Error::InvalidResponse(_))
        ));
        assert_eq!(
            client.create_comment(&repository, 7, "body").await,
            Err(Error::SubmissionUncertain)
        );
        assert!(matches!(
            client
                .check_details(&repository, 7, &"a".repeat(40), 9, 1)
                .await,
            Err(Error::InvalidResponse(_))
        ));
        assert!(matches!(
            client.check_log(&repository, 7, &"a".repeat(40), 9).await,
            Err(Error::InvalidResponse(_))
        ));
        assert_eq!(
            client.rerun_check(&repository, 7, &"a".repeat(40), 9).await,
            Err(Error::SubmissionUncertain)
        );
    });
}

struct FollowUpProvider {
    calls: std::sync::atomic::AtomicUsize,
    moving: bool,
    pending: bool,
    repeated_page: bool,
}

impl GitHubProvider for FollowUpProvider {
    fn call(
        &self,
        authorization: Option<GitHubAuthorization>,
        request: GitHubRequest,
        _: &CancellationToken,
    ) -> Result<GitHubResponse> {
        assert_eq!(authorization.unwrap().account_id, "42");
        match request {
            GitHubRequest::PullRequest { .. } => {
                let count = self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                let sha = if self.moving && count > 0 { "b" } else { "a" }.repeat(40);
                Ok(GitHubResponse::PullRequest(serde_json::from_value(serde_json::json!({
                    "number":7,"node_id":"node","title":"PR","body":null,"html_url":"https://github.com/team/repo/pull/7",
                    "state":"open","draft":false,"merged_at":null,"mergeable":true,
                    "head":{"sha":sha,"ref":"topic","repo":null},
                    "base":{"sha":"base","ref":"main","repo":null}
                })).unwrap()))
            }
            GitHubRequest::Checks { page, .. } => Ok(GitHubResponse::Checks(CheckStatus {
                state: "failure".into(),
                statuses: vec![],
                checks: vec![CheckRun {
                    id: u64::from(page),
                    name: format!("check-{page}"),
                    status: if self.pending {
                        "in_progress"
                    } else {
                        "completed"
                    }
                    .into(),
                    conclusion: Some("failure".into()),
                    details_url: None,
                }],
                next_page: if self.repeated_page {
                    Some(1)
                } else if page == 1 {
                    Some(2)
                } else {
                    None
                },
            })),
            GitHubRequest::CheckDetails { .. } => Ok(GitHubResponse::CheckDetails(CheckDetails {
                title: "Build failed".into(),
                summary: "Compiler diagnostics".into(),
                text: "src/main.rs:3: missing value".into(),
                annotations: vec![],
                next_page: None,
                actions_job: true,
            })),
            _ => panic!("unexpected follow-up operation"),
        }
    }
}

#[test]
fn follow_up_requires_complete_settled_checks_at_one_head_and_an_exact_account() {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .build()
        .unwrap();
    for (moving, pending, repeated_page) in [
        (false, false, false),
        (true, false, false),
        (false, true, false),
        (false, false, true),
    ] {
        let client = GitHub::for_selected_account(
            Arc::new(Credentials),
            Arc::new(FollowUpProvider {
                calls: Default::default(),
                moving,
                pending,
                repeated_page,
            }),
            CancellationSource::new().token(),
            "42",
        )
        .unwrap();
        let repository =
            Repository::new("github.com".into(), "team".into(), "repo".into()).unwrap();
        let result = runtime.block_on(client.pull_request_follow_up(&repository, 7));
        if repeated_page {
            assert!(matches!(result, Err(Error::InvalidResponse(_))));
        } else if moving || pending {
            assert_eq!(result.unwrap(), PullRequestFollowUp::Waiting);
        } else {
            let PullRequestFollowUp::Failed { head, context } = result.unwrap() else {
                panic!("missing failure");
            };
            assert_eq!(head, "a".repeat(40));
            let context: serde_json::Value = serde_json::from_str(&context).unwrap();
            assert!(
                context["diagnostics"][0]["text"]
                    .as_str()
                    .unwrap()
                    .contains("src/main.rs:3")
            );
            assert_eq!(
                context["failedChecks"],
                serde_json::json!(["check-1: ", "check-2: "])
            );
        }
    }
    assert!(
        GitHub::for_selected_account(
            Arc::new(Credentials),
            Arc::new(WrongReply),
            CancellationSource::new().token(),
            "other-account"
        )
        .is_err()
    );
}

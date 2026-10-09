use ash_app_server_protocol::protocol::github::GitHubAccount;
use ash_app_server_protocol::protocol::github::GitHubAccountConnectParams;
use ash_app_server_protocol::protocol::github::GitHubAccountListParams;
use ash_app_server_protocol::protocol::github::GitHubAccountsResult;
use ash_app_server_protocol::protocol::github::GitHubDiffSide;
use ash_app_server_protocol::protocol::github::GitHubFileContent;
use ash_app_server_protocol::protocol::github::GitHubFileReadParams;
use ash_app_server_protocol::protocol::github::GitHubForkBranches;
use ash_app_server_protocol::protocol::github::GitHubForkCreateParams;
use ash_app_server_protocol::protocol::github::GitHubForkResult;
use ash_app_server_protocol::protocol::github::GitHubNotification;
use ash_app_server_protocol::protocol::github::GitHubNotificationFilter;
use ash_app_server_protocol::protocol::github::GitHubNotificationReadParams;
use ash_app_server_protocol::protocol::github::GitHubNotificationsParams;
use ash_app_server_protocol::protocol::github::GitHubNotificationsReadParams;
use ash_app_server_protocol::protocol::github::GitHubNotificationsResult;
use ash_app_server_protocol::protocol::github::GitHubRequestedReviewers;
use ash_app_server_protocol::protocol::github::GitHubReviewComment;
use ash_app_server_protocol::protocol::github::GitHubReviewCommentDeleteParams;
use ash_app_server_protocol::protocol::github::GitHubReviewCommentEditParams;
use ash_app_server_protocol::protocol::github::GitHubReviewCommentsResult;
use ash_app_server_protocol::protocol::github::GitHubReviewDiffParams;
use ash_app_server_protocol::protocol::github::GitHubReviewDiffResult;
use ash_app_server_protocol::protocol::github::GitHubReviewThread;
use ash_app_server_protocol::protocol::github::GitHubReviewThreadReadParams;
use ash_app_server_protocol::protocol::github::GitHubReviewThreadReplyParams;
use ash_app_server_protocol::protocol::github::GitHubReviewThreadResolveParams;
use ash_app_server_protocol::protocol::github::GitHubReviewThreadState;
use ash_app_server_protocol::protocol::github::GitHubReviewThreadsParams;
use ash_app_server_protocol::protocol::github::GitHubReviewThreadsResult;
use ash_app_server_protocol::protocol::github::GitHubReviewerChange;
use ash_app_server_protocol::protocol::github::GitHubReviewersChangeParams;

use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::issue_operations::summary;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::github::GitHubAssigneesResult;
use ash_app_server_protocol::protocol::github::GitHubCancelParams;
use ash_app_server_protocol::protocol::github::GitHubCancelResult;
use ash_app_server_protocol::protocol::github::GitHubCancelStatus;
use ash_app_server_protocol::protocol::github::GitHubCheckRun;
use ash_app_server_protocol::protocol::github::GitHubChecksParams;
use ash_app_server_protocol::protocol::github::GitHubChecksResult;
use ash_app_server_protocol::protocol::github::GitHubCommentCreateParams;
use ash_app_server_protocol::protocol::github::GitHubCommentDeleteParams;
use ash_app_server_protocol::protocol::github::GitHubCommentListResult;
use ash_app_server_protocol::protocol::github::GitHubCommentUpdateParams;
use ash_app_server_protocol::protocol::github::GitHubCommit;
use ash_app_server_protocol::protocol::github::GitHubCommitParams;
use ash_app_server_protocol::protocol::github::GitHubCommitStatus;
use ash_app_server_protocol::protocol::github::GitHubIssue;
use ash_app_server_protocol::protocol::github::GitHubIssueCreateParams;
use ash_app_server_protocol::protocol::github::GitHubIssueListParams;
use ash_app_server_protocol::protocol::github::GitHubIssueListResult;
use ash_app_server_protocol::protocol::github::GitHubIssueUpdateParams;
use ash_app_server_protocol::protocol::github::GitHubLabel;
use ash_app_server_protocol::protocol::github::GitHubLabelParams;
use ash_app_server_protocol::protocol::github::GitHubLabelsResult;
use ash_app_server_protocol::protocol::github::GitHubMergeMethod;
use ash_app_server_protocol::protocol::github::GitHubMergeResult;
use ash_app_server_protocol::protocol::github::GitHubNumberParams;
use ash_app_server_protocol::protocol::github::GitHubPageParams;
use ash_app_server_protocol::protocol::github::GitHubPullRequest;
use ash_app_server_protocol::protocol::github::GitHubPullRequestCreateParams;
use ash_app_server_protocol::protocol::github::GitHubPullRequestFile;
use ash_app_server_protocol::protocol::github::GitHubPullRequestFilesResult;
use ash_app_server_protocol::protocol::github::GitHubPullRequestListParams;
use ash_app_server_protocol::protocol::github::GitHubPullRequestListResult;
use ash_app_server_protocol::protocol::github::GitHubPullRequestMergeParams;
use ash_app_server_protocol::protocol::github::GitHubPullRequestReview;
use ash_app_server_protocol::protocol::github::GitHubPullRequestReviewParams;
use ash_app_server_protocol::protocol::github::GitHubPullRequestReviewsResult;
use ash_app_server_protocol::protocol::github::GitHubPullRequestUpdateParams;
use ash_app_server_protocol::protocol::github::GitHubRepositoryParams;
use ash_app_server_protocol::protocol::github::GitHubRepositoryResult;
use ash_app_server_protocol::protocol::github::GitHubReviewEvent;
use ash_app_server_protocol::protocol::issues::IssueComment;
use ash_app_server_protocol::protocol::issues::IssueReadResult;
use ash_app_server_protocol::protocol::issues::IssueState;
use ash_app_server_protocol::protocol::registry::ClientMethod;
use ash_async_utils::CancellationToken;
use ash_http_client::HttpClient;
use core_api::AgentRuntime;

impl super::AppServer {
    pub(crate) fn with_thread_pull_requests(
        mut self,
        store: std::sync::Arc<ash_state::SqliteThreadStore>,
    ) -> Self {
        self.thread_pull_requests = Some(store);
        self
    }

    pub(super) fn session_github_references(
        &self,
        method: ClientMethod,
        params: &Value,
    ) -> Result<Value, RpcError> {
        use ash_app_server_protocol::protocol::github::GitHubIssueReference;
        use ash_app_server_protocol::protocol::github::GitHubPullRequestReference;
        use ash_app_server_protocol::protocol::github::GitHubSessionIssueParams;
        use ash_app_server_protocol::protocol::github::GitHubSessionIssuesParams;
        use ash_app_server_protocol::protocol::github::GitHubSessionIssuesResult;
        use ash_app_server_protocol::protocol::github::GitHubSessionPullRequestParams;
        use ash_app_server_protocol::protocol::github::GitHubSessionPullRequestsParams;
        use ash_app_server_protocol::protocol::github::GitHubSessionPullRequestsResult;
        let (session_id, reference) = match method {
            ClientMethod::GitHubSessionPullRequests => {
                let p: GitHubSessionPullRequestsParams = decode(params)?;
                (p.session_id, None)
            }
            ClientMethod::GitHubSessionIssues => {
                let p: GitHubSessionIssuesParams = decode(params)?;
                (p.session_id, None)
            }
            ClientMethod::GitHubSessionPullRequestAttach
            | ClientMethod::GitHubSessionPullRequestDetach => {
                let p: GitHubSessionPullRequestParams = decode(params)?;
                (
                    p.session_id,
                    Some((p.reference.repository, p.reference.number)),
                )
            }
            ClientMethod::GitHubSessionIssueAttach | ClientMethod::GitHubSessionIssueDetach => {
                let p: GitHubSessionIssueParams = decode(params)?;
                (
                    p.session_id,
                    Some((p.reference.repository, p.reference.number)),
                )
            }
            _ => unreachable!("only Session GitHub reference methods are dispatched here"),
        };
        if self
            .agent_runtime()
            .read_session_catalog(&session_id)
            .map_err(super::core_error)?
            .is_none()
        {
            return Err(super::core_error(core_api::CoreError::NotFound(
                session_id.to_string(),
            )));
        }
        let thread_id = ash_protocol::ThreadId::new(session_id.as_str())
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        let store = self
            .thread_pull_requests
            .as_ref()
            .ok_or_else(|| RpcError::new(-32070, AppServerErrorName::GitHubUnavailable))?;
        let storage_error = |error: thread_store::ThreadStoreError| {
            RpcError::with_details(
                -32070,
                AppServerErrorName::GitHubOperationFailed,
                error.to_string(),
            )
        };
        let repository_view = |repository: github::Repository| {
            ash_app_server_protocol::protocol::issues::IssueRepository {
                host: repository.host,
                owner: repository.owner,
                name: repository.name,
            }
        };
        match method {
            ClientMethod::GitHubSessionPullRequests => {
                let references = store
                    .list_pull_requests(&thread_id)
                    .map_err(storage_error)?;
                result(&GitHubSessionPullRequestsResult {
                    references: references
                        .into_iter()
                        .map(|(repository, number)| GitHubPullRequestReference {
                            repository: repository_view(repository),
                            number,
                        })
                        .collect(),
                })
            }
            ClientMethod::GitHubSessionIssues => {
                let references = store.list_issues(&thread_id).map_err(storage_error)?;
                result(&GitHubSessionIssuesResult {
                    references: references
                        .into_iter()
                        .map(|(repository, number)| GitHubIssueReference {
                            repository: repository_view(repository),
                            number,
                        })
                        .collect(),
                })
            }
            ClientMethod::GitHubSessionPullRequestAttach
            | ClientMethod::GitHubSessionPullRequestDetach
            | ClientMethod::GitHubSessionIssueAttach
            | ClientMethod::GitHubSessionIssueDetach => {
                let (repository, number) = reference.expect("mutation params include a reference");
                let repository =
                    github::Repository::new(repository.host, repository.owner, repository.name)
                        .map_err(github_error)?;
                if number == 0 || number > 9_007_199_254_740_991 {
                    return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
                }
                let changed = match method {
                    ClientMethod::GitHubSessionPullRequestAttach => {
                        store.attach_pull_request(&thread_id, &repository, number)
                    }
                    ClientMethod::GitHubSessionPullRequestDetach => {
                        store.detach_pull_request(&thread_id, &repository, number)
                    }
                    ClientMethod::GitHubSessionIssueAttach => {
                        store.attach_issue(&thread_id, &repository, number)
                    }
                    ClientMethod::GitHubSessionIssueDetach => {
                        store.detach_issue(&thread_id, &repository, number)
                    }
                    _ => unreachable!("only mutations are dispatched here"),
                }
                .map_err(storage_error)?;
                if changed {
                    self.updates.publish_session_changed(&session_id);
                }
                result(&())
            }
            _ => unreachable!("only Session GitHub reference methods are dispatched here"),
        }
    }
}
use serde_json::Value;
use std::sync::Arc;

/// Protocol conversion for hosted repositories. Credential grants and HTTP policy are
/// supplied by their domain owners; the processor never depends on the application host.
pub(super) struct GitHubRequestProcessor {
    credentials: Arc<dyn github::GitHubCredentialProvider>,
    http: Arc<dyn HttpClient>,
}

impl GitHubRequestProcessor {
    pub(super) fn new(
        credentials: Arc<dyn github::GitHubCredentialProvider>,
        http: Arc<dyn HttpClient>,
    ) -> Self {
        Self { credentials, http }
    }

    pub(super) fn credentials(&self) -> &dyn github::GitHubCredentialProvider {
        self.credentials.as_ref()
    }

    pub(super) fn client(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<github::GitHub, RpcError> {
        github::GitHub::for_account(
            Arc::clone(&self.credentials),
            Arc::clone(&self.http),
            cancellation.clone(),
        )
        .map_err(github_authentication_error)
    }

    pub(super) fn handles(method: ClientMethod) -> bool {
        matches!(
            method,
            ClientMethod::GitHubNotificationsList
                | ClientMethod::GitHubNotificationRead
                | ClientMethod::GitHubNotificationsRead
                | ClientMethod::GitHubForkCreate
                | ClientMethod::GitHubReviewersRead
                | ClientMethod::GitHubReviewersChange
                | ClientMethod::GitHubReviewCommentEdit
                | ClientMethod::GitHubReviewCommentDelete
                | ClientMethod::GitHubCommitRead
                | ClientMethod::GitHubRepositoryRead
                | ClientMethod::GitHubIssueList
                | ClientMethod::GitHubIssueRead
                | ClientMethod::GitHubIssueCreate
                | ClientMethod::GitHubIssueUpdate
                | ClientMethod::GitHubCommentList
                | ClientMethod::GitHubCommentCreate
                | ClientMethod::GitHubCommentUpdate
                | ClientMethod::GitHubCommentDelete
                | ClientMethod::GitHubPullRequestList
                | ClientMethod::GitHubPullRequestRead
                | ClientMethod::GitHubPullRequestCreate
                | ClientMethod::GitHubPullRequestUpdate
                | ClientMethod::GitHubPullRequestFiles
                | ClientMethod::GitHubPullRequestReviews
                | ClientMethod::GitHubPullRequestDiff
                | ClientMethod::GitHubFileRead
                | ClientMethod::GitHubReviewThreads
                | ClientMethod::GitHubReviewThreadRead
                | ClientMethod::GitHubReviewThreadReply
                | ClientMethod::GitHubReviewThreadResolve
                | ClientMethod::GitHubPullRequestReview
                | ClientMethod::GitHubPullRequestMerge
                | ClientMethod::GitHubPullRequestAutoMerge
                | ClientMethod::GitHubChecks
                | ClientMethod::GitHubLabelsList
                | ClientMethod::GitHubLabelCreate
                | ClientMethod::GitHubLabelUpdate
                | ClientMethod::GitHubAssigneesList
        )
    }

    pub(super) async fn request(
        &self,
        method: ClientMethod,
        params: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        #[derive(serde::Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct AccountSelection {
            account_id: Option<String>,
        }
        let selection: AccountSelection = decode(params)?;
        let client = if let Some(account_id) = selection.account_id {
            github::GitHub::for_selected_account(
                Arc::clone(&self.credentials),
                Arc::clone(&self.http),
                cancellation.clone(),
                &account_id,
            )
            .map_err(github_authentication_error)?
        } else {
            self.client(cancellation)?
        };
        // DTOs terminate here. Domain validation and remote effects remain in ash-github.
        macro_rules! operation {
            ($ty:ty, |$p:ident, $repo:ident| $body:expr) => {{
                let $p: $ty = decode(params)?;
                let $repo = github::Repository::new(
                    $p.repository.host.clone(),
                    $p.repository.owner.clone(),
                    $p.repository.name.clone(),
                )
                .map_err(github_error)?;
                let value = async { $body }.await.map_err(github_error)?;
                result(&value)
            }};
        }
        match method {
            ClientMethod::GitHubNotificationsList => {
                let p: GitHubNotificationsParams = decode(params)?;
                let filter = match p.filter {
                    GitHubNotificationFilter::Unread => github::NotificationFilter::Unread,
                    GitHubNotificationFilter::All => github::NotificationFilter::All,
                    GitHubNotificationFilter::Participating => {
                        github::NotificationFilter::Participating
                    }
                };
                let page = client
                    .notifications(filter, p.page)
                    .await
                    .map_err(github_error)?;
                result(&GitHubNotificationsResult {
                    notifications: page
                        .notifications
                        .into_iter()
                        .map(|row| GitHubNotification {
                            id: row.id,
                            title: row.title,
                            subject_type: row.subject_type,
                            reason: row.reason,
                            unread: row.unread,
                            updated_at: row.updated_at,
                            repository:
                                ash_app_server_protocol::protocol::issues::IssueRepository {
                                    host: row.repository.host,
                                    owner: row.repository.owner,
                                    name: row.repository.name,
                                },
                            url: row.url,
                        })
                        .collect(),
                    next_page: page.next_page,
                })
            }
            ClientMethod::GitHubNotificationRead => {
                let p: GitHubNotificationReadParams = decode(params)?;
                client
                    .mark_notification_read(&p.thread_id)
                    .await
                    .map_err(github_error)?;
                result(&())
            }
            ClientMethod::GitHubNotificationsRead => {
                let _: GitHubNotificationsReadParams = decode(params)?;
                client
                    .mark_notifications_read()
                    .await
                    .map_err(github_error)?;
                result(&())
            }
            ClientMethod::GitHubForkCreate => {
                operation!(GitHubForkCreateParams, |p, repository| {
                    let fork = client
                        .create_fork(
                            &repository,
                            &github::CreateFork {
                                organization: p.organization,
                                name: p.name,
                                branches: match p.branches {
                                    GitHubForkBranches::All => github::ForkBranches::All,
                                    GitHubForkBranches::Default => github::ForkBranches::Default,
                                },
                            },
                        )
                        .await?;
                    Ok::<_, github::Error>(GitHubForkResult {
                        full_name: fork.full_name,
                        url: fork.html_url,
                        default_branch: fork.default_branch,
                    })
                })
            }
            ClientMethod::GitHubReviewersRead => operation!(GitHubNumberParams, |p, repository| {
                Ok::<_, github::Error>(requested_reviewers(
                    client.requested_reviewers(&repository, p.number).await?,
                ))
            }),
            ClientMethod::GitHubReviewersChange => {
                operation!(GitHubReviewersChangeParams, |p, repository| {
                    let change = match p.change {
                        GitHubReviewerChange::Request => github::ReviewerChange::Request,
                        GitHubReviewerChange::Remove => github::ReviewerChange::Remove,
                    };
                    Ok::<_, github::Error>(requested_reviewers(
                        client
                            .change_reviewers(&repository, p.number, change, &p.users, &p.teams)
                            .await?,
                    ))
                })
            }
            ClientMethod::GitHubReviewCommentEdit => {
                operation!(GitHubReviewCommentEditParams, |p, repository| {
                    Ok::<_, github::Error>(review_comment(
                        client
                            .update_review_comment(&repository, p.number, &p.comment_id, &p.body)
                            .await?,
                    ))
                })
            }
            ClientMethod::GitHubReviewCommentDelete => {
                operation!(GitHubReviewCommentDeleteParams, |p, repository| {
                    client
                        .delete_review_comment(&repository, p.number, &p.comment_id)
                        .await
                })
            }
            ClientMethod::GitHubCommitRead => operation!(GitHubCommitParams, |p, repository| {
                let commit = client.commit(&repository, &p.sha).await?;
                Ok::<_, github::Error>(GitHubCommit {
                    sha: commit.sha,
                    url: commit.html_url,
                    message: commit.commit.message,
                    author: commit.commit.author.name,
                    committed_at: commit.commit.committer.date,
                    additions: commit.stats.additions,
                    deletions: commit.stats.deletions,
                })
            }),
            ClientMethod::GitHubRepositoryRead => {
                operation!(GitHubRepositoryParams, |p, repository| {
                    let repository = client.repository(&repository).await?;
                    let info = repository.metadata;
                    let options = repository.merge_options;
                    Ok::<_, github::Error>(GitHubRepositoryResult {
                        default_branch: info.default_branch,
                        full_name: info.full_name,
                        allow_merge_commit: options.allow_merge_commit,
                        allow_squash_merge: options.allow_squash_merge,
                        allow_rebase_merge: options.allow_rebase_merge,
                        allow_auto_merge: options.allow_auto_merge,
                    })
                })
            }
            ClientMethod::GitHubIssueList => operation!(GitHubIssueListParams, |p, repository| {
                let page = client
                    .search_issues(&repository, state(p.state), &p.query, p.page)
                    .await?;
                Ok::<_, github::Error>(GitHubIssueListResult {
                    issues: page.issues.into_iter().map(summary).collect(),
                    next_page: page.next_page,
                    notice: page.notice,
                })
            }),
            ClientMethod::GitHubIssueRead => operation!(GitHubNumberParams, |p, repository| {
                let snapshot = client.issue(&repository, p.number).await?;
                Ok::<_, github::Error>(IssueReadResult {
                    body: snapshot.issue.body.clone().unwrap_or_default(),
                    issue: summary(snapshot.issue),
                    comments: snapshot.comments.into_iter().map(comment).collect(),
                })
            }),
            ClientMethod::GitHubIssueCreate => {
                operation!(GitHubIssueCreateParams, |p, repository| {
                    client
                        .create_issue(
                            &repository,
                            github::CreateIssue {
                                title: &p.title,
                                body: &p.body,
                                labels: &p.labels,
                                assignees: &p.assignees,
                            },
                        )
                        .await
                        .map(issue)
                })
            }
            ClientMethod::GitHubIssueUpdate => {
                operation!(GitHubIssueUpdateParams, |p, repository| {
                    client
                        .update_issue(
                            &repository,
                            p.number,
                            github::UpdateIssue {
                                title: p.title.as_deref(),
                                body: p.body.as_deref(),
                                state: p.state.map(state),
                                labels: p.labels.as_deref(),
                                assignees: p.assignees.as_deref(),
                            },
                        )
                        .await
                        .map(issue)
                })
            }
            ClientMethod::GitHubCommentList => operation!(GitHubPageParams, |p, repository| {
                let page = client.comments(&repository, p.number, p.page).await?;
                Ok::<_, github::Error>(GitHubCommentListResult {
                    comments: page.items.into_iter().map(comment).collect(),
                    next_page: page.next_page,
                })
            }),
            ClientMethod::GitHubCommentCreate => {
                operation!(GitHubCommentCreateParams, |p, repository| {
                    client
                        .create_comment(&repository, p.number, &p.body)
                        .await
                        .map(comment)
                })
            }
            ClientMethod::GitHubCommentUpdate => {
                operation!(GitHubCommentUpdateParams, |p, repository| {
                    client
                        .update_comment(&repository, p.comment_id, &p.body)
                        .await
                        .map(comment)
                })
            }
            ClientMethod::GitHubCommentDelete => {
                operation!(GitHubCommentDeleteParams, |p, repository| {
                    client.delete_comment(&repository, p.comment_id).await
                })
            }
            ClientMethod::GitHubPullRequestList => {
                operation!(GitHubPullRequestListParams, |p, repository| {
                    let page = client
                        .pull_requests(&repository, state(p.state), p.page, p.head.as_deref())
                        .await?;
                    Ok::<_, github::Error>(GitHubPullRequestListResult {
                        pull_requests: page.pull_requests.into_iter().map(pull_request).collect(),
                        next_page: page.next_page,
                    })
                })
            }
            ClientMethod::GitHubPullRequestRead => {
                operation!(GitHubNumberParams, |p, repository| {
                    client
                        .pull_request(&repository, p.number)
                        .await
                        .map(pull_request)
                })
            }
            ClientMethod::GitHubPullRequestCreate => {
                operation!(GitHubPullRequestCreateParams, |p, repository| {
                    client
                        .create_pull_request(
                            &repository,
                            github::CreatePullRequest {
                                title: &p.title,
                                body: &p.body,
                                head: &p.head,
                                base: &p.base,
                                draft: p.draft,
                            },
                        )
                        .await
                        .map(pull_request)
                })
            }
            ClientMethod::GitHubPullRequestUpdate => {
                operation!(GitHubPullRequestUpdateParams, |p, repository| {
                    client
                        .update_pull_request(
                            &repository,
                            p.number,
                            github::UpdatePullRequest {
                                title: p.title.as_deref(),
                                body: p.body.as_deref(),
                                state: p.state.map(state),
                                base: p.base.as_deref(),
                            },
                        )
                        .await
                        .map(pull_request)
                })
            }
            ClientMethod::GitHubPullRequestFiles => {
                operation!(GitHubPageParams, |p, repository| {
                    let page = client
                        .pull_request_files(&repository, p.number, p.page)
                        .await?;
                    Ok::<_, github::Error>(review_files(page))
                })
            }
            ClientMethod::GitHubPullRequestReviews => {
                operation!(GitHubPageParams, |p, repository| {
                    let page = client
                        .pull_request_reviews(&repository, p.number, p.page)
                        .await?;
                    Ok::<_, github::Error>(GitHubPullRequestReviewsResult {
                        reviews: page.items.into_iter().map(review).collect(),
                        next_page: page.next_page,
                    })
                })
            }
            ClientMethod::GitHubPullRequestDiff => {
                operation!(GitHubReviewDiffParams, |p, repository| {
                    let diff = client
                        .review_diff(&repository, p.number, &p.commit, p.page)
                        .await?;
                    Ok::<_, github::Error>(GitHubReviewDiffResult {
                        base_commit: diff.base_commit,
                        files: review_files(diff.files),
                    })
                })
            }
            ClientMethod::GitHubFileRead => {
                operation!(GitHubFileReadParams, |p, repository| {
                    client
                        .file_content(&repository, &p.commit, &p.path)
                        .await
                        .map(|content| match content {
                            github::FileContent::Text { text } => GitHubFileContent::Text { text },
                            github::FileContent::Binary => GitHubFileContent::Binary,
                            github::FileContent::TooLarge => GitHubFileContent::TooLarge,
                        })
                })
            }
            ClientMethod::GitHubReviewThreads => {
                operation!(GitHubReviewThreadsParams, |p, repository| {
                    let page = client
                        .review_threads(&repository, p.number, p.cursor.as_deref())
                        .await?;
                    Ok::<_, github::Error>(GitHubReviewThreadsResult {
                        next_cursor: next_review_cursor(
                            page.page_info.has_next_page,
                            page.page_info.end_cursor,
                        )?,
                        threads: page
                            .nodes
                            .into_iter()
                            .map(review_thread)
                            .collect::<github::Result<Vec<_>>>()?,
                    })
                })
            }
            ClientMethod::GitHubReviewThreadRead => {
                operation!(GitHubReviewThreadReadParams, |p, repository| {
                    let comments = client
                        .thread_comments(&repository, p.number, &p.thread_id, p.cursor.as_deref())
                        .await?;
                    review_comments(comments)
                })
            }
            ClientMethod::GitHubReviewThreadReply => {
                operation!(GitHubReviewThreadReplyParams, |p, repository| {
                    client
                        .reply_review_thread(&repository, p.number, &p.thread_id, &p.body)
                        .await
                        .map(review_comment)
                })
            }
            ClientMethod::GitHubReviewThreadResolve => {
                operation!(GitHubReviewThreadResolveParams, |p, repository| {
                    client
                        .resolve_review_thread(
                            &repository,
                            p.number,
                            &p.thread_id,
                            match p.state {
                                GitHubReviewThreadState::Resolved => github::ThreadState::Resolved,
                                GitHubReviewThreadState::Unresolved => {
                                    github::ThreadState::Unresolved
                                }
                            },
                        )
                        .await
                })
            }
            ClientMethod::GitHubPullRequestReview => {
                operation!(GitHubPullRequestReviewParams, |p, repository| {
                    let event = match p.event {
                        GitHubReviewEvent::Approve => github::ReviewEvent::Approve,
                        GitHubReviewEvent::RequestChanges => github::ReviewEvent::RequestChanges,
                        GitHubReviewEvent::Comment => github::ReviewEvent::Comment,
                    };
                    client
                        .review_pull_request(
                            &repository,
                            p.number,
                            &p.commit,
                            event,
                            &p.body,
                            &p.comments
                                .into_iter()
                                .map(|comment| github::ReviewCommentInput {
                                    path: comment.path,
                                    line: comment.line,
                                    side: match comment.side {
                                        GitHubDiffSide::Left => github::DiffSide::Left,
                                        GitHubDiffSide::Right => github::DiffSide::Right,
                                    },
                                    body: comment.body,
                                })
                                .collect::<Vec<_>>(),
                        )
                        .await
                        .map(review)
                })
            }
            ClientMethod::GitHubPullRequestMerge => {
                operation!(GitHubPullRequestMergeParams, |p, repository| {
                    let merged = client
                        .merge_pull_request(
                            &repository,
                            p.number,
                            &p.commit,
                            merge_method(p.method),
                        )
                        .await?;
                    Ok::<_, github::Error>(GitHubMergeResult {
                        commit: merged.sha,
                        merged: merged.merged,
                        message: merged.message,
                    })
                })
            }
            ClientMethod::GitHubPullRequestAutoMerge => {
                operation!(GitHubPullRequestMergeParams, |p, repository| {
                    let pull_request = client.pull_request(&repository, p.number).await?;
                    if !pull_request.head.sha.eq_ignore_ascii_case(&p.commit) {
                        return Err(github::Error::Conflict(
                            "PR head changed since review".into(),
                        ));
                    }
                    client
                        .enable_auto_merge(&repository, &pull_request, merge_method(p.method))
                        .await
                })
            }
            ClientMethod::GitHubChecks => operation!(GitHubChecksParams, |p, repository| {
                let page = client.checks(&repository, &p.commit, p.page).await?;
                Ok::<_, github::Error>(GitHubChecksResult {
                    state: page.state,
                    next_page: page.next_page,
                    statuses: page
                        .statuses
                        .into_iter()
                        .map(|s| GitHubCommitStatus {
                            context: s.context,
                            state: s.state,
                            description: s.description,
                            target_url: s.target_url,
                        })
                        .collect(),
                    checks: page
                        .checks
                        .into_iter()
                        .map(|c| GitHubCheckRun {
                            id: c.id,
                            name: c.name,
                            status: c.status,
                            conclusion: c.conclusion,
                            details_url: c.details_url,
                        })
                        .collect(),
                })
            }),
            ClientMethod::GitHubLabelsList => {
                operation!(GitHubRepositoryParams, |p, repository| {
                    client
                        .issue_labels(&repository)
                        .await
                        .map(|labels| GitHubLabelsResult {
                            labels: labels.into_iter().map(label).collect(),
                        })
                })
            }
            ClientMethod::GitHubLabelCreate => operation!(GitHubLabelParams, |p, repository| {
                client
                    .create_issue_label(&repository, &p.name, &p.color)
                    .await
                    .map(label)
            }),
            ClientMethod::GitHubLabelUpdate => operation!(GitHubLabelParams, |p, repository| {
                client
                    .update_issue_label_color(&repository, &p.name, &p.color)
                    .await
                    .map(label)
            }),
            ClientMethod::GitHubAssigneesList => {
                operation!(GitHubRepositoryParams, |p, repository| {
                    client.issue_assignees(&repository).await.map(|assignees| {
                        GitHubAssigneesResult {
                            assignees: assignees.into_iter().map(|a| a.login).collect(),
                        }
                    })
                })
            }
            _ => Err(RpcError::new(-32601, AppServerErrorName::MethodNotFound)),
        }
    }
}

pub(super) fn cancel(
    scheduler: &super::request_serialization::RequestScheduler,
    cancellations: &super::request_serialization::RequestCancellationRegistry,
    connection: &ConnectionState,
    params: &Value,
) -> Result<Value, RpcError> {
    use super::request_serialization::RequestCancelStatus;
    let params: GitHubCancelParams = decode(params)?;
    if params.operation_id.is_empty() || params.operation_id.chars().count() > 128 {
        return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
    }
    let status = match cancellations.cancel_operation(connection.connection_id, params.operation_id)
    {
        RequestCancelStatus::Requested => GitHubCancelStatus::Requested,
        RequestCancelStatus::AlreadyRequested => GitHubCancelStatus::AlreadyRequested,
        RequestCancelStatus::Completed => GitHubCancelStatus::Completed,
    };
    scheduler.cancel_waiting_requests();
    result(&GitHubCancelResult { status })
}

pub(super) fn account_request(
    accounts: Option<&Arc<dyn github::GitHubAccountManager>>,
    method: ClientMethod,
    params: &Value,
    cancellation: &CancellationToken,
) -> Result<Value, RpcError> {
    let accounts =
        accounts.ok_or_else(|| RpcError::new(-32030, AppServerErrorName::AccountUnavailable))?;
    match method {
        ClientMethod::GitHubAccountList => {
            let _: GitHubAccountListParams = decode(params)?;
            result(&GitHubAccountsResult {
                accounts: accounts
                    .accounts()
                    .map_err(github_authentication_error)?
                    .into_iter()
                    .map(account)
                    .collect(),
            })
        }
        ClientMethod::GitHubAccountConnect => {
            let p: GitHubAccountConnectParams = decode(params)?;
            let connected = accounts
                .connect_token(
                    &p.host,
                    ash_secrets::SecretValue::new(p.token.into_bytes()),
                    cancellation,
                )
                .map_err(github_authentication_error)?;
            result(&account(connected))
        }
        _ => unreachable!("account methods selected above"),
    }
}

fn state(value: IssueState) -> github::IssueState {
    match value {
        IssueState::Open => github::IssueState::Open,
        IssueState::Closed => github::IssueState::Closed,
    }
}
fn merge_method(value: GitHubMergeMethod) -> github::MergeMethod {
    match value {
        GitHubMergeMethod::Merge => github::MergeMethod::Merge,
        GitHubMergeMethod::Squash => github::MergeMethod::Squash,
        GitHubMergeMethod::Rebase => github::MergeMethod::Rebase,
    }
}
fn issue(value: github::Issue) -> GitHubIssue {
    GitHubIssue {
        body: value.body.clone().unwrap_or_default(),
        issue: summary(value),
    }
}
pub(super) fn comment(value: github::Comment) -> IssueComment {
    IssueComment {
        id: value.id,
        body: value.body,
        url: value.html_url,
        updated_at: value.updated_at,
    }
}
fn pull_request(value: github::PullRequest) -> GitHubPullRequest {
    GitHubPullRequest {
        number: value.number,
        title: value.title,
        body: value.body.unwrap_or_default(),
        url: value.html_url,
        state: value.state,
        draft: value.draft,
        merged_at: value.merged_at,
        mergeable: value.mergeable,
        head_commit: value.head.sha,
        head_branch: value.head.name,
        head_repository: value.head.repo.map(|repository| repository.full_name),
        base_branch: value.base.name,
        auto_merge: value.auto_merge.is_some(),
    }
}
fn review(value: github::PullRequestReview) -> GitHubPullRequestReview {
    GitHubPullRequestReview {
        id: value.id,
        body: value.body,
        state: value.state,
        url: value.html_url,
        commit: value.commit_id,
        submitted_at: value.submitted_at,
    }
}
fn label(value: github::IssueLabel) -> GitHubLabel {
    GitHubLabel {
        name: value.name,
        color: value.color,
    }
}

pub(super) fn github_authentication_error(error: ash_login::LoginError) -> RpcError {
    match error.kind() {
        ash_login::LoginErrorKind::ExternalLoginRequired => {
            RpcError::new(-32030, AppServerErrorName::AccountAuthenticationRequired)
        }
        ash_login::LoginErrorKind::Unavailable => {
            RpcError::new(-32030, AppServerErrorName::AccountUnavailable)
        }
        ash_login::LoginErrorKind::InvalidInput
        | ash_login::LoginErrorKind::NotFound
        | ash_login::LoginErrorKind::Conflict
        | ash_login::LoginErrorKind::Driver => {
            RpcError::new(-32030, AppServerErrorName::AccountOperationFailed)
        }
    }
}

pub(super) fn github_error(error: github::Error) -> RpcError {
    use github::Error;
    let name = match &error {
        Error::InvalidInput(_) => AppServerErrorName::InvalidParams,
        Error::AuthenticationRequired => AppServerErrorName::AccountAuthenticationRequired,
        Error::PermissionDenied => AppServerErrorName::GitHubPermissionDenied,
        Error::RateLimited => AppServerErrorName::GitHubRateLimited,
        Error::NotFound => AppServerErrorName::GitHubNotFound,
        Error::Conflict(_) => AppServerErrorName::GitHubConflict,
        Error::Unavailable(_) => AppServerErrorName::GitHubUnavailable,
        Error::TimedOut => AppServerErrorName::GitHubTimedOut,
        Error::Cancelled => AppServerErrorName::RequestCancelled,
        Error::SubmissionUncertain => AppServerErrorName::GitHubSubmissionUncertain,
        Error::InvalidResponse(_) | Error::OperationFailed(_) => {
            AppServerErrorName::GitHubOperationFailed
        }
    };
    let code = match name {
        AppServerErrorName::InvalidParams => -32602,
        AppServerErrorName::RequestCancelled => -32800,
        AppServerErrorName::AccountAuthenticationRequired => -32030,
        _ => -32070,
    };
    let mut result = RpcError::new(code, name);
    result.detail = Some(error.to_string());
    result
}

#[cfg(test)]
#[path = "github_tests.rs"]
mod tests;

fn review_files(files: github::PullRequestFiles) -> GitHubPullRequestFilesResult {
    GitHubPullRequestFilesResult {
        next_page: files.next_page,
        limit_reached: files.limit_reached,
        files: files
            .files
            .into_iter()
            .map(|file| GitHubPullRequestFile {
                filename: file.filename,
                status: file.status,
                additions: file.additions,
                deletions: file.deletions,
                changes: file.changes,
                patch: file.patch,
                previous_filename: file.previous_filename,
            })
            .collect(),
    }
}
fn next_review_cursor(more: bool, cursor: Option<String>) -> github::Result<Option<String>> {
    if more && cursor.as_deref().is_none_or(str::is_empty) {
        return Err(github::Error::InvalidResponse(
            "Missing review pagination cursor".into(),
        ));
    }
    Ok(if more { cursor } else { None })
}
fn review_comment(comment: github::ReviewComment) -> GitHubReviewComment {
    GitHubReviewComment {
        id: comment.id,
        body: comment.body,
        url: comment.url,
        author: comment.author.map(|author| author.login),
        can_update: comment.viewer_can_update,
        can_delete: comment.viewer_can_delete,
    }
}
fn review_comments(comments: github::ThreadComments) -> github::Result<GitHubReviewCommentsResult> {
    Ok(GitHubReviewCommentsResult {
        comments: comments.nodes.into_iter().map(review_comment).collect(),
        next_cursor: next_review_cursor(
            comments.page_info.has_next_page,
            comments.page_info.end_cursor,
        )?,
    })
}
fn review_thread(thread: github::ReviewThread) -> github::Result<GitHubReviewThread> {
    Ok(GitHubReviewThread {
        id: thread.id,
        path: thread.path,
        line: thread.line,
        side: match thread.diff_side {
            github::DiffSide::Left => GitHubDiffSide::Left,
            github::DiffSide::Right => GitHubDiffSide::Right,
        },
        resolved: thread.is_resolved,
        outdated: thread.is_outdated,
        can_resolve: thread.viewer_can_resolve,
        comments: review_comments(thread.comments)?,
    })
}

fn account(value: github::GitHubAccount) -> GitHubAccount {
    GitHubAccount { id: value.id, host: value.host, login: value.login, status: match value.status {
            ash_login::AccountStatus::Ready => ash_app_server_protocol::protocol::account::AccountStatusDto::Ready,
            ash_login::AccountStatus::ReauthenticationRequired => ash_app_server_protocol::protocol::account::AccountStatusDto::ReauthenticationRequired,
            ash_login::AccountStatus::Unavailable => ash_app_server_protocol::protocol::account::AccountStatusDto::Unavailable,
        }, credential_revision: value.credential_revision.to_string() }
}

fn requested_reviewers(value: github::RequestedReviewers) -> GitHubRequestedReviewers {
    GitHubRequestedReviewers {
        users: value.users.into_iter().map(|user| user.login).collect(),
        teams: value.teams.into_iter().map(|team| team.slug).collect(),
    }
}

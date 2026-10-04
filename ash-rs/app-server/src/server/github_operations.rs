use super::AppServer;
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
use serde_json::Value;
use std::sync::Arc;

/// Hosted repository operations do not require a local checkout. The application owns
/// this executor and HTTP configuration; each request captures its account grant.
pub(super) struct GitHubRuntime {
    pub(super) http: Arc<dyn HttpClient>,
    executor: tokio::runtime::Runtime,
}

impl GitHubRuntime {
    pub(super) fn open(http: Arc<dyn HttpClient>) -> Result<Self, String> {
        let executor = tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .worker_threads(1)
            .thread_name("github")
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self { http, executor })
    }
}

impl AppServer {
    pub(super) fn github_client(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<github::GitHub, RpcError> {
        let credentials = self
            .github
            .as_ref()
            .ok_or_else(|| RpcError::new(-32030, AppServerErrorName::AccountUnavailable))?;
        github::GitHub::for_account(
            std::sync::Arc::clone(credentials),
            self.github_runtime
                .as_ref()
                .ok_or_else(|| RpcError::new(-32070, AppServerErrorName::GitHubUnavailable))?
                .http
                .clone(),
            cancellation.clone(),
        )
        .map_err(github_authentication_error)
    }

    pub(super) fn github_request(
        &self,
        method: ClientMethod,
        params: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let runtime = self
            .github_runtime
            .as_ref()
            .ok_or_else(|| RpcError::new(-32070, AppServerErrorName::GitHubUnavailable))?;
        let client = self.github_client(cancellation)?;
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
                let value = runtime
                    .executor
                    .block_on(async { $body })
                    .map_err(github_error)?;
                result(&value)
            }};
        }
        match method {
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
                        .pull_requests(&repository, state(p.state), p.page)
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
                    Ok::<_, github::Error>(GitHubPullRequestFilesResult {
                        next_page: page.next_page,
                        limit_reached: page.limit_reached,
                        files: page
                            .files
                            .into_iter()
                            .map(|f| GitHubPullRequestFile {
                                filename: f.filename,
                                status: f.status,
                                additions: f.additions,
                                deletions: f.deletions,
                                changes: f.changes,
                                patch: f.patch,
                                previous_filename: f.previous_filename,
                            })
                            .collect(),
                    })
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
            ClientMethod::GitHubPullRequestReview => {
                operation!(GitHubPullRequestReviewParams, |p, repository| {
                    let event = match p.event {
                        GitHubReviewEvent::Approve => github::ReviewEvent::Approve,
                        GitHubReviewEvent::RequestChanges => github::ReviewEvent::RequestChanges,
                        GitHubReviewEvent::Comment => github::ReviewEvent::Comment,
                    };
                    client
                        .review_pull_request(&repository, p.number, &p.commit, event, &p.body)
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

    pub(super) fn github_cancel(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        use super::request_serialization::RequestCancelStatus;
        let params: GitHubCancelParams = decode(params)?;
        if params.operation_id.is_empty() || params.operation_id.chars().count() > 128 {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let status = match self
            .request_cancellations
            .cancel_operation(connection.connection_id, params.operation_id)
        {
            RequestCancelStatus::Requested => GitHubCancelStatus::Requested,
            RequestCancelStatus::AlreadyRequested => GitHubCancelStatus::AlreadyRequested,
            RequestCancelStatus::Completed => GitHubCancelStatus::Completed,
        };
        self.request_scheduler.cancel_waiting_requests();
        result(&GitHubCancelResult { status })
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
        head_commit: value.head.sha,
        head_branch: value.head.name,
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
#[path = "github_operations_tests.rs"]
mod tests;

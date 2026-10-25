//! GitHub consumer models, authorization contracts and capability client.
//! OAuth and API implementations belong to the independently supervised extensions.
mod credentials;
mod error;
mod follow_up;
mod models;
mod provider;
mod reporter;
use ash_async_utils::CancellationToken;
pub use credentials::*;
pub use error::Error;
pub use follow_up::PullRequestFollowUp;
pub use models::*;
pub use provider::*;
pub use reporter::GitHubIssueReporter;
use serde_json::Value;
use std::sync::Arc;
pub type Result<T> = std::result::Result<T, Error>;
/// A consumer bound to an exact account grant; it owns no GitHub IO or session state.
pub struct GitHub {
    provider: Arc<dyn GitHubProvider>,
    cancellation: CancellationToken,
    credentials: Arc<dyn GitHubCredentialProvider>,
    authorization: GitHubAuthorization,
}
impl GitHub {
    pub async fn search_repositories(
        &self,
        query: &str,
        page: u32,
    ) -> Result<Page<RemoteRepository>> {
        if let GitHubResponse::SearchRepositories(value) = self
            .invoke(GitHubRequest::SearchRepositories {
                query: query.into(),
                page,
            })
            .await?
        {
            Ok(value)
        } else {
            Err(Error::InvalidResponse(
                "Unexpected repository search response".into(),
            ))
        }
    }
    pub async fn create_repository(
        &self,
        name: &str,
        description: &str,
        visibility: RepositoryVisibility,
    ) -> Result<RemoteRepository> {
        if let GitHubResponse::CreateRepository(value) = self
            .invoke(GitHubRequest::CreateRepository {
                name: name.into(),
                description: description.into(),
                visibility,
            })
            .await?
        {
            Ok(value)
        } else {
            Err(Error::SubmissionUncertain)
        }
    }
    pub async fn repository_branches(
        &self,
        repository: &Repository,
        page: u32,
    ) -> Result<Page<RepositoryBranch>> {
        if let GitHubResponse::RepositoryBranches(value) = self
            .invoke(GitHubRequest::RepositoryBranches {
                repository: repository.clone(),
                page,
            })
            .await?
        {
            Ok(value)
        } else {
            Err(Error::InvalidResponse(
                "Unexpected repository branches response".into(),
            ))
        }
    }
    pub async fn branch_protection(&self, repository: &Repository) -> Result<BranchProtection> {
        if let GitHubResponse::BranchProtection(value) = self
            .invoke(GitHubRequest::BranchProtection {
                repository: repository.clone(),
            })
            .await?
        {
            Ok(value)
        } else {
            Err(Error::InvalidResponse(
                "Unexpected branch protection response".into(),
            ))
        }
    }
    /// Link generation is anonymous and performs no network operation.
    pub async fn share_link(
        provider: Arc<dyn GitHubProvider>,
        link: ShareLink,
        cancellation: CancellationToken,
    ) -> Result<String> {
        let source = cancellation.child_source();
        let _guard = source.cancel_on_drop();
        let result = tokio::task::spawn_blocking(move || {
            provider.call(None, GitHubRequest::ShareLink(link), &source.token())
        })
        .await
        .map_err(|_| Error::Unavailable("GitHub provider worker failed".into()))??;
        if let GitHubResponse::ShareLink(value) = result {
            Ok(value)
        } else {
            Err(Error::InvalidResponse(
                "Unexpected share link response".into(),
            ))
        }
    }
    async fn invoke(&self, request: GitHubRequest) -> Result<GitHubResponse> {
        let provider = self.provider.clone();
        let authorization = self.authorization.clone();
        let source = self.cancellation.child_source();
        let _cancel_on_drop = source.cancel_on_drop();
        let cancellation = source.token();
        let write = request.is_write();
        tokio::task::spawn_blocking(move || {
            provider.call(Some(authorization), request, &cancellation)
        })
        .await
        .map_err(|_| {
            if write {
                Error::SubmissionUncertain
            } else {
                Error::Unavailable("GitHub provider worker failed".into())
            }
        })?
    }
    pub fn for_account(
        credentials: Arc<dyn GitHubCredentialProvider>,
        provider: Arc<dyn GitHubProvider>,
        cancellation: CancellationToken,
    ) -> std::result::Result<Self, ash_login::LoginError> {
        let authorization = credentials.authorization()?;
        Ok(Self {
            provider,
            cancellation,
            credentials,
            authorization,
        })
    }

    pub fn for_selected_account(
        credentials: Arc<dyn GitHubCredentialProvider>,
        provider: Arc<dyn GitHubProvider>,
        cancellation: CancellationToken,
        account_id: &str,
    ) -> std::result::Result<Self, ash_login::LoginError> {
        let authorization = credentials.authorization_for(account_id)?;
        Ok(Self {
            credentials,
            provider,
            cancellation,
            authorization,
        })
    }

    pub fn authorization(&self) -> &GitHubAuthorization {
        &self.authorization
    }

    /// Rejects cache hits after grant revocation or capability disablement.
    pub fn validate_authorization(&self) -> std::result::Result<(), ash_login::LoginError> {
        self.provider.check_available().map_err(|_| {
            ash_login::LoginError::new(
                ash_login::LoginErrorKind::Unavailable,
                "GitHub API extension unavailable",
            )
        })?;
        self.credentials.token(&self.authorization).map(|_| ())
    }

    pub async fn commit(&self, repository: &Repository, sha: &str) -> Result<Commit> {
        match self
            .invoke(GitHubRequest::Commit {
                repository: repository.clone(),
                sha: sha.to_owned(),
            })
            .await?
        {
            GitHubResponse::Commit(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
    pub async fn issues(
        &self,
        repository: &Repository,
        state: IssueState,
        page: u32,
    ) -> Result<IssuePage> {
        match self
            .invoke(GitHubRequest::Issues {
                repository: repository.clone(),
                state,
                page,
            })
            .await?
        {
            GitHubResponse::Issues(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
    pub async fn search_issues(
        &self,
        repository: &Repository,
        state: IssueState,
        query: &str,
        page: u32,
    ) -> Result<IssuePage> {
        match self
            .invoke(GitHubRequest::SearchIssues {
                repository: repository.clone(),
                state,
                query: query.to_owned(),
                page,
            })
            .await?
        {
            GitHubResponse::SearchIssues(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
    pub async fn issue(&self, repository: &Repository, number: u64) -> Result<IssueSnapshot> {
        match self
            .invoke(GitHubRequest::Issue {
                repository: repository.clone(),
                number,
            })
            .await?
        {
            GitHubResponse::Issue(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
    pub async fn comments(
        &self,
        repository: &Repository,
        number: u64,
        page: u32,
    ) -> Result<crate::Page<Comment>> {
        match self
            .invoke(GitHubRequest::Comments {
                repository: repository.clone(),
                number,
                page,
            })
            .await?
        {
            GitHubResponse::Comments(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
    pub async fn create_issue(
        &self,
        repository: &Repository,
        request: CreateIssue<'_>,
    ) -> Result<Issue> {
        match self
            .invoke(GitHubRequest::CreateIssue {
                repository: repository.clone(),
                request: request.into(),
            })
            .await?
        {
            GitHubResponse::CreateIssue(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn update_issue(
        &self,
        repository: &Repository,
        number: u64,
        update: UpdateIssue<'_>,
    ) -> Result<Issue> {
        match self
            .invoke(GitHubRequest::UpdateIssue {
                repository: repository.clone(),
                number,
                update: update.into(),
            })
            .await?
        {
            GitHubResponse::UpdateIssue(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn create_comment(
        &self,
        repository: &Repository,
        number: u64,
        body: &str,
    ) -> Result<Comment> {
        match self
            .invoke(GitHubRequest::CreateComment {
                repository: repository.clone(),
                number,
                body: body.to_owned(),
            })
            .await?
        {
            GitHubResponse::CreateComment(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn update_comment(
        &self,
        repository: &Repository,
        comment_id: u64,
        body: &str,
    ) -> Result<Comment> {
        match self
            .invoke(GitHubRequest::UpdateComment {
                repository: repository.clone(),
                comment_id,
                body: body.to_owned(),
            })
            .await?
        {
            GitHubResponse::UpdateComment(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn delete_comment(&self, repository: &Repository, comment_id: u64) -> Result<()> {
        match self
            .invoke(GitHubRequest::DeleteComment {
                repository: repository.clone(),
                comment_id,
            })
            .await?
        {
            GitHubResponse::DeleteComment(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn update_issue_label_color(
        &self,
        repository: &Repository,
        name: &str,
        color: &str,
    ) -> Result<IssueLabel> {
        match self
            .invoke(GitHubRequest::UpdateIssueLabelColor {
                repository: repository.clone(),
                name: name.to_owned(),
                color: color.to_owned(),
            })
            .await?
        {
            GitHubResponse::UpdateIssueLabelColor(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn automatic_issue_candidates(
        &self,
        repository: &Repository,
        labels: &[String],
        assignee: Option<&str>,
        limit: usize,
    ) -> Result<Vec<IssueMetadata>> {
        match self
            .invoke(GitHubRequest::AutomaticIssueCandidates {
                repository: repository.clone(),
                labels: labels.to_vec(),
                assignee: assignee.map(str::to_owned),
                limit,
            })
            .await?
        {
            GitHubResponse::AutomaticIssueCandidates(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
    pub async fn unassign_issue(
        &self,
        repository: &Repository,
        number: u64,
        owner: &str,
    ) -> Result<()> {
        match self
            .invoke(GitHubRequest::UnassignIssue {
                repository: repository.clone(),
                number,
                owner: owner.to_owned(),
            })
            .await?
        {
            GitHubResponse::UnassignIssue(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn close_completed_issue(&self, repository: &Repository, number: u64) -> Result<()> {
        match self
            .invoke(GitHubRequest::CloseCompletedIssue {
                repository: repository.clone(),
                number,
            })
            .await?
        {
            GitHubResponse::CloseCompletedIssue(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn issue_repository(&self, repository: &Repository) -> Result<IssueRepositoryInfo> {
        match self
            .invoke(GitHubRequest::IssueRepository {
                repository: repository.clone(),
            })
            .await?
        {
            GitHubResponse::IssueRepository(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
    pub async fn issue_metadata(
        &self,
        repository: &Repository,
        number: u64,
    ) -> Result<IssueMetadata> {
        match self
            .invoke(GitHubRequest::IssueMetadata {
                repository: repository.clone(),
                number,
            })
            .await?
        {
            GitHubResponse::IssueMetadata(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
    pub async fn issue_labels(&self, repository: &Repository) -> Result<Vec<IssueLabel>> {
        match self
            .invoke(GitHubRequest::IssueLabels {
                repository: repository.clone(),
            })
            .await?
        {
            GitHubResponse::IssueLabels(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
    pub async fn issue_assignees(&self, repository: &Repository) -> Result<Vec<IssueAssignee>> {
        match self
            .invoke(GitHubRequest::IssueAssignees {
                repository: repository.clone(),
            })
            .await?
        {
            GitHubResponse::IssueAssignees(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
    pub async fn create_issue_label(
        &self,
        repository: &Repository,
        name: &str,
        color: &str,
    ) -> Result<IssueLabel> {
        match self
            .invoke(GitHubRequest::CreateIssueLabel {
                repository: repository.clone(),
                name: name.to_owned(),
                color: color.to_owned(),
            })
            .await?
        {
            GitHubResponse::CreateIssueLabel(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn assign_issue(
        &self,
        repository: &Repository,
        number: u64,
        login: &str,
    ) -> Result<()> {
        match self
            .invoke(GitHubRequest::AssignIssue {
                repository: repository.clone(),
                number,
                login: login.to_owned(),
            })
            .await?
        {
            GitHubResponse::AssignIssue(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn sync_issue_labels(
        &self,
        repository: &Repository,
        number: u64,
        managed: &[String],
        desired: Option<&str>,
        expected: &[String],
    ) -> Result<Vec<String>> {
        match self
            .invoke(GitHubRequest::SyncIssueLabels {
                repository: repository.clone(),
                number,
                managed: managed.to_vec(),
                desired: desired.map(str::to_owned),
                expected: expected.to_vec(),
            })
            .await?
        {
            GitHubResponse::SyncIssueLabels(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn linked_issue_branches(
        &self,
        repository: &Repository,
        issue_id: &str,
    ) -> Result<Vec<LinkedIssueBranch>> {
        match self
            .invoke(GitHubRequest::LinkedIssueBranches {
                repository: repository.clone(),
                issue_id: issue_id.to_owned(),
            })
            .await?
        {
            GitHubResponse::LinkedIssueBranches(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
    pub async fn create_linked_issue_branch(
        &self,
        repository: &Repository,
        issue_id: &str,
        name: &str,
        commit: &str,
    ) -> Result<LinkedIssueBranch> {
        match self
            .invoke(GitHubRequest::CreateLinkedIssueBranch {
                repository: repository.clone(),
                issue_id: issue_id.to_owned(),
                name: name.to_owned(),
                commit: commit.to_owned(),
            })
            .await?
        {
            GitHubResponse::CreateLinkedIssueBranch(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn repository(&self, repository: &Repository) -> Result<RepositoryInfo> {
        match self
            .invoke(GitHubRequest::Repository {
                repository: repository.clone(),
            })
            .await?
        {
            GitHubResponse::Repository(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
    pub async fn pull_requests(
        &self,
        repository: &Repository,
        state: IssueState,
        page: u32,
        head: Option<&str>,
    ) -> Result<PullRequestPage> {
        match self
            .invoke(GitHubRequest::PullRequests {
                repository: repository.clone(),
                state,
                page,
                head: head.map(str::to_owned),
            })
            .await?
        {
            GitHubResponse::PullRequests(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
    pub async fn pull_request_files(
        &self,
        repository: &Repository,
        number: u64,
        page: u32,
    ) -> Result<PullRequestFiles> {
        match self
            .invoke(GitHubRequest::PullRequestFiles {
                repository: repository.clone(),
                number,
                page,
            })
            .await?
        {
            GitHubResponse::PullRequestFiles(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
    pub async fn pull_request_reviews(
        &self,
        repository: &Repository,
        number: u64,
        page: u32,
    ) -> Result<Page<PullRequestReview>> {
        match self
            .invoke(GitHubRequest::PullRequestReviews {
                repository: repository.clone(),
                number,
                page,
            })
            .await?
        {
            GitHubResponse::PullRequestReviews(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
    pub async fn review_pull_request(
        &self,
        repository: &Repository,
        number: u64,
        commit: &str,
        event: ReviewEvent,
        body: &str,
        comments: &[ReviewCommentInput],
    ) -> Result<PullRequestReview> {
        match self
            .invoke(GitHubRequest::ReviewPullRequest {
                repository: repository.clone(),
                number,
                commit: commit.to_owned(),
                event,
                body: body.to_owned(),
                comments: comments.to_vec(),
            })
            .await?
        {
            GitHubResponse::ReviewPullRequest(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn merge_pull_request(
        &self,
        repository: &Repository,
        number: u64,
        commit: &str,
        method: MergeMethod,
    ) -> Result<MergeResult> {
        match self
            .invoke(GitHubRequest::MergePullRequest {
                repository: repository.clone(),
                number,
                commit: commit.to_owned(),
                method,
            })
            .await?
        {
            GitHubResponse::MergePullRequest(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn enable_auto_merge(
        &self,
        repository: &Repository,
        pull_request: &PullRequest,
        method: MergeMethod,
    ) -> Result<()> {
        match self
            .invoke(GitHubRequest::EnableAutoMerge {
                repository: repository.clone(),
                pull_request: pull_request.clone(),
                method,
            })
            .await?
        {
            GitHubResponse::EnableAutoMerge(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn merge_options(&self, repository: &Repository) -> Result<MergeOptions> {
        match self
            .invoke(GitHubRequest::MergeOptions {
                repository: repository.clone(),
            })
            .await?
        {
            GitHubResponse::MergeOptions(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
    pub async fn find_pull_request(
        &self,
        repository: &Repository,
        head: &str,
        base: &str,
    ) -> Result<Option<PullRequest>> {
        match self
            .invoke(GitHubRequest::FindPullRequest {
                repository: repository.clone(),
                head: head.to_owned(),
                base: base.to_owned(),
            })
            .await?
        {
            GitHubResponse::FindPullRequest(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
    pub async fn checks(
        &self,
        repository: &Repository,
        commit: &str,
        page: u32,
    ) -> Result<CheckStatus> {
        match self
            .invoke(GitHubRequest::Checks {
                repository: repository.clone(),
                commit: commit.to_owned(),
                page,
            })
            .await?
        {
            GitHubResponse::Checks(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
    pub async fn check_details(
        &self,
        repository: &Repository,
        number: u64,
        commit: &str,
        check_id: u64,
        page: u32,
    ) -> Result<CheckDetails> {
        match self
            .invoke(GitHubRequest::CheckDetails {
                repository: repository.clone(),
                number,
                commit: commit.into(),
                check_id,
                page,
            })
            .await?
        {
            GitHubResponse::CheckDetails(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "Unexpected check operation response".into(),
            )),
        }
    }
    pub async fn check_log(
        &self,
        repository: &Repository,
        number: u64,
        commit: &str,
        check_id: u64,
    ) -> Result<String> {
        match self
            .invoke(GitHubRequest::CheckLog {
                repository: repository.clone(),
                number,
                commit: commit.into(),
                check_id,
            })
            .await?
        {
            GitHubResponse::CheckLog(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "Unexpected check operation response".into(),
            )),
        }
    }
    pub async fn rerun_check(
        &self,
        repository: &Repository,
        number: u64,
        commit: &str,
        check_id: u64,
    ) -> Result<()> {
        match self
            .invoke(GitHubRequest::RerunCheck {
                repository: repository.clone(),
                number,
                commit: commit.into(),
                check_id,
            })
            .await?
        {
            GitHubResponse::RerunCheck(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn pull_request(&self, repository: &Repository, number: u64) -> Result<PullRequest> {
        match self
            .invoke(GitHubRequest::PullRequest {
                repository: repository.clone(),
                number,
            })
            .await?
        {
            GitHubResponse::PullRequest(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
    pub async fn create_pull_request(
        &self,
        repository: &Repository,
        request: CreatePullRequest<'_>,
    ) -> Result<PullRequest> {
        match self
            .invoke(GitHubRequest::CreatePullRequest {
                repository: repository.clone(),
                request: request.into(),
            })
            .await?
        {
            GitHubResponse::CreatePullRequest(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn update_pull_request(
        &self,
        repository: &Repository,
        number: u64,
        request: UpdatePullRequest<'_>,
    ) -> Result<PullRequest> {
        match self
            .invoke(GitHubRequest::UpdatePullRequest {
                repository: repository.clone(),
                number,
                request: request.into(),
            })
            .await?
        {
            GitHubResponse::UpdatePullRequest(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn requested_reviewers(
        &self,
        repository: &Repository,
        number: u64,
    ) -> Result<RequestedReviewers> {
        match self
            .invoke(GitHubRequest::RequestedReviewers {
                repository: repository.clone(),
                number,
            })
            .await?
        {
            GitHubResponse::RequestedReviewers(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
    pub async fn change_reviewers(
        &self,
        repository: &Repository,
        number: u64,
        change: ReviewerChange,
        users: &[String],
        teams: &[String],
    ) -> Result<RequestedReviewers> {
        match self
            .invoke(GitHubRequest::ChangeReviewers {
                repository: repository.clone(),
                number,
                change,
                users: users.to_vec(),
                teams: teams.to_vec(),
            })
            .await?
        {
            GitHubResponse::ChangeReviewers(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn update_review_comment(
        &self,
        repository: &Repository,
        number: u64,
        comment: &str,
        body: &str,
    ) -> Result<ReviewComment> {
        match self
            .invoke(GitHubRequest::UpdateReviewComment {
                repository: repository.clone(),
                number,
                comment: comment.to_owned(),
                body: body.to_owned(),
            })
            .await?
        {
            GitHubResponse::UpdateReviewComment(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn delete_review_comment(
        &self,
        repository: &Repository,
        number: u64,
        comment: &str,
    ) -> Result<()> {
        match self
            .invoke(GitHubRequest::DeleteReviewComment {
                repository: repository.clone(),
                number,
                comment: comment.to_owned(),
            })
            .await?
        {
            GitHubResponse::DeleteReviewComment(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn review_diff(
        &self,
        repository: &Repository,
        number: u64,
        commit: &str,
        page: u32,
    ) -> Result<ReviewDiff> {
        match self
            .invoke(GitHubRequest::ReviewDiff {
                repository: repository.clone(),
                number,
                commit: commit.to_owned(),
                page,
            })
            .await?
        {
            GitHubResponse::ReviewDiff(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
    pub async fn file_content(
        &self,
        repository: &Repository,
        commit: &str,
        path: &str,
    ) -> Result<FileContent> {
        match self
            .invoke(GitHubRequest::FileContent {
                repository: repository.clone(),
                commit: commit.to_owned(),
                path: path.to_owned(),
            })
            .await?
        {
            GitHubResponse::FileContent(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
    pub async fn review_threads(
        &self,
        repository: &Repository,
        number: u64,
        cursor: Option<&str>,
    ) -> Result<ReviewThreadPage> {
        match self
            .invoke(GitHubRequest::ReviewThreads {
                repository: repository.clone(),
                number,
                cursor: cursor.map(str::to_owned),
            })
            .await?
        {
            GitHubResponse::ReviewThreads(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
    pub async fn thread_comments(
        &self,
        repository: &Repository,
        number: u64,
        thread: &str,
        cursor: Option<&str>,
    ) -> Result<ThreadComments> {
        match self
            .invoke(GitHubRequest::ThreadComments {
                repository: repository.clone(),
                number,
                thread: thread.to_owned(),
                cursor: cursor.map(str::to_owned),
            })
            .await?
        {
            GitHubResponse::ThreadComments(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
    pub async fn reply_review_thread(
        &self,
        repository: &Repository,
        number: u64,
        thread: &str,
        body: &str,
    ) -> Result<ReviewComment> {
        match self
            .invoke(GitHubRequest::ReplyReviewThread {
                repository: repository.clone(),
                number,
                thread: thread.to_owned(),
                body: body.to_owned(),
            })
            .await?
        {
            GitHubResponse::ReplyReviewThread(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn resolve_review_thread(
        &self,
        repository: &Repository,
        number: u64,
        thread: &str,
        state: ThreadState,
    ) -> Result<()> {
        match self
            .invoke(GitHubRequest::ResolveReviewThread {
                repository: repository.clone(),
                number,
                thread: thread.to_owned(),
                state,
            })
            .await?
        {
            GitHubResponse::ResolveReviewThread(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn create_fork(
        &self,
        repository: &Repository,
        fork: &CreateFork,
    ) -> Result<ForkRepository> {
        match self
            .invoke(GitHubRequest::CreateFork {
                repository: repository.clone(),
                fork: fork.clone(),
            })
            .await?
        {
            GitHubResponse::CreateFork(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn notifications(
        &self,
        filter: NotificationFilter,
        page: u32,
    ) -> Result<NotificationPage> {
        match self
            .invoke(GitHubRequest::Notifications { filter, page })
            .await?
        {
            GitHubResponse::Notifications(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
    pub async fn mark_notification_read(&self, thread_id: &str) -> Result<()> {
        match self
            .invoke(GitHubRequest::MarkNotificationRead {
                thread_id: thread_id.to_owned(),
            })
            .await?
        {
            GitHubResponse::MarkNotificationRead(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn mark_notifications_read(&self) -> Result<()> {
        match self.invoke(GitHubRequest::MarkNotificationsRead).await? {
            GitHubResponse::MarkNotificationsRead(value) => Ok(value),
            _ => Err(Error::SubmissionUncertain),
        }
    }
    pub async fn managed_settings(&self) -> Result<Option<Value>> {
        match self.invoke(GitHubRequest::ManagedSettings).await? {
            GitHubResponse::ManagedSettings(value) => Ok(value),
            _ => Err(Error::InvalidResponse(
                "GitHub provider returned a different operation".into(),
            )),
        }
    }
}

#[cfg(test)]
mod client_tests;

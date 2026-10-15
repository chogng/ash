//! Versioned GitHub capability contract; implementations run outside the shared backend.
use crate::*;
use ash_async_utils::CancellationToken;
use serde_json::Value;
/// Product consumers bind one immutable grant to every provider invocation.
pub trait GitHubProvider: Send + Sync {
    /// Rejects cache access when a dynamically selected capability has been disabled.
    /// In-process implementations without an activation lifecycle are always available.
    fn check_available(&self) -> Result<()> {
        Ok(())
    }

    fn call(
        &self,
        authorization: Option<GitHubAuthorization>,
        request: GitHubRequest,
        cancellation: &CancellationToken,
    ) -> Result<GitHubResponse>;
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(
    tag = "operation",
    content = "params",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum GitHubRequest {
    SearchRepositories {
        query: String,
        page: u32,
    },
    CreateRepository {
        name: String,
        description: String,
        visibility: RepositoryVisibility,
    },
    RepositoryBranches {
        repository: Repository,
        page: u32,
    },
    BranchProtection {
        repository: Repository,
    },
    ShareLink(ShareLink),
    Commit {
        repository: Repository,
        sha: String,
    },
    Issues {
        repository: Repository,
        state: IssueState,
        page: u32,
    },
    SearchIssues {
        repository: Repository,
        state: IssueState,
        query: String,
        page: u32,
    },
    Issue {
        repository: Repository,
        number: u64,
    },
    Comments {
        repository: Repository,
        number: u64,
        page: u32,
    },
    CreateIssue {
        repository: Repository,
        request: OwnedCreateIssue,
    },
    UpdateIssue {
        repository: Repository,
        number: u64,
        update: OwnedUpdateIssue,
    },
    CreateComment {
        repository: Repository,
        number: u64,
        body: String,
    },
    UpdateComment {
        repository: Repository,
        comment_id: u64,
        body: String,
    },
    DeleteComment {
        repository: Repository,
        comment_id: u64,
    },
    UpdateIssueLabelColor {
        repository: Repository,
        name: String,
        color: String,
    },
    AutomaticIssueCandidates {
        repository: Repository,
        labels: Vec<String>,
        assignee: Option<String>,
        limit: usize,
    },
    UnassignIssue {
        repository: Repository,
        number: u64,
        owner: String,
    },
    CloseCompletedIssue {
        repository: Repository,
        number: u64,
    },
    IssueRepository {
        repository: Repository,
    },
    IssueMetadata {
        repository: Repository,
        number: u64,
    },
    IssueLabels {
        repository: Repository,
    },
    IssueAssignees {
        repository: Repository,
    },
    CreateIssueLabel {
        repository: Repository,
        name: String,
        color: String,
    },
    AssignIssue {
        repository: Repository,
        number: u64,
        login: String,
    },
    SyncIssueLabels {
        repository: Repository,
        number: u64,
        managed: Vec<String>,
        desired: Option<String>,
        expected: Vec<String>,
    },
    LinkedIssueBranches {
        repository: Repository,
        issue_id: String,
    },
    CreateLinkedIssueBranch {
        repository: Repository,
        issue_id: String,
        name: String,
        commit: String,
    },
    Repository {
        repository: Repository,
    },
    PullRequests {
        repository: Repository,
        state: IssueState,
        page: u32,
        head: Option<String>,
    },
    PullRequestFiles {
        repository: Repository,
        number: u64,
        page: u32,
    },
    PullRequestReviews {
        repository: Repository,
        number: u64,
        page: u32,
    },
    ReviewPullRequest {
        repository: Repository,
        number: u64,
        commit: String,
        event: ReviewEvent,
        body: String,
        comments: Vec<ReviewCommentInput>,
    },
    MergePullRequest {
        repository: Repository,
        number: u64,
        commit: String,
        method: MergeMethod,
    },
    EnableAutoMerge {
        repository: Repository,
        pull_request: PullRequest,
        method: MergeMethod,
    },
    MergeOptions {
        repository: Repository,
    },
    FindPullRequest {
        repository: Repository,
        head: String,
        base: String,
    },
    Checks {
        repository: Repository,
        commit: String,
        page: u32,
    },
    PullRequest {
        repository: Repository,
        number: u64,
    },
    CreatePullRequest {
        repository: Repository,
        request: OwnedCreatePullRequest,
    },
    UpdatePullRequest {
        repository: Repository,
        number: u64,
        request: OwnedUpdatePullRequest,
    },
    RequestedReviewers {
        repository: Repository,
        number: u64,
    },
    ChangeReviewers {
        repository: Repository,
        number: u64,
        change: ReviewerChange,
        users: Vec<String>,
        teams: Vec<String>,
    },
    UpdateReviewComment {
        repository: Repository,
        number: u64,
        comment: String,
        body: String,
    },
    DeleteReviewComment {
        repository: Repository,
        number: u64,
        comment: String,
    },
    ReviewDiff {
        repository: Repository,
        number: u64,
        commit: String,
        page: u32,
    },
    FileContent {
        repository: Repository,
        commit: String,
        path: String,
    },
    ReviewThreads {
        repository: Repository,
        number: u64,
        cursor: Option<String>,
    },
    ThreadComments {
        repository: Repository,
        number: u64,
        thread: String,
        cursor: Option<String>,
    },
    ReplyReviewThread {
        repository: Repository,
        number: u64,
        thread: String,
        body: String,
    },
    ResolveReviewThread {
        repository: Repository,
        number: u64,
        thread: String,
        state: ThreadState,
    },
    CreateFork {
        repository: Repository,
        fork: CreateFork,
    },
    Notifications {
        filter: NotificationFilter,
        page: u32,
    },
    MarkNotificationRead {
        thread_id: String,
    },
    MarkNotificationsRead,
    ManagedSettings,
    ReporterSearch {
        target: String,
        title: String,
    },
    ReporterSubmit {
        target: String,
        title: String,
        body: String,
    },
}
impl GitHubRequest {
    /// A lost invocation result after a possible mutation must never invite automatic retry.
    pub fn is_write(&self) -> bool {
        match self {
            Self::CreateRepository { .. }
            | Self::CreateIssue { .. }
            | Self::UpdateIssue { .. }
            | Self::CreateComment { .. }
            | Self::UpdateComment { .. }
            | Self::DeleteComment { .. }
            | Self::UpdateIssueLabelColor { .. }
            | Self::UnassignIssue { .. }
            | Self::CloseCompletedIssue { .. }
            | Self::CreateIssueLabel { .. }
            | Self::AssignIssue { .. }
            | Self::SyncIssueLabels { .. }
            | Self::CreateLinkedIssueBranch { .. }
            | Self::ReviewPullRequest { .. }
            | Self::MergePullRequest { .. }
            | Self::EnableAutoMerge { .. }
            | Self::CreatePullRequest { .. }
            | Self::UpdatePullRequest { .. }
            | Self::ChangeReviewers { .. }
            | Self::UpdateReviewComment { .. }
            | Self::DeleteReviewComment { .. }
            | Self::ReplyReviewThread { .. }
            | Self::ResolveReviewThread { .. }
            | Self::CreateFork { .. }
            | Self::MarkNotificationRead { .. }
            | Self::MarkNotificationsRead
            | Self::ReporterSubmit { .. } => true,
            Self::SearchRepositories { .. }
            | Self::RepositoryBranches { .. }
            | Self::BranchProtection { .. }
            | Self::ShareLink(_)
            | Self::Commit { .. }
            | Self::Issues { .. }
            | Self::SearchIssues { .. }
            | Self::Issue { .. }
            | Self::Comments { .. }
            | Self::AutomaticIssueCandidates { .. }
            | Self::IssueRepository { .. }
            | Self::IssueMetadata { .. }
            | Self::IssueLabels { .. }
            | Self::IssueAssignees { .. }
            | Self::LinkedIssueBranches { .. }
            | Self::Repository { .. }
            | Self::PullRequests { .. }
            | Self::PullRequestFiles { .. }
            | Self::PullRequestReviews { .. }
            | Self::MergeOptions { .. }
            | Self::FindPullRequest { .. }
            | Self::Checks { .. }
            | Self::PullRequest { .. }
            | Self::RequestedReviewers { .. }
            | Self::ReviewDiff { .. }
            | Self::FileContent { .. }
            | Self::ReviewThreads { .. }
            | Self::ThreadComments { .. }
            | Self::Notifications { .. }
            | Self::ManagedSettings
            | Self::ReporterSearch { .. } => false,
        }
    }
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(
    tag = "operation",
    content = "result",
    rename_all = "camelCase",
    deny_unknown_fields
)]
pub enum GitHubResponse {
    SearchRepositories(Page<RemoteRepository>),
    CreateRepository(RemoteRepository),
    RepositoryBranches(Page<RepositoryBranch>),
    BranchProtection(BranchProtection),
    ShareLink(String),
    Commit(Commit),
    Issues(IssuePage),
    SearchIssues(IssuePage),
    Issue(IssueSnapshot),
    Comments(Page<Comment>),
    CreateIssue(Issue),
    UpdateIssue(Issue),
    CreateComment(super::Comment),
    UpdateComment(super::Comment),
    DeleteComment(()),
    UpdateIssueLabelColor(IssueLabel),
    AutomaticIssueCandidates(Vec<IssueMetadata>),
    UnassignIssue(()),
    CloseCompletedIssue(()),
    IssueRepository(IssueRepositoryInfo),
    IssueMetadata(IssueMetadata),
    IssueLabels(Vec<IssueLabel>),
    IssueAssignees(Vec<IssueAssignee>),
    CreateIssueLabel(IssueLabel),
    AssignIssue(()),
    SyncIssueLabels(Vec<String>),
    LinkedIssueBranches(Vec<LinkedIssueBranch>),
    CreateLinkedIssueBranch(LinkedIssueBranch),
    Repository(RepositoryInfo),
    PullRequests(PullRequestPage),
    PullRequestFiles(PullRequestFiles),
    PullRequestReviews(Page<PullRequestReview>),
    ReviewPullRequest(PullRequestReview),
    MergePullRequest(MergeResult),
    EnableAutoMerge(()),
    MergeOptions(MergeOptions),
    FindPullRequest(Option<PullRequest>),
    Checks(CheckStatus),
    PullRequest(PullRequest),
    CreatePullRequest(PullRequest),
    UpdatePullRequest(PullRequest),
    RequestedReviewers(RequestedReviewers),
    ChangeReviewers(RequestedReviewers),
    UpdateReviewComment(ReviewComment),
    DeleteReviewComment(()),
    ReviewDiff(ReviewDiff),
    FileContent(FileContent),
    ReviewThreads(ReviewThreadPage),
    ThreadComments(ThreadComments),
    ReplyReviewThread(ReviewComment),
    ResolveReviewThread(()),
    CreateFork(ForkRepository),
    Notifications(NotificationPage),
    MarkNotificationRead(()),
    MarkNotificationsRead(()),
    ManagedSettings(Option<Value>),
    ReporterSearch(std::result::Result<Vec<ReporterIssue>, ReporterError>),
    ReporterSubmit(std::result::Result<ReporterIssue, ReporterError>),
}
#[derive(serde::Serialize, serde::Deserialize)]
#[serde(deny_unknown_fields)]
pub struct GitHubInvocation {
    pub authorization: Option<GitHubAuthorization>,
    pub request: GitHubRequest,
}

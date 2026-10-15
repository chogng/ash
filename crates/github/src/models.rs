use crate::*;
use url::Url;
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum ReporterError {
    InvalidInput,
    AuthenticationRequired,
    PermissionDenied,
    RateLimited,
    Unavailable,
    OperationFailed,
    SubmissionUncertain,
    Cancelled,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct ReporterIssue {
    pub number: u64,
    pub html_url: String,
    pub title: String,
    pub state: String,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct Repository {
    pub host: String,
    pub owner: String,
    pub name: String,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct Issue {
    #[serde(default)]
    pub labels: Vec<IssueLabel>,
    #[serde(default)]
    pub assignees: Vec<IssueAssignee>,
    pub number: u64,
    pub title: String,
    pub body: Option<String>,
    pub html_url: String,
    #[serde(default)]
    pub created_at: String,
    pub updated_at: String,
    pub state: String,
    /// Preserve GitHub's reason vocabulary, including values added by the server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub state_reason: Option<String>,
    #[serde(default)]
    pub pull_request: Option<serde_json::Value>,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct Comment {
    pub id: u64,
    pub body: String,
    pub html_url: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct IssueSnapshot {
    pub issue: Issue,
    pub comments: Vec<Comment>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum IssueState {
    Open,
    Closed,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct IssuePage {
    pub issues: Vec<Issue>,
    pub next_page: Option<u32>,
    #[serde(default)]
    pub notice: String,
}

#[derive(Clone, Copy, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct PullRequest {
    pub number: u64,
    pub node_id: String,
    pub title: String,
    pub body: Option<String>,
    pub html_url: String,
    pub state: String,
    pub draft: bool,
    pub merged_at: Option<String>,
    /// GitHub returns null while computing mergeability; it is not a conflict verdict.
    pub mergeable: Option<bool>,
    pub head: PullRequestBranch,
    pub base: PullRequestBranch,
    #[serde(default)]
    pub auto_merge: Option<serde_json::Value>,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct MergeOptions {
    pub allow_merge_commit: bool,
    pub allow_squash_merge: bool,
    pub allow_rebase_merge: bool,
    #[serde(default)]
    pub allow_auto_merge: bool,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct RepositoryInfo {
    #[serde(flatten)]
    pub metadata: IssueRepositoryInfo,
    #[serde(flatten)]
    pub merge_options: MergeOptions,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct Commit {
    pub sha: String,
    pub html_url: String,
    pub commit: CommitDetails,
    pub stats: CommitStats,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct CommitDetails {
    pub message: String,
    pub author: CommitAuthor,
    pub committer: CommitAuthor,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct CommitAuthor {
    pub name: String,
    pub date: String,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct CommitStats {
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct PullRequestBranch {
    pub sha: String,
    #[serde(rename = "ref")]
    pub name: String,
    pub repo: Option<PullRequestRepository>,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct PullRequestRepository {
    pub full_name: String,
}

pub struct CreatePullRequest<'a> {
    pub title: &'a str,
    pub body: &'a str,
    pub head: &'a str,
    pub base: &'a str,
    pub draft: bool,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct OwnedCreatePullRequest {
    pub title: String,
    pub body: String,
    pub head: String,
    pub base: String,
    pub draft: bool,
}
impl From<CreatePullRequest<'_>> for OwnedCreatePullRequest {
    fn from(value: CreatePullRequest<'_>) -> Self {
        Self {
            title: value.title.to_owned(),
            body: value.body.to_owned(),
            head: value.head.to_owned(),
            base: value.base.to_owned(),
            draft: value.draft,
        }
    }
}
impl OwnedCreatePullRequest {
    pub fn as_borrowed(&self) -> CreatePullRequest<'_> {
        CreatePullRequest {
            title: &self.title,
            body: &self.body,
            head: &self.head,
            base: &self.base,
            draft: self.draft,
        }
    }
}

pub struct CreateIssue<'a> {
    pub title: &'a str,
    pub body: &'a str,
    pub labels: &'a [String],
    pub assignees: &'a [String],
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct OwnedCreateIssue {
    pub title: String,
    pub body: String,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
}
impl From<CreateIssue<'_>> for OwnedCreateIssue {
    fn from(value: CreateIssue<'_>) -> Self {
        Self {
            title: value.title.to_owned(),
            body: value.body.to_owned(),
            labels: value.labels.to_vec(),
            assignees: value.assignees.to_vec(),
        }
    }
}
impl OwnedCreateIssue {
    pub fn as_borrowed(&self) -> CreateIssue<'_> {
        CreateIssue {
            title: &self.title,
            body: &self.body,
            labels: &self.labels,
            assignees: &self.assignees,
        }
    }
}

pub struct UpdateIssue<'a> {
    pub title: Option<&'a str>,
    pub body: Option<&'a str>,
    pub state: Option<super::IssueState>,
    pub labels: Option<&'a [String]>,
    pub assignees: Option<&'a [String]>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct OwnedUpdateIssue {
    pub title: Option<String>,
    pub body: Option<String>,
    pub state: Option<super::IssueState>,
    pub labels: Option<Vec<String>>,
    pub assignees: Option<Vec<String>>,
}
impl From<UpdateIssue<'_>> for OwnedUpdateIssue {
    fn from(value: UpdateIssue<'_>) -> Self {
        Self {
            title: value.title.map(str::to_owned),
            body: value.body.map(str::to_owned),
            state: value.state,
            labels: value.labels.map(<[String]>::to_vec),
            assignees: value.assignees.map(<[String]>::to_vec),
        }
    }
}
impl OwnedUpdateIssue {
    pub fn as_borrowed(&self) -> UpdateIssue<'_> {
        UpdateIssue {
            title: self.title.as_deref(),
            body: self.body.as_deref(),
            state: self.state,
            labels: self.labels.as_deref(),
            assignees: self.assignees.as_deref(),
        }
    }
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct IssueLabel {
    pub name: String,
    pub color: String,
    pub node_id: String,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct IssueAssignee {
    pub login: String,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct IssueMetadata {
    #[serde(flatten)]
    pub issue: Issue,
    pub node_id: String,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct IssueRepositoryInfo {
    pub node_id: String,
    pub default_branch: String,
    pub full_name: String,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LinkedIssueBranch {
    pub id: String,
    pub name: String,
    pub commit: String,
}

#[derive(Clone, Copy, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "UPPERCASE")]
pub enum DiffSide {
    Left,
    Right,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct ReviewCommentInput {
    pub path: String,
    pub line: u32,
    pub side: DiffSide,
    pub body: String,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ReviewDiff {
    pub base_commit: String,
    pub files: PullRequestFiles,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum FileContent {
    Text { text: String },
    Binary,
    TooLarge,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewComment {
    pub id: String,
    pub body: String,
    pub url: String,
    pub author: Option<ReviewAuthor>,
    pub viewer_can_update: bool,
    pub viewer_can_delete: bool,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct ReviewAuthor {
    pub login: String,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThread {
    pub id: String,
    pub path: String,
    pub line: Option<u32>,
    pub diff_side: DiffSide,
    pub is_resolved: bool,
    pub is_outdated: bool,
    pub viewer_can_resolve: bool,
    pub comments: ThreadComments,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ThreadComments {
    pub nodes: Vec<ReviewComment>,
    pub page_info: PageInfo,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PageInfo {
    pub has_next_page: bool,
    pub end_cursor: Option<String>,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewThreadPage {
    pub nodes: Vec<ReviewThread>,
    pub page_info: PageInfo,
}

#[derive(Clone, Copy, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ThreadState {
    Resolved,
    Unresolved,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct RequestedReviewers {
    pub users: Vec<ReviewerUser>,
    pub teams: Vec<ReviewerTeam>,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct ReviewerUser {
    pub login: String,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct ReviewerTeam {
    pub slug: String,
}

#[derive(Clone, Copy, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum ReviewerChange {
    Request,
    Remove,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct PullRequestPage {
    pub pull_requests: Vec<PullRequest>,
    pub next_page: Option<u32>,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct Page<T> {
    pub items: Vec<T>,
    pub next_page: Option<u32>,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct PullRequestFiles {
    pub files: Vec<PullRequestFile>,
    pub next_page: Option<u32>,
    /// A full final page reaches GitHub's 3000-file cap and cannot prove completeness.
    pub limit_reached: bool,
}

pub struct UpdatePullRequest<'a> {
    pub title: Option<&'a str>,
    pub body: Option<&'a str>,
    pub state: Option<IssueState>,
    pub base: Option<&'a str>,
}

#[derive(serde::Serialize, serde::Deserialize)]
pub struct OwnedUpdatePullRequest {
    pub title: Option<String>,
    pub body: Option<String>,
    pub state: Option<IssueState>,
    pub base: Option<String>,
}
impl From<UpdatePullRequest<'_>> for OwnedUpdatePullRequest {
    fn from(value: UpdatePullRequest<'_>) -> Self {
        Self {
            title: value.title.map(str::to_owned),
            body: value.body.map(str::to_owned),
            state: value.state,
            base: value.base.map(str::to_owned),
        }
    }
}
impl OwnedUpdatePullRequest {
    pub fn as_borrowed(&self) -> UpdatePullRequest<'_> {
        UpdatePullRequest {
            title: self.title.as_deref(),
            body: self.body.as_deref(),
            state: self.state,
            base: self.base.as_deref(),
        }
    }
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct PullRequestFile {
    pub filename: String,
    pub status: String,
    pub additions: u64,
    pub deletions: u64,
    pub changes: u64,
    pub patch: Option<String>,
    pub previous_filename: Option<String>,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct PullRequestReview {
    pub id: u64,
    pub body: String,
    pub state: String,
    pub html_url: String,
    pub commit_id: String,
    pub submitted_at: Option<String>,
}

#[derive(Clone, Copy, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum ReviewEvent {
    Approve,
    RequestChanges,
    Comment,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct MergeResult {
    pub sha: String,
    pub merged: bool,
    pub message: String,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct CommitStatus {
    pub context: String,
    pub state: String,
    pub description: Option<String>,
    pub target_url: Option<String>,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct CheckRun {
    pub id: u64,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub details_url: Option<String>,
}

#[derive(Clone, Debug, serde::Deserialize, Eq, PartialEq, serde::Serialize)]
pub struct CheckStatus {
    pub state: String,
    pub statuses: Vec<CommitStatus>,
    pub checks: Vec<CheckRun>,
    pub next_page: Option<u32>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum ForkBranches {
    All,
    Default,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct CreateFork {
    pub organization: Option<String>,
    pub name: String,
    pub branches: ForkBranches,
}

#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
/// GitHub has accepted creation; Git objects may still be copying asynchronously.
pub struct ForkRepository {
    pub full_name: String,
    pub html_url: String,
    pub default_branch: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum NotificationFilter {
    Unread,
    All,
    Participating,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct Notification {
    pub id: String,
    pub title: String,
    pub subject_type: String,
    pub reason: String,
    pub unread: bool,
    pub updated_at: String,
    pub repository: Repository,
    pub url: String,
}

#[derive(Clone, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub struct NotificationPage {
    pub notifications: Vec<Notification>,
    pub next_page: Option<u32>,
}
impl Repository {
    pub fn new(host: String, owner: String, name: String) -> Result<Self> {
        if !valid_component(&host) || !valid_component(&owner) || !valid_component(&name) {
            return Err(Error::InvalidInput(
                "Invalid GitHub repository identity".into(),
            ));
        }
        Ok(Self { host, owner, name })
    }
}

fn valid_component(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 255
        && !value.starts_with(['-', '.'])
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
}

/// Validates an issue-list boundary before cache reads, deletion, or GitHub IO.
pub fn validate_issue_query(query: &str, page: u32) -> Result<()> {
    let query = query.trim();
    if query.len() > 256
        || query
            .chars()
            .any(|c| c.is_control() || c == '"' || c == '\\')
    {
        return Err(Error::InvalidInput("Search accepts up to 256 bytes of keywords or #number; quotes and control characters are not supported".into()));
    }
    let maximum = if query.is_empty() { 10_000 } else { 10 };
    if page == 0 || page > maximum {
        return Err(Error::InvalidInput(format!(
            "Issue page must be between 1 and {maximum}"
        )));
    }
    if !query.is_empty() {
        let number = query.strip_prefix('#').unwrap_or(query);
        if query.starts_with('#') || number.bytes().all(|c| c.is_ascii_digit()) {
            let number: u64 = number
                .parse()
                .map_err(|_| Error::InvalidInput("Use a positive issue number".into()))?;
            if number == 0 || page != 1 {
                return Err(Error::InvalidInput(
                    "Exact issue lookup requires a positive number and page 1".into(),
                ));
            }
        }
    }
    Ok(())
}

impl IssueState {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closed => "closed",
        }
    }
}

/// A distribution's report target is independent of the currently open workspace.
pub fn report_repository(target: &str) -> std::result::Result<Repository, ReporterError> {
    let url = Url::parse(target).map_err(|_| ReporterError::InvalidInput)?;
    let parts = url.path().trim_matches('/').split('/').collect::<Vec<_>>();
    if url.scheme() != "https"
        || url.host_str() != Some("github.com")
        || url.port().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || parts.len() != 3
        || parts[2] != "issues"
    {
        return Err(ReporterError::InvalidInput);
    }
    Repository::new("github.com".into(), parts[0].into(), parts[1].into())
        .map_err(|_| ReporterError::InvalidInput)
}

impl std::fmt::Display for ReporterError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(match self {
            Self::InvalidInput => "Invalid issue report",
            Self::AuthenticationRequired => "GitHub authentication is required",
            Self::PermissionDenied => "GitHub issue write permission is required",
            Self::RateLimited => "GitHub rate limit reached",
            Self::Unavailable => "Issue reporter is unavailable",
            Self::OperationFailed => "GitHub issue operation failed",
            Self::SubmissionUncertain => {
                "GitHub may have created the issue; check the repository before submitting again"
            }
            Self::Cancelled => "Issue search cancelled",
        })
    }
}

impl std::error::Error for ReporterError {}

/// Metadata validated against the selected account's hosting instance.
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct RemoteRepository {
    pub repository: Repository,
    pub description: Option<String>,
    pub stars: u64,
    pub private: bool,
    pub default_branch: String,
    pub html_url: String,
    pub clone_url: String,
    pub ssh_url: String,
}
#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum RepositoryVisibility {
    Private,
    Public,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct RepositoryBranch {
    pub name: String,
    pub default: bool,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct BranchProtectionRule {
    pub include: Vec<String>,
    pub exclude: Vec<String>,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct BranchProtection {
    pub default_branch: Option<String>,
    pub rules: Vec<BranchProtectionRule>,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "camelCase")]
pub enum ShareReference {
    Commit(String),
    Branch(String),
}
#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ShareTarget {
    GitHub,
    VscodeDev,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ShareLineRange {
    pub start: u32,
    pub end: u32,
}
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct ShareLink {
    pub path_kind: SharePathKind,
    pub repository: Repository,
    pub reference: ShareReference,
    pub target: ShareTarget,
    pub path: Option<String>,
    pub lines: Option<ShareLineRange>,
    pub notebook_cell: Option<u32>,
}

#[derive(Clone, Copy, Debug, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum SharePathKind {
    File,
    Directory,
}

use crate::JsonSchema;
use crate::TS;
use crate::protocol::issues::IssueComment;
use crate::protocol::issues::IssueRepository;
use crate::protocol::issues::IssueState;
use crate::protocol::issues::IssueSummary;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum GitHubMergeMethod {
    Merge,
    Squash,
    Rebase,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum GitHubReviewEvent {
    Approve,
    RequestChanges,
    Comment,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum GitHubCancelStatus {
    Requested,
    AlreadyRequested,
    Completed,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubRepositoryParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubNumberParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    #[ts(type = "number")]
    pub number: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubPageParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    #[ts(type = "number")]
    pub number: u64,
    pub page: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubIssueListParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    pub state: IssueState,
    pub query: String,
    pub page: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubIssueListResult {
    pub issues: Vec<IssueSummary>,
    pub next_page: Option<u32>,
    pub notice: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubIssueCreateParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    pub title: String,
    pub body: String,
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubIssueUpdateParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    #[ts(type = "number")]
    pub number: u64,
    pub title: Option<String>,
    pub body: Option<String>,
    pub state: Option<IssueState>,
    pub labels: Option<Vec<String>>,
    pub assignees: Option<Vec<String>>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubIssue {
    pub issue: IssueSummary,
    pub body: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubCommentListResult {
    pub comments: Vec<IssueComment>,
    pub next_page: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubCommentCreateParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    #[ts(type = "number")]
    pub number: u64,
    pub body: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubCommentUpdateParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    #[ts(type = "number")]
    pub comment_id: u64,
    pub body: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubCommentDeleteParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    #[ts(type = "number")]
    pub comment_id: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubPullRequestListParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    pub state: IssueState,
    pub page: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubPullRequest {
    #[ts(type = "number")]
    pub number: u64,
    pub title: String,
    pub body: String,
    pub url: String,
    pub state: String,
    pub draft: bool,
    pub merged_at: Option<String>,
    pub head_commit: String,
    pub head_branch: String,
    pub head_repository: Option<String>,
    pub base_branch: String,
    pub auto_merge: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubPullRequestListResult {
    pub pull_requests: Vec<GitHubPullRequest>,
    pub next_page: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubPullRequestCreateParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    pub title: String,
    pub body: String,
    pub head: String,
    pub base: String,
    pub draft: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubPullRequestUpdateParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    #[ts(type = "number")]
    pub number: u64,
    pub title: Option<String>,
    pub body: Option<String>,
    pub state: Option<IssueState>,
    pub base: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubPullRequestFile {
    pub filename: String,
    pub status: String,
    #[ts(type = "number")]
    pub additions: u64,
    #[ts(type = "number")]
    pub deletions: u64,
    #[ts(type = "number")]
    pub changes: u64,
    pub patch: Option<String>,
    pub previous_filename: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubPullRequestFilesResult {
    pub files: Vec<GitHubPullRequestFile>,
    pub next_page: Option<u32>,
    pub limit_reached: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubPullRequestReview {
    #[ts(type = "number")]
    pub id: u64,
    pub body: String,
    pub state: String,
    pub url: String,
    pub commit: String,
    pub submitted_at: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubPullRequestReviewsResult {
    pub reviews: Vec<GitHubPullRequestReview>,
    pub next_page: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubPullRequestReviewParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    #[ts(type = "number")]
    pub number: u64,
    pub commit: String,
    pub event: GitHubReviewEvent,
    pub body: String,
    #[serde(default)]
    pub comments: Vec<GitHubReviewCommentInput>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "UPPERCASE")]
pub enum GitHubDiffSide {
    Left,
    Right,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubReviewCommentInput {
    pub path: String,
    pub line: u32,
    pub side: GitHubDiffSide,
    pub body: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubReviewDiffParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    #[ts(type = "number")]
    pub number: u64,
    pub commit: String,
    pub page: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubReviewDiffResult {
    pub base_commit: String,
    pub files: GitHubPullRequestFilesResult,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubFileReadParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    pub commit: String,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
pub enum GitHubFileContent {
    Text { text: String },
    Binary,
    TooLarge,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubReviewThreadsParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    #[ts(type = "number")]
    pub number: u64,
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubReviewThreadReadParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    #[ts(type = "number")]
    pub number: u64,
    pub thread_id: String,
    pub cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubReviewThreadReplyParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    #[ts(type = "number")]
    pub number: u64,
    pub thread_id: String,
    pub body: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum GitHubReviewThreadState {
    Resolved,
    Unresolved,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubReviewThreadResolveParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    #[ts(type = "number")]
    pub number: u64,
    pub thread_id: String,
    pub state: GitHubReviewThreadState,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubReviewComment {
    pub id: String,
    pub body: String,
    pub url: String,
    pub author: Option<String>,
    pub can_update: bool,
    pub can_delete: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubReviewCommentsResult {
    pub comments: Vec<GitHubReviewComment>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubReviewThread {
    pub id: String,
    pub path: String,
    pub line: Option<u32>,
    pub side: GitHubDiffSide,
    pub resolved: bool,
    pub outdated: bool,
    pub can_resolve: bool,
    pub comments: GitHubReviewCommentsResult,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubReviewThreadsResult {
    pub threads: Vec<GitHubReviewThread>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubPullRequestMergeParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    #[ts(type = "number")]
    pub number: u64,
    pub commit: String,
    pub method: GitHubMergeMethod,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubMergeResult {
    pub commit: String,
    pub merged: bool,
    pub message: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubChecksParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    pub commit: String,
    pub page: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubCommitParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    pub sha: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubCommit {
    pub sha: String,
    pub url: String,
    pub message: String,
    pub author: String,
    pub committed_at: String,
    #[ts(type = "number")]
    pub additions: u64,
    #[ts(type = "number")]
    pub deletions: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubCommitStatus {
    pub context: String,
    pub state: String,
    pub description: Option<String>,
    pub target_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubCheckRun {
    #[ts(type = "number")]
    pub id: u64,
    pub name: String,
    pub status: String,
    pub conclusion: Option<String>,
    pub details_url: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubChecksResult {
    pub state: String,
    pub statuses: Vec<GitHubCommitStatus>,
    pub checks: Vec<GitHubCheckRun>,
    pub next_page: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubRepositoryResult {
    pub default_branch: String,
    pub full_name: String,
    pub allow_merge_commit: bool,
    pub allow_squash_merge: bool,
    pub allow_rebase_merge: bool,
    pub allow_auto_merge: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubLabel {
    pub name: String,
    pub color: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubLabelsResult {
    pub labels: Vec<GitHubLabel>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubLabelParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    pub name: String,
    pub color: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubAssigneesResult {
    pub assignees: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubCancelParams {
    pub operation_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubCancelResult {
    pub status: GitHubCancelStatus,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubAccount {
    pub id: String,
    pub host: String,
    pub login: String,
    pub status: crate::protocol::account::AccountStatusDto,
    pub credential_revision: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubAccountsResult {
    pub accounts: Vec<GitHubAccount>,
}

/// Credentials are accepted only as explicit user input and never returned or formatted in diagnostics.
#[derive(Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubAccountConnectParams {
    pub operation_id: String,
    pub host: String,
    pub token: String,
}

impl std::fmt::Debug for GitHubAccountConnectParams {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("GitHubAccountConnectParams")
            .field("operation_id", &self.operation_id)
            .field("host", &self.host)
            .finish_non_exhaustive()
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubAccountListParams {
    pub operation_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubReviewCommentEditParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    #[ts(type = "number")]
    pub number: u64,
    pub comment_id: String,
    pub body: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubReviewCommentDeleteParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    #[ts(type = "number")]
    pub number: u64,
    pub comment_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum GitHubReviewerChange {
    Request,
    Remove,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubReviewersChangeParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    #[ts(type = "number")]
    pub number: u64,
    pub change: GitHubReviewerChange,
    pub users: Vec<String>,
    pub teams: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubRequestedReviewers {
    pub users: Vec<String>,
    pub teams: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubNotificationsParams {
    pub operation_id: String,
    pub account_id: String,
    pub filter: GitHubNotificationFilter,
    pub page: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubNotificationReadParams {
    pub operation_id: String,
    pub account_id: String,
    pub thread_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubNotificationsReadParams {
    pub operation_id: String,
    pub account_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubNotification {
    pub id: String,
    pub title: String,
    pub subject_type: String,
    pub reason: String,
    pub unread: bool,
    pub updated_at: String,
    pub repository: IssueRepository,
    pub url: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubNotificationsResult {
    pub notifications: Vec<GitHubNotification>,
    pub next_page: Option<u32>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubForkCreateParams {
    pub operation_id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub account_id: Option<String>,
    pub repository: IssueRepository,
    pub organization: Option<String>,
    pub name: String,
    pub branches: GitHubForkBranches,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubForkResult {
    pub full_name: String,
    pub url: String,
    pub default_branch: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum GitHubNotificationFilter {
    Unread,
    All,
    Participating,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum GitHubForkBranches {
    All,
    Default,
}

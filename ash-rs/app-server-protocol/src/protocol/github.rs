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
    pub repository: IssueRepository,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubNumberParams {
    pub operation_id: String,
    pub repository: IssueRepository,
    #[ts(type = "number")]
    pub number: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubPageParams {
    pub operation_id: String,
    pub repository: IssueRepository,
    #[ts(type = "number")]
    pub number: u64,
    pub page: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubIssueListParams {
    pub operation_id: String,
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
    pub repository: IssueRepository,
    #[ts(type = "number")]
    pub number: u64,
    pub body: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubCommentUpdateParams {
    pub operation_id: String,
    pub repository: IssueRepository,
    #[ts(type = "number")]
    pub comment_id: u64,
    pub body: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubCommentDeleteParams {
    pub operation_id: String,
    pub repository: IssueRepository,
    #[ts(type = "number")]
    pub comment_id: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubPullRequestListParams {
    pub operation_id: String,
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
    pub repository: IssueRepository,
    #[ts(type = "number")]
    pub number: u64,
    pub commit: String,
    pub event: GitHubReviewEvent,
    pub body: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubPullRequestMergeParams {
    pub operation_id: String,
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
    pub repository: IssueRepository,
    pub commit: String,
    pub page: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitHubCommitParams {
    pub operation_id: String,
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

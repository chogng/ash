//! GitHub account authorization and repository operations.
//!
//! Account credentials belong to Ash's profile secret store. Repository operations
//! bind shared HTTP requests to one explicit Ash authorization.

mod api;
mod auth;
mod error;
mod forks;
mod issues;
mod notifications;
mod pull_requests;
mod reporter;
mod reviews;
pub use auth::GITHUB_PROVIDER_ID;
pub use auth::GitHubAccount;
pub use auth::GitHubAccountManager;
pub use auth::GitHubAuthorization;
pub use auth::GitHubBrowserConfig;
pub use auth::GitHubCredentialProvider;
pub use auth::GitHubOAuth;
pub use error::Error;
pub use forks::CreateFork;
pub use forks::ForkBranches;
pub use forks::ForkRepository;
pub use issues::CreateIssue;
pub use issues::IssueAssignee;
pub use issues::IssueLabel;
pub use issues::IssueMetadata;
pub use issues::IssueRepositoryInfo;
pub use issues::LinkedIssueBranch;
pub use issues::UpdateIssue;
pub use notifications::Notification;
pub use notifications::NotificationFilter;
pub use notifications::NotificationPage;
pub use pull_requests::CheckRun;
pub use pull_requests::CheckStatus;
pub use pull_requests::CommitStatus;
pub use pull_requests::MergeResult;
pub use pull_requests::Page;
pub use pull_requests::PullRequestFile;
pub use pull_requests::PullRequestFiles;
pub use pull_requests::PullRequestPage;
pub use pull_requests::PullRequestReview;
pub use pull_requests::ReviewEvent;
pub use pull_requests::UpdatePullRequest;
pub use reporter::GitHubIssueReporter;
pub use reporter::ReporterError;
pub use reporter::ReporterIssue;
pub use reporter::report_repository;
pub use reviews::DiffSide;
pub use reviews::FileContent;
pub use reviews::RequestedReviewers;
pub use reviews::ReviewComment;
pub use reviews::ReviewCommentInput;
pub use reviews::ReviewDiff;
pub use reviews::ReviewThread;
pub use reviews::ReviewThreadPage;
pub use reviews::ReviewerChange;
pub use reviews::ThreadComments;
pub use reviews::ThreadState;

use ash_async_utils::CancellationToken;
use ash_http_client::HttpClient;
use ash_http_client::HttpMethod;
use serde::Deserialize;
use serde::Serialize;
use serde_json::json;
use std::sync::Arc;

pub type Result<T> = std::result::Result<T, Error>;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Repository {
    pub host: String,
    pub owner: String,
    pub name: String,
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

    fn endpoint(&self, suffix: &str) -> String {
        format!("repos/{}/{}/{}", self.owner, self.name, suffix)
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
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
    #[serde(default)]
    pub pull_request: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Comment {
    pub id: u64,
    pub body: String,
    pub html_url: String,
    pub updated_at: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct IssueSnapshot {
    pub issue: Issue,
    pub comments: Vec<Comment>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum IssueState {
    Open,
    Closed,
}

impl IssueState {
    pub(crate) fn as_str(self) -> &'static str {
        match self {
            Self::Open => "open",
            Self::Closed => "closed",
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct IssuePage {
    pub issues: Vec<Issue>,
    pub next_page: Option<u32>,
    #[serde(default)]
    pub notice: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum MergeMethod {
    Merge,
    Squash,
    Rebase,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct MergeOptions {
    pub allow_merge_commit: bool,
    pub allow_squash_merge: bool,
    pub allow_rebase_merge: bool,
    #[serde(default)]
    pub allow_auto_merge: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RepositoryInfo {
    #[serde(flatten)]
    pub metadata: IssueRepositoryInfo,
    #[serde(flatten)]
    pub merge_options: MergeOptions,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Commit {
    pub sha: String,
    pub html_url: String,
    pub commit: CommitDetails,
    pub stats: CommitStats,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CommitDetails {
    pub message: String,
    pub author: CommitAuthor,
    pub committer: CommitAuthor,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CommitAuthor {
    pub name: String,
    pub date: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CommitStats {
    pub additions: u64,
    pub deletions: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PullRequestBranch {
    pub sha: String,
    #[serde(rename = "ref")]
    pub name: String,
    pub repo: Option<PullRequestRepository>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
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

/// GitHub-specific IO; callers supply a previously authorized repository identity.
pub struct GitHub {
    http: Arc<dyn HttpClient>,
    cancellation: CancellationToken,
    credentials: Arc<dyn GitHubCredentialProvider>,
    authorization: GitHubAuthorization,
}

impl GitHub {
    /// Reads an immutable commit identity, never a movable branch or tag.
    pub async fn commit(&self, repository: &Repository, sha: &str) -> Result<Commit> {
        if !(7..=40).contains(&sha.len()) || !sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(Error::InvalidInput("Use a hexadecimal commit SHA".into()));
        }
        let commit: Commit = self
            .api(
                repository,
                HttpMethod::Get,
                &repository.endpoint(&format!("commits/{sha}")),
                None,
            )
            .await?;
        if commit.sha.len() != 40
            || !commit.sha.bytes().all(|byte| byte.is_ascii_hexdigit())
            || !commit
                .sha
                .to_ascii_lowercase()
                .starts_with(&sha.to_ascii_lowercase())
        {
            return Err(Error::InvalidResponse(
                "GitHub returned a different commit".into(),
            ));
        }
        Ok(commit)
    }

    pub fn for_account(
        credentials: Arc<dyn GitHubCredentialProvider>,
        http: Arc<dyn HttpClient>,
        cancellation: CancellationToken,
    ) -> std::result::Result<Self, ash_login::LoginError> {
        let authorization = credentials.authorization()?;
        Ok(Self {
            http,
            cancellation,
            credentials,
            authorization,
        })
    }

    pub fn for_selected_account(
        credentials: Arc<dyn GitHubCredentialProvider>,
        http: Arc<dyn HttpClient>,
        cancellation: CancellationToken,
        account_id: &str,
    ) -> std::result::Result<Self, ash_login::LoginError> {
        let authorization = credentials.authorization_for(account_id)?;
        Ok(Self {
            credentials,
            http,
            cancellation,
            authorization,
        })
    }

    pub fn authorization(&self) -> &GitHubAuthorization {
        &self.authorization
    }

    /// Rejects results from a revoked or replaced grant, including cache hits.
    pub fn validate_authorization(&self) -> std::result::Result<(), ash_login::LoginError> {
        self.credentials.token(&self.authorization).map(|_| ())
    }

    pub async fn issues(
        &self,
        repository: &Repository,
        state: IssueState,
        page: u32,
    ) -> Result<IssuePage> {
        if page == 0 || page > 10_000 {
            return Err(Error::InvalidInput(
                "Issue page must be between 1 and 10000".into(),
            ));
        }
        let rows: Vec<Issue> = self
            .api(
                repository,
                HttpMethod::Get,
                &repository.endpoint(&format!(
                    "issues?state={}&sort=updated&direction=desc&per_page=100&page={page}",
                    state.as_str()
                )),
                None,
            )
            .await?;
        let next_page = (rows.len() == 100 && page < 10_000).then_some(page + 1);
        Ok(IssuePage {
            issues: rows
                .into_iter()
                .filter(|issue| issue.pull_request.is_none())
                .collect(),
            next_page,
            notice: String::new(),
        })
    }

    /// Searches only the supplied repository and issue state. Numeric input is an exact lookup.
    pub async fn search_issues(
        &self,
        repository: &Repository,
        state: IssueState,
        query: &str,
        page: u32,
    ) -> Result<IssuePage> {
        let query = query.trim();
        validate_issue_query(query, page)?;
        if query.is_empty() {
            return self.issues(repository, state, page).await;
        }
        if page == 0 || page > 10 {
            return Err(Error::InvalidInput(
                "Search supports pages 1–10; narrow the query beyond 1000 matches".into(),
            ));
        }
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
            let issue: Issue = self
                .api(
                    repository,
                    HttpMethod::Get,
                    &repository.endpoint(&format!("issues/{number}")),
                    None,
                )
                .await?;
            if issue.number != number || issue.pull_request.is_some() {
                return Err(Error::InvalidResponse(
                    "Selected item is not the requested issue".into(),
                ));
            }
            return Ok(IssuePage {
                issues: if issue.state == state.as_str() {
                    vec![issue]
                } else {
                    vec![]
                },
                next_page: None,
                notice: String::new(),
            });
        }
        #[derive(Deserialize)]
        struct SearchResult {
            items: Vec<Issue>,
            total_count: u64,
            incomplete_results: bool,
        }
        let terms = query
            .split_whitespace()
            .map(|term| format!("\"{term}\""))
            .collect::<Vec<_>>()
            .join(" ");
        let search = format!(
            "repo:{}/{} is:issue state:{} in:title,body {terms}",
            repository.owner,
            repository.name,
            state.as_str()
        );
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("q", &search)
            .append_pair("sort", "updated")
            .append_pair("order", "desc")
            .append_pair("per_page", "100")
            .append_pair("page", &page.to_string())
            .finish();
        let result: SearchResult = self
            .api(
                repository,
                HttpMethod::Get,
                &format!("search/issues?{query}"),
                None,
            )
            .await?;
        let prefix = format!(
            "https://{}/{}/{}/issues/",
            repository.host, repository.owner, repository.name
        );
        if result.items.iter().any(|issue| {
            !issue
                .html_url
                .to_lowercase()
                .starts_with(&prefix.to_lowercase())
                || issue.state != state.as_str()
                || issue.pull_request.is_some()
        }) {
            return Err(Error::InvalidResponse(
                "Search returned items outside the requested repository or state".into(),
            ));
        }
        let notice = match (result.incomplete_results, result.total_count > 1000) {
            (true, _) => "GitHub returned incomplete search results; refine the query or refresh",
            (_, true) => "GitHub search exposes the first 1000 matches; refine the query",
            _ => "",
        }
        .into();
        Ok(IssuePage {
            next_page: (page < 10 && u64::from(page) * 100 < result.total_count)
                .then_some(page + 1),
            issues: result.items,
            notice,
        })
    }

    pub async fn issue(&self, repository: &Repository, number: u64) -> Result<IssueSnapshot> {
        self.read_issue(repository, number).await
    }

    async fn read_issue(&self, repository: &Repository, number: u64) -> Result<IssueSnapshot> {
        if number == 0 {
            return Err(Error::InvalidInput("Issue number must be positive".into()));
        }
        let issue: Issue = self
            .api(
                repository,
                HttpMethod::Get,
                &repository.endpoint(&format!("issues/{number}")),
                None,
            )
            .await?;
        if issue.number != number || issue.pull_request.is_some() {
            return Err(Error::InvalidResponse(
                "Selected item is not the requested issue".into(),
            ));
        }
        let mut comments = Vec::new();
        let mut context_bytes = issue.body.as_ref().map_or(0, String::len);
        for page in 1..=100 {
            let rows: Vec<Comment> = self
                .api(
                    repository,
                    HttpMethod::Get,
                    &repository.endpoint(&format!(
                        "issues/{number}/comments?per_page=100&page={page}"
                    )),
                    None,
                )
                .await?;
            let complete = rows.len() < 100;
            context_bytes += rows
                .iter()
                .map(|comment| {
                    comment.body.len() + comment.html_url.len() + comment.updated_at.len()
                })
                .sum::<usize>();
            if context_bytes > 4 * 1024 * 1024 {
                return Err(Error::OperationFailed("Issue context exceeds 4 MiB".into()));
            }
            comments.extend(rows);
            if complete {
                return Ok(IssueSnapshot { issue, comments });
            }
        }
        Err(Error::OperationFailed(
            "Issue exceeds the supported comment limit; no partial context was submitted".into(),
        ))
    }
}

#[cfg(test)]
#[path = "github_tests.rs"]
mod tests;

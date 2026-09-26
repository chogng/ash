//! GitHub account authorization and repository operations.
//!
//! Account credentials belong to Ash's profile secret store. Repository issue and PR
//! operations currently use the host's authenticated GitHub CLI.

mod auth;
mod issues;
mod process;
pub use auth::GITHUB_PROVIDER_ID;
pub use auth::GitHubOAuth;
pub use issues::IssueAssignee;
pub use issues::IssueLabel;
pub use issues::IssueMetadata;
pub use issues::IssueRepositoryInfo;
pub use issues::LinkedIssueBranch;

use serde::Deserialize;
use serde::Serialize;
use serde_json::json;
use std::path::PathBuf;

pub type Result<T> = std::result::Result<T, String>;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Repository {
    pub host: String,
    pub owner: String,
    pub name: String,
}

impl Repository {
    pub fn new(host: String, owner: String, name: String) -> Result<Self> {
        if !valid_component(&host) || !valid_component(&owner) || !valid_component(&name) {
            return Err("Invalid GitHub repository identity".into());
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
        return Err("Search accepts up to 256 bytes of keywords or #number; quotes and control characters are not supported".into());
    }
    let maximum = if query.is_empty() { 10_000 } else { 10 };
    if page == 0 || page > maximum {
        return Err(format!("Issue page must be between 1 and {maximum}"));
    }
    if !query.is_empty() {
        let number = query.strip_prefix('#').unwrap_or(query);
        if query.starts_with('#') || number.bytes().all(|c| c.is_ascii_digit()) {
            let number: u64 = number.parse().map_err(|_| "Use a positive issue number")?;
            if number == 0 || page != 1 {
                return Err("Exact issue lookup requires a positive number and page 1".into());
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
    pub updated_at: String,
    pub state: String,
    #[serde(default)]
    pub pull_request: Option<serde_json::Value>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Comment {
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
    fn as_str(self) -> &'static str {
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
    pub html_url: String,
    pub state: String,
    pub draft: bool,
    pub merged_at: Option<String>,
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
pub struct PullRequestBranch {
    pub sha: String,
    #[serde(rename = "ref")]
    pub name: String,
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
    executable: PathBuf,
}

impl Default for GitHub {
    fn default() -> Self {
        Self {
            executable: PathBuf::from("gh"),
        }
    }
}

impl GitHub {
    pub async fn merge_options(&self, repository: &Repository) -> Result<MergeOptions> {
        self.api(
            repository,
            "GET",
            &format!("repos/{}/{}", repository.owner, repository.name),
            None,
        )
        .await
    }

    pub async fn find_pull_request(
        &self,
        repository: &Repository,
        head: &str,
        base: &str,
    ) -> Result<Option<PullRequest>> {
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("state", "all")
            .append_pair("head", &format!("{}:{head}", repository.owner))
            .append_pair("base", base)
            .append_pair("per_page", "100")
            .finish();
        let requests: Vec<PullRequest> = self
            .api(
                repository,
                "GET",
                &repository.endpoint(&format!("pulls?{query}")),
                None,
            )
            .await?;
        if requests.len() > 1 {
            return Err(
                "Multiple PRs exist for this task branch; select the intended PR on GitHub".into(),
            );
        }
        Ok(requests.into_iter().next())
    }

    pub async fn checks(&self, repository: &Repository, commit: &str) -> Result<String> {
        if !(40..=64).contains(&commit.len())
            || !commit.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err("Invalid PR commit".into());
        }
        let statuses: serde_json::Value = self
            .api(
                repository,
                "GET",
                &repository.endpoint(&format!("commits/{commit}/status")),
                None,
            )
            .await?;
        let runs: serde_json::Value = self
            .api(
                repository,
                "GET",
                &repository.endpoint(&format!("commits/{commit}/check-runs?per_page=100")),
                None,
            )
            .await?;
        let mut lines = vec![format!(
            "Commit status: {}",
            statuses
                .get("state")
                .and_then(serde_json::Value::as_str)
                .unwrap_or("unknown")
        )];
        if let Some(checks) = runs.get("check_runs").and_then(serde_json::Value::as_array) {
            for check in checks {
                let name = check
                    .get("name")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("check");
                let status = check
                    .get("conclusion")
                    .and_then(serde_json::Value::as_str)
                    .or_else(|| check.get("status").and_then(serde_json::Value::as_str))
                    .unwrap_or("unknown");
                lines.push(format!("{name}: {status}"));
            }
            if runs
                .get("total_count")
                .and_then(serde_json::Value::as_u64)
                .is_some_and(|total| total > checks.len() as u64)
            {
                lines.push("Additional checks are available on GitHub".into());
            }
        }
        Ok(lines.join("\n"))
    }
    async fn api<T: serde::de::DeserializeOwned>(
        &self,
        repository: &Repository,
        method: &str,
        endpoint: &str,
        body: Option<serde_json::Value>,
    ) -> Result<T> {
        Repository::new(
            repository.host.clone(),
            repository.owner.clone(),
            repository.name.clone(),
        )?;
        let mut arguments = vec![
            "api".to_owned(),
            "--hostname".into(),
            repository.host.clone(),
            "--method".into(),
            method.into(),
            endpoint.into(),
        ];
        let input = body
            .map(|body| serde_json::to_vec(&body))
            .transpose()
            .map_err(|error| error.to_string())?;
        if input.is_some() {
            arguments.extend(["--input".into(), "-".into()]);
        }
        let output = process::run(&self.executable, &arguments, input.as_deref()).await?;
        let value: serde_json::Value = serde_json::from_slice(&output)
            .map_err(|error| format!("Invalid GitHub response: {error}"))?;
        if let Some(errors) = value.get("errors") {
            return Err(format!("GitHub rejected the request: {errors}"));
        }
        serde_json::from_value(value).map_err(|error| format!("Invalid GitHub response: {error}"))
    }

    pub async fn issues(
        &self,
        repository: &Repository,
        state: IssueState,
        page: u32,
    ) -> Result<IssuePage> {
        if page == 0 || page > 10_000 {
            return Err("Issue page must be between 1 and 10000".into());
        }
        let rows: Vec<Issue> = self
            .api(
                repository,
                "GET",
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
            return Err("Search supports pages 1–10; narrow the query beyond 1000 matches".into());
        }
        let number = query.strip_prefix('#').unwrap_or(query);
        if query.starts_with('#') || number.bytes().all(|c| c.is_ascii_digit()) {
            let number: u64 = number.parse().map_err(|_| "Use a positive issue number")?;
            if number == 0 || page != 1 {
                return Err("Exact issue lookup requires a positive number and page 1".into());
            }
            let issue: Issue = self
                .api(
                    repository,
                    "GET",
                    &repository.endpoint(&format!("issues/{number}")),
                    None,
                )
                .await?;
            if issue.number != number || issue.pull_request.is_some() {
                return Err("Selected item is not the requested issue".into());
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
            .api(repository, "GET", &format!("search/issues?{query}"), None)
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
            return Err("Search returned items outside the requested repository or state".into());
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
        tokio::time::timeout(
            std::time::Duration::from_secs(30),
            self.read_issue(repository, number),
        )
        .await
        .map_err(|_| "Reading issue context timed out".to_string())?
    }

    async fn read_issue(&self, repository: &Repository, number: u64) -> Result<IssueSnapshot> {
        if number == 0 {
            return Err("Issue number must be positive".into());
        }
        let issue: Issue = self
            .api(
                repository,
                "GET",
                &repository.endpoint(&format!("issues/{number}")),
                None,
            )
            .await?;
        if issue.number != number || issue.pull_request.is_some() {
            return Err("Selected item is not the requested issue".into());
        }
        let mut comments = Vec::new();
        let mut context_bytes = issue.body.as_ref().map_or(0, String::len);
        for page in 1..=100 {
            let rows: Vec<Comment> = self
                .api(
                    repository,
                    "GET",
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
                return Err("Issue context exceeds 4 MiB".into());
            }
            comments.extend(rows);
            if complete {
                return Ok(IssueSnapshot { issue, comments });
            }
        }
        Err("Issue exceeds the supported comment limit; no partial context was submitted".into())
    }

    pub async fn pull_request(&self, repository: &Repository, number: u64) -> Result<PullRequest> {
        if number == 0 {
            return Err("PR number must be positive".into());
        }
        self.api(
            repository,
            "GET",
            &repository.endpoint(&format!("pulls/{number}")),
            None,
        )
        .await
    }

    pub async fn create_pull_request(
        &self,
        repository: &Repository,
        request: CreatePullRequest<'_>,
    ) -> Result<PullRequest> {
        if request.title.trim().is_empty() || request.head == request.base {
            return Err("PR requires a title and distinct head/base branches".into());
        }
        self.api(
            repository,
            "POST",
            &repository.endpoint("pulls"),
            Some(json!({
                "title": request.title, "body": request.body, "head": request.head,
                "base": request.base, "draft": request.draft,
            })),
        )
        .await
    }

    pub async fn enable_auto_merge(
        &self,
        repository: &Repository,
        pull_request: &PullRequest,
        method: MergeMethod,
    ) -> Result<()> {
        if pull_request.draft || pull_request.state != "open" {
            return Err("Automatic merge requires an open, non-draft PR".into());
        }
        Repository::new(
            repository.host.clone(),
            repository.owner.clone(),
            repository.name.clone(),
        )?;
        let method = match method {
            MergeMethod::Merge => "--merge",
            MergeMethod::Squash => "--squash",
            MergeMethod::Rebase => "--rebase",
        };
        let arguments = vec![
            "pr".into(),
            "merge".into(),
            pull_request.number.to_string(),
            "--repo".into(),
            format!(
                "{}/{}/{}",
                repository.host, repository.owner, repository.name
            ),
            "--auto".into(),
            method.into(),
            "--match-head-commit".into(),
            pull_request.head.sha.clone(),
        ];
        process::run(&self.executable, &arguments, None).await?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "github_tests.rs"]
mod tests;

//! GitHub API implementation, executed by the independently supervised Rust extension.
mod api;
mod dispatch;
mod error;
mod forks;
mod issues;
mod links;
mod managed_settings;
mod notifications;
mod provider;
mod pull_requests;
mod reporter;
mod repositories;
mod reviews;
mod runtime;
mod services;
use ash_async_utils::CancellationToken;
use ash_http_client::HttpClient;
use ash_http_client::HttpMethod;
use github::*;
pub use provider::ApiProvider;
use reporter::GitHubIssueReporter;
pub use runtime::GitHubExtension;
use serde::Deserialize;
use serde_json::json;
use std::sync::Arc;

/// GitHub-specific IO; callers supply a previously authorized repository identity.
struct GitHub {
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
                &crate::endpoint(repository, &format!("commits/{sha}")),
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

    #[cfg(test)]
    fn for_account(
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
                &crate::endpoint(
                    repository,
                    &format!(
                        "issues?state={}&sort=updated&direction=desc&per_page=100&page={page}",
                        state.as_str()
                    ),
                ),
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
                    &crate::endpoint(repository, &format!("issues/{number}")),
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
                &crate::endpoint(repository, &format!("issues/{number}")),
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
                    &crate::endpoint(
                        repository,
                        &format!("issues/{number}/comments?per_page=100&page={page}"),
                    ),
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

#[cfg(test)]
mod managed_settings_tests;

fn valid_component(value: &str) -> bool {
    github::Repository::new("github.com".into(), value.into(), "repository".into()).is_ok()
}
fn endpoint(repository: &Repository, suffix: &str) -> String {
    format!("repos/{}/{}/{}", repository.owner, repository.name, suffix)
}

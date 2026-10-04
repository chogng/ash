use crate::GitHubCredentialProvider;
use crate::Repository;
use ash_async_utils::CancellationToken;
use ash_http_client::HttpClient;
use ash_http_client::HttpHeader;
use ash_http_client::HttpMethod;
use ash_http_client::HttpRequest;
use ash_http_client::HttpResponse;
use serde::Deserialize;
use std::sync::Arc;
use url::Url;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
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

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct ReporterIssue {
    pub number: u64,
    pub html_url: String,
    pub title: String,
    pub state: String,
}

/// A distribution's report target is independent of the currently open workspace.
pub fn report_repository(target: &str) -> Result<Repository, ReporterError> {
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

/// Uses Ash's outbound network policy; credentials never cross the renderer boundary.
pub struct GitHubIssueReporter {
    repository: Repository,
    http: Arc<dyn HttpClient>,
}

impl GitHubIssueReporter {
    pub fn new(target: &str, http: Arc<dyn HttpClient>) -> Result<Self, ReporterError> {
        Ok(Self {
            repository: report_repository(target)?,
            http,
        })
    }

    pub fn target(&self) -> String {
        format!(
            "https://github.com/{}/{}/issues",
            self.repository.owner, self.repository.name
        )
    }

    pub fn search(
        &self,
        title: &str,
        cancellation: &CancellationToken,
    ) -> Result<Vec<ReporterIssue>, ReporterError> {
        let title = title.trim();
        if title.is_empty() || title.chars().count() > 256 || title.chars().any(char::is_control) {
            return Err(ReporterError::InvalidInput);
        }
        // Only plain words enter the query, so user text cannot escape the product repository.
        let words = title
            .split(|character: char| !character.is_alphanumeric())
            .filter(|word| !word.is_empty())
            .take(32)
            .collect::<Vec<_>>();
        if words.is_empty() {
            return Err(ReporterError::InvalidInput);
        }
        let mut url =
            Url::parse("https://api.github.com/search/issues").expect("static GitHub API URL");
        url.query_pairs_mut()
            .append_pair(
                "q",
                &format!(
                    "repo:{}/{} is:issue {} in:title",
                    self.repository.owner,
                    self.repository.name,
                    words.join(" ")
                ),
            )
            .append_pair("per_page", "5");
        let request = HttpRequest::new(HttpMethod::Get, url.as_str(), headers(), vec![])
            .map_err(|_| ReporterError::InvalidInput)?
            .without_redirects();
        let response = self
            .http
            .execute_with_cancellation(&request, cancellation)
            .map_err(|_| {
                if cancellation.is_cancelled() {
                    ReporterError::Cancelled
                } else {
                    ReporterError::OperationFailed
                }
            })?;
        validate_status(&response)?;
        #[derive(Deserialize)]
        struct Search {
            items: Vec<ReporterIssue>,
        }
        let search: Search =
            serde_json::from_slice(response.body()).map_err(|_| ReporterError::OperationFailed)?;
        for issue in &search.items {
            self.validate_issue(issue)?;
        }
        Ok(search.items.into_iter().take(5).collect())
    }

    pub fn submit(
        &self,
        credentials: &dyn GitHubCredentialProvider,
        title: &str,
        body: &str,
    ) -> Result<ReporterIssue, ReporterError> {
        if title.trim().is_empty()
            || title.chars().count() > 256
            || title.chars().any(char::is_control)
            || body.trim().is_empty()
            || body.chars().count() > 65_536
            || body.contains('\0')
        {
            return Err(ReporterError::InvalidInput);
        }
        let authorization = credentials.authorization().map_err(login_error)?;
        if authorization.host != self.repository.host {
            return Err(ReporterError::AuthenticationRequired);
        }
        let token = credentials.token(&authorization).map_err(login_error)?;
        let token = std::str::from_utf8(token.expose())
            .map_err(|_| ReporterError::AuthenticationRequired)?;
        let mut headers = headers();
        headers.push(HttpHeader::new("Authorization", format!("Bearer {token}")));
        let body = serde_json::to_vec(&serde_json::json!({"title": title.trim(), "body": body}))
            .map_err(|_| ReporterError::InvalidInput)?;
        let request = HttpRequest::post(
            format!(
                "https://api.github.com/repos/{}/{}/issues",
                self.repository.owner, self.repository.name
            ),
            headers,
            body,
        )
        .map_err(|_| ReporterError::InvalidInput)?
        .without_redirects();
        // Creating an issue is a single attempt. A lost response must never trigger an automatic
        // retry, and logout after sending cannot turn a successful creation into a false failure.
        let response = self
            .http
            .execute(&request)
            .map_err(|_| ReporterError::SubmissionUncertain)?;
        if response.status() >= 500 {
            return Err(ReporterError::SubmissionUncertain);
        }
        validate_status(&response)?;
        if response.status() != 201 {
            return Err(ReporterError::SubmissionUncertain);
        }
        let issue = serde_json::from_slice(response.body())
            .map_err(|_| ReporterError::SubmissionUncertain)?;
        self.validate_issue(&issue)
            .map_err(|_| ReporterError::SubmissionUncertain)?;
        Ok(issue)
    }

    fn validate_issue(&self, issue: &ReporterIssue) -> Result<(), ReporterError> {
        if issue.number == 0
            || issue.html_url != format!("{}/{}", self.target(), issue.number)
            || !matches!(issue.state.as_str(), "open" | "closed")
        {
            return Err(ReporterError::OperationFailed);
        }
        Ok(())
    }
}

fn headers() -> Vec<HttpHeader> {
    vec![
        HttpHeader::new("Accept", "application/vnd.github+json"),
        HttpHeader::new("Content-Type", "application/json"),
        HttpHeader::new("User-Agent", "Ash-Issue-Reporter"),
        HttpHeader::new("X-GitHub-Api-Version", "2022-11-28"),
    ]
}

fn login_error(error: ash_login::LoginError) -> ReporterError {
    match error.kind() {
        ash_login::LoginErrorKind::ExternalLoginRequired => ReporterError::AuthenticationRequired,
        ash_login::LoginErrorKind::Unavailable => ReporterError::Unavailable,
        ash_login::LoginErrorKind::InvalidInput
        | ash_login::LoginErrorKind::NotFound
        | ash_login::LoginErrorKind::Conflict
        | ash_login::LoginErrorKind::Driver => ReporterError::OperationFailed,
    }
}

fn validate_status(response: &HttpResponse) -> Result<(), ReporterError> {
    match response.status() {
        200..=299 => Ok(()),
        401 => Err(ReporterError::AuthenticationRequired),
        429 => Err(ReporterError::RateLimited),
        403 if response.headers().iter().any(|header| {
            header.name().eq_ignore_ascii_case("x-ratelimit-remaining") && header.value() == "0"
        }) =>
        {
            Err(ReporterError::RateLimited)
        }
        403 => Err(ReporterError::PermissionDenied),
        422 => Err(ReporterError::InvalidInput),
        _ => Err(ReporterError::OperationFailed),
    }
}

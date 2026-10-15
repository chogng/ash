use crate::GitHub;
use crate::GitHubIssueReporter;
use ash_async_utils::CancellationToken;
use ash_http_client::HttpClient;
use github::*;
use std::sync::Arc;

/// API capability implementation. Production supplies invocation-scoped host services;
/// domain tests can supply the same credential and HTTP contracts directly.
pub struct ApiProvider {
    credentials: Arc<dyn GitHubCredentialProvider>,
    http: Arc<dyn HttpClient>,
}
impl ApiProvider {
    pub fn new(credentials: Arc<dyn GitHubCredentialProvider>, http: Arc<dyn HttpClient>) -> Self {
        Self { credentials, http }
    }
}
impl GitHubProvider for ApiProvider {
    fn call(
        &self,
        authorization: Option<GitHubAuthorization>,
        request: GitHubRequest,
        cancellation: &CancellationToken,
    ) -> Result<GitHubResponse> {
        match request {
            GitHubRequest::ShareLink(link) => {
                cancellation.check().map_err(|_| Error::Cancelled)?;
                crate::links::share_link(link).map(GitHubResponse::ShareLink)
            }
            GitHubRequest::ReporterSearch { target, title } => Ok(GitHubResponse::ReporterSearch(
                GitHubIssueReporter::new(&target, self.http.clone())
                    .and_then(|reporter| reporter.search(&title, cancellation)),
            )),
            GitHubRequest::ReporterSubmit {
                target,
                title,
                body,
            } => {
                let authorization = authorization.ok_or(Error::AuthenticationRequired)?;
                let credentials = SelectedCredentials {
                    credentials: self.credentials.clone(),
                    authorization,
                };
                Ok(GitHubResponse::ReporterSubmit(
                    GitHubIssueReporter::new(&target, self.http.clone())
                        .and_then(|reporter| reporter.submit(&credentials, &title, &body)),
                ))
            }
            request => {
                let authorization = authorization.ok_or(Error::AuthenticationRequired)?;
                let client = GitHub {
                    authorization,
                    credentials: self.credentials.clone(),
                    http: self.http.clone(),
                    cancellation: cancellation.clone(),
                };
                let runtime = tokio::runtime::Builder::new_current_thread()
                    .enable_time()
                    .build()
                    .map_err(|_| Error::Unavailable("GitHub API executor unavailable".into()))?;
                runtime.block_on(crate::dispatch::dispatch(&client, request))
            }
        }
    }
}
struct SelectedCredentials {
    credentials: Arc<dyn GitHubCredentialProvider>,
    authorization: GitHubAuthorization,
}
impl GitHubCredentialProvider for SelectedCredentials {
    fn authorization(&self) -> std::result::Result<GitHubAuthorization, ash_login::LoginError> {
        Ok(self.authorization.clone())
    }
    fn token(
        &self,
        authorization: &GitHubAuthorization,
    ) -> std::result::Result<ash_secrets::SecretValue, ash_login::LoginError> {
        self.credentials.token(authorization)
    }
}

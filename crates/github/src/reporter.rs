use crate::*;
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use std::sync::Arc;
/// Product issue reporting through the selected GitHub capability provider.
pub struct GitHubIssueReporter {
    target: String,
    provider: Arc<dyn GitHubProvider>,
}
impl GitHubIssueReporter {
    pub fn new(
        target: &str,
        provider: Arc<dyn GitHubProvider>,
    ) -> std::result::Result<Self, ReporterError> {
        let repository = report_repository(target)?;
        Ok(Self {
            target: format!(
                "https://github.com/{}/{}/issues",
                repository.owner, repository.name
            ),
            provider,
        })
    }
    pub fn target(&self) -> String {
        self.target.clone()
    }
    pub fn search(
        &self,
        title: &str,
        cancellation: &CancellationToken,
    ) -> std::result::Result<Vec<ReporterIssue>, ReporterError> {
        match self
            .provider
            .call(
                None,
                GitHubRequest::ReporterSearch {
                    target: self.target.clone(),
                    title: title.into(),
                },
                cancellation,
            )
            .map_err(reporter_error)?
        {
            GitHubResponse::ReporterSearch(result) => result,
            _ => Err(ReporterError::OperationFailed),
        }
    }
    pub fn submit(
        &self,
        credentials: &dyn GitHubCredentialProvider,
        title: &str,
        body: &str,
    ) -> std::result::Result<ReporterIssue, ReporterError> {
        let authorization = credentials
            .authorization()
            .map_err(|error| reporter_error(Error::from(error)))?;
        match self
            .provider
            .call(
                Some(authorization),
                GitHubRequest::ReporterSubmit {
                    target: self.target.clone(),
                    title: title.into(),
                    body: body.into(),
                },
                &CancellationSource::new().token(),
            )
            .map_err(reporter_error)?
        {
            GitHubResponse::ReporterSubmit(result) => result,
            _ => Err(ReporterError::SubmissionUncertain),
        }
    }
}
fn reporter_error(error: Error) -> ReporterError {
    match error {
        Error::InvalidInput(_) => ReporterError::InvalidInput,
        Error::AuthenticationRequired => ReporterError::AuthenticationRequired,
        Error::PermissionDenied => ReporterError::PermissionDenied,
        Error::RateLimited => ReporterError::RateLimited,
        Error::Unavailable(_) => ReporterError::Unavailable,
        Error::Cancelled => ReporterError::Cancelled,
        Error::SubmissionUncertain => ReporterError::SubmissionUncertain,
        Error::NotFound
        | Error::Conflict(_)
        | Error::TimedOut
        | Error::InvalidResponse(_)
        | Error::OperationFailed(_) => ReporterError::OperationFailed,
    }
}

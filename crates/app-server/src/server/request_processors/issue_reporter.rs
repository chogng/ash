use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::issue_reporter::IssueReporterCancelParams;
use ash_app_server_protocol::protocol::issue_reporter::IssueReporterCancelResult;
use ash_app_server_protocol::protocol::issue_reporter::IssueReporterCancelStatus;
use ash_app_server_protocol::protocol::issue_reporter::IssueReporterContext;
use ash_app_server_protocol::protocol::issue_reporter::IssueReporterIssue;
use ash_app_server_protocol::protocol::issue_reporter::IssueReporterSearchParams;
use ash_app_server_protocol::protocol::issue_reporter::IssueReporterSearchResult;
use ash_app_server_protocol::protocol::issue_reporter::IssueReporterSubmitParams;
use ash_async_utils::CancellationToken;
use serde_json::Value;

/// Borrows only the issue reporter domain services for one request.
/// Composition retains their lifetimes; this adapter cannot access other server state.
pub(super) struct IssueReporterRequestProcessor<'a> {
    github_processor: &'a Option<super::Arc<super::github_processor::GitHubRequestProcessor>>,
    issue_reporter: &'a Option<github::GitHubIssueReporter>,
    request_cancellations: &'a super::RequestCancellationRegistry,
    request_scheduler: &'a super::RequestScheduler,
}

impl<'a> IssueReporterRequestProcessor<'a> {
    pub(super) fn new(
        github_processor: &'a Option<super::Arc<super::github_processor::GitHubRequestProcessor>>,
        issue_reporter: &'a Option<github::GitHubIssueReporter>,
        request_cancellations: &'a super::RequestCancellationRegistry,
        request_scheduler: &'a super::RequestScheduler,
    ) -> Self {
        Self {
            github_processor,
            issue_reporter,
            request_cancellations,
            request_scheduler,
        }
    }
}

impl<'a> IssueReporterRequestProcessor<'a> {
    fn reporter(&self) -> Result<&'a github::GitHubIssueReporter, RpcError> {
        self.issue_reporter
            .as_ref()
            .ok_or_else(|| reporter_error(github::ReporterError::Unavailable))
    }

    pub(super) fn issue_reporter_read(&self) -> Result<Value, RpcError> {
        result(&IssueReporterContext {
            report_issue_url: self.reporter()?.target(),
            version: build_info::VERSION.into(),
            os: std::env::consts::OS.into(),
            arch: std::env::consts::ARCH.into(),
        })
    }

    pub(super) fn issue_reporter_search(
        &self,
        params: &Value,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: IssueReporterSearchParams = decode(params)?;
        let issues = self
            .reporter()?
            .search(&params.title, cancellation)
            .map_err(reporter_error)?;
        result(&IssueReporterSearchResult {
            issues: issues.into_iter().map(issue).collect(),
        })
    }

    pub(super) fn issue_reporter_search_cancel(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        use super::request_serialization::RequestCancelStatus;
        let params: IssueReporterCancelParams = decode(params)?;
        let status = match self
            .request_cancellations
            .cancel_operation(connection.connection_id, params.operation_id)
        {
            RequestCancelStatus::Requested => IssueReporterCancelStatus::Requested,
            RequestCancelStatus::AlreadyRequested => IssueReporterCancelStatus::AlreadyRequested,
            RequestCancelStatus::Completed => IssueReporterCancelStatus::Completed,
        };
        self.request_scheduler.cancel_waiting_requests();
        result(&IssueReporterCancelResult { status })
    }

    pub(super) fn issue_reporter_submit(&self, params: &Value) -> Result<Value, RpcError> {
        let params: IssueReporterSubmitParams = decode(params)?;
        let processor = self
            .github_processor
            .as_ref()
            .ok_or_else(|| reporter_error(github::ReporterError::Unavailable))?;
        result(&issue(
            self.reporter()?
                .submit(processor.credentials(), &params.title, &params.body)
                .map_err(reporter_error)?,
        ))
    }
}

fn issue(value: github::ReporterIssue) -> IssueReporterIssue {
    IssueReporterIssue {
        number: value.number,
        url: value.html_url,
        title: value.title,
        state: value.state,
    }
}

fn reporter_error(error: github::ReporterError) -> RpcError {
    use github::ReporterError;
    let name = match error {
        ReporterError::InvalidInput => AppServerErrorName::InvalidParams,
        ReporterError::AuthenticationRequired => AppServerErrorName::AccountAuthenticationRequired,
        ReporterError::PermissionDenied => AppServerErrorName::IssueReporterPermissionDenied,
        ReporterError::RateLimited => AppServerErrorName::IssueReporterRateLimited,
        ReporterError::Unavailable => AppServerErrorName::IssueReporterUnavailable,
        ReporterError::OperationFailed => AppServerErrorName::IssueOperationFailed,
        ReporterError::SubmissionUncertain => AppServerErrorName::IssueReporterSubmissionUncertain,
        ReporterError::Cancelled => AppServerErrorName::RequestCancelled,
    };
    RpcError::new(
        if name == AppServerErrorName::RequestCancelled {
            -32800
        } else {
            -32070
        },
        name,
    )
}

//! OpenAI/Codex backend business APIs, separate from model wire protocols.

mod usage;

pub use usage::CreditBalance;
pub use usage::RateLimit;
pub use usage::RateLimitWindow;
pub use usage::RateLimits;

use async_utils::CancellationToken;
use client::ClientError;
use client::ClientRequest;
use client::OperationClient;
use client::ResolvedApiTarget;
use client::RetryPolicy;
use http_client::HttpMethod;
use std::fmt;

pub const CHATGPT_BACKEND_BASE_URL: &str = "https://chatgpt.com/backend-api";

/// Selects the upstream API contract explicitly, independently of the hostname.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RouteStyle {
    Codex,
    ChatGpt,
}

/// A redacted failure. Response bodies and credentials never become error text.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RequestError {
    InvalidTarget,
    Cancelled,
    Transport,
    HttpStatus(u16),
    InvalidResponse,
}

impl fmt::Display for RequestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidTarget => formatter.write_str("invalid backend API target"),
            Self::Cancelled => formatter.write_str("backend request cancelled"),
            Self::Transport => formatter.write_str("backend transport failed"),
            Self::HttpStatus(status) => write!(formatter, "backend returned HTTP {status}"),
            Self::InvalidResponse => formatter.write_str("invalid backend response"),
        }
    }
}

impl std::error::Error for RequestError {}

impl From<ClientError> for RequestError {
    fn from(error: ClientError) -> Self {
        match error {
            ClientError::Cancelled(_) => Self::Cancelled,
            ClientError::InvalidRequest(_) => Self::InvalidTarget,
            ClientError::InvalidResponse(_) | ClientError::Framing(_) => Self::InvalidResponse,
            ClientError::Transport(_) => Self::Transport,
        }
    }
}

/// Executes business requests using a freshly resolved authentication target.
/// The injected transport must reject redirects for authenticated requests.
pub struct BackendClient<'a> {
    client: &'a dyn OperationClient,
    target: &'a ResolvedApiTarget,
    route: RouteStyle,
}

impl<'a> BackendClient<'a> {
    pub fn new(
        client: &'a dyn OperationClient,
        target: &'a ResolvedApiTarget,
        route: RouteStyle,
    ) -> Result<Self, RequestError> {
        let url = url::Url::parse(&target.base_url).map_err(|_| RequestError::InvalidTarget)?;
        if url.scheme() != "https"
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(RequestError::InvalidTarget);
        }
        Ok(Self {
            client,
            target,
            route,
        })
    }

    pub fn read_rate_limits(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<RateLimits, RequestError> {
        let route = match self.route {
            RouteStyle::Codex => "api/codex",
            RouteStyle::ChatGpt => "wham",
        };
        let request = ClientRequest::new(
            HttpMethod::Get,
            format!(
                "{}/{route}/usage",
                self.target.base_url.trim_end_matches('/')
            ),
            self.target.headers.clone(),
            Vec::new(),
            RetryPolicy::never(),
        )?;
        let response = self
            .client
            .execute_with_cancellation(&request, cancellation)?;
        if !response.is_success() {
            return Err(RequestError::HttpStatus(response.status()));
        }
        usage::decode(response.body())
    }
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;

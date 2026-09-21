use ::client::ClientError;
use ::client::ClientRequest;
use ::client::ClientResponse;
use ::client::OperationClient;
use ::client::ResolvedApiTarget;
use ::client::RetryPolicy;
use async_utils::CancellationToken;
use http_client::HttpHeader;
use http_client::HttpMethod;
use serde::Serialize;
use serde::de::DeserializeOwned;
use std::fmt;
use url::Url;

pub const CHATGPT_BACKEND_BASE_URL: &str = "https://chatgpt.com/backend-api";

/// Selects the upstream API contract independently of the hostname.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RouteStyle {
    Codex,
    ChatGpt,
}

/// A redacted failure. Response bodies and credentials never become error text.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RequestError {
    InvalidTarget,
    InvalidRequest,
    Cancelled,
    Transport,
    HttpStatus(u16),
    InvalidResponse,
}

impl fmt::Display for RequestError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidTarget => formatter.write_str("invalid backend API target"),
            Self::InvalidRequest => formatter.write_str("invalid backend request"),
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
            ClientError::InvalidRequest(_) => Self::InvalidRequest,
            ClientError::InvalidResponse(_) | ClientError::Framing(_) => Self::InvalidResponse,
            ClientError::Transport(_) => Self::Transport,
        }
    }
}

/// Business HTTP operations using caller-resolved authentication and cancellation.
/// The injected transport must reject redirects for authenticated requests.
pub struct BackendClient<'a> {
    client: &'a dyn OperationClient,
    target: &'a ResolvedApiTarget,
    base: Url,
    route: RouteStyle,
}

impl<'a> BackendClient<'a> {
    pub fn new(
        client: &'a dyn OperationClient,
        target: &'a ResolvedApiTarget,
        route: RouteStyle,
    ) -> Result<Self, RequestError> {
        let base = Url::parse(target.base_url.trim_end_matches('/'))
            .map_err(|_| RequestError::InvalidTarget)?;
        if base.scheme() != "https"
            || base.host_str().is_none()
            || !base.username().is_empty()
            || base.password().is_some()
            || base.query().is_some()
            || base.fragment().is_some()
        {
            return Err(RequestError::InvalidTarget);
        }
        Ok(Self {
            client,
            target,
            base,
            route,
        })
    }

    pub(crate) fn endpoint(&self, path: &[&str]) -> Result<Url, RequestError> {
        let mut url = self.base.clone();
        let mut segments = url
            .path_segments_mut()
            .map_err(|_| RequestError::InvalidTarget)?;
        segments.pop_if_empty();
        match self.route {
            RouteStyle::Codex => {
                segments.extend(["api", "codex"]);
            }
            RouteStyle::ChatGpt => {
                segments.push("wham");
            }
        }
        for segment in path {
            if segment.trim().is_empty() || matches!(*segment, "." | "..") {
                return Err(RequestError::InvalidRequest);
            }
            segments.push(segment);
        }
        drop(segments);
        Ok(url)
    }

    pub(crate) fn api_key_endpoint(&self) -> Url {
        let mut url = self.base.clone();
        url.set_path("/v1/analytics/codex/turn-costs");
        url
    }

    pub(crate) fn get<T: DeserializeOwned>(
        &self,
        url: Url,
        headers: &[HttpHeader],
        cancellation: &CancellationToken,
    ) -> Result<T, RequestError> {
        let response = self.send(HttpMethod::Get, url, headers, Vec::new(), cancellation)?;
        decode(response.body())
    }

    pub(crate) fn post<T: DeserializeOwned>(
        &self,
        url: Url,
        body: &impl Serialize,
        cancellation: &CancellationToken,
    ) -> Result<T, RequestError> {
        let response = self.post_response(url, body, cancellation)?;
        decode(response.body())
    }

    pub(crate) fn post_response(
        &self,
        url: Url,
        body: &impl Serialize,
        cancellation: &CancellationToken,
    ) -> Result<ClientResponse, RequestError> {
        let body = serde_json::to_vec(body).map_err(|_| RequestError::InvalidRequest)?;
        self.send(
            HttpMethod::Post,
            url,
            &[HttpHeader::new("Content-Type", "application/json")],
            body,
            cancellation,
        )
    }

    fn send(
        &self,
        method: HttpMethod,
        url: Url,
        extra_headers: &[HttpHeader],
        body: Vec<u8>,
        cancellation: &CancellationToken,
    ) -> Result<ClientResponse, RequestError> {
        let mut headers = self.target.headers.clone();
        for header in extra_headers {
            headers.retain(|existing| !existing.name().eq_ignore_ascii_case(header.name()));
            headers.push(header.clone());
        }
        let request =
            ClientRequest::new(method, url.as_str(), headers, body, RetryPolicy::never())?;
        let response = self
            .client
            .execute_with_cancellation(&request, cancellation)?;
        if !response.is_success() {
            return Err(RequestError::HttpStatus(response.status()));
        }
        Ok(response)
    }
}

pub(crate) fn decode<T: DeserializeOwned>(body: &[u8]) -> Result<T, RequestError> {
    serde_json::from_slice(body).map_err(|_| RequestError::InvalidResponse)
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;

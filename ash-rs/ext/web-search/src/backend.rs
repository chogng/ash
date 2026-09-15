use std::sync::Arc;

use ash_async_utils::CancellationToken;
use ash_client::ClientRequest;
use ash_client::OperationClient;
use ash_client::RetryPolicy;
use ash_http_client::HttpHeader;
use url::Url;

use crate::WebSearchError;
use crate::WebSearchRequest;
use crate::WebSearchResponse;

/// Executes one validated Web Search request against a host-selected external service.
///
/// Implementations must use only their configured endpoint and credential binding, observe
/// cancellation, bound response bodies in their transport, and return no hidden side effects.
pub trait WebSearchBackend: Send + Sync {
    fn service_name(&self) -> &str;
    fn network_scopes(&self) -> Vec<String>;
    fn credential_reference(&self) -> Option<String>;
    fn search(
        &self,
        request: &WebSearchRequest,
        cancellation: &CancellationToken,
    ) -> Result<WebSearchResponse, WebSearchError>;
}

/// JSON-over-HTTP backend for a host-configured Search service.
///
/// The endpoint accepts [`WebSearchRequest`] and returns [`WebSearchResponse`]. Headers are
/// redacted by `ash-http-client`; `credential_reference` is durable metadata only and never used
/// as the secret value.
pub struct JsonWebSearchBackend {
    service_name: String,
    endpoint: String,
    network_scope: String,
    credential_reference: Option<String>,
    headers: Vec<HttpHeader>,
    client: Arc<dyn OperationClient>,
}

impl JsonWebSearchBackend {
    pub fn new(
        service_name: impl Into<String>,
        endpoint: impl Into<String>,
        credential_reference: Option<String>,
        headers: Vec<HttpHeader>,
        client: Arc<dyn OperationClient>,
    ) -> Result<Self, WebSearchError> {
        let service_name = service_name.into();
        if service_name.trim().is_empty() {
            return Err(WebSearchError::InvalidRequest(
                "search service name must not be empty".into(),
            ));
        }
        let endpoint = endpoint.into();
        let parsed = Url::parse(&endpoint)
            .map_err(|_| WebSearchError::InvalidRequest("search endpoint URL is invalid".into()))?;
        if !matches!(parsed.scheme(), "http" | "https") {
            return Err(WebSearchError::InvalidRequest(
                "search endpoint must use HTTP or HTTPS".into(),
            ));
        }
        let network_scope = parsed
            .host_str()
            .ok_or_else(|| WebSearchError::InvalidRequest("search endpoint has no host".into()))?
            .to_owned();
        Ok(Self {
            service_name,
            endpoint,
            network_scope,
            credential_reference,
            headers,
            client,
        })
    }
}

impl WebSearchBackend for JsonWebSearchBackend {
    fn service_name(&self) -> &str {
        &self.service_name
    }

    fn network_scopes(&self) -> Vec<String> {
        vec![self.network_scope.clone()]
    }

    fn credential_reference(&self) -> Option<String> {
        self.credential_reference.clone()
    }

    fn search(
        &self,
        request: &WebSearchRequest,
        cancellation: &CancellationToken,
    ) -> Result<WebSearchResponse, WebSearchError> {
        let body = serde_json::to_vec(request)
            .map_err(|error| WebSearchError::InvalidRequest(error.to_string()))?;
        let mut headers = self.headers.clone();
        if !headers
            .iter()
            .any(|header| header.name().eq_ignore_ascii_case("content-type"))
        {
            headers.push(HttpHeader::new("content-type", "application/json"));
        }
        let request = ClientRequest::post(&self.endpoint, headers, body, RetryPolicy::never())
            .map_err(|error| WebSearchError::Unavailable(error.to_string()))?;
        let response = self
            .client
            .execute_with_cancellation(&request, cancellation)
            .map_err(|error| WebSearchError::Unavailable(error.to_string()))?;
        if !response.is_success() {
            return Err(WebSearchError::Unavailable(format!(
                "search endpoint returned HTTP {}",
                response.status()
            )));
        }
        serde_json::from_slice(response.body())
            .map_err(|error| WebSearchError::InvalidResponse(error.to_string()))
    }
}

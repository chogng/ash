use std::num::NonZeroUsize;
use std::sync::Arc;

use ash_http_client::HttpClient;
use ash_http_client::HttpClientConfig;
use ash_http_client::HttpMethod;
use ash_http_client::HttpRequest;
use ash_http_client::ResponseBodyLimit;
use ash_http_client::UreqHttpClient;
use async_trait::async_trait;
use tough::Transport;
use tough::TransportError;
use tough::TransportErrorKind;
use tough::TransportStream;
use url::Url;

use crate::ExtensionsClientError;
use crate::registry::archive::MAX_ARCHIVE_BYTES;

/// Bridges deployment-specific TLS roots to TUF through the shared verified HTTP client.
#[derive(Clone)]
pub(super) struct HttpsTransport {
    http: Arc<UreqHttpClient>,
}

impl std::fmt::Debug for HttpsTransport {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("HttpsTransport")
            .finish_non_exhaustive()
    }
}

impl HttpsTransport {
    pub(super) fn new(config: HttpClientConfig) -> Result<Self, ExtensionsClientError> {
        let limit = ResponseBodyLimit::new(NonZeroUsize::new(MAX_ARCHIVE_BYTES as usize).unwrap())
            .map_err(|_| ExtensionsClientError::unavailable())?;
        let http =
            UreqHttpClient::with_config(config.with_response_body_limit(limit)).map_err(|_| {
                ExtensionsClientError::invalid_request("Extensions TLS roots are invalid")
            })?;
        Ok(Self {
            http: Arc::new(http),
        })
    }
}

#[async_trait]
impl Transport for HttpsTransport {
    async fn fetch(&self, url: Url) -> Result<TransportStream, TransportError> {
        if url.scheme() != "https" {
            return Err(TransportError::new(
                TransportErrorKind::UnsupportedUrlScheme,
                url,
            ));
        }
        let http = self.http.clone();
        let request_url = url.clone();
        let response = tokio::task::spawn_blocking(move || {
            let request = HttpRequest::new(HttpMethod::Get, request_url.as_str(), vec![], vec![])?;
            http.execute(&request)
        })
        .await
        .map_err(|error| TransportError::new_with_cause(TransportErrorKind::Other, &url, error))?
        .map_err(|error| TransportError::new_with_cause(TransportErrorKind::Other, &url, error))?;
        match response.status() {
            200 => Ok(Box::pin(futures::stream::once(std::future::ready(Ok(
                bytes::Bytes::copy_from_slice(response.body()),
            ))))),
            403 | 404 | 410 => Err(TransportError::new(TransportErrorKind::FileNotFound, url)),
            _ => Err(TransportError::new(TransportErrorKind::Other, url)),
        }
    }
}

#[cfg(test)]
#[path = "transport_tests.rs"]
mod tests;

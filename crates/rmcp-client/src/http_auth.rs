//! Per-request credential resolution keeps HTTP sessions independent of OAuth persistence.
use std::collections::HashMap;
use std::sync::Arc;

use futures::StreamExt;
use futures::stream::BoxStream;

mod scope;
use reqwest::header::HeaderName;
use reqwest::header::HeaderValue;
use rmcp::model::ClientJsonRpcMessage;
use rmcp::transport::streamable_http_client::SseError;
use rmcp::transport::streamable_http_client::StreamableHttpClient;
use rmcp::transport::streamable_http_client::StreamableHttpError;
use rmcp::transport::streamable_http_client::StreamableHttpPostResponse;
pub use scope::HttpCredentialLease;
pub use scope::HttpCredentialScope;
use sse_stream::Sse;

/// Host-owned authentication. A rejected bearer requests one serialized refresh; errors are sanitized.
pub trait HttpCredentialProvider: Send + Sync {
    fn bearer(&self, rejected: Option<&str>) -> Result<String, std::io::Error>;

    /// A login-bound lifetime; static credentials have no retirement domain.
    fn scope(&self) -> Option<Arc<HttpCredentialScope>> {
        None
    }
}

#[derive(Clone)]
pub(crate) struct AuthenticatedClient {
    pub client: reqwest::Client,
    pub credentials: Option<Arc<dyn HttpCredentialProvider>>,
}

impl AuthenticatedClient {
    async fn authorized<T>(
        &self,
        work: impl std::future::Future<Output = Result<T, StreamableHttpError<reqwest::Error>>>,
    ) -> Result<(T, Option<HttpCredentialLease>), StreamableHttpError<reqwest::Error>> {
        let Some(scope) = self
            .credentials
            .as_ref()
            .and_then(|credentials| credentials.scope())
        else {
            return work.await.map(|result| (result, None));
        };
        let lease = scope.acquire().ok_or_else(retired)?;
        let result = tokio::select! {
            biased;
            _ = scope.cancelled() => return Err(retired()),
            result = work => result?,
        };
        if scope.is_closed() {
            return Err(retired());
        }
        Ok((result, Some(lease)))
    }

    fn scoped_stream(
        &self,
        stream: BoxStream<'static, Result<Sse, SseError>>,
        lease: Option<HttpCredentialLease>,
    ) -> BoxStream<'static, Result<Sse, SseError>> {
        let Some(scope) = self
            .credentials
            .as_ref()
            .and_then(|credentials| credentials.scope())
        else {
            return stream;
        };
        futures::stream::unfold(
            (stream, scope, lease),
            |(mut stream, scope, lease)| async move {
                let item = tokio::select! {
                    biased;
                    _ = scope.cancelled() => None,
                    item = stream.next() => item,
                };
                if scope.is_closed() {
                    return None;
                }
                item.map(|item| (item, (stream, scope, lease)))
            },
        )
        .boxed()
    }

    async fn token(
        &self,
        fallback: Option<String>,
        rejected: Option<String>,
    ) -> Result<Option<String>, StreamableHttpError<reqwest::Error>> {
        let Some(credentials) = self.credentials.clone() else {
            return Ok(fallback);
        };
        tokio::task::spawn_blocking(move || credentials.bearer(rejected.as_deref()))
            .await?
            .map(Some)
            .map_err(StreamableHttpError::Io)
    }
}

impl StreamableHttpClient for AuthenticatedClient {
    type Error = reqwest::Error;
    async fn post_message(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<StreamableHttpPostResponse, StreamableHttpError<Self::Error>> {
        self.post_message_with_max_sse_event_size(
            uri,
            message,
            session_id,
            auth_header,
            custom_headers,
            1024 * 1024,
        )
        .await
    }

    async fn post_message_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        message: ClientJsonRpcMessage,
        session_id: Option<Arc<str>>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
        limit: usize,
    ) -> Result<StreamableHttpPostResponse, StreamableHttpError<Self::Error>> {
        let (response, lease) = self
            .authorized(async {
                let token = self.token(auth_header, None).await?;
                let result = self
                    .client
                    .post_message_with_max_sse_event_size(
                        uri.clone(),
                        message.clone(),
                        session_id.clone(),
                        token.clone(),
                        custom_headers.clone(),
                        limit,
                    )
                    .await;
                // Only a definitive 401 permits replay. Never retry a timeout, 403, or an uncertain write.
                if self.credentials.is_some()
                    && matches!(result, Err(StreamableHttpError::AuthRequired(_)))
                {
                    let fresh = self.token(None, token).await?;
                    return self
                        .client
                        .post_message_with_max_sse_event_size(
                            uri,
                            message,
                            session_id,
                            fresh,
                            custom_headers,
                            limit,
                        )
                        .await;
                }
                result
            })
            .await?;
        Ok(match response {
            StreamableHttpPostResponse::Sse(stream, session) => {
                StreamableHttpPostResponse::Sse(self.scoped_stream(stream, lease), session)
            }
            response => response,
        })
    }

    async fn delete_session(
        &self,
        uri: Arc<str>,
        session_id: Arc<str>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<(), StreamableHttpError<Self::Error>> {
        self.authorized(async {
            let token = self.token(auth_header, None).await?;
            self.client
                .delete_session(uri, session_id, token, custom_headers)
                .await
        })
        .await
        .map(|(result, _)| result)
    }

    async fn get_stream(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<BoxStream<'static, Result<Sse, SseError>>, StreamableHttpError<Self::Error>> {
        self.get_stream_with_max_sse_event_size(
            uri,
            session_id,
            last_event_id,
            auth_header,
            custom_headers,
            1024 * 1024,
        )
        .await
    }

    async fn get_stream_with_max_sse_event_size(
        &self,
        uri: Arc<str>,
        session_id: Option<Arc<str>>,
        last_event_id: Option<String>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
        limit: usize,
    ) -> Result<BoxStream<'static, Result<Sse, SseError>>, StreamableHttpError<Self::Error>> {
        let (stream, lease) = self
            .authorized(async {
                let token = self.token(auth_header, None).await?;
                let result = self
                    .client
                    .get_stream_with_max_sse_event_size(
                        uri.clone(),
                        session_id.clone(),
                        last_event_id.clone(),
                        token.clone(),
                        custom_headers.clone(),
                        limit,
                    )
                    .await;
                if self.credentials.is_some()
                    && matches!(result, Err(StreamableHttpError::AuthRequired(_)))
                {
                    let fresh = self.token(None, token).await?;
                    return self
                        .client
                        .get_stream_with_max_sse_event_size(
                            uri,
                            session_id,
                            last_event_id,
                            fresh,
                            custom_headers,
                            limit,
                        )
                        .await;
                }
                result
            })
            .await?;
        Ok(self.scoped_stream(stream, lease))
    }
}

fn retired() -> StreamableHttpError<reqwest::Error> {
    StreamableHttpError::Io(std::io::Error::other("MCP authorization was retired"))
}

#[cfg(test)]
#[path = "http_auth_tests.rs"]
mod tests;

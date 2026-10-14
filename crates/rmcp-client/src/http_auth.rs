//! Per-request credential resolution keeps HTTP sessions independent of OAuth persistence.
use std::collections::HashMap;
use std::sync::Arc;

use futures::stream::BoxStream;
use reqwest::header::HeaderName;
use reqwest::header::HeaderValue;
use rmcp::model::ClientJsonRpcMessage;
use rmcp::transport::streamable_http_client::SseError;
use rmcp::transport::streamable_http_client::StreamableHttpClient;
use rmcp::transport::streamable_http_client::StreamableHttpError;
use rmcp::transport::streamable_http_client::StreamableHttpPostResponse;
use sse_stream::Sse;

/// Host-owned authentication. A rejected bearer requests one serialized refresh; errors are sanitized.
pub trait HttpCredentialProvider: Send + Sync {
    fn bearer(&self, rejected: Option<&str>) -> Result<String, std::io::Error>;
}

#[derive(Clone)]
pub(crate) struct AuthenticatedClient {
    pub client: reqwest::Client,
    pub credentials: Option<Arc<dyn HttpCredentialProvider>>,
}

impl AuthenticatedClient {
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
        if self.credentials.is_some() && matches!(result, Err(StreamableHttpError::AuthRequired(_)))
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
    }

    async fn delete_session(
        &self,
        uri: Arc<str>,
        session_id: Arc<str>,
        auth_header: Option<String>,
        custom_headers: HashMap<HeaderName, HeaderValue>,
    ) -> Result<(), StreamableHttpError<Self::Error>> {
        let token = self.token(auth_header, None).await?;
        self.client
            .delete_session(uri, session_id, token, custom_headers)
            .await
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
        if self.credentials.is_some() && matches!(result, Err(StreamableHttpError::AuthRequired(_)))
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
    }
}

#[cfg(test)]
#[path = "http_auth_tests.rs"]
mod tests;

use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::diagnostics::FeedbackPrepareParams;
use ash_app_server_protocol::protocol::diagnostics::FeedbackUploadParams;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use serde_json::Value;

impl AppServer {
    pub(super) fn refresh_analytics(&self) -> Result<(), RpcError> {
        let enabled = match &self.config {
            Some(config) => features::Feature::Analytics.enabled(
                &config
                    .read_snapshot()
                    .map_err(|_| RpcError::new(-32030, AppServerErrorName::ConfigUnavailable))?
                    .values
                    .features,
            ),
            None => false,
        };
        self.analytics.set_enabled(enabled);
        Ok(())
    }

    pub(super) fn diagnostics_read(&self) -> Result<Value, RpcError> {
        self.refresh_analytics()?;
        self.telemetry.flush().map_err(internal)?;
        result(&self.diagnostics.snapshot(self.analytics.snapshot()))
    }

    pub(super) fn feedback_prepare(
        &self,
        connection: &ConnectionState,
        value: &Value,
    ) -> Result<Value, RpcError> {
        let params: FeedbackPrepareParams = decode(value)?;
        self.refresh_analytics()?;
        self.telemetry.flush().map_err(internal)?;
        let prepared = self
            .feedback
            .prepare(
                connection.connection_id,
                &params.endpoint,
                self.diagnostics.snapshot(self.analytics.snapshot()),
            )
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        result(&prepared)
    }

    pub(super) fn feedback_upload(
        &self,
        connection: &ConnectionState,
        value: &Value,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: FeedbackUploadParams = decode(value)?;
        let timeout = ash_http_client::Timeout::After(std::time::Duration::from_secs(15));
        let config = ash_http_client::HttpClientConfig::default()
            .with_redirect_policy(ash_http_client::RedirectPolicy::Reject)
            .with_network_target_policy(ash_http_client::NetworkTargetPolicy::PublicInternetOnly)
            .with_proxy_policy(ash_http_client::ProxyPolicy::Direct)
            .with_timeouts(ash_http_client::TransportTimeouts::new(
                timeout, timeout, timeout, timeout,
            ));
        let http = ash_http_client::UreqHttpClient::with_config(config).map_err(internal)?;
        let client = ash_client::AshClient::new(std::sync::Arc::new(http));
        self.feedback
            .upload(
                connection.connection_id,
                &params.digest,
                &client,
                cancellation,
            )
            .map_err(|_| RpcError::new(-32126, AppServerErrorName::FeedbackOperationFailed))?;
        self.analytics
            .record(analytics::UsageEvent::FeedbackSubmitted);
        result(&())
    }
}

fn internal(_: impl std::fmt::Display) -> RpcError {
    RpcError::new(-32603, AppServerErrorName::InternalError)
}

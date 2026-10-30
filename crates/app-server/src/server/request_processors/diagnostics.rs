use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::diagnostics::FeedbackPrepareParams;
use ash_app_server_protocol::protocol::diagnostics::FeedbackUploadParams;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use serde_json::Value;

/// Borrows only the diagnostics domain services for one request.
/// Composition retains their lifetimes; this adapter cannot access other server state.
pub(super) struct DiagnosticsRequestProcessor<'a> {
    analytics: &'a super::Arc<analytics::Analytics>,
    config: &'a Option<super::Arc<super::ConfigStore>>,
    diagnostics: &'a diagnostics::Diagnostics,
    build_info: &'a build_info::BuildInfo,
    feedback: &'a feedback::Feedback,
    telemetry: &'a ash_otel::Telemetry,
    home: &'a Option<super::Arc<ash_home::AshHome>>,
    resources: &'a super::Arc<std::sync::Mutex<crate::resource_store::ResourceStore>>,
}

impl<'a> DiagnosticsRequestProcessor<'a> {
    pub(super) fn new(
        analytics: &'a super::Arc<analytics::Analytics>,
        config: &'a Option<super::Arc<super::ConfigStore>>,
        diagnostics: &'a diagnostics::Diagnostics,
        build_info: &'a build_info::BuildInfo,
        feedback: &'a feedback::Feedback,
        telemetry: &'a ash_otel::Telemetry,
        home: &'a Option<super::Arc<ash_home::AshHome>>,
        resources: &'a super::Arc<std::sync::Mutex<crate::resource_store::ResourceStore>>,
    ) -> Self {
        Self {
            analytics,
            config,
            diagnostics,
            build_info,
            feedback,
            telemetry,
            home,
            resources,
        }
    }
}

impl<'a> DiagnosticsRequestProcessor<'a> {
    pub(super) fn collect_debug_logs(
        &self,
        connection: &ConnectionState,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<Value, RpcError> {
        use super::resources_processor::resource_rpc_error;
        use ash_app_server_protocol::protocol::diagnostics::AgentHostDebugLogFile;
        use ash_app_server_protocol::protocol::diagnostics::AgentHostDebugLogsResult;
        use ash_app_server_protocol::protocol::resources::ResourceMetadataResult;

        let home = self
            .home
            .as_ref()
            .ok_or_else(|| internal("Profile is unavailable"))?;
        let (logs, omitted_files) =
            ash_app_server_daemon::read_process_logs(home.root()).map_err(internal)?;
        let state = connection.state.lock().map_err(internal)?;
        if state.closed || cancellation.is_cancelled() {
            return Err(RpcError::new(-32800, AppServerErrorName::RequestCancelled));
        }
        let mut resources = self.resources.lock().map_err(internal)?;
        let mut files: Vec<AgentHostDebugLogFile> = Vec::new();
        for log in logs {
            let metadata = match resources.create(
                connection.connection_id,
                "text/plain".into(),
                log.bytes,
                std::time::Duration::from_secs(600),
            ) {
                Ok(metadata) => metadata,
                Err(error) => {
                    for file in &files {
                        let _ =
                            resources.release(connection.connection_id, &file.resource.resource_id);
                    }
                    return Err(resource_rpc_error(error));
                }
            };
            files.push(AgentHostDebugLogFile {
                name: log.name,
                truncated: log.truncated,
                resource: ResourceMetadataResult {
                    resource_id: metadata.resource_id,
                    mime_type: metadata.mime_type,
                    size: metadata.size,
                    sha256: metadata.sha256,
                },
            });
        }
        result(&AgentHostDebugLogsResult {
            files,
            omitted_files,
        })
    }

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
        result(
            &self
                .diagnostics
                .snapshot(self.build_info.clone(), self.analytics.snapshot()),
        )
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
                self.diagnostics
                    .snapshot(self.build_info.clone(), self.analytics.snapshot()),
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

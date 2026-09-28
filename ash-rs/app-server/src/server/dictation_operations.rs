use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::dictation::DictationBackend;
use ash_app_server_protocol::protocol::dictation::DictationEnded;
use ash_app_server_protocol::protocol::dictation::DictationResourceParams;
use ash_app_server_protocol::protocol::dictation::DictationStartParams;
use ash_app_server_protocol::protocol::dictation::DictationStopResult;
use ash_app_server_protocol::protocol::dictation::DictationTranscript;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::registry::ServerNotificationMethod;
use realtime_voice::CloudDictationRequest;
use realtime_voice::DictationEvent;
use realtime_voice::DictationRequest;
use realtime_voice::LocalDictationRequest;
use serde_json::Value;

use super::update_broker::notification;

impl AppServer {
    pub(super) fn dictation_start(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        if !connection.allows_product_host_capabilities() {
            return Err(RpcError::new(
                -32073,
                AppServerErrorName::PermissionRequired,
            ));
        }
        let params: DictationStartParams = decode(params)?;
        realtime_voice::DictationManager::validate_resource_id(&params.resource_id)
            .map_err(dictation_error)?;
        let _microphone = self
            .microphone_gate
            .lock()
            .map_err(|_| dictation_error("Microphone state unavailable".into()))?;
        if self.calls.has_active_audio() {
            return Err(dictation_error(
                "The microphone is already in use for a call".into(),
            ));
        }
        let audio_host = super::call_runtime::executable("ASH_VOICE_HOST_PATH", "ash-voice-host")
            .map_err(dictation_error)?;
        let request = match params.backend {
            DictationBackend::Local { model_id } => {
                DictationRequest::Local(LocalDictationRequest {
                    model_id,
                    model_root: self
                        .home
                        .as_ref()
                        .ok_or_else(|| dictation_error("Ash home is unavailable".into()))?
                        .root()
                        .join("dictation-models"),
                    audio_host,
                    network: ash_http_client::OutboundNetworkSnapshot::with_policy(
                        ash_http_client::HttpClientConfig::new()
                            .with_redirect_policy(ash_http_client::RedirectPolicy::Follow {
                                max_hops: std::num::NonZeroU8::new(4)
                                    .expect("nonzero redirect limit"),
                            })
                            .with_streaming_response_body_limit(
                                ash_http_client::ResponseBodyLimit::new(
                                    std::num::NonZeroUsize::new(300 * 1024 * 1024)
                                        .expect("nonzero model limit"),
                                )
                                .map_err(|error| dictation_error(error.to_string()))?,
                            )
                            .with_timeouts(ash_http_client::TransportTimeouts::new(
                                ash_http_client::Timeout::After(std::time::Duration::from_secs(30)),
                                ash_http_client::Timeout::Disabled,
                                ash_http_client::Timeout::Disabled,
                                ash_http_client::Timeout::After(std::time::Duration::from_secs(
                                    300,
                                )),
                            )),
                        self.calls.network_policy(),
                    )
                    .map_err(|error| dictation_error(error.to_string()))?,
                })
            }
            DictationBackend::Cloud { model_id } => {
                if model_id != "gpt-live-transcribe" {
                    return Err(dictation_error("Unsupported cloud dictation model".into()));
                }
                let provider_runtime = self
                    .provider_runtime
                    .as_ref()
                    .ok_or_else(|| dictation_error("Model provider is unavailable".into()))?
                    .clone();
                let store = self
                    .config
                    .as_ref()
                    .ok_or_else(|| dictation_error("Model configuration is unavailable".into()))?;
                let snapshot = store
                    .read_snapshot()
                    .map_err(|error| dictation_error(error.to_string()))?;
                let provider =
                    ash_protocol::ProviderId::new("openai").expect("built-in provider ID");
                let connection = snapshot
                    .values
                    .active_connections
                    .get(&provider)
                    .cloned()
                    .unwrap_or_else(|| {
                        ash_protocol::ModelConnectionId::new("openai")
                            .expect("built-in connection ID")
                    });
                let provider_config = snapshot
                    .values
                    .connections
                    .get(&connection)
                    .cloned()
                    .unwrap_or_else(|| {
                        ash_model_provider_config::ModelProviderConfig::for_connection(connection)
                    });
                let network = ash_http_client::OutboundNetworkSnapshot::with_policy(
                    ash_http_client::HttpClientConfig::new(),
                    self.calls.network_policy(),
                )
                .map_err(|error| dictation_error(error.to_string()))?;
                DictationRequest::Cloud(CloudDictationRequest {
                    model_id,
                    audio_host,
                    provider_runtime,
                    provider_config,
                    connector: ash_websocket_client::WebSocketConnector::new(network),
                })
            }
        };
        let resource_id = params.resource_id.clone();
        let notifications = connection.outbound_notifications.clone();
        self.dictation
            .start(
                connection.connection_id,
                params.resource_id,
                request,
                move |event| match event {
                    DictationEvent::Transcript { text, is_final } => {
                        notifications.push(notification(
                            ServerNotificationMethod::DictationTranscript,
                            &DictationTranscript {
                                resource_id: resource_id.clone(),
                                text,
                                is_final,
                            },
                        ))
                    }
                    DictationEvent::Ended { error } => notifications.push(notification(
                        ServerNotificationMethod::DictationEnded,
                        &DictationEnded {
                            resource_id: resource_id.clone(),
                            error,
                        },
                    )),
                },
            )
            .map_err(dictation_error)?;
        result(&())
    }

    pub(super) fn dictation_stop(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: DictationResourceParams = decode(params)?;
        let text = self
            .dictation
            .stop(connection.connection_id, &params.resource_id)
            .map_err(dictation_error)?;
        result(&DictationStopResult { text })
    }
}

fn dictation_error(detail: String) -> RpcError {
    let mut error = RpcError::new(-32000, AppServerErrorName::InternalError);
    error.detail = Some(detail);
    error
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local::ProviderModelService;
    use ash_core::{InMemoryThreadStore, ThreadController};
    use ash_model_provider::EchoModel;
    use std::sync::Arc;

    #[test]
    fn dictation_requires_product_authority_and_rejects_invalid_resource_ids() {
        let server = AppServer::new(
            Arc::new(ThreadController::with_store(Arc::new(
                InMemoryThreadStore::default(),
            ))),
            Arc::new(ProviderModelService::new(Arc::new(EchoModel))),
        );
        let mut client = server.connection();
        let mut host = server.product_host_connection();
        for connection in [&mut client, &mut host] {
            let response: serde_json::Value = serde_json::from_str(&server.handle_json(connection,
                &serde_json::json!({"jsonrpc":"2.0", "id":1, "method":"initialize", "params":{"clientInfo":{"name":"dictation-test","version":"1"},"capabilities":{}}}).to_string())).unwrap();
            assert!(response.get("result").is_some());
        }
        let request = serde_json::json!({"jsonrpc":"2.0", "id":2, "method":"dictation/start", "params":{"resourceId":"bad/id","backend":{"type":"local","modelId":"paraformer-large-online-ec6a3c64"}}}).to_string();
        let denied: serde_json::Value =
            serde_json::from_str(&server.handle_json(&mut client, &request)).unwrap();
        assert_eq!(denied["error"]["message"], "PermissionRequired");
        let rejected: serde_json::Value =
            serde_json::from_str(&server.handle_json(&mut host, &request)).unwrap();
        assert_eq!(
            rejected["error"]["message"],
            "InternalError: Invalid dictation resource ID"
        );
    }
}

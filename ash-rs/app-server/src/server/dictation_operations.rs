use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::dictation::DictationBackend;
use ash_app_server_protocol::protocol::dictation::DictationCloudProvider;
use ash_app_server_protocol::protocol::dictation::DictationEnded;
use ash_app_server_protocol::protocol::dictation::DictationInputDevice;
use ash_app_server_protocol::protocol::dictation::DictationModelList;
use ash_app_server_protocol::protocol::dictation::DictationModelOperation;
use ash_app_server_protocol::protocol::dictation::DictationModelParams;
use ash_app_server_protocol::protocol::dictation::DictationModelProgress;
use ash_app_server_protocol::protocol::dictation::DictationModelStage;
use ash_app_server_protocol::protocol::dictation::DictationModelStartParams;
use ash_app_server_protocol::protocol::dictation::DictationModelStatus;
use ash_app_server_protocol::protocol::dictation::DictationOptions;
use ash_app_server_protocol::protocol::dictation::DictationOptionsParams;
use ash_app_server_protocol::protocol::dictation::DictationResourceParams;
use ash_app_server_protocol::protocol::dictation::DictationStartParams;
use ash_app_server_protocol::protocol::dictation::DictationStopResult;
use ash_app_server_protocol::protocol::dictation::DictationTranscript;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::registry::ServerNotificationMethod;
use realtime_voice::CloudDictationRequest;
use realtime_voice::CloudTranscriptionProvider;
use realtime_voice::DictationEvent;
use realtime_voice::DictationRequest;
use realtime_voice::LocalDictationRequest;
use serde_json::Value;
use std::sync::Arc;

use super::update_broker::notification;

impl AppServer {
    pub(super) fn dictation_options(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        require_product_host(connection)?;
        let params: DictationOptionsParams = decode(params)?;
        let audio_host = super::call_runtime::executable("ASH_VOICE_HOST_PATH", "ash-voice-host")
            .map_err(dictation_error)?;
        let input_devices = self
            .dictation
            .input_devices(&audio_host)
            .map_err(dictation_error)?
            .into_iter()
            .map(|device| DictationInputDevice {
                id: device.id,
                label: device.label,
                is_default: device.is_default,
            })
            .collect();
        result(&DictationOptions {
            input_devices,
            languages: languages(&params.backend)
                .iter()
                .map(|language| (*language).to_owned())
                .collect(),
        })
    }

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
        if params
            .language
            .as_ref()
            .is_some_and(|language| !languages(&params.backend).contains(&language.as_str()))
        {
            return Err(dictation_error(
                "The selected transcription language is not supported".into(),
            ));
        }
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
                    model_root: self.dictation_model_root()?,
                    audio_host,
                    network: self.dictation_model_network()?,
                    input_device: params.input_device,
                })
            }
            DictationBackend::Cloud { provider, model_id } => {
                let (provider_id, expected_model, protocol) = match provider {
                    DictationCloudProvider::OpenAi => (
                        "openai",
                        "gpt-live-transcribe",
                        CloudTranscriptionProvider::OpenAi,
                    ),
                    DictationCloudProvider::Xai => (
                        "xai",
                        "grok-voice-transcribe-2.0",
                        CloudTranscriptionProvider::Xai,
                    ),
                };
                if model_id != expected_model {
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
                // Speech recognition uses direct API credentials independently of the text model.
                let connection = ash_protocol::ModelConnectionId::new(provider_id)
                    .expect("built-in connection ID");
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
                    provider: protocol,
                    model_id,
                    audio_host,
                    provider_runtime,
                    provider_config,
                    connector: ash_websocket_client::WebSocketConnector::new(network),
                    input_device: params.input_device,
                    language: params.language,
                })
            }
        };
        let resource_id = params.resource_id.clone();
        let model_id = match &request {
            DictationRequest::Local(request) => Some(request.model_id.clone()),
            DictationRequest::Cloud(_) => None,
        };
        let notifications = connection.outbound_notifications.clone();
        self.dictation
            .start(
                connection.connection_id,
                params.resource_id,
                request,
                move |event| match event {
                    DictationEvent::ModelProgress(progress) => notifications.push(notification(
                        ServerNotificationMethod::DictationModelProgress,
                        &DictationModelProgress {
                            resource_id: resource_id.clone(),
                            model_id: model_id.clone().expect("local model progress"),
                            stage: model_stage(progress),
                        },
                    )),
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

    pub(super) fn dictation_model_read(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        require_product_host(connection)?;
        let params: DictationModelParams = decode(params)?;
        result(&self.dictation_model_status(params.model_id)?)
    }

    fn dictation_model_status(&self, model_id: String) -> Result<DictationModelStatus, RpcError> {
        let root = self.dictation_model_root()?;
        let available = realtime_voice::DictationModelManager::is_available(&root, &model_id)
            .map_err(dictation_error)?;
        let size_bytes = realtime_voice::DictationModelManager::size_bytes(&root, &model_id)
            .map_err(dictation_error)?;
        let stage = self.dictation_models.progress(&model_id).map(model_stage);
        Ok(DictationModelStatus {
            model_id,
            available,
            size_bytes,
            stage,
        })
    }

    pub(super) fn dictation_model_list(
        &self,
        connection: &ConnectionState,
    ) -> Result<Value, RpcError> {
        require_product_host(connection)?;
        let models = self
            .dictation_models
            .list(&self.dictation_model_root()?)
            .map_err(dictation_error)?
            .into_iter()
            .map(|id| self.dictation_model_status(id))
            .collect::<Result<Vec<_>, _>>()?;
        result(&DictationModelList { models })
    }

    pub(super) fn dictation_model_cancel(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        require_product_host(connection)?;
        let params: DictationModelParams = decode(params)?;
        self.dictation_models
            .cancel_model(&params.model_id)
            .map_err(dictation_error)?;
        result(&())
    }

    pub(super) fn dictation_model_delete(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        require_product_host(connection)?;
        let params: DictationModelParams = decode(params)?;
        let _microphone = self
            .microphone_gate
            .lock()
            .map_err(|_| dictation_error("Microphone state unavailable".into()))?;
        if self.dictation.is_active() || self.calls.has_active_audio() {
            return Err(dictation_error(
                "Stop voice input before deleting the model".into(),
            ));
        }
        self.dictation_models
            .remove(&self.dictation_model_root()?, &params.model_id)
            .map_err(dictation_error)?;
        self.updates
            .publish_dictation_model_changed(params.model_id);
        result(&())
    }

    pub(super) fn dictation_model_start(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        require_product_host(connection)?;
        let params: DictationModelStartParams = decode(params)?;
        let operation = match params.operation {
            DictationModelOperation::Prepare => realtime_voice::ModelOperation::Prepare {
                network: self.dictation_model_network()?,
            },
            DictationModelOperation::Import { source_directory } => {
                realtime_voice::ModelOperation::Import {
                    source: source_directory.into(),
                }
            }
        };
        let model_id = params.model_id.clone();
        let resource_id = params.resource_id.clone();
        let notifications = connection.outbound_notifications.clone();
        let updates = Arc::clone(&self.updates);
        self.dictation_models
            .start(
                connection.connection_id,
                params.resource_id,
                realtime_voice::ModelRequest {
                    model_root: self.dictation_model_root()?,
                    model_id: params.model_id,
                    operation,
                },
                move |progress| {
                    notifications.push(notification(
                        ServerNotificationMethod::DictationModelProgress,
                        &DictationModelProgress {
                            resource_id: resource_id.clone(),
                            model_id: model_id.clone(),
                            stage: model_stage(progress),
                        },
                    ));
                    updates.publish_dictation_model_changed(model_id.clone());
                },
            )
            .map_err(dictation_error)?;
        result(&())
    }

    pub(super) fn dictation_model_stop(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        require_product_host(connection)?;
        let params: DictationResourceParams = decode(params)?;
        realtime_voice::DictationManager::validate_resource_id(&params.resource_id)
            .map_err(dictation_error)?;
        self.dictation_models
            .stop(connection.connection_id, &params.resource_id)
            .map_err(dictation_error)?;
        result(&())
    }

    fn dictation_model_root(&self) -> Result<std::path::PathBuf, RpcError> {
        Ok(self
            .home
            .as_ref()
            .ok_or_else(|| dictation_error("Ash home is unavailable".into()))?
            .root()
            .join("dictation-models"))
    }

    fn dictation_model_network(
        &self,
    ) -> Result<ash_http_client::OutboundNetworkSnapshot, RpcError> {
        ash_http_client::OutboundNetworkSnapshot::with_policy(
            ash_http_client::HttpClientConfig::new()
                .with_redirect_policy(ash_http_client::RedirectPolicy::Follow {
                    max_hops: std::num::NonZeroU8::new(4).expect("nonzero redirect limit"),
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
                    ash_http_client::Timeout::After(std::time::Duration::from_secs(300)),
                )),
            self.calls.network_policy(),
        )
        .map_err(|error| dictation_error(error.to_string()))
    }
}

fn languages(backend: &DictationBackend) -> &'static [&'static str] {
    match backend {
        DictationBackend::Local { .. } => &[],
        DictationBackend::Cloud {
            provider: DictationCloudProvider::OpenAi,
            ..
        } => realtime_voice::transcription_languages(CloudTranscriptionProvider::OpenAi),
        DictationBackend::Cloud {
            provider: DictationCloudProvider::Xai,
            ..
        } => realtime_voice::transcription_languages(CloudTranscriptionProvider::Xai),
    }
}

fn require_product_host(connection: &ConnectionState) -> Result<(), RpcError> {
    if !connection.allows_product_host_capabilities() {
        return Err(RpcError::new(
            -32073,
            AppServerErrorName::PermissionRequired,
        ));
    }
    Ok(())
}

fn model_stage(progress: realtime_voice::ModelProgress) -> DictationModelStage {
    match progress {
        realtime_voice::ModelProgress::Checking => DictationModelStage::Checking,
        realtime_voice::ModelProgress::Downloading {
            file,
            downloaded_bytes,
        } => DictationModelStage::Downloading {
            file,
            downloaded_bytes,
        },
        realtime_voice::ModelProgress::Loading => DictationModelStage::Loading,
        realtime_voice::ModelProgress::Ready => DictationModelStage::Ready,
        realtime_voice::ModelProgress::Cancelled => DictationModelStage::Cancelled,
        realtime_voice::ModelProgress::Failed { error } => DictationModelStage::Failed { error },
    }
}

fn dictation_error(detail: String) -> RpcError {
    let mut error = RpcError::new(-32000, AppServerErrorName::InternalError);
    error.detail = Some(detail);
    error
}

#[cfg(test)]
#[path = "dictation_operations_tests.rs"]
mod tests;

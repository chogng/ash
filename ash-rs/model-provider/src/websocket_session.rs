use super::ModelEventSink;
use super::ModelProviderRuntime;
use super::Provider;
use crate::ModelProviderError;
use ash_api::ApiError;
use ash_api::ApiStreamSink;
use ash_api::ModelRequest;
use ash_api::ModelResponse;
use ash_api::ModelStreamEvent;
use ash_api::RealtimeSession;
use ash_api::ResponsesWebSocketSession;
use ash_api::WebSocketSessionConfig;
use ash_async_utils::CancellationToken;
use ash_client::ResolvedApiTarget;
use ash_model_provider_config::ModelProviderConfig;
use ash_model_provider_config::RealtimeApiProfile;
use ash_model_provider_config::WebSocketApiProfile;
use ash_protocol::ModelRef;
use ash_websocket_client::WebSocketConnector;

/// Explicit caller-owned Responses connection. Separate instances isolate execution branches.
/// Credentials are rechecked before each invocation; rotation discards all connection history.
pub struct ResponsesModelSession {
    provider: Provider,
    model: String,
    cache_key: Option<String>,
    connector: WebSocketConnector,
    limits: WebSocketSessionConfig,
    target: ResolvedApiTarget,
    session: ResponsesWebSocketSession,
}

impl ModelProviderRuntime {
    /// Creates a voice session using the provider's independent speech catalog and credentials.
    pub async fn connect_voice(
        &self,
        config: &ModelProviderConfig,
        selection: &ash_model_provider_config::VoiceModelConfig,
        instructions: &str,
        connector: &WebSocketConnector,
        limits: WebSocketSessionConfig,
        cancellation: &CancellationToken,
    ) -> Result<VoiceModelSession, ModelProviderError> {
        super::check_cancellation(cancellation)?;
        let runtime = self.with_configs([config])?;
        let normalized = runtime.configs.normalize_for(config, &config.provider)?;
        let definition = runtime
            .configs
            .get(&normalized.provider)
            .expect("normalized provider exists");
        if definition.live_api_profile != ash_model_provider_config::LiveApiProfile::OpenAiLive {
            return Err(ModelProviderError::Unavailable(
                "provider has no declared voice session protocol".into(),
            ));
        }
        let voice = definition.resolve_voice(selection)?;
        let model = ModelRef::new(definition.id.clone(), voice.model.clone());
        // This factory always resolves direct provider credentials, independently of text subscriptions.
        let connection = runtime.direct_connection(&normalized)?;
        let provider = runtime.instantiate_normalized_with_connection(normalized, connection)?;
        let target = provider.target.resolve()?;
        let session = ash_api::LiveSession::connect(
            connector,
            target.api_target(),
            voice.model.as_str(),
            &ash_api::LiveConfig {
                instructions: instructions.into(),
                voice: voice.voice.clone(),
            },
            limits,
            cancellation,
        )
        .await?;
        Ok(VoiceModelSession {
            model,
            voice: voice.voice,
            session,
        })
    }

    /// Opens an explicitly declared Responses WebSocket service. Does not change HTTP defaults.
    pub async fn connect_responses(
        &self,
        config: &ModelProviderConfig,
        model: &ModelRef,
        cache_key: Option<String>,
        connector: WebSocketConnector,
        limits: WebSocketSessionConfig,
        cancellation: &CancellationToken,
    ) -> Result<ResponsesModelSession, ModelProviderError> {
        super::check_cancellation(cancellation)?;
        let runtime = self.with_configs([config])?;
        let normalized = runtime.configs.normalize_for(config, &model.provider)?;
        let definition = runtime
            .configs
            .get(&normalized.provider)
            .expect("normalized provider exists");
        if definition.websocket_api_profile != WebSocketApiProfile::OpenAiResponses {
            return Err(ModelProviderError::Unavailable(
                "provider has no declared Responses WebSocket protocol".into(),
            ));
        }
        let connection = runtime.connection(model, &normalized)?;
        let provider = runtime.instantiate_normalized_with_connection(normalized, connection)?;
        provider.resolve_model(&model.model)?;
        let target = provider.target.resolve()?.into_api_target();
        let endpoint = provider.target.endpoint(provider.adapter.endpoint());
        let session = ResponsesWebSocketSession::connect(
            &connector,
            &target,
            endpoint,
            model.model.as_str(),
            cache_key.clone(),
            limits,
            cancellation,
        )
        .await?;
        Ok(ResponsesModelSession {
            provider,
            model: model.model.to_string(),
            cache_key,
            connector,
            limits,
            target,
            session,
        })
    }

    /// Opens a public Realtime GA session using its own declared capability and direct credentials.
    /// The caller owns session retirement and audio capture/playback. ChatGPT text subscriptions
    /// do not authorize this distinct service.
    pub async fn connect_realtime(
        &self,
        config: &ModelProviderConfig,
        model: &ModelRef,
        connector: &WebSocketConnector,
        limits: WebSocketSessionConfig,
        cancellation: &CancellationToken,
    ) -> Result<RealtimeSession, ModelProviderError> {
        super::check_cancellation(cancellation)?;
        let runtime = self.with_configs([config])?;
        let normalized = runtime.configs.normalize_for(config, &model.provider)?;
        let definition = runtime
            .configs
            .get(&normalized.provider)
            .expect("normalized provider exists");
        if definition.realtime_api_profile != RealtimeApiProfile::OpenAiRealtime {
            return Err(ModelProviderError::Unavailable(
                "provider has no declared Realtime GA protocol".into(),
            ));
        }
        if ash_model_provider_config::find_static_model(model).is_some_and(|model| {
            !matches!(
                model.runtime,
                ash_model_provider_config::StaticModelRuntime::ProviderApi
            )
        }) {
            return Err(ModelProviderError::Unavailable(
                "subscription text models do not authorize the Realtime service".into(),
            ));
        }
        let connection = runtime.direct_connection(&normalized)?;
        let provider = runtime.instantiate_normalized_with_connection(normalized, connection)?;
        provider.resolve_model(&model.model)?;
        let target = provider.target.resolve()?;
        RealtimeSession::connect(
            connector,
            target.api_target(),
            model.model.as_str(),
            limits,
            cancellation,
        )
        .await
        .map_err(Into::into)
    }
}

impl ResponsesModelSession {
    pub fn connection_stats(&self) -> ash_api::ResponsesConnectionStats {
        self.session.stats()
    }
    pub fn is_open(&self) -> bool {
        self.session.is_open()
    }
    pub async fn close(
        &mut self,
        cancellation: &CancellationToken,
    ) -> Result<(), ModelProviderError> {
        self.session.close(cancellation).await.map_err(Into::into)
    }

    pub async fn invoke(
        &mut self,
        request: &ModelRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn ModelEventSink,
    ) -> Result<ModelResponse, ModelProviderError> {
        self.refresh_auth(cancellation).await?;
        let model = self.provider.resolve_model(
            &ash_model_provider_config::ModelId::new(&self.model).expect("validated model ID"),
        )?;
        let request = self.provider.prepare_request(&model, request);
        let mut events = Events {
            inner: sink,
            failure: None,
        };
        let result = self
            .session
            .invoke(&request, cancellation, &mut events)
            .await;
        if let Some(error) = events.failure {
            return Err(error);
        }
        result.map_err(Into::into)
    }
    pub async fn warm_up(
        &mut self,
        request: &ModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<ash_api::ResponsesWarmup, ModelProviderError> {
        self.refresh_auth(cancellation).await?;
        let model = self.provider.resolve_model(
            &ash_model_provider_config::ModelId::new(&self.model).expect("validated model ID"),
        )?;
        let request = self.provider.prepare_request(&model, request);
        self.session
            .warm_up(&request, cancellation)
            .await
            .map_err(Into::into)
    }

    async fn refresh_auth(
        &mut self,
        cancellation: &CancellationToken,
    ) -> Result<(), ModelProviderError> {
        super::check_cancellation(cancellation)?;
        let target = match self.provider.target.resolve() {
            Ok(target) => target.into_api_target(),
            Err(error) => {
                self.session.abort();
                return Err(error);
            }
        };
        if target != self.target {
            self.session.abort();
            self.session = ResponsesWebSocketSession::connect(
                &self.connector,
                &target,
                self.provider
                    .target
                    .endpoint(self.provider.adapter.endpoint()),
                &self.model,
                self.cache_key.clone(),
                self.limits,
                cancellation,
            )
            .await?;
            self.target = target;
        }
        Ok(())
    }
}
struct Events<'a> {
    inner: &'a mut dyn ModelEventSink,
    failure: Option<ModelProviderError>,
}
impl ApiStreamSink for Events<'_> {
    fn emit(&mut self, event: ModelStreamEvent) -> Result<(), ApiError> {
        if let Err(error) = self.inner.emit(event) {
            self.failure = Some(error);
            return Err(ApiError::Transport(
                "model stream consumer rejected a WebSocket event".into(),
            ));
        }
        Ok(())
    }
}

/// A caller-owned speech session with a resolved provider/model identity and fixed voice.
/// Created only through ModelProviderRuntime so room consumers cannot bypass model admission.
pub struct VoiceModelSession {
    model: ModelRef,
    voice: String,
    session: ash_api::LiveSession,
}

impl VoiceModelSession {
    pub fn model(&self) -> &ModelRef {
        &self.model
    }
    pub fn voice(&self) -> &str {
        &self.voice
    }
    pub fn session_id(&self) -> &str {
        self.session.session_id()
    }
    pub fn is_open(&self) -> bool {
        self.session.is_open()
    }
    pub async fn send(
        &mut self,
        command: ash_api::LiveCommand,
        cancellation: &CancellationToken,
    ) -> Result<(), ModelProviderError> {
        self.session
            .send(command, cancellation)
            .await
            .map_err(Into::into)
    }
    pub async fn receive(
        &mut self,
        cancellation: &CancellationToken,
    ) -> Result<ash_api::LiveEvent, ModelProviderError> {
        self.session.receive(cancellation).await.map_err(Into::into)
    }
    pub async fn close(
        &mut self,
        cancellation: &CancellationToken,
    ) -> Result<ash_api::LiveEvent, ModelProviderError> {
        self.session.close(cancellation).await.map_err(Into::into)
    }
}

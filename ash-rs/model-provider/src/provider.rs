#[path = "websocket_session.rs"]
mod websocket_session;
pub use websocket_session::ResponsesModelSession;
pub use websocket_session::VoiceModelSession;

use crate::ModelCatalogBinding;
use crate::ModelProviderError;
use crate::ProviderCredentialService;
use crate::diagnostics::DiagnosticClient;
use crate::lazy_client::LazyOperationClient;
use crate::providers;
use crate::providers::ProviderAdapter;
use ash_api::ApiEndpoint;
use ash_api::ApiProtocol;
use ash_api::ApiStreamSink;
use ash_api::ContentPart;
use ash_api::InputItem;
use ash_api::ModelRequest;
use ash_api::ModelResponse;
use ash_api::ModelStreamEvent;
use ash_api::OutputItem;
use ash_api::StopReason;
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use ash_chatgpt::ChatGptApiTarget;
use ash_chatgpt::ChatGptOAuth;
use ash_client::AshClient;
use ash_client::ClientError;
use ash_client::ClientRequest;
use ash_client::ClientResponse;
use ash_client::OperationClient;
use ash_client::OperationStreamSink;
use ash_client::ResolvedApiTarget;
use ash_context_engine::ContextTokenMeasurementCapability;
use ash_context_engine::ContextTokenMeasurementOutcome;
use ash_http_client::UreqHttpClient;
use ash_kimi::KimiOAuth;
use ash_model_provider_config::Model;
use ash_model_provider_config::ModelId;
use ash_model_provider_config::ModelProviderConfig;
use ash_model_provider_config::NormalizedModelProviderConfig;
use ash_model_provider_config::ProviderAccessMode;
use ash_model_provider_config::ProviderConfigError;
use ash_model_provider_config::ProviderConfigRegistry;
use ash_model_provider_config::ProviderDefinition;
use ash_model_provider_config::ProviderId;
use ash_model_tokenizer::LocalTokenizerRegistry;
use ash_model_tokenizer::LocalTokenizerService;
use ash_models_manager::ModelRequirements;
use ash_models_manager::ModelsManager;
use ash_models_manager::ModelsManagerError;
use ash_protocol::CapabilitySupport;
use ash_protocol::ModelImageInputPolicy;
use ash_protocol::ModelOutputTransport;
use ash_protocol::ModelRef;
use ash_secrets::SecretStore;
use response_debug_context::AuthRecovery;
use response_debug_context::ResponseDiagnosticSink;
use response_debug_context::ResponseOperation;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;

enum ProviderConnection {
    ChatGpt { auth: Arc<ChatGptOAuth> },
    Xai { auth: Arc<xai::XaiOAuth> },
    Direct { headers: crate::auth::ModelHeaders },
    Subscription { target: ResolvedApiTarget },
}

#[derive(Clone)]
enum ProviderTarget {
    Fixed(ResolvedApiTarget),
    ChatGpt(Arc<ChatGptOAuth>),
    Xai(Arc<xai::XaiOAuth>),
}

enum ResolvedProviderTarget<'a> {
    Fixed(&'a ResolvedApiTarget),
    ChatGpt(ChatGptApiTarget),
    Xai(xai::XaiApiTarget),
}

impl ResolvedProviderTarget<'_> {
    fn api_target(&self) -> &ResolvedApiTarget {
        match self {
            Self::Fixed(target) => target,
            Self::ChatGpt(target) => target.api_target(),
            Self::Xai(target) => &target.target,
        }
    }

    fn into_api_target(self) -> ResolvedApiTarget {
        match self {
            Self::Fixed(target) => target.clone(),
            Self::ChatGpt(target) => target.into_api_target(),
            Self::Xai(target) => target.target,
        }
    }
}

impl ProviderTarget {
    fn endpoint(&self, direct: ApiEndpoint) -> ApiEndpoint {
        match self {
            Self::ChatGpt(_) => ApiEndpoint::ChatGptResponses,
            Self::Xai(_) => ApiEndpoint::XaiSubscriptionResponses,
            Self::Fixed(_) => direct,
        }
    }

    fn resolve(&self) -> Result<ResolvedProviderTarget<'_>, ModelProviderError> {
        match self {
            Self::Fixed(target) => Ok(ResolvedProviderTarget::Fixed(target)),
            Self::Xai(auth) => auth
                .api_target()
                .map(ResolvedProviderTarget::Xai)
                .map_err(|error| ModelProviderError::Credential(error.to_string())),
            Self::ChatGpt(auth) => auth
                .api_target()
                .map(ResolvedProviderTarget::ChatGpt)
                .map_err(|error| ModelProviderError::Credential(error.to_string())),
        }
    }

    fn recover_unauthorized(
        &self,
        rejected: &ResolvedProviderTarget<'_>,
    ) -> Result<Option<ResolvedProviderTarget<'static>>, ModelProviderError> {
        match (self, rejected) {
            (Self::Xai(auth), ResolvedProviderTarget::Xai(rejected)) => auth
                .recover_unauthorized(rejected)
                .map(|target| target.map(ResolvedProviderTarget::Xai))
                .map_err(|error| ModelProviderError::Credential(error.to_string())),
            (Self::ChatGpt(auth), ResolvedProviderTarget::ChatGpt(rejected)) => auth
                .recover_unauthorized(rejected)
                .map(|target| target.map(ResolvedProviderTarget::ChatGpt))
                .map_err(|error| ModelProviderError::Credential(error.to_string())),
            _ => Ok(None),
        }
    }

    fn note_rejected(&self, target: &ResolvedProviderTarget<'_>) {
        if let (Self::Xai(auth), ResolvedProviderTarget::Xai(target)) = (self, target) {
            auth.note_rejected(target);
        }
        if let (Self::ChatGpt(auth), ResolvedProviderTarget::ChatGpt(target)) = (self, target) {
            auth.note_rejected(target);
        }
    }
}

struct AttemptEvents<'a> {
    sink: &'a mut dyn ModelEventSink,
    emitted: bool,
}

// Only an HTTP 401 proves rejection before model execution. A similarly named
// error inside an accepted response stream must not cause the request to replay.
struct AttemptClient<'a> {
    client: &'a dyn OperationClient,
    unauthorized: AtomicBool,
}

impl<'a> AttemptClient<'a> {
    fn new(client: &'a dyn OperationClient) -> Self {
        Self {
            client,
            unauthorized: AtomicBool::new(false),
        }
    }

    fn observe(
        &self,
        result: Result<ClientResponse, ClientError>,
    ) -> Result<ClientResponse, ClientError> {
        if result
            .as_ref()
            .is_ok_and(|response| response.status() == 401)
        {
            self.unauthorized.store(true, Ordering::Relaxed);
        }
        result
    }

    fn was_unauthorized(&self) -> bool {
        self.unauthorized.load(Ordering::Relaxed)
    }
}

impl OperationClient for AttemptClient<'_> {
    fn execute(&self, request: &ClientRequest) -> Result<ClientResponse, ClientError> {
        self.observe(self.client.execute(request))
    }
    fn execute_with_cancellation(
        &self,
        request: &ClientRequest,
        cancellation: &CancellationToken,
    ) -> Result<ClientResponse, ClientError> {
        self.observe(self.client.execute_with_cancellation(request, cancellation))
    }

    fn execute_streaming(
        &self,
        request: &ClientRequest,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        self.observe(self.client.execute_streaming(request, sink))
    }
    fn execute_streaming_with_cancellation(
        &self,
        request: &ClientRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn OperationStreamSink,
    ) -> Result<ClientResponse, ClientError> {
        self.observe(
            self.client
                .execute_streaming_with_cancellation(request, cancellation, sink),
        )
    }
}

impl ModelEventSink for AttemptEvents<'_> {
    fn emit(&mut self, event: ModelStreamEvent) -> Result<(), ModelProviderError> {
        self.emitted = true;
        self.sink.emit(event)
    }
}

#[derive(Clone)]
enum RemoteMeasurement {
    Enabled(Vec<ash_http_client::HttpHeader>),
    Disabled,
}

#[derive(Clone)]
pub struct Provider {
    definition: ProviderDefinition,
    config: NormalizedModelProviderConfig,
    models: ModelsManager,
    adapter: Arc<dyn ProviderAdapter>,
    target: ProviderTarget,
    remote_measurement: RemoteMeasurement,
    client: Arc<dyn OperationClient>,
    local_counter: providers::measurement::LocalInputTokenCounter,
    diagnostics: Option<Arc<dyn ResponseDiagnosticSink>>,
}

impl Provider {
    fn instantiate(
        definition: ProviderDefinition,
        config: NormalizedModelProviderConfig,
        models: ModelsManager,
        client: Arc<dyn OperationClient>,
        local_tokenizers: Arc<dyn LocalTokenizerService>,
        connection: ProviderConnection,
    ) -> Result<Self, ModelProviderError> {
        if definition.id != config.provider {
            return Err(ProviderConfigError::ProviderMismatch {
                configured: config.provider,
                selected: definition.id,
            }
            .into());
        }
        let adapter = providers::instantiate(definition.adapter, &config);
        let (target, remote_measurement) = match connection {
            ProviderConnection::Direct {
                headers: credentials,
            } => {
                let mut headers = adapter.fixed_headers();
                headers.extend(credentials.invocation);
                let mut count_headers = adapter.fixed_headers();
                count_headers.extend(credentials.measurement);
                (
                    ProviderTarget::Fixed(ResolvedApiTarget::new(config.base_url.clone(), headers)),
                    RemoteMeasurement::Enabled(count_headers),
                )
            }
            ProviderConnection::Subscription { target } => {
                (ProviderTarget::Fixed(target), RemoteMeasurement::Disabled)
            }
            ProviderConnection::Xai { auth } => {
                (ProviderTarget::Xai(auth), RemoteMeasurement::Disabled)
            }
            ProviderConnection::ChatGpt { auth } => {
                (ProviderTarget::ChatGpt(auth), RemoteMeasurement::Disabled)
            }
        };
        let local_counter = providers::measurement::LocalInputTokenCounter::new(
            config.provider.clone(),
            local_tokenizers,
        );
        Ok(Self {
            definition,
            config,
            models,
            adapter,
            target,
            remote_measurement,
            client,
            local_counter,
            diagnostics: None,
        })
    }

    fn prepare_request(&self, model: &Model, request: &ModelRequest) -> ModelRequest {
        let mut request = request.clone();
        request.max_output_tokens = request.max_output_tokens.or(self.config.max_output_tokens);
        let _ = request.sanitize_image_details(
            model.capabilities.image_detail_original == CapabilitySupport::Supported,
        );
        request
    }

    pub fn id(&self) -> &ProviderId {
        &self.definition.id
    }

    pub fn definition(&self) -> &ProviderDefinition {
        &self.definition
    }

    pub fn config(&self) -> &NormalizedModelProviderConfig {
        &self.config
    }

    pub fn protocol(&self) -> ApiProtocol {
        self.target.endpoint(self.adapter.endpoint()).protocol()
    }

    pub fn build_model(
        &self,
        model_id: &ModelId,
    ) -> Result<Arc<dyn ModelInvoker>, ModelProviderError> {
        let model = self.resolve_model(model_id)?;
        Ok(Arc::new(RegisteredModelInvoker {
            provider: self.clone(),
            model,
        }))
    }

    pub fn complete(
        &self,
        model_id: &ModelId,
        request: &ModelRequest,
    ) -> Result<ModelResponse, ModelProviderError> {
        self.complete_with_cancellation(model_id, request, &CancellationSource::new().token())
    }

    pub fn complete_with_cancellation(
        &self,
        model_id: &ModelId,
        request: &ModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<ModelResponse, ModelProviderError> {
        self.execute_with_cancellation(model_id, request, cancellation, &mut DiscardModelEvents)
    }

    pub fn stream_with_cancellation(
        &self,
        model_id: &ModelId,
        request: &ModelRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn ModelEventSink,
    ) -> Result<ModelResponse, ModelProviderError> {
        check_cancellation(cancellation)?;
        if self.definition.output_transport == ModelOutputTransport::Unary {
            return Err(ModelProviderError::Unavailable(
                "the configured model endpoint does not support streaming".into(),
            ));
        }
        self.execute_with_cancellation(model_id, request, cancellation, sink)
    }

    fn execute_with_cancellation(
        &self,
        model_id: &ModelId,
        request: &ModelRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn ModelEventSink,
    ) -> Result<ModelResponse, ModelProviderError> {
        let diagnostic = DiagnosticClient::new(
            self.client.clone(),
            self.diagnostics.clone(),
            ResponseOperation::Model,
        );
        let result = (|| {
            let model = self.resolve_model(model_id)?;
            let request = self.prepare_request(&model, request);
            check_cancellation(cancellation)?;
            let target = self.target.resolve()?;
            let attempt_client = AttemptClient::new(&diagnostic);
            let mut attempt = AttemptEvents {
                sink,
                emitted: false,
            };
            let response = self.execute_attempt(
                &target,
                model.id.as_str(),
                &request,
                &attempt_client,
                cancellation,
                &mut attempt,
            );
            if matches!(
                response,
                Err(ModelProviderError::AuthFailed(_)
                    | ModelProviderError::Api(ash_api::ApiError::HttpStatus(401)))
            ) && !attempt.emitted
                && attempt_client.was_unauthorized()
            {
                check_cancellation(cancellation)?;
                let recovered = self.target.recover_unauthorized(&target);
                diagnostic.recovery(match &recovered {
                    Ok(Some(_)) => AuthRecovery::CredentialsRecovered,
                    Ok(None) => AuthRecovery::Unavailable,
                    Err(_) => AuthRecovery::Failed,
                });
                if let Some(renewed) = recovered? {
                    let retry_client = AttemptClient::new(&diagnostic);
                    let response = self.execute_attempt(
                        &renewed,
                        model.id.as_str(),
                        &request,
                        &retry_client,
                        cancellation,
                        &mut attempt,
                    );
                    if matches!(
                        response,
                        Err(ModelProviderError::AuthFailed(_)
                            | ModelProviderError::Api(ash_api::ApiError::HttpStatus(401)))
                    ) && retry_client.was_unauthorized()
                    {
                        self.target.note_rejected(&renewed);
                    }
                    check_cancellation(cancellation)?;
                    return response;
                }
                self.target.note_rejected(&target);
            }
            check_cancellation(cancellation)?;
            response
        })();
        diagnostic.finish(&result);
        result
    }

    fn execute_attempt(
        &self,
        target: &ResolvedProviderTarget<'_>,
        model: &str,
        request: &ModelRequest,
        client: &dyn OperationClient,
        cancellation: &CancellationToken,
        sink: &mut dyn ModelEventSink,
    ) -> Result<ModelResponse, ModelProviderError> {
        use sha2::Digest;
        let endpoint = self.target.endpoint(self.adapter.endpoint());
        let model = self.adapter.model_id(model);
        let mut digest = sha2::Sha256::new();
        let mut hash = |value: &str| {
            digest.update((value.len() as u64).to_be_bytes());
            digest.update(value.as_bytes());
        };
        hash(self.id().as_str());
        hash(&format!("{endpoint:?}"));
        hash(model);
        match target {
            ResolvedProviderTarget::Xai(target) => hash(&target.account_id),
            _ => {
                hash(&target.api_target().base_url);
                for header in &target.api_target().headers {
                    hash(header.name());
                    hash(header.value());
                }
            }
        }
        let scope = format!("{:x}", digest.finalize());
        let mut request = request.clone();
        let mut retained_prefix: u32 = 0;
        let mut index = 0;
        request.input.retain(|item| {
            let keep = match item {
                InputItem::Reasoning(state) => {
                    endpoint.protocol() == ApiProtocol::OpenAiResponses && state.scope == scope
                }
                _ => true,
            };
            if keep
                && request
                    .prompt_cache_prefix_end
                    .is_some_and(|end| index <= end)
            {
                retained_prefix += 1;
            }
            index += 1;
            keep
        });
        request.prompt_cache_prefix_end = retained_prefix.checked_sub(1);
        let target = target.api_target();
        let mut response = match self.definition.output_transport {
            ModelOutputTransport::NativeStreaming => stream_endpoint(
                endpoint,
                target,
                model,
                &request,
                client,
                cancellation,
                sink,
            ),
            ModelOutputTransport::Unary => endpoint
                .complete_with_client_and_cancellation(
                    target,
                    model,
                    &request,
                    client,
                    cancellation,
                )
                .map_err(Into::into),
        }?;
        for item in &mut response.output {
            if let OutputItem::ReasoningState(state) = item {
                state.scope = scope.clone();
            }
        }
        Ok(response)
    }

    pub fn input_token_measurement_capability(
        &self,
        model_id: &ModelId,
    ) -> Result<ContextTokenMeasurementCapability, ModelProviderError> {
        let model = self.resolve_model(model_id)?;
        let provider = if matches!(self.remote_measurement, RemoteMeasurement::Enabled(_)) {
            self.adapter
                .input_token_measurement_capability(model.id.as_str())
        } else {
            ContextTokenMeasurementCapability::Unavailable
        };
        if provider != ContextTokenMeasurementCapability::Unavailable {
            Ok(provider)
        } else if self.local_counter.supports(model.id.as_str()) {
            Ok(ContextTokenMeasurementCapability::Local)
        } else {
            Ok(ContextTokenMeasurementCapability::Unavailable)
        }
    }

    pub fn measure_input_with_cancellation(
        &self,
        model_id: &ModelId,
        request: &ModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<ContextTokenMeasurementOutcome, ModelProviderError> {
        let model = self.resolve_model(model_id)?;
        let provider = if let RemoteMeasurement::Enabled(headers) = &self.remote_measurement {
            let target = ResolvedApiTarget::new(self.config.base_url.clone(), headers.clone());
            let diagnostic = DiagnosticClient::new(
                self.client.clone(),
                self.diagnostics.clone(),
                ResponseOperation::InputTokenCount,
            );
            let result = self.adapter.measure_input(
                &target,
                model.id.as_str(),
                request,
                &diagnostic,
                cancellation,
            );
            diagnostic.finish(&result);
            result
        } else {
            Ok(ContextTokenMeasurementOutcome::Unavailable)
        };
        match provider {
            Ok(ContextTokenMeasurementOutcome::Measured(measurement)) => {
                return Ok(ContextTokenMeasurementOutcome::Measured(measurement));
            }
            Err(ModelProviderError::Cancelled(message)) => {
                return Err(ModelProviderError::Cancelled(message));
            }
            Ok(ContextTokenMeasurementOutcome::Unavailable) | Err(_) => {}
        }
        match self
            .local_counter
            .count(model.id.as_str(), request, cancellation)
        {
            Ok(outcome) => Ok(outcome),
            Err(ModelProviderError::Cancelled(message)) => {
                Err(ModelProviderError::Cancelled(message))
            }
            Err(_) => Ok(ContextTokenMeasurementOutcome::Unavailable),
        }
    }

    fn resolve_model(&self, model_id: &ModelId) -> Result<Model, ModelProviderError> {
        if let ProviderTarget::Xai(auth) = &self.target {
            let binding =
                crate::catalog::xai_catalog_binding(Arc::clone(auth))?.ok_or_else(|| {
                    ModelProviderError::Credential("xAI Subscription is not signed in".into())
                })?;
            return self
                .models
                .resolve(binding.scope(), model_id, &ModelRequirements::agent())
                .map(|resolved| resolved.entry().info().clone())
                .map_err(model_resolution_error);
        }
        if let ProviderTarget::ChatGpt(auth) = &self.target {
            let binding = crate::catalog::chatgpt_catalog_binding(
                Arc::clone(auth),
                Arc::clone(&self.client),
                self.diagnostics.clone(),
            )?
            .ok_or_else(|| ModelProviderError::Credential("ChatGPT is not signed in".into()))?;
            return self
                .models
                .resolve(binding.scope(), model_id, &ModelRequirements::agent())
                .map(|resolved| resolved.entry().info().clone())
                .map_err(model_resolution_error);
        }
        self.models
            .resolve_static(
                &ModelRef::new(self.definition.id.clone(), model_id.clone()),
                &ModelRequirements::agent(),
            )
            .map(|resolved| resolved.entry().info().clone())
            .map_err(model_resolution_error)
    }
}

/// Process-local runtime that instantiates declarative provider configuration.
#[derive(Clone)]
pub struct ModelProviderRuntime {
    configs: ProviderConfigRegistry,
    models: ModelsManager,
    client: Arc<dyn OperationClient>,
    credentials: Option<ProviderCredentialService>,
    local_tokenizers: Arc<dyn LocalTokenizerService>,
    chatgpt_oauth: Option<Arc<ChatGptOAuth>>,
    kimi_oauth: Option<Arc<KimiOAuth>>,
    xai_oauth: Option<Arc<xai::XaiOAuth>>,
    diagnostics: Option<Arc<dyn ResponseDiagnosticSink>>,
}

impl ModelProviderRuntime {
    /// Creates an immutable runtime for the exact persisted connection definitions.
    pub fn with_configs<'a>(
        &self,
        configs: impl IntoIterator<Item = &'a ModelProviderConfig>,
    ) -> Result<Self, ModelProviderError> {
        let configs = self.configs.with_configs(configs)?;
        let mut runtime = self.clone();
        runtime.models = self.models.with_registry(configs.clone());
        runtime.credentials = self
            .credentials
            .as_ref()
            .map(|credentials| credentials.with_registry(configs.clone()));
        runtime.configs = configs;
        Ok(runtime)
    }
    pub fn new(configs: ProviderConfigRegistry) -> Self {
        Self::with_client(
            configs,
            Arc::new(LazyOperationClient::new(production_client)),
        )
    }

    pub fn with_client(configs: ProviderConfigRegistry, client: Arc<dyn OperationClient>) -> Self {
        let models = ModelsManager::new(configs.clone());
        Self {
            configs,
            models,
            client,
            credentials: None,
            local_tokenizers: Arc::new(LocalTokenizerRegistry::new()),
            chatgpt_oauth: None,
            kimi_oauth: None,
            xai_oauth: None,
            diagnostics: None,
        }
    }

    pub fn with_secrets(configs: ProviderConfigRegistry, secrets: Arc<dyn SecretStore>) -> Self {
        Self::with_client_and_secrets(
            configs,
            Arc::new(LazyOperationClient::new(production_client)),
            secrets,
        )
    }

    pub fn with_client_and_secrets(
        configs: ProviderConfigRegistry,
        client: Arc<dyn OperationClient>,
        secrets: Arc<dyn SecretStore>,
    ) -> Self {
        let models = ModelsManager::new(configs.clone());
        let credentials = ProviderCredentialService::new(configs.clone(), Arc::clone(&secrets));
        Self {
            configs,
            models,
            client,
            credentials: Some(credentials),
            local_tokenizers: Arc::new(LocalTokenizerRegistry::new()),
            chatgpt_oauth: None,
            kimi_oauth: None,
            xai_oauth: None,
            diagnostics: None,
        }
    }

    /// Installs the read-only local tokenizer service used by provider/model adapters.
    ///
    /// The host must finish loading and validating model bindings before composition. Existing
    /// model invokers remain immutable and retain the service snapshot they were created with.
    pub fn with_local_tokenizers(
        mut self,
        local_tokenizers: Arc<dyn LocalTokenizerService>,
    ) -> Self {
        self.local_tokenizers = local_tokenizers;
        self
    }

    pub fn with_catalog_cache(mut self, directory: PathBuf) -> Self {
        self.models = self.models.with_disk_cache(directory);
        self
    }

    /// Installs the xAI subscription credential authority.
    pub fn with_xai_oauth(mut self, auth: Arc<xai::XaiOAuth>) -> Self {
        self.xai_oauth = Some(auth);
        self
    }

    /// Installs the Kimi Code OAuth authority used by subscription model rows.
    pub fn with_kimi_oauth(mut self, kimi_oauth: Arc<KimiOAuth>) -> Self {
        self.kimi_oauth = Some(kimi_oauth);
        self
    }

    /// Installs the ChatGPT OAuth authority used by subscription model rows.
    pub fn with_chatgpt_oauth(mut self, chatgpt_oauth: Arc<ChatGptOAuth>) -> Self {
        self.chatgpt_oauth = Some(chatgpt_oauth);
        self
    }

    /// Invokes a small request against an unsaved connection, or discovers its model IDs.
    /// The optional key is used only for this call; stored credentials are never changed.
    pub fn probe_connection(
        &self,
        config: &ModelProviderConfig,
        api_key: Option<Vec<u8>>,
        model: Option<&str>,
    ) -> Result<Option<Vec<String>>, ModelProviderError> {
        let diagnostic = DiagnosticClient::new(
            self.client.clone(),
            self.diagnostics.clone(),
            ResponseOperation::ConnectionProbe,
        );
        let result = (|| {
            let runtime = self.with_configs([config])?;
            let normalized = runtime.configs.normalize(config)?;
            let definition = runtime
                .configs
                .get(&config.provider)
                .expect("validated provider");
            let adapter = providers::instantiate(definition.adapter, &normalized);
            let credentials = match api_key {
                Some(key) => {
                    let credentials = ProviderCredentialService::new(
                        runtime.configs.clone(),
                        Arc::new(ash_secrets::MemorySecretStore::default()),
                    );
                    credentials
                        .set_api_key(&config.provider, key)
                        .map_err(|error| ModelProviderError::Credential(error.to_string()))?;
                    Some(credentials)
                }
                None => runtime.credentials.clone(),
            };
            let mut headers = adapter.fixed_headers();
            if let Some(credentials) = credentials {
                headers.extend(
                    credentials
                        .request_headers(&config.provider)
                        .map_err(|error| ModelProviderError::Credential(error.to_string()))?,
                );
            }
            let target = ResolvedApiTarget::new(normalized.base_url, headers);
            let cancellation = CancellationSource::new();
            if let Some(model) = model {
                ModelId::new(model)
                    .map_err(|error| ModelProviderError::InvalidRequest(error.to_string()))?;
                let mut request = ModelRequest::text("Reply with OK.");
                request.max_output_tokens = Some(1024);
                let endpoint = adapter.endpoint();
                let model = adapter.model_id(model);
                match definition.output_transport {
                    ModelOutputTransport::NativeStreaming => stream_endpoint(
                        endpoint,
                        &target,
                        model,
                        &request,
                        &diagnostic,
                        &cancellation.token(),
                        &mut DiscardModelEvents,
                    )?,
                    ModelOutputTransport::Unary => endpoint.complete_with_client_and_cancellation(
                        &target,
                        model,
                        &request,
                        &diagnostic,
                        &cancellation.token(),
                    )?,
                };
                return Ok(None);
            }
            let request = ClientRequest::new(
                ash_http_client::HttpMethod::Get,
                target
                    .endpoint("models")
                    .map_err(|error| ModelProviderError::InvalidRequest(error.to_string()))?,
                target.headers,
                Vec::new(),
                ash_client::RetryPolicy::never(),
            )
            .map_err(|error| ModelProviderError::InvalidRequest(error.to_string()))?;
            let response = diagnostic
                .execute_with_cancellation(&request, &cancellation.token())
                .map_err(|error| ModelProviderError::Unavailable(error.to_string()))?;
            if !(200..300).contains(&response.status()) {
                return Err(ash_api::ApiError::HttpStatus(response.status()).into());
            }
            let value: serde_json::Value = serde_json::from_slice(response.body())
                .map_err(|_| ModelProviderError::InvalidResponse("Invalid model list".into()))?;
            let rows = value
                .get("data")
                .and_then(serde_json::Value::as_array)
                .ok_or_else(|| {
                    ModelProviderError::InvalidResponse("Expected a model data list".into())
                })?;
            let mut models = Vec::new();
            for row in rows {
                let id = row
                    .get("id")
                    .and_then(serde_json::Value::as_str)
                    .ok_or_else(|| {
                        ModelProviderError::InvalidResponse("Model entry has no ID".into())
                    })?;
                ModelId::new(id)
                    .map_err(|error| ModelProviderError::InvalidResponse(error.to_string()))?;
                if !models.iter().any(|existing| existing == id) {
                    models.push(id.to_owned());
                }
            }
            Ok(Some(models))
        })();
        diagnostic.finish(&result);
        result
    }

    /// Installs the product-owned bounded diagnostic destination.
    pub fn with_response_diagnostics(
        mut self,
        diagnostics: Arc<dyn ResponseDiagnosticSink>,
    ) -> Self {
        self.diagnostics = Some(diagnostics);
        self
    }

    pub fn builtin() -> Self {
        Self::new(ProviderConfigRegistry::builtin())
    }

    pub fn builtin_with_client(client: Arc<dyn OperationClient>) -> Self {
        Self::with_client(ProviderConfigRegistry::builtin(), client)
    }

    /// Returns the shared catalog manager used by this runtime for model resolution.
    pub fn models_manager(&self) -> ModelsManager {
        self.models.clone()
    }

    pub fn models_manager_for_config(
        &self,
        config: &ModelProviderConfig,
    ) -> Result<ModelsManager, ModelProviderError> {
        let effective = self.effective_config(config)?;
        let registry = self.configs.with_configs([&effective])?;
        Ok(self.models.with_registry(registry))
    }

    /// Materializes the active connection. A ready subscription takes precedence over
    /// a stored API key; a credential-store error must not silently change the route.
    pub fn effective_config(
        &self,
        config: &ModelProviderConfig,
    ) -> Result<ModelProviderConfig, ModelProviderError> {
        let subscription_ready = match config.provider.as_str() {
            "openai" => self
                .chatgpt_oauth
                .as_ref()
                .map(|auth| auth.account_id())
                .transpose()
                .map_err(|error| ModelProviderError::Credential(error.to_string()))?
                .flatten()
                .is_some(),
            "xai" => self
                .xai_oauth
                .as_ref()
                .map(|auth| auth.subscription_ready())
                .transpose()
                .map_err(|error| ModelProviderError::Credential(error.to_string()))?
                .unwrap_or(false),
            "kimi" => self
                .kimi_oauth
                .as_ref()
                .map(|auth| auth.subscription_ready())
                .transpose()
                .map_err(|error| ModelProviderError::Credential(error.to_string()))?
                .unwrap_or(false),
            "bigmodel-coding-plan" | "zai-coding-plan" => {
                // Each plan has its own connection and credential, even when the wire adapter
                // and model catalog are shared with the corresponding API connection.
                let endpoint = match config.provider.as_str() {
                    "bigmodel-coding-plan" => {
                        ash_model_provider_config::BIGMODEL_CODING_PLAN_BASE_URL
                    }
                    "zai-coding-plan" => ash_model_provider_config::ZAI_CODING_PLAN_BASE_URL,
                    _ => unreachable!(),
                };
                let coding_plan_selected = config
                    .base_url
                    .as_deref()
                    .is_some_and(|base_url| base_url.trim().trim_end_matches('/') == endpoint);
                coding_plan_selected
                    && self
                        .credentials
                        .as_ref()
                        .map(|credentials| {
                            credentials
                                .stored_api_key(&config.provider)
                                .map(|key| key.is_some())
                        })
                        .transpose()
                        .map_err(|error| ModelProviderError::Credential(error.to_string()))?
                        .unwrap_or(false)
            }
            _ => false,
        };
        let mut effective = config.clone();
        effective.access_mode = if subscription_ready {
            ProviderAccessMode::Subscription
        } else {
            ProviderAccessMode::Api
        };
        if subscription_ready {
            effective.base_url = None;
        }
        Ok(effective)
    }

    /// Resolves a dynamic model catalog source for one immutable provider configuration.
    pub fn catalog_binding(
        &self,
        config: &ModelProviderConfig,
    ) -> Result<Option<ModelCatalogBinding>, ModelProviderError> {
        let config = self.effective_config(config)?;
        let runtime = self.with_configs([&config])?;
        let normalized = runtime.configs.normalize(&config)?;
        if normalized.access_mode == ProviderAccessMode::Subscription
            && normalized.provider.as_str() == "xai"
        {
            return self
                .xai_oauth
                .as_ref()
                .map(|auth| crate::catalog::xai_catalog_binding(Arc::clone(auth)))
                .transpose()
                .map(Option::flatten);
        }
        if normalized.access_mode == ProviderAccessMode::Subscription
            && normalized.provider.as_str() == "openai"
        {
            return self
                .chatgpt_oauth
                .as_ref()
                .map(|auth| {
                    crate::catalog::chatgpt_catalog_binding(
                        Arc::clone(auth),
                        Arc::clone(&self.client),
                        self.diagnostics.clone(),
                    )
                })
                .transpose()
                .map(Option::flatten);
        }
        if normalized.access_mode == ProviderAccessMode::Subscription
            && normalized.provider.as_str() == "kimi"
        {
            return self
                .kimi_oauth
                .as_ref()
                .map(|auth| crate::catalog::kimi_catalog_binding(Arc::clone(auth)))
                .transpose()
                .map(Option::flatten);
        }
        if normalized.access_mode == ProviderAccessMode::Subscription
            && matches!(
                normalized.provider.as_str(),
                "bigmodel-coding-plan" | "zai-coding-plan"
            )
        {
            let api_key = self
                .credentials
                .as_ref()
                .map(|credentials| credentials.stored_api_key(&normalized.provider))
                .transpose()
                .map_err(|error| ModelProviderError::Credential(error.to_string()))?
                .flatten();
            return crate::catalog::glm_coding_plan_catalog_binding(&normalized.provider, api_key);
        }
        let definition = runtime
            .configs
            .get(&normalized.provider)
            .expect("normalization only succeeds for registered providers");
        match definition.adapter {
            ash_model_provider_config::ProviderAdapter::OpenAi
            | ash_model_provider_config::ProviderAdapter::OpenAiCompatible => {
                let headers = runtime
                    .credentials
                    .as_ref()
                    .map(|credentials| credentials.request_headers(&config.provider))
                    .transpose()
                    .map_err(|error| ModelProviderError::Credential(error.to_string()))?
                    .unwrap_or_default();
                crate::catalog::openai_catalog_binding(
                    &normalized,
                    headers,
                    Arc::clone(&self.client),
                    self.diagnostics.clone(),
                )
                .map(Some)
            }
            ash_model_provider_config::ProviderAdapter::Ollama => {
                crate::catalog::ollama_catalog_binding(
                    normalized.provider,
                    &normalized.base_url,
                    Arc::clone(&self.client),
                )
                .map(Some)
                .map_err(|error| ModelProviderError::Unavailable(error.to_string()))
            }
            _ => Ok(None),
        }
    }

    pub fn instantiate(
        &self,
        config: &ModelProviderConfig,
    ) -> Result<Provider, ModelProviderError> {
        let config = self.effective_config(config)?;
        let runtime = self.with_configs([&config])?;
        let normalized = runtime.configs.normalize(&config)?;
        runtime.instantiate_normalized(normalized)
    }

    pub fn model_info(
        &self,
        config: &ModelProviderConfig,
        model: &ModelRef,
    ) -> Result<Model, ModelProviderError> {
        let config = self.effective_config(config)?;
        let runtime = self.with_configs([&config])?;
        let normalized = runtime.configs.normalize_for(&config, &model.provider)?;
        let connection = runtime.connection(&normalized)?;
        runtime
            .instantiate_normalized_with_connection(normalized, connection)?
            .resolve_model(&model.model)
    }

    pub fn build_model(
        &self,
        config: &ModelProviderConfig,
        model_ref: &ModelRef,
    ) -> Result<Arc<dyn ModelInvoker>, ModelProviderError> {
        let config = self.effective_config(config)?;
        let runtime = self.with_configs([&config])?;
        let normalized = runtime
            .configs
            .normalize_for(&config, &model_ref.provider)?;
        let connection = runtime.connection(&normalized)?;
        runtime
            .instantiate_normalized_with_connection(normalized, connection)?
            .build_model(&model_ref.model)
    }

    pub fn complete(
        &self,
        config: &ModelProviderConfig,
        model_ref: &ModelRef,
        request: &ModelRequest,
    ) -> Result<ModelResponse, ModelProviderError> {
        let config = self.effective_config(config)?;
        let runtime = self.with_configs([&config])?;
        let normalized = runtime
            .configs
            .normalize_for(&config, &model_ref.provider)?;
        let connection = runtime.connection(&normalized)?;
        runtime
            .instantiate_normalized_with_connection(normalized, connection)?
            .complete(&model_ref.model, request)
    }

    fn instantiate_normalized(
        &self,
        normalized: NormalizedModelProviderConfig,
    ) -> Result<Provider, ModelProviderError> {
        let connection = self.connection(&normalized)?;
        self.instantiate_normalized_with_connection(normalized, connection)
    }

    fn instantiate_normalized_with_connection(
        &self,
        normalized: NormalizedModelProviderConfig,
        connection: ProviderConnection,
    ) -> Result<Provider, ModelProviderError> {
        let definition = self
            .configs
            .get(&normalized.provider)
            .expect("normalization only succeeds for registered providers")
            .clone();
        let mut provider = Provider::instantiate(
            definition,
            normalized,
            self.models.clone(),
            self.client.clone(),
            self.local_tokenizers.clone(),
            connection,
        )?;
        provider.diagnostics = self.diagnostics.clone();
        Ok(provider)
    }

    fn connection(
        &self,
        normalized: &NormalizedModelProviderConfig,
    ) -> Result<ProviderConnection, ModelProviderError> {
        if normalized.access_mode == ProviderAccessMode::Subscription
            && normalized.provider.as_str() == "xai"
        {
            return self.xai_connection();
        }
        match (normalized.access_mode, normalized.provider.as_str()) {
            (ProviderAccessMode::Subscription, "kimi") => self
                .kimi_oauth
                .as_ref()
                .ok_or_else(|| {
                    ModelProviderError::Credential("Kimi Code OAuth is unavailable".into())
                })?
                .api_target()
                .map(|target| ProviderConnection::Subscription { target })
                .map_err(|error| ModelProviderError::Credential(error.to_string())),
            (ProviderAccessMode::Subscription, "bigmodel-coding-plan" | "zai-coding-plan") => {
                self.direct_connection(normalized)
            }
            (ProviderAccessMode::Subscription, "openai") => {
                let auth = self.chatgpt_oauth.as_ref().ok_or_else(|| {
                    ModelProviderError::Credential("ChatGPT OAuth is unavailable".into())
                })?;
                auth.api_target()
                    .map_err(|error| ModelProviderError::Credential(error.to_string()))?;
                // Keep the authority, not a token snapshot: a reused model must observe
                // Codex rotation, logout and Ash disconnection before every invocation.
                Ok(ProviderConnection::ChatGpt {
                    auth: Arc::clone(auth),
                })
            }
            (ProviderAccessMode::Api, _) => self.direct_connection(normalized),
            (ProviderAccessMode::Subscription, _) => Err(ModelProviderError::Unavailable(
                "subscription access is unavailable for this provider".into(),
            )),
        }
    }

    fn xai_connection(&self) -> Result<ProviderConnection, ModelProviderError> {
        let auth = self.xai_oauth.as_ref().ok_or_else(|| {
            ModelProviderError::Credential("xAI subscription login is unavailable".into())
        })?;
        Ok(ProviderConnection::Xai {
            auth: Arc::clone(auth),
        })
    }

    fn direct_connection(
        &self,
        normalized: &NormalizedModelProviderConfig,
    ) -> Result<ProviderConnection, ModelProviderError> {
        let headers = self
            .credentials
            .as_ref()
            .map(|credentials| credentials.request_model_headers(normalized))
            .transpose()
            .map_err(|error| ModelProviderError::Credential(error.to_string()))?
            .unwrap_or(crate::auth::ModelHeaders {
                invocation: Vec::new(),
                measurement: Vec::new(),
            });
        Ok(ProviderConnection::Direct { headers })
    }
}

fn model_resolution_error(error: ModelsManagerError) -> ModelProviderError {
    match error {
        ModelsManagerError::ModelNotListed { provider, model } => {
            ModelProviderError::ModelNotRegistered { provider, model }
        }
        error => ModelProviderError::Unavailable(error.to_string()),
    }
}

fn production_client() -> Result<Arc<dyn OperationClient>, ClientError> {
    let transport = UreqHttpClient::new()?;
    Ok(Arc::new(AshClient::new(Arc::new(transport))))
}

impl crate::SemanticModelProvider for ModelProviderRuntime {
    fn embedding_runtime_identity(
        &self,
        request: &crate::EmbeddingRuntimeRequest,
    ) -> Result<crate::EmbeddingRuntimeIdentity, ModelProviderError> {
        crate::semantic_runtime::SemanticRuntimeResolver {
            configs: self.configs.clone(),
            client: Arc::clone(&self.client),
            credentials: self.credentials.clone(),
        }
        .embedding_runtime_identity(request)
    }

    fn embedding_runtime_location(
        &self,
        request: &crate::EmbeddingRuntimeRequest,
    ) -> Result<crate::SemanticRuntimeLocation, ModelProviderError> {
        crate::semantic_runtime::SemanticRuntimeResolver {
            configs: self.configs.clone(),
            client: Arc::clone(&self.client),
            credentials: self.credentials.clone(),
        }
        .embedding_runtime_location(request)
    }

    fn rerank_runtime_location(
        &self,
        request: &crate::RerankRuntimeRequest,
    ) -> Result<crate::SemanticRuntimeLocation, ModelProviderError> {
        crate::semantic_runtime::SemanticRuntimeResolver {
            configs: self.configs.clone(),
            client: Arc::clone(&self.client),
            credentials: self.credentials.clone(),
        }
        .rerank_runtime_location(request)
    }

    fn embedding_runtime(
        &self,
        request: crate::EmbeddingRuntimeRequest,
    ) -> Result<Arc<dyn crate::EmbeddingInvoker>, ModelProviderError> {
        crate::semantic_runtime::SemanticRuntimeResolver {
            configs: self.configs.clone(),
            client: Arc::clone(&self.client),
            credentials: self.credentials.clone(),
        }
        .embedding_runtime(request)
    }

    fn rerank_runtime(
        &self,
        request: crate::RerankRuntimeRequest,
    ) -> Result<Arc<dyn crate::RerankInvoker>, ModelProviderError> {
        crate::semantic_runtime::SemanticRuntimeResolver {
            configs: self.configs.clone(),
            client: Arc::clone(&self.client),
            credentials: self.credentials.clone(),
        }
        .rerank_runtime(request)
    }
}

impl Default for ModelProviderRuntime {
    fn default() -> Self {
        Self::builtin()
    }
}

#[derive(Clone)]
pub struct ModelRuntimeRequest {
    pub model: ModelRef,
    pub config: ModelProviderConfig,
}

/// Receives provider-neutral model deltas from one immutable model invocation.
///
/// Implementations must preserve event order and should return an error when
/// cancellation or downstream lifecycle prevents more output from being
/// accepted.
pub trait ModelEventSink {
    fn emit(&mut self, event: ModelStreamEvent) -> Result<(), ModelProviderError>;
}

impl ModelRuntimeRequest {
    pub fn new(model: ModelRef, config: ModelProviderConfig) -> Self {
        Self { model, config }
    }
}

/// Invokes one immutable provider/model selection with a canonical request.
///
/// Implementations own provider transport and wire adaptation. They must not read Core Thread
/// state or mutable product configuration; a newly resolved invoker is used when configuration
/// changes should affect a later invocation.
pub trait ModelInvoker: Send + Sync {
    /// Returns image limits belonging to this immutable provider/model selection.
    fn image_input_policy(&self) -> ModelImageInputPolicy {
        ModelImageInputPolicy::default()
    }

    fn invoke(&self, request: &ModelRequest) -> Result<ModelResponse, ModelProviderError> {
        self.invoke_with_cancellation(request, &CancellationSource::new().token())
    }

    /// Reports whether this immutable runtime uses a native provider stream or a unary call.
    fn output_transport(&self) -> ModelOutputTransport;

    /// Reports the cost category of this immutable model's input-token measurement contract.
    fn input_token_measurement_capability(&self) -> ContextTokenMeasurementCapability {
        ContextTokenMeasurementCapability::Unavailable
    }

    /// Measures one fully assembled request using a fresh compatibility cancellation scope.
    fn measure_input(
        &self,
        request: &ModelRequest,
    ) -> Result<ContextTokenMeasurementOutcome, ModelProviderError> {
        self.measure_input_with_cancellation(request, &CancellationSource::new().token())
    }

    /// Measures input tokens within one caller-owned cancellation scope.
    ///
    /// Implementations that declare a local or remote capability must override this method and
    /// measure the same canonical request snapshot that will be passed to invocation.
    fn measure_input_with_cancellation(
        &self,
        _: &ModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<ContextTokenMeasurementOutcome, ModelProviderError> {
        check_cancellation(cancellation)?;
        Ok(ContextTokenMeasurementOutcome::Unavailable)
    }

    /// Returns the final result of the same invocation used for incremental output.
    /// Explicitly unary runtimes override this method and reject stream requests.
    fn invoke_with_cancellation(
        &self,
        request: &ModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<ModelResponse, ModelProviderError> {
        check_cancellation(cancellation)?;
        let response =
            self.stream_with_cancellation(request, cancellation, &mut DiscardModelEvents)?;
        check_cancellation(cancellation)?;
        Ok(response)
    }

    /// Delivers incremental output before completion and returns the authoritative final result.
    /// Implementations propagate cancellation and receiver errors. A unary runtime must return
    /// an unsupported error rather than turn a completed response into incremental events.
    fn stream_with_cancellation(
        &self,
        request: &ModelRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn ModelEventSink,
    ) -> Result<ModelResponse, ModelProviderError>;
}

/// Resolves declarative provider configuration into immutable Ash model runtimes.
///
/// Implementations must validate and normalize configuration before creating runtime state,
/// resolve the provider-specific API adapter and endpoint, and keep transport or client state out
/// of the serializable configuration layer.
pub trait ModelProvider: Send + Sync {
    fn runtime(
        &self,
        request: ModelRuntimeRequest,
    ) -> Result<Arc<dyn ModelInvoker>, ModelProviderError>;
}

impl ModelProvider for ModelProviderRuntime {
    fn runtime(
        &self,
        request: ModelRuntimeRequest,
    ) -> Result<Arc<dyn ModelInvoker>, ModelProviderError> {
        self.build_model(&request.config, &request.model)
    }
}

struct RegisteredModelInvoker {
    provider: Provider,
    model: Model,
}

impl ModelInvoker for RegisteredModelInvoker {
    fn image_input_policy(&self) -> ModelImageInputPolicy {
        self.provider.adapter.image_input_policy(&self.model)
    }

    fn invoke_with_cancellation(
        &self,
        request: &ModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<ModelResponse, ModelProviderError> {
        let request = self.prepare_request(request);
        self.provider
            .complete_with_cancellation(&self.model.id, &request, cancellation)
    }

    fn output_transport(&self) -> ModelOutputTransport {
        self.provider.definition.output_transport
    }

    fn stream_with_cancellation(
        &self,
        request: &ModelRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn ModelEventSink,
    ) -> Result<ModelResponse, ModelProviderError> {
        let request = self.prepare_request(request);
        self.provider
            .stream_with_cancellation(&self.model.id, &request, cancellation, sink)
    }

    fn input_token_measurement_capability(&self) -> ContextTokenMeasurementCapability {
        self.provider
            .input_token_measurement_capability(&self.model.id)
            .unwrap_or(ContextTokenMeasurementCapability::Unavailable)
    }

    fn measure_input_with_cancellation(
        &self,
        request: &ModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<ContextTokenMeasurementOutcome, ModelProviderError> {
        let request = self.prepare_request(request);
        self.provider
            .measure_input_with_cancellation(&self.model.id, &request, cancellation)
    }
}

impl RegisteredModelInvoker {
    fn prepare_request(&self, request: &ModelRequest) -> ModelRequest {
        self.provider.prepare_request(&self.model, request)
    }
}

/// Returns a clear model error when Ash cannot resolve a configured model runtime.
pub struct UnavailableModel {
    error: ModelProviderError,
}

impl UnavailableModel {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            error: ModelProviderError::Unavailable(message.into()),
        }
    }

    pub fn from_error(error: ModelProviderError) -> Self {
        Self { error }
    }
}

impl ModelInvoker for UnavailableModel {
    fn output_transport(&self) -> ModelOutputTransport {
        ModelOutputTransport::Unary
    }

    fn stream_with_cancellation(
        &self,
        _: &ModelRequest,
        cancellation: &CancellationToken,
        _: &mut dyn ModelEventSink,
    ) -> Result<ModelResponse, ModelProviderError> {
        check_cancellation(cancellation)?;
        Err(self.error.clone())
    }
}

/// Deterministic model adapter used only by unit tests and local protocol fixtures.
pub struct EchoModel;

impl ModelInvoker for EchoModel {
    fn output_transport(&self) -> ModelOutputTransport {
        ModelOutputTransport::NativeStreaming
    }

    fn stream_with_cancellation(
        &self,
        request: &ModelRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn ModelEventSink,
    ) -> Result<ModelResponse, ModelProviderError> {
        check_cancellation(cancellation)?;
        let prompt = request
            .input
            .iter()
            .rev()
            .find_map(|item| match item {
                InputItem::Message(message) => message.content.iter().find_map(|content| {
                    let ContentPart::Text(text) = content else {
                        return None;
                    };
                    Some(text.as_str())
                }),
                InputItem::ToolResult(_) | InputItem::Reasoning(_) => None,
            })
            .unwrap_or_default();
        let text = format!("Ash: {prompt}");
        sink.emit(ModelStreamEvent::TextDelta(text.clone()))?;
        check_cancellation(cancellation)?;
        Ok(ModelResponse {
            output: vec![OutputItem::Text(text)],
            usage: None,
            billing: None,
            stop_reason: StopReason::Completed,
        })
    }
}

fn check_cancellation(cancellation: &CancellationToken) -> Result<(), ModelProviderError> {
    cancellation
        .check()
        .map_err(|signal| ModelProviderError::Cancelled(signal.reason().to_string()))
}

struct DiscardModelEvents;

impl ModelEventSink for DiscardModelEvents {
    fn emit(&mut self, _: ModelStreamEvent) -> Result<(), ModelProviderError> {
        Ok(())
    }
}

fn stream_endpoint(
    endpoint: ApiEndpoint,
    target: &ash_client::ResolvedApiTarget,
    model: &str,
    request: &ModelRequest,
    client: &dyn OperationClient,
    cancellation: &CancellationToken,
    sink: &mut dyn ModelEventSink,
) -> Result<ModelResponse, ModelProviderError> {
    let mut sink = ProviderApiStreamSink {
        inner: sink,
        failure: None,
    };
    let response = endpoint.stream_with_client_and_cancellation(
        target,
        model,
        request,
        client,
        cancellation,
        &mut sink,
    );
    if let Some(error) = sink.failure {
        return Err(error);
    }
    response.map_err(Into::into)
}

struct ProviderApiStreamSink<'a> {
    inner: &'a mut dyn ModelEventSink,
    failure: Option<ModelProviderError>,
}

impl ApiStreamSink for ProviderApiStreamSink<'_> {
    fn emit(&mut self, event: ModelStreamEvent) -> Result<(), ash_api::ApiError> {
        if let Err(error) = self.inner.emit(event) {
            self.failure = Some(error);
            return Err(ash_api::ApiError::Transport(
                "model stream consumer rejected an event".into(),
            ));
        }
        Ok(())
    }
}

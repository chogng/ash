use crate::catalog::ModelCatalogBinding;
use crate::diagnostics::DiagnosticClient;
use ::supergrok::SuperGrokOAuth;
use ash_async_utils::CancellationSource;
use ash_client::OperationClient;
use ash_models_manager::CatalogCacheHint;
use ash_models_manager::CatalogDiscoveryOutcome;
use ash_models_manager::CatalogScopeKey;
use ash_models_manager::CatalogSourceError;
use ash_models_manager::CatalogSourceErrorKind;
use ash_models_manager::CatalogSourceFuture;
use ash_models_manager::CatalogSourceScopeId;
use ash_models_manager::DiscoveredCatalog;
use ash_models_manager::DiscoveredModel;
use ash_models_manager::DiscoveryCoverage;
use ash_models_manager::ModelCapabilitiesPatch;
use ash_models_manager::ModelCatalogSource;
use ash_models_manager::ModelMetadataPatch;
use ash_protocol::CapabilitySupport;
use ash_protocol::ContextWindow;
use ash_protocol::ModelAccess;
use ash_protocol::ModelId;
use ash_protocol::ProviderId;
use ash_protocol::ReasoningEffort;
use response_debug_context::DiagnosticOutcome;
use response_debug_context::ResponseDiagnosticSink;
use response_debug_context::ResponseOperation;
use sha2::Digest;
use sha2::Sha256;
use std::sync::Arc;
use std::time::Duration;
use std::time::SystemTime;

pub(crate) fn xai_api_catalog_binding(
    config: &model_provider_info::NormalizedModelProviderConfig,
    target: ash_client::ResolvedApiTarget,
    client: Arc<dyn OperationClient>,
    diagnostics: Option<Arc<dyn ResponseDiagnosticSink>>,
) -> Result<ModelCatalogBinding, crate::ModelProviderError> {
    let mut digest = Sha256::new();
    digest.update(format!("{config:?}").as_bytes());
    for header in target.headers() {
        digest.update(header.name().as_bytes());
        digest.update(header.value().as_bytes());
    }
    let scope = CatalogScopeKey::new(
        config.provider.clone(),
        CatalogSourceScopeId::new(format!("xai-api:{:x}", digest.finalize()))
            .map_err(|error| crate::ModelProviderError::Unavailable(error.to_string()))?,
    );
    // /models includes image and other non-Agent models; /language-models is the text catalog.
    let request = target
        .request(
            ash_http_client::HttpMethod::Get,
            target.endpoint("language-models")?,
            Vec::new(),
            Vec::new(),
        )
        .map_err(|_| crate::ModelProviderError::Unavailable("Invalid models endpoint".into()))?;
    Ok(ModelCatalogBinding {
        scope: scope.clone(),
        source: Arc::new(XaiApiCatalogSource {
            scope,
            request,
            client,
            diagnostics,
        }),
    })
}

struct XaiApiCatalogSource {
    scope: CatalogScopeKey,
    request: ash_client::ClientRequest,
    client: Arc<dyn OperationClient>,
    diagnostics: Option<Arc<dyn ResponseDiagnosticSink>>,
}

impl ModelCatalogSource for XaiApiCatalogSource {
    fn discover<'a>(
        &'a self,
        request: ash_models_manager::CatalogDiscoveryRequest,
    ) -> CatalogSourceFuture<'a> {
        Box::pin(async move {
            let diagnostic = Arc::new(DiagnosticClient::new(
                Arc::clone(&self.client),
                self.diagnostics.clone(),
                ResponseOperation::ModelCatalog,
            ));
            let result = async {
                if request.scope() != &self.scope {
                    return Err(CatalogSourceError::new(
                        CatalogSourceErrorKind::InvalidRequest,
                        "xAI API catalog scope changed",
                    ));
                }
                let client = Arc::clone(&diagnostic);
                let request = self.request.clone();
                let cancellation = CancellationSource::new();
                let token = cancellation.token();
                let cancel_on_drop = cancellation.cancel_on_drop();
                let response = tokio::task::spawn_blocking(move || {
                    client.execute_with_cancellation(&request, &token)
                })
                .await
                .map_err(|_| {
                    CatalogSourceError::new(
                        CatalogSourceErrorKind::Transient,
                        "xAI API catalog worker stopped",
                    )
                })?
                .map_err(|error| {
                    CatalogSourceError::new(
                        match error {
                            ash_client::ClientError::Cancelled(_) => {
                                CatalogSourceErrorKind::Cancelled
                            }
                            ash_client::ClientError::InvalidRequest(_) => {
                                CatalogSourceErrorKind::InvalidRequest
                            }
                            ash_client::ClientError::Transport(_) => {
                                CatalogSourceErrorKind::Unreachable
                            }
                            ash_client::ClientError::InvalidResponse(_)
                            | ash_client::ClientError::Framing(_) => {
                                CatalogSourceErrorKind::InvalidPayload
                            }
                        },
                        "Could not fetch xAI language models",
                    )
                })?;
                cancel_on_drop.disarm();
                if !response.is_success() {
                    let kind = match response.status() {
                        401 => CatalogSourceErrorKind::Authentication,
                        403 => CatalogSourceErrorKind::Permission,
                        404 | 405 | 501 => CatalogSourceErrorKind::Unsupported,
                        429 => CatalogSourceErrorKind::RateLimited,
                        400..=499 => CatalogSourceErrorKind::InvalidRequest,
                        500..=599 => CatalogSourceErrorKind::ProviderUnavailable,
                        _ => CatalogSourceErrorKind::Transient,
                    };
                    return Err(CatalogSourceError::new(
                        kind,
                        format!(
                            "xAI language model request failed (HTTP {})",
                            response.status()
                        ),
                    ));
                }
                #[derive(serde::Deserialize)]
                struct Catalog {
                    models: Vec<Entry>,
                }
                #[derive(serde::Deserialize)]
                struct Entry {
                    id: String,
                    context_length: Option<u32>,
                }
                let catalog: Catalog = serde_json::from_slice(response.body()).map_err(|_| {
                    CatalogSourceError::new(
                        CatalogSourceErrorKind::InvalidPayload,
                        "Invalid xAI language model list",
                    )
                })?;
                let mut ids = std::collections::BTreeSet::new();
                let mut models = Vec::new();
                for entry in catalog.models {
                    let id = ModelId::new(entry.id).map_err(|_| {
                        CatalogSourceError::new(
                            CatalogSourceErrorKind::InvalidPayload,
                            "Invalid xAI model ID",
                        )
                    })?;
                    if ids.insert(id.clone()) {
                        models.push(DiscoveredModel::new(id).with_metadata(ModelMetadataPatch {
                            access: Some(ModelAccess::ApiKey),
                            context_window: entry.context_length.map(ContextWindow::Known),
                            ..ModelMetadataPatch::default()
                        }));
                    }
                }
                Ok(CatalogDiscoveryOutcome::Modified(
                    DiscoveredCatalog::new(
                        self.scope.clone(),
                        DiscoveryCoverage::CompleteAgentCatalog,
                        SystemTime::now(),
                    )
                    .with_models(models)
                    .with_cache_hint(
                        CatalogCacheHint::unspecified()
                            .with_fresh_for(Duration::from_secs(300))
                            .with_stale_usable_for(Duration::from_secs(86400)),
                    ),
                ))
            }
            .await;
            diagnostic.finish_with(match &result {
                Ok(_) => DiagnosticOutcome::Succeeded,
                Err(error) if error.kind() == CatalogSourceErrorKind::Cancelled => {
                    DiagnosticOutcome::Cancelled
                }
                Err(_) => DiagnosticOutcome::Failed,
            });
            result
        })
    }
}

pub(crate) fn xai_catalog_binding(
    config: &model_provider_info::NormalizedModelProviderConfig,
    auth: Arc<SuperGrokOAuth>,
) -> Result<Option<ModelCatalogBinding>, crate::ModelProviderError> {
    let Some(account_id) = auth
        .account_id()
        .map_err(|error| crate::ModelProviderError::Credential(error.to_string()))?
    else {
        return Ok(None);
    };
    let digest = Sha256::digest(format!("{config:?}:{account_id}").as_bytes());
    let scope = CatalogScopeKey::new(
        ProviderId::new("xai").expect("constant provider ID"),
        CatalogSourceScopeId::new(format!("xai-subscription:{digest:x}"))
            .map_err(|error| crate::ModelProviderError::Unavailable(error.to_string()))?,
    );
    Ok(Some(ModelCatalogBinding {
        scope: scope.clone(),
        source: Arc::new(XaiCatalogSource {
            scope,
            account_id,
            auth,
        }),
    }))
}

struct XaiCatalogSource {
    scope: CatalogScopeKey,
    account_id: String,
    auth: Arc<SuperGrokOAuth>,
}

impl ModelCatalogSource for XaiCatalogSource {
    fn discover<'a>(
        &'a self,
        request: ash_models_manager::CatalogDiscoveryRequest,
    ) -> CatalogSourceFuture<'a> {
        Box::pin(async move {
            if request.scope() != &self.scope {
                return Err(CatalogSourceError::new(
                    CatalogSourceErrorKind::InvalidRequest,
                    "xAI catalog scope changed",
                ));
            }
            let cancellation = CancellationSource::new();
            let token = cancellation.token();
            let cancel_on_drop = cancellation.cancel_on_drop();
            let auth = Arc::clone(&self.auth);
            let account_id = self.account_id.clone();
            let models = tokio::task::spawn_blocking(move || auth.models(&account_id, &token))
                .await
                .map_err(|_| {
                    CatalogSourceError::new(
                        CatalogSourceErrorKind::Transient,
                        "xAI catalog worker stopped",
                    )
                })?
                .map_err(|error| {
                    CatalogSourceError::new(
                        match error.kind() {
                            ::supergrok::SuperGrokErrorKind::Authentication
                            | ::supergrok::SuperGrokErrorKind::AccountChanged => {
                                CatalogSourceErrorKind::Authentication
                            }
                            ::supergrok::SuperGrokErrorKind::Permission => {
                                CatalogSourceErrorKind::Permission
                            }
                            ::supergrok::SuperGrokErrorKind::UpgradeRequired => {
                                CatalogSourceErrorKind::Unsupported
                            }
                            ::supergrok::SuperGrokErrorKind::RateLimited => {
                                CatalogSourceErrorKind::RateLimited
                            }
                            ::supergrok::SuperGrokErrorKind::InvalidResponse => {
                                CatalogSourceErrorKind::InvalidPayload
                            }
                            ::supergrok::SuperGrokErrorKind::Cancelled => {
                                CatalogSourceErrorKind::Cancelled
                            }
                            ::supergrok::SuperGrokErrorKind::Unavailable => {
                                CatalogSourceErrorKind::Unreachable
                            }
                        },
                        error.to_string(),
                    )
                })?;
            cancel_on_drop.disarm();
            let models = models
                .into_iter()
                .map(|model| {
                    let id = ModelId::new(model.id).map_err(|_| {
                        CatalogSourceError::new(
                            CatalogSourceErrorKind::InvalidPayload,
                            "xAI returned an invalid model ID",
                        )
                    })?;
                    let efforts: Vec<_> = model
                        .reasoning_efforts
                        .iter()
                        .filter_map(|value| effort(value))
                        .map(ash_protocol::ModelReasoningEffortOption::from)
                        .collect();
                    Ok(DiscoveredModel::new(id).with_metadata(ModelMetadataPatch {
                        access: Some(ModelAccess::Subscription),
                        display_name: model.name,
                        context_window: model.context_window.map(ContextWindow::Known),
                        capabilities: ModelCapabilitiesPatch {
                            tools: Some(CapabilitySupport::Supported),
                            reasoning: (!efforts.is_empty())
                                .then_some(CapabilitySupport::Supported),
                            ..ModelCapabilitiesPatch::default()
                        },
                        default_reasoning_effort: model
                            .reasoning_effort
                            .as_deref()
                            .and_then(effort),
                        supported_reasoning_efforts: Some(efforts),
                        ..ModelMetadataPatch::default()
                    }))
                })
                .collect::<Result<Vec<_>, CatalogSourceError>>()?;
            Ok(CatalogDiscoveryOutcome::Modified(
                DiscoveredCatalog::new(
                    self.scope.clone(),
                    DiscoveryCoverage::CompleteAgentCatalog,
                    SystemTime::now(),
                )
                .with_models(models)
                .with_cache_hint(
                    CatalogCacheHint::unspecified()
                        .with_fresh_for(Duration::from_secs(300))
                        .with_stale_usable_for(Duration::from_secs(86400)),
                ),
            ))
        })
    }
}

fn effort(value: &str) -> Option<ReasoningEffort> {
    match value {
        "low" => Some(ReasoningEffort::Low),
        "medium" => Some(ReasoningEffort::Medium),
        "high" => Some(ReasoningEffort::High),
        "xhigh" => Some(ReasoningEffort::ExtraHigh),
        _ => None,
    }
}

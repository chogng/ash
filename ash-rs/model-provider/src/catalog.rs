use crate::diagnostics::DiagnosticClient;
use ash_async_utils::CancellationSource;
use ash_client::OperationClient;
use ash_model_provider_config::ModelId;
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
use ash_ollama::OllamaClient;
use ash_ollama::OllamaError;
use ash_protocol::CapabilitySupport;
use ash_protocol::ProviderId;
use response_debug_context::DiagnosticOutcome;
use response_debug_context::ResponseDiagnosticSink;
use response_debug_context::ResponseOperation;
use sha2::Digest;
use sha2::Sha256;
use std::fmt::Write;
use std::sync::Arc;
use std::time::Duration;
use std::time::SystemTime;

const OLLAMA_FRESH_FOR: Duration = Duration::from_secs(2);
const OLLAMA_STALE_USABLE_FOR: Duration = Duration::from_secs(30);

pub(crate) fn openai_catalog_binding(
    config: &ash_model_provider_config::NormalizedModelProviderConfig,
    headers: Vec<ash_http_client::HttpHeader>,
    client: Arc<dyn OperationClient>,
    diagnostics: Option<Arc<dyn ResponseDiagnosticSink>>,
) -> Result<ModelCatalogBinding, crate::ModelProviderError> {
    let mut digest = Sha256::new();
    digest.update(config.base_url.as_bytes());
    digest.update(format!("{:?}", config.api_profile).as_bytes());
    for header in &headers {
        digest.update(header.name().as_bytes());
        digest.update(header.value().as_bytes());
    }
    let scope_id = CatalogSourceScopeId::new(format!("openai:{:x}", digest.finalize()))
        .map_err(|error| crate::ModelProviderError::Unavailable(error.to_string()))?;
    let scope = CatalogScopeKey::new(config.provider.clone(), scope_id);
    let request = ash_client::ClientRequest::new(
        ash_http_client::HttpMethod::Get,
        format!("{}/models", config.base_url),
        headers,
        Vec::new(),
        ash_client::RetryPolicy::never(),
    )
    .map_err(|_| crate::ModelProviderError::Unavailable("Invalid models endpoint".into()))?;
    Ok(ModelCatalogBinding {
        scope: scope.clone(),
        source: Arc::new(OpenAiCatalogSource {
            scope,
            request,
            client,
            diagnostics,
        }),
    })
}

struct OpenAiCatalogSource {
    scope: CatalogScopeKey,
    request: ash_client::ClientRequest,
    client: Arc<dyn OperationClient>,
    diagnostics: Option<Arc<dyn ResponseDiagnosticSink>>,
}

impl ModelCatalogSource for OpenAiCatalogSource {
    fn discover<'a>(
        &'a self,
        request: ash_models_manager::CatalogDiscoveryRequest,
    ) -> CatalogSourceFuture<'a> {
        Box::pin(async move {
            let diagnostic = Arc::new(DiagnosticClient::new(
                self.client.clone(),
                self.diagnostics.clone(),
                ResponseOperation::ModelCatalog,
            ));
            let result = async {
                if request.scope() != &self.scope {
                    return Err(CatalogSourceError::new(
                        CatalogSourceErrorKind::InvalidPayload,
                        "Model catalog scope changed",
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
                        "Model catalog worker stopped",
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
                        "Could not fetch model list",
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
                        format!("Model list request failed (HTTP {})", response.status()),
                    ));
                }
                #[derive(serde::Deserialize)]
                struct Catalog {
                    data: Vec<Entry>,
                }
                #[derive(serde::Deserialize)]
                struct Entry {
                    id: String,
                }
                let catalog: Catalog = serde_json::from_slice(response.body()).map_err(|_| {
                    CatalogSourceError::new(
                        CatalogSourceErrorKind::InvalidPayload,
                        "Invalid model list response",
                    )
                })?;
                let mut ids = std::collections::BTreeSet::new();
                let mut models = Vec::new();
                for entry in catalog.data {
                    let id = ModelId::new(entry.id).map_err(|_| {
                        CatalogSourceError::new(
                            CatalogSourceErrorKind::InvalidPayload,
                            "Invalid model ID",
                        )
                    })?;
                    if ids.insert(id.clone()) {
                        models.push(DiscoveredModel::new(id));
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

/// Binds one exact provider configuration to its dynamic catalog identity and source.
///
/// App Server composition uses this value to refresh the shared models manager without exposing
/// endpoint details or credentials through its client protocol.
pub struct ModelCatalogBinding {
    scope: CatalogScopeKey,
    source: Arc<dyn ModelCatalogSource>,
}

impl ModelCatalogBinding {
    pub fn scope(&self) -> &CatalogScopeKey {
        &self.scope
    }

    pub fn source(&self) -> Arc<dyn ModelCatalogSource> {
        Arc::clone(&self.source)
    }
}

pub(crate) fn ollama_catalog_binding(
    provider: ProviderId,
    base_url: &str,
    client: Arc<dyn OperationClient>,
) -> Result<ModelCatalogBinding, OllamaError> {
    let client = OllamaClient::from_openai_compatible_base_url(base_url, client)?;
    let scope = CatalogScopeKey::new(provider, catalog_scope(client.host_root())?);
    let source = Arc::new(OllamaCatalogSource {
        scope: scope.clone(),
        client,
    });
    Ok(ModelCatalogBinding { scope, source })
}

fn catalog_scope(host_root: &str) -> Result<CatalogSourceScopeId, OllamaError> {
    let digest = Sha256::digest(host_root.as_bytes());
    let mut value = String::with_capacity("ollama:".len() + digest.len() * 2);
    value.push_str("ollama:");
    for byte in digest {
        write!(&mut value, "{byte:02x}").expect("writing to a string cannot fail");
    }
    CatalogSourceScopeId::new(value)
        .map_err(|error| OllamaError::InvalidEndpoint(error.to_string()))
}

struct OllamaCatalogSource {
    scope: CatalogScopeKey,
    client: OllamaClient,
}

impl ModelCatalogSource for OllamaCatalogSource {
    fn discover<'a>(
        &'a self,
        request: ash_models_manager::CatalogDiscoveryRequest,
    ) -> CatalogSourceFuture<'a> {
        if request.scope() != &self.scope {
            return Box::pin(async {
                Err(CatalogSourceError::new(
                    CatalogSourceErrorKind::InvalidPayload,
                    "Ollama catalog request scope does not match its source",
                ))
            });
        }
        let scope = self.scope.clone();
        let client = self.client.clone();
        let cancellation = CancellationSource::new();
        let token = cancellation.token();
        let task = tokio::task::spawn_blocking(move || {
            client
                .list_models(&token)?
                .into_iter()
                .try_fold(Vec::new(), |mut models, model| {
                    let info = client.show_model(&model.name, &token)?;
                    if info.supports("completion") != Some(false) {
                        models.push((model, info));
                    }
                    Ok::<_, OllamaError>(models)
                })
        });
        Box::pin(async move {
            let cancel_on_drop = cancellation.cancel_on_drop();
            let models = task
                .await
                .map_err(|_| {
                    CatalogSourceError::new(
                        CatalogSourceErrorKind::Transient,
                        "Ollama catalog worker stopped",
                    )
                })?
                .map_err(catalog_error)?;
            cancel_on_drop.disarm();
            let models = models
                .into_iter()
                .map(|(model, info)| {
                    let id = ModelId::new(model.name.clone()).map_err(|_| {
                        CatalogSourceError::new(
                            CatalogSourceErrorKind::InvalidPayload,
                            "Ollama returned an invalid model name",
                        )
                    })?;
                    Ok(DiscoveredModel::new(id).with_metadata(ModelMetadataPatch {
                        display_name: Some(model.name),
                        capabilities: ModelCapabilitiesPatch {
                            tools: info.supports("tools").map(capability_support),
                            reasoning: info.supports("thinking").map(capability_support),
                            ..ModelCapabilitiesPatch::default()
                        },
                        ..ModelMetadataPatch::default()
                    }))
                })
                .collect::<Result<Vec<_>, CatalogSourceError>>()?;
            Ok(CatalogDiscoveryOutcome::Modified(
                DiscoveredCatalog::new(scope, DiscoveryCoverage::Partial, SystemTime::now())
                    .with_models(models)
                    .with_cache_hint(
                        CatalogCacheHint::unspecified()
                            .with_fresh_for(OLLAMA_FRESH_FOR)
                            .with_stale_usable_for(OLLAMA_STALE_USABLE_FOR),
                    ),
            ))
        })
    }
}

fn capability_support(supported: bool) -> CapabilitySupport {
    if supported {
        CapabilitySupport::Supported
    } else {
        CapabilitySupport::Unsupported
    }
}

fn catalog_error(error: OllamaError) -> CatalogSourceError {
    let kind = match error {
        OllamaError::Cancelled(_) => CatalogSourceErrorKind::Cancelled,
        OllamaError::Unavailable(_) => CatalogSourceErrorKind::Unreachable,
        OllamaError::HttpStatus(401) => CatalogSourceErrorKind::Authentication,
        OllamaError::HttpStatus(403) => CatalogSourceErrorKind::Permission,
        OllamaError::HttpStatus(404 | 405 | 501) => CatalogSourceErrorKind::Unsupported,
        OllamaError::HttpStatus(429) => CatalogSourceErrorKind::RateLimited,
        OllamaError::HttpStatus(400..=499) => CatalogSourceErrorKind::InvalidRequest,
        OllamaError::HttpStatus(500..=599) => CatalogSourceErrorKind::ProviderUnavailable,
        OllamaError::InvalidEndpoint(_) | OllamaError::InvalidRequest(_) => {
            CatalogSourceErrorKind::InvalidRequest
        }
        OllamaError::InvalidResponse(_) => CatalogSourceErrorKind::InvalidPayload,
        OllamaError::HttpStatus(_)
        | OllamaError::PullFailed(_)
        | OllamaError::ProgressRejected(_) => CatalogSourceErrorKind::Transient,
    };
    CatalogSourceError::new(kind, "Ollama model discovery failed")
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;

mod chatgpt;
pub(crate) use chatgpt::chatgpt_catalog_binding;

use crate::catalog::ModelCatalogBinding;
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
use ash_models_manager::ModelCatalogSource;
use response_debug_context::DiagnosticOutcome;
use response_debug_context::ResponseDiagnosticSink;
use response_debug_context::ResponseOperation;
use sha2::Digest;
use sha2::Sha256;
use std::sync::Arc;
use std::time::Duration;
use std::time::SystemTime;

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

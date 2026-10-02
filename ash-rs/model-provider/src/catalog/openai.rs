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
    target: ash_client::ResolvedApiTarget,
    client: Arc<dyn OperationClient>,
    diagnostics: Option<Arc<dyn ResponseDiagnosticSink>>,
) -> Result<ModelCatalogBinding, crate::ModelProviderError> {
    http_catalog_binding(config, target, client, diagnostics, "models")
}

pub(crate) fn anthropic_catalog_binding(
    config: &ash_model_provider_config::NormalizedModelProviderConfig,
    target: ash_client::ResolvedApiTarget,
    client: Arc<dyn OperationClient>,
    diagnostics: Option<Arc<dyn ResponseDiagnosticSink>>,
    endpoint: ash_api::ApiEndpoint,
) -> Result<ModelCatalogBinding, crate::ModelProviderError> {
    let target = target.with_headers(vec![ash_http_client::HttpHeader::new(
        "anthropic-version",
        "2023-06-01",
    )])?;
    http_catalog_binding(
        config,
        target,
        client,
        diagnostics,
        if endpoint == ash_api::ApiEndpoint::AnthropicMessagesAtBase {
            "models"
        } else {
            "v1/models"
        },
    )
}

fn http_catalog_binding(
    config: &ash_model_provider_config::NormalizedModelProviderConfig,
    target: ash_client::ResolvedApiTarget,
    client: Arc<dyn OperationClient>,
    diagnostics: Option<Arc<dyn ResponseDiagnosticSink>>,
    path: &str,
) -> Result<ModelCatalogBinding, crate::ModelProviderError> {
    let paginate = config.api_profile == ash_model_provider_config::ApiProfile::AnthropicMessages;
    let mut digest = Sha256::new();
    // Context declarations and local aliases do not change the remote catalog identity.
    digest.update(
        format!(
            "{:?}|{:?}|{:?}|{}|{path}",
            config.provider, config.connection, config.api_profile, config.base_url
        )
        .as_bytes(),
    );
    for header in target.headers() {
        digest.update(header.name().as_bytes());
        digest.update(header.value().as_bytes());
    }
    let scope_id = CatalogSourceScopeId::new(format!(
        "{}:{:x}",
        if paginate { "anthropic" } else { "openai" },
        digest.finalize()
    ))
    .map_err(|error| crate::ModelProviderError::Unavailable(error.to_string()))?;
    let scope = CatalogScopeKey::new(config.provider.clone(), scope_id);
    let request = target
        .request(
            ash_http_client::HttpMethod::Get,
            target.endpoint(path)?,
            Vec::new(),
            Vec::new(),
        )
        .map_err(|_| crate::ModelProviderError::Unavailable("Invalid models endpoint".into()))?;
    Ok(ModelCatalogBinding {
        scope: scope.clone(),
        source: Arc::new(HttpModelCatalogSource {
            scope,
            request,
            target,
            client,
            diagnostics,
            paginate,
        }),
    })
}

struct HttpModelCatalogSource {
    scope: CatalogScopeKey,
    request: ash_client::ClientRequest,
    target: ash_client::ResolvedApiTarget,
    client: Arc<dyn OperationClient>,
    diagnostics: Option<Arc<dyn ResponseDiagnosticSink>>,
    paginate: bool,
}

impl ModelCatalogSource for HttpModelCatalogSource {
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
                let cancellation = CancellationSource::new();
                let token = cancellation.token();
                let cancel_on_drop = cancellation.cancel_on_drop();
                let mut next = self.request.clone();
                let mut cursors = std::collections::BTreeSet::new();
                let mut ids = std::collections::BTreeSet::new();
                let mut models = Vec::new();
                loop {
                    let client = Arc::clone(&diagnostic);
                    let request = next.clone();
                    let token = token.clone();
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
                        #[serde(default)]
                        has_more: bool,
                        #[serde(default)]
                        last_id: Option<String>,
                    }
                    #[derive(serde::Deserialize)]
                    struct Entry {
                        id: String,
                        #[serde(default)]
                        display_name: Option<String>,
                    }
                    let catalog: Catalog =
                        serde_json::from_slice(response.body()).map_err(|_| {
                            CatalogSourceError::new(
                                CatalogSourceErrorKind::InvalidPayload,
                                "Invalid model list response",
                            )
                        })?;
                    for entry in catalog.data {
                        let id = ModelId::new(entry.id).map_err(|_| {
                            CatalogSourceError::new(
                                CatalogSourceErrorKind::InvalidPayload,
                                "Invalid model ID",
                            )
                        })?;
                        if ids.insert(id.clone()) {
                            models.push(DiscoveredModel::new(id).with_metadata(
                                ash_models_manager::ModelMetadataPatch {
                                    display_name: entry.display_name,
                                    ..Default::default()
                                },
                            ));
                        }
                    }
                    if !self.paginate || !catalog.has_more {
                        break;
                    }
                    let cursor = catalog.last_id.filter(|id| !id.is_empty()).ok_or_else(|| {
                        CatalogSourceError::new(
                            CatalogSourceErrorKind::InvalidPayload,
                            "Missing model list cursor",
                        )
                    })?;
                    if !cursors.insert(cursor.clone()) {
                        return Err(CatalogSourceError::new(
                            CatalogSourceErrorKind::InvalidPayload,
                            "Repeated model list cursor",
                        ));
                    }
                    let mut url = url::Url::parse(self.request.url()).map_err(|_| {
                        CatalogSourceError::new(
                            CatalogSourceErrorKind::InvalidRequest,
                            "Invalid models endpoint",
                        )
                    })?;
                    url.query_pairs_mut().append_pair("after_id", &cursor);
                    next = self
                        .target
                        .request(
                            self.request.method(),
                            url.to_string(),
                            Vec::new(),
                            Vec::new(),
                        )
                        .map_err(|_| {
                            CatalogSourceError::new(
                                CatalogSourceErrorKind::InvalidRequest,
                                "Invalid model list cursor",
                            )
                        })?;
                }
                cancel_on_drop.disarm();
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

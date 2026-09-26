use crate::catalog::ModelCatalogBinding;
mod codex;
use crate::ModelProviderError;
use crate::diagnostics::DiagnosticClient;
use ash_async_utils::CancellationSource;
use ash_chatgpt::ChatGptOAuth;
use ash_client::ClientRequest;
use ash_client::OperationClient;
use ash_client::RetryPolicy;
use ash_http_client::HttpMethod;
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
use codex::local_models;
use response_debug_context::DiagnosticOutcome;
use response_debug_context::ResponseDiagnosticSink;
use response_debug_context::ResponseOperation;
use sha2::Digest;
use sha2::Sha256;
use std::sync::Arc;
use std::time::Duration;
use std::time::SystemTime;

const MAX_CATALOG_BYTES: usize = 1024 * 1024;

pub(crate) fn chatgpt_catalog_binding(
    auth: Arc<ChatGptOAuth>,
    client: Arc<dyn OperationClient>,
    diagnostics: Option<Arc<dyn ResponseDiagnosticSink>>,
) -> Result<Option<ModelCatalogBinding>, ModelProviderError> {
    let account_id = auth
        .account_id()
        .map_err(|error| ModelProviderError::Credential(error.to_string()))?;
    let Some(account_id) = account_id else {
        return Ok(None);
    };
    let digest = Sha256::digest(account_id.as_bytes());
    let scope = CatalogScopeKey::new(
        ProviderId::new("openai").expect("constant provider ID"),
        CatalogSourceScopeId::new(format!("chatgpt:{digest:x}"))
            .map_err(|error| ModelProviderError::Unavailable(error.to_string()))?,
    );
    Ok(Some(ModelCatalogBinding {
        scope: scope.clone(),
        source: Arc::new(ChatGptCatalogSource {
            scope,
            account_id,
            auth,
            client,
            diagnostics,
        }),
    }))
}

struct ChatGptCatalogSource {
    scope: CatalogScopeKey,
    account_id: String,
    auth: Arc<ChatGptOAuth>,
    client: Arc<dyn OperationClient>,
    diagnostics: Option<Arc<dyn ResponseDiagnosticSink>>,
}

impl ModelCatalogSource for ChatGptCatalogSource {
    fn discover<'a>(
        &'a self,
        request: ash_models_manager::CatalogDiscoveryRequest,
    ) -> CatalogSourceFuture<'a> {
        Box::pin(async move {
            if request.scope() != &self.scope {
                return Err(CatalogSourceError::new(
                    CatalogSourceErrorKind::InvalidRequest,
                    "ChatGPT catalog scope changed",
                ));
            }
            let diagnostic = Arc::new(DiagnosticClient::new(
                Arc::clone(&self.client),
                self.diagnostics.clone(),
                ResponseOperation::ModelCatalog,
            ));
            let request_client = Arc::clone(&diagnostic);
            let auth = Arc::clone(&self.auth);
            let account_id = self.account_id.clone();
            let scope = self.scope.clone();
            let cancellation = CancellationSource::new();
            let token = cancellation.token();
            let cancel_on_drop = cancellation.cancel_on_drop();
            let result = tokio::task::spawn_blocking(move || {
                if let Some(models) = auth
                    .codex_model_cache_path()
                    .and_then(|path| local_models(&path))
                {
                    let models = normalize_models(models)?;
                    ensure_account(&auth, &account_id)?;
                    return Ok(CatalogDiscoveryOutcome::Modified(
                        DiscoveredCatalog::new(
                            scope,
                            DiscoveryCoverage::Partial,
                            SystemTime::now(),
                        )
                        .with_models(models)
                        .with_cache_hint(catalog_cache_hint()),
                    ));
                }
                let target = auth.api_target().map_err(|error| {
                    CatalogSourceError::new(
                        CatalogSourceErrorKind::Authentication,
                        error.to_string(),
                    )
                })?;
                let target = target.api_target();
                let url = target
                    .endpoint(&format!(
                        "models?client_version={}",
                        env!("CARGO_PKG_VERSION")
                    ))
                    .map_err(|_| {
                        CatalogSourceError::new(
                            CatalogSourceErrorKind::InvalidRequest,
                            "Invalid ChatGPT models endpoint",
                        )
                    })?;
                let request = ClientRequest::new(
                    HttpMethod::Get,
                    url,
                    target.headers.clone(),
                    Vec::new(),
                    RetryPolicy::never(),
                )
                .map_err(|_| {
                    CatalogSourceError::new(
                        CatalogSourceErrorKind::InvalidRequest,
                        "Invalid ChatGPT model catalog request",
                    )
                })?;
                let response = request_client
                    .execute_with_cancellation(&request, &token)
                    .map_err(|error| {
                        CatalogSourceError::new(
                            match error {
                                ash_client::ClientError::Cancelled(_) => {
                                    CatalogSourceErrorKind::Cancelled
                                }
                                ash_client::ClientError::Transport(_) => {
                                    CatalogSourceErrorKind::Unreachable
                                }
                                ash_client::ClientError::InvalidRequest(_) => {
                                    CatalogSourceErrorKind::InvalidRequest
                                }
                                _ => CatalogSourceErrorKind::InvalidPayload,
                            },
                            "Could not fetch ChatGPT model catalog",
                        )
                    })?;
                if !response.is_success() {
                    let kind = match response.status() {
                        401 => CatalogSourceErrorKind::Authentication,
                        403 => CatalogSourceErrorKind::Permission,
                        429 => CatalogSourceErrorKind::RateLimited,
                        500..=599 => CatalogSourceErrorKind::ProviderUnavailable,
                        _ => CatalogSourceErrorKind::InvalidRequest,
                    };
                    return Err(CatalogSourceError::new(
                        kind,
                        format!(
                            "ChatGPT model catalog request failed (HTTP {})",
                            response.status()
                        ),
                    ));
                }
                if response.body().len() > MAX_CATALOG_BYTES {
                    return Err(CatalogSourceError::new(
                        CatalogSourceErrorKind::InvalidPayload,
                        "ChatGPT model catalog is too large",
                    ));
                }
                let catalog: Catalog = serde_json::from_slice(response.body()).map_err(|_| {
                    CatalogSourceError::new(
                        CatalogSourceErrorKind::InvalidPayload,
                        "Invalid ChatGPT model catalog",
                    )
                })?;
                let models = normalize_models(catalog.models)?;
                ensure_account(&auth, &account_id)?;
                Ok(CatalogDiscoveryOutcome::Modified(
                    DiscoveredCatalog::new(scope, DiscoveryCoverage::Partial, SystemTime::now())
                        .with_models(models)
                        .with_cache_hint(catalog_cache_hint()),
                ))
            })
            .await
            .map_err(|_| {
                CatalogSourceError::new(
                    CatalogSourceErrorKind::Transient,
                    "ChatGPT catalog worker stopped",
                )
            })?;
            cancel_on_drop.disarm();
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

fn ensure_account(auth: &ChatGptOAuth, account_id: &str) -> Result<(), CatalogSourceError> {
    let current = auth.account_id().map_err(|_| {
        CatalogSourceError::new(
            CatalogSourceErrorKind::Authentication,
            "ChatGPT login changed during catalog discovery",
        )
    })?;
    if current.as_deref() != Some(account_id) {
        return Err(CatalogSourceError::new(
            CatalogSourceErrorKind::Authentication,
            "ChatGPT account changed during catalog discovery",
        ));
    }
    Ok(())
}

fn catalog_cache_hint() -> CatalogCacheHint {
    CatalogCacheHint::unspecified()
        .with_fresh_for(Duration::from_secs(300))
        .with_stale_usable_for(Duration::from_secs(86400))
}

fn normalize_models(
    mut entries: Vec<CatalogEntry>,
) -> Result<Vec<DiscoveredModel>, CatalogSourceError> {
    // The subscription catalog's priority is the same ordering Codex uses in its picker.
    // Codex model/list already arrives in that order and has no priority field.
    entries.sort_by_key(|entry| entry.priority.unwrap_or(i32::MAX));
    let models: Vec<_> = entries
        .into_iter()
        .filter(|entry| entry.visibility.as_deref() == Some("list"))
        .map(|entry| {
            let id = ModelId::new(entry.slug).map_err(|_| {
                CatalogSourceError::new(
                    CatalogSourceErrorKind::InvalidPayload,
                    "ChatGPT returned an invalid model ID",
                )
            })?;
            let efforts = entry
                .supported_reasoning_levels
                .into_iter()
                .filter_map(|level| ReasoningEffort::parse(&level.effort))
                .collect::<Vec<_>>();
            Ok(DiscoveredModel::new(id).with_metadata(ModelMetadataPatch {
                access: Some(ModelAccess::Subscription),
                display_name: entry.display_name,
                context_window: entry.context_window.map(ContextWindow::Known),
                capabilities: ModelCapabilitiesPatch {
                    tools: Some(CapabilitySupport::Supported),
                    reasoning: (!efforts.is_empty()).then_some(CapabilitySupport::Supported),
                    ..ModelCapabilitiesPatch::default()
                },
                supported_reasoning_efforts: Some(efforts),
                model_reasoning_effort: entry
                    .default_reasoning_level
                    .as_deref()
                    .and_then(ReasoningEffort::parse),
                ..ModelMetadataPatch::default()
            }))
        })
        .collect::<Result<_, _>>()?;
    if models.is_empty() {
        return Err(CatalogSourceError::new(
            CatalogSourceErrorKind::InvalidPayload,
            "Invalid ChatGPT model catalog",
        ));
    }
    Ok(models)
}

#[derive(serde::Deserialize)]
struct Catalog {
    models: Vec<CatalogEntry>,
}

#[derive(serde::Deserialize)]
struct CatalogEntry {
    slug: String,
    #[serde(default)]
    priority: Option<i32>,
    display_name: Option<String>,
    visibility: Option<String>,
    context_window: Option<u32>,
    default_reasoning_level: Option<String>,
    #[serde(default)]
    supported_reasoning_levels: Vec<ReasoningLevel>,
}

#[derive(serde::Deserialize)]
struct ReasoningLevel {
    effort: String,
}

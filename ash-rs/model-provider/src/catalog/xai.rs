use super::ModelCatalogBinding;
use ::xai::XaiOAuth;
use ash_async_utils::CancellationSource;
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
use std::sync::Arc;
use std::time::Duration;
use std::time::SystemTime;

pub(crate) fn xai_catalog_binding(
    auth: Arc<XaiOAuth>,
) -> Result<Option<ModelCatalogBinding>, crate::ModelProviderError> {
    let Some(account_id) = auth
        .account_id()
        .map_err(|error| crate::ModelProviderError::Credential(error.to_string()))?
    else {
        return Ok(None);
    };
    let scope = CatalogScopeKey::new(
        ProviderId::new(::xai::XAI_PROVIDER_ID).expect("constant provider ID"),
        CatalogSourceScopeId::new(format!("xai-subscription:{account_id}"))
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
    auth: Arc<XaiOAuth>,
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
                            ::xai::XaiErrorKind::Authentication
                            | ::xai::XaiErrorKind::AccountChanged => {
                                CatalogSourceErrorKind::Authentication
                            }
                            ::xai::XaiErrorKind::Permission => CatalogSourceErrorKind::Permission,
                            ::xai::XaiErrorKind::UpgradeRequired => {
                                CatalogSourceErrorKind::Unsupported
                            }
                            ::xai::XaiErrorKind::RateLimited => CatalogSourceErrorKind::RateLimited,
                            ::xai::XaiErrorKind::InvalidResponse => {
                                CatalogSourceErrorKind::InvalidPayload
                            }
                            ::xai::XaiErrorKind::Cancelled => CatalogSourceErrorKind::Cancelled,
                            ::xai::XaiErrorKind::Unavailable => CatalogSourceErrorKind::Unreachable,
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
                        model_reasoning_effort: model.reasoning_effort.as_deref().and_then(effort),
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
                        .with_stale_usable_for(Duration::ZERO),
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

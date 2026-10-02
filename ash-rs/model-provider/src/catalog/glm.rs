use crate::ModelProviderError;
use crate::catalog::ModelCatalogBinding;
use ash_glm::GlmOAuth;
use ash_models_manager::CatalogCacheHint;
use ash_models_manager::CatalogDiscoveryOutcome;
use ash_models_manager::CatalogDiscoveryRequest;
use ash_models_manager::CatalogScopeKey;
use ash_models_manager::CatalogSourceError;
use ash_models_manager::CatalogSourceErrorKind;
use ash_models_manager::CatalogSourceFuture;
use ash_models_manager::CatalogSourceScopeId;
use ash_models_manager::DiscoveredCatalog;
use ash_models_manager::DiscoveredModel;
use ash_models_manager::DiscoveryCoverage;
use ash_models_manager::ModelCatalogSource;
use ash_models_manager::ModelMetadataPatch;
use ash_protocol::ModelAccess;
use ash_protocol::ModelId;
use ash_protocol::ProviderId;
use sha2::Digest;
use sha2::Sha256;
use std::sync::Arc;
use std::time::Duration;
use std::time::SystemTime;

pub(crate) fn glm_catalog_binding(
    config: &ash_model_provider_config::NormalizedModelProviderConfig,
    auth: Arc<GlmOAuth>,
) -> Result<Option<ModelCatalogBinding>, ModelProviderError> {
    let Some(identity) = auth
        .account_id()
        .map_err(|error| ModelProviderError::Credential(error.to_string()))?
    else {
        return Ok(None);
    };
    let digest = Sha256::digest(format!("{config:?}:{identity}").as_bytes());
    let scope = CatalogScopeKey::new(
        ProviderId::new("glm").expect("constant provider ID"),
        CatalogSourceScopeId::new(format!("glm-subscription:{digest:x}"))
            .map_err(|error| ModelProviderError::Unavailable(error.to_string()))?,
    );
    let models = match config.connection.as_str() {
        "bigmodel-start-plan" | "zai-start-plan" => &[][..],
        "bigmodel-coding-plan" => &[("glm-5.1", "GLM-5.1")][..],
        "zai-coding-plan" => &[
            ("glm-5.3", "GLM-5.3"),
            ("glm-5.3-flash", "GLM-5.3 Flash"),
            ("glm-5.1", "GLM-5.1"),
        ][..],
        _ => {
            return Err(ModelProviderError::Unavailable(
                "unknown GLM subscription".into(),
            ));
        }
    };
    Ok(Some(ModelCatalogBinding {
        scope: scope.clone(),
        source: Arc::new(GlmCatalogSource {
            scope,
            identity,
            auth,
            models,
        }),
    }))
}

struct GlmCatalogSource {
    scope: CatalogScopeKey,
    identity: String,
    auth: Arc<GlmOAuth>,
    models: &'static [(&'static str, &'static str)],
}

impl ModelCatalogSource for GlmCatalogSource {
    fn discover<'a>(&'a self, request: CatalogDiscoveryRequest) -> CatalogSourceFuture<'a> {
        Box::pin(async move {
            if request.scope() != &self.scope {
                return Err(CatalogSourceError::new(
                    CatalogSourceErrorKind::InvalidRequest,
                    "GLM catalog scope changed",
                ));
            }
            let identity = self.auth.account_id().map_err(|error| {
                CatalogSourceError::new(CatalogSourceErrorKind::Authentication, error.to_string())
            })?;
            if identity.as_deref() != Some(self.identity.as_str()) {
                return Err(CatalogSourceError::new(
                    CatalogSourceErrorKind::Authentication,
                    "GLM login changed during catalog discovery",
                ));
            }
            let models: Vec<_> = if self.auth.is_start_plan() {
                let auth = Arc::clone(&self.auth);
                let identity = self.identity.clone();
                let source = ash_async_utils::CancellationSource::new();
                let cancel_on_drop = source.cancel_on_drop();
                let usage = tokio::task::spawn_blocking(move || {
                    auth.read_start_plan(&identity, &source.token())
                })
                .await
                .map_err(|_| {
                    CatalogSourceError::new(
                        CatalogSourceErrorKind::Unreachable,
                        "Start Plan discovery worker failed",
                    )
                })?
                .map_err(|error| {
                    let kind = match error {
                        ash_glm::GlmUsageError::AccountChanged
                        | ash_glm::GlmUsageError::AuthenticationRequired => {
                            CatalogSourceErrorKind::Authentication
                        }
                        ash_glm::GlmUsageError::Cancelled => CatalogSourceErrorKind::Cancelled,
                        ash_glm::GlmUsageError::Unavailable => {
                            CatalogSourceErrorKind::ProviderUnavailable
                        }
                        ash_glm::GlmUsageError::RequestFailed => {
                            CatalogSourceErrorKind::Unreachable
                        }
                    };
                    CatalogSourceError::new(kind, "Start Plan entitlement discovery failed")
                })?;
                drop(cancel_on_drop);
                usage
                    .models()
                    .into_iter()
                    .map(|id| {
                        ModelId::new(id)
                            .map(DiscoveredModel::new)
                            .map(|model| {
                                model.with_metadata(ModelMetadataPatch {
                                    access: Some(ModelAccess::Subscription),
                                    ..ModelMetadataPatch::default()
                                })
                            })
                            .map_err(|_| {
                                CatalogSourceError::new(
                                    CatalogSourceErrorKind::InvalidPayload,
                                    "invalid Start Plan model",
                                )
                            })
                    })
                    .collect::<Result<_, _>>()?
            } else {
                self.models
                    .iter()
                    .map(|(id, name)| {
                        DiscoveredModel::new(ModelId::new(*id).expect("constant model ID"))
                            .with_metadata(ModelMetadataPatch {
                                access: Some(ModelAccess::Subscription),
                                display_name: Some((*name).into()),
                                ..ModelMetadataPatch::default()
                            })
                    })
                    .collect()
            };
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

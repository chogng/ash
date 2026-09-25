use crate::ModelProviderError;
use crate::catalog::ModelCatalogBinding;
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
use ash_secrets::SecretValue;
use sha2::Digest;
use sha2::Sha256;
use std::sync::Arc;
use std::time::Duration;
use std::time::SystemTime;

/// Binds the GLM Coding Plan catalog to the stored zai API key.
///
/// The coding endpoint exposes no model listing, so discovery publishes the plan's fixed
/// Ash-supported model rows under a key-scoped subscription cache instead of fetching them.
pub(crate) fn zai_catalog_binding(
    api_key: Option<SecretValue>,
) -> Result<Option<ModelCatalogBinding>, ModelProviderError> {
    let Some(api_key) = api_key else {
        return Ok(None);
    };
    let digest = Sha256::digest(api_key.expose());
    let scope = CatalogScopeKey::new(
        ProviderId::new("zai").expect("constant provider ID"),
        CatalogSourceScopeId::new(format!("zai-subscription:{digest:x}"))
            .map_err(|error| ModelProviderError::Unavailable(error.to_string()))?,
    );
    Ok(Some(ModelCatalogBinding {
        scope: scope.clone(),
        source: Arc::new(ZaiCatalogSource { scope }),
    }))
}

struct ZaiCatalogSource {
    scope: CatalogScopeKey,
}

impl ModelCatalogSource for ZaiCatalogSource {
    fn discover<'a>(&'a self, request: CatalogDiscoveryRequest) -> CatalogSourceFuture<'a> {
        Box::pin(async move {
            if request.scope() != &self.scope {
                return Err(CatalogSourceError::new(
                    CatalogSourceErrorKind::InvalidRequest,
                    "Zai catalog scope changed",
                ));
            }
            Ok(CatalogDiscoveryOutcome::Modified(
                DiscoveredCatalog::new(
                    self.scope.clone(),
                    DiscoveryCoverage::CompleteAgentCatalog,
                    SystemTime::now(),
                )
                .with_models(vec![DiscoveredModel::new(
                    ModelId::new("glm-5.1").expect("constant model ID"),
                )
                .with_metadata(ModelMetadataPatch {
                    access: Some(ModelAccess::Subscription),
                    display_name: Some("GLM-5.1".into()),
                    ..ModelMetadataPatch::default()
                })])
                .with_cache_hint(
                    CatalogCacheHint::unspecified()
                        .with_fresh_for(Duration::from_secs(300))
                        .with_stale_usable_for(Duration::from_secs(86400)),
                ),
            ))
        })
    }
}

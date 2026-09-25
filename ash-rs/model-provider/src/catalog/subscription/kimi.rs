use crate::ModelProviderError;
use crate::catalog::ModelCatalogBinding;
use ash_kimi::KimiOAuth;
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

pub(crate) fn kimi_catalog_binding(
    auth: Arc<KimiOAuth>,
) -> Result<Option<ModelCatalogBinding>, ModelProviderError> {
    let Some(identity) = auth
        .subscription_catalog_identity()
        .map_err(|error| ModelProviderError::Credential(error.to_string()))?
    else {
        return Ok(None);
    };
    let digest = Sha256::digest(identity.as_bytes());
    let scope = CatalogScopeKey::new(
        ProviderId::new("kimi").expect("constant provider ID"),
        CatalogSourceScopeId::new(format!("kimi-subscription:{digest:x}"))
            .map_err(|error| ModelProviderError::Unavailable(error.to_string()))?,
    );
    Ok(Some(ModelCatalogBinding {
        scope: scope.clone(),
        source: Arc::new(KimiCatalogSource {
            scope,
            identity,
            auth,
        }),
    }))
}

struct KimiCatalogSource {
    scope: CatalogScopeKey,
    identity: String,
    auth: Arc<KimiOAuth>,
}

impl ModelCatalogSource for KimiCatalogSource {
    fn discover<'a>(&'a self, request: CatalogDiscoveryRequest) -> CatalogSourceFuture<'a> {
        Box::pin(async move {
            if request.scope() != &self.scope {
                return Err(CatalogSourceError::new(
                    CatalogSourceErrorKind::InvalidRequest,
                    "Kimi catalog scope changed",
                ));
            }
            let identity = self.auth.subscription_catalog_identity().map_err(|error| {
                CatalogSourceError::new(CatalogSourceErrorKind::Authentication, error.to_string())
            })?;
            if identity.as_deref() != Some(self.identity.as_str()) {
                return Err(CatalogSourceError::new(
                    CatalogSourceErrorKind::Authentication,
                    "Kimi login changed during catalog discovery",
                ));
            }
            // Kimi Code currently exposes one Ash-supported model through its coding endpoint.
            // Keep it in the same account-scoped cache used by discovered subscription catalogs.
            Ok(CatalogDiscoveryOutcome::Modified(
                DiscoveredCatalog::new(
                    self.scope.clone(),
                    DiscoveryCoverage::CompleteAgentCatalog,
                    SystemTime::now(),
                )
                .with_models(vec![
                    DiscoveredModel::new(
                        ModelId::new("kimi-k2.7-code").expect("constant model ID"),
                    )
                    .with_metadata(ModelMetadataPatch {
                        access: Some(ModelAccess::Subscription),
                        display_name: Some("Kimi K2.7 Code".into()),
                        ..ModelMetadataPatch::default()
                    }),
                ])
                .with_cache_hint(
                    CatalogCacheHint::unspecified()
                        .with_fresh_for(Duration::from_secs(300))
                        .with_stale_usable_for(Duration::from_secs(86400)),
                ),
            ))
        })
    }
}

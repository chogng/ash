use crate::ModelProviderError;
use crate::catalog::ModelCatalogBinding;
use ash_async_utils::CancellationSource;
use ash_client::ClientRequest;
use ash_client::OperationClient;
use ash_client::RetryPolicy;
use ash_http_client::HttpMethod;
use ash_kimi::KimiExternalCredential;
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

pub(crate) fn kimi_external_catalog_binding(
    config: &ash_model_provider_config::NormalizedModelProviderConfig,
    connection: &str,
    credential: Arc<dyn KimiExternalCredential>,
    client: Arc<dyn OperationClient>,
) -> Result<ModelCatalogBinding, ModelProviderError> {
    let identity = credential
        .catalog_identity()
        .map_err(|error| ModelProviderError::Credential(error.to_string()))?;
    let digest = Sha256::digest(format!("{config:?}:{identity}").as_bytes());
    let scope = CatalogScopeKey::new(
        ProviderId::new(connection).expect("validated connection ID"),
        CatalogSourceScopeId::new(format!("{connection}:{digest:x}"))
            .map_err(|error| ModelProviderError::Unavailable(error.to_string()))?,
    );
    Ok(ModelCatalogBinding {
        scope: scope.clone(),
        source: Arc::new(KimiExternalCatalogSource {
            scope,
            identity,
            credential,
            client,
        }),
    })
}

struct KimiExternalCatalogSource {
    scope: CatalogScopeKey,
    identity: String,
    credential: Arc<dyn KimiExternalCredential>,
    client: Arc<dyn OperationClient>,
}

impl ModelCatalogSource for KimiExternalCatalogSource {
    fn discover<'a>(&'a self, request: CatalogDiscoveryRequest) -> CatalogSourceFuture<'a> {
        Box::pin(async move {
            if request.scope() != &self.scope {
                return Err(CatalogSourceError::new(
                    CatalogSourceErrorKind::InvalidRequest,
                    "Kimi Code catalog scope changed",
                ));
            }
            let credential = Arc::clone(&self.credential);
            let client = Arc::clone(&self.client);
            let cancellation = CancellationSource::new();
            let token = cancellation.token();
            let cancel_on_drop = cancellation.cancel_on_drop();
            let response = tokio::task::spawn_blocking(move || {
                let target = credential.api_target().map_err(|_| {
                    CatalogSourceError::new(
                        CatalogSourceErrorKind::Authentication,
                        "Kimi Code connection changed",
                    )
                })?;
                let request = ClientRequest::new(
                    HttpMethod::Get,
                    format!("{}/models", target.base_url),
                    target.headers,
                    Vec::new(),
                    RetryPolicy::never(),
                )
                .map_err(|_| {
                    CatalogSourceError::new(
                        CatalogSourceErrorKind::InvalidRequest,
                        "Invalid Kimi Code models request",
                    )
                })?;
                client
                    .execute_with_cancellation(&request, &token)
                    .map_err(|_| {
                        CatalogSourceError::new(
                            CatalogSourceErrorKind::Unreachable,
                            "Could not fetch Kimi Code models",
                        )
                    })
            })
            .await
            .map_err(|_| {
                CatalogSourceError::new(
                    CatalogSourceErrorKind::Transient,
                    "Kimi Code model discovery stopped",
                )
            })??;
            drop(cancel_on_drop);
            if response.status() != 200 {
                return Err(CatalogSourceError::new(
                    match response.status() {
                        401 => CatalogSourceErrorKind::Authentication,
                        402 | 403 => CatalogSourceErrorKind::Permission,
                        429 => CatalogSourceErrorKind::RateLimited,
                        500..=599 => CatalogSourceErrorKind::ProviderUnavailable,
                        _ => CatalogSourceErrorKind::InvalidRequest,
                    },
                    format!(
                        "Kimi Code model list returned HTTP {}",
                        response.status()
                    ),
                ));
            }
            #[derive(serde::Deserialize)]
            struct ModelList {
                data: Vec<ModelEntry>,
            }
            #[derive(serde::Deserialize)]
            struct ModelEntry {
                id: String,
                display_name: Option<String>,
            }
            let list: ModelList = serde_json::from_slice(response.body()).map_err(|_| {
                CatalogSourceError::new(
                    CatalogSourceErrorKind::InvalidPayload,
                    "Invalid Kimi Code model list",
                )
            })?;
            let current = self.credential.catalog_identity().map_err(|_| {
                CatalogSourceError::new(
                    CatalogSourceErrorKind::Authentication,
                    "Kimi Code connection changed",
                )
            })?;
            if current != self.identity {
                return Err(CatalogSourceError::new(
                    CatalogSourceErrorKind::Authentication,
                    "Kimi Code connection changed during model discovery",
                ));
            }
            let mut seen = std::collections::BTreeSet::new();
            let mut models = Vec::new();
            for entry in list.data {
                let id = ModelId::new(entry.id).map_err(|_| {
                    CatalogSourceError::new(
                        CatalogSourceErrorKind::InvalidPayload,
                        "Invalid Kimi Code model ID",
                    )
                })?;
                if seen.insert(id.clone()) {
                    models.push(DiscoveredModel::new(id).with_metadata(ModelMetadataPatch {
                        access: Some(ModelAccess::Subscription),
                        display_name: entry.display_name,
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
        })
    }
}

pub(crate) fn kimi_catalog_binding(
    config: &ash_model_provider_config::NormalizedModelProviderConfig,
    auth: Arc<KimiOAuth>,
) -> Result<Option<ModelCatalogBinding>, ModelProviderError> {
    let Some(identity) = auth
        .subscription_catalog_identity()
        .map_err(|error| ModelProviderError::Credential(error.to_string()))?
    else {
        return Ok(None);
    };
    let digest = Sha256::digest(format!("{config:?}:{identity}").as_bytes());
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

use super::ModelCatalogBinding;
use crate::ModelProviderError;
use ash_async_utils::CancellationSource;
use ash_chatgpt::ChatGptPlanOAuth;
use ash_client::OperationClient;
use ash_client::RequestIdentity;
use ash_http_client::HttpMethod;
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
use ash_models_manager::ModelMetadataPatch;
use ash_protocol::ModelAccess;
use ash_protocol::ModelId;
use serde::Deserialize;
use sha2::Digest;
use std::sync::Arc;
use std::time::SystemTime;

pub(crate) fn chatgpt_plan_catalog_binding(
    config: &model_provider_info::NormalizedModelProviderConfig,
    auth: Arc<ChatGptPlanOAuth>,
    client: Arc<dyn OperationClient>,
) -> Result<Option<ModelCatalogBinding>, ModelProviderError> {
    let Some(account_id) = auth
        .account_id()
        .map_err(|error| ModelProviderError::Credential(error.to_string()))?
    else {
        return Ok(None);
    };
    // Registrations and connection IDs isolate this catalog from Codex reuse,
    // even when both connections represent the same person and model vendor.
    let digest = sha2::Sha256::digest(format!("{config:?}:{account_id}"));
    let scope = CatalogScopeKey::new(
        config.provider.clone(),
        CatalogSourceScopeId::new(format!("chatgpt-plan:{digest:x}"))
            .map_err(|error| ModelProviderError::Unavailable(error.to_string()))?,
    );
    Ok(Some(ModelCatalogBinding {
        scope: scope.clone(),
        source: Arc::new(PlanCatalogSource {
            scope,
            account_id,
            auth,
            client,
        }),
    }))
}

struct PlanCatalogSource {
    scope: CatalogScopeKey,
    account_id: String,
    auth: Arc<ChatGptPlanOAuth>,
    client: Arc<dyn OperationClient>,
}

impl ModelCatalogSource for PlanCatalogSource {
    fn discover<'a>(
        &'a self,
        request: ash_models_manager::CatalogDiscoveryRequest,
    ) -> CatalogSourceFuture<'a> {
        Box::pin(async move {
            if request.scope() != &self.scope {
                return Err(catalog_error(CatalogSourceErrorKind::InvalidRequest));
            }
            let auth = Arc::clone(&self.auth);
            let client = Arc::clone(&self.client);
            let account_id = self.account_id.clone();
            let scope = self.scope.clone();
            let cancellation = CancellationSource::new();
            let token = cancellation.token();
            let cancel_on_drop = cancellation.cancel_on_drop();
            let result = tokio::task::spawn_blocking(move || {
                let target = auth.api_target()
                    .map_err(|_| catalog_error(CatalogSourceErrorKind::Authentication))?;
                if !matches!(target.binding().identity(), RequestIdentity::Account { account_id: current, .. } if current == &account_id) {
                    return Err(catalog_error(CatalogSourceErrorKind::Authentication));
                }
                let url = target.endpoint("models")
                    .map_err(|_| catalog_error(CatalogSourceErrorKind::InvalidRequest))?;
                let operation = target.request(HttpMethod::Get, url, Vec::new(), Vec::new())
                    .map_err(|_| catalog_error(CatalogSourceErrorKind::InvalidRequest))?;
                let response = client.execute_with_cancellation(&operation, &token)
                    .map_err(|_| catalog_error(if token.is_cancelled() {
                        CatalogSourceErrorKind::Cancelled
                    } else { CatalogSourceErrorKind::Unreachable }))?;
                if !response.is_success() {
                    return Err(catalog_error(match response.status() {
                        401 => CatalogSourceErrorKind::Authentication,
                        403 => CatalogSourceErrorKind::Permission,
                        429 => CatalogSourceErrorKind::RateLimited,
                        500..=599 => CatalogSourceErrorKind::ProviderUnavailable,
                        _ => CatalogSourceErrorKind::InvalidRequest,
                    }));
                }
                if response.body().len() > 1024 * 1024 {
                    return Err(catalog_error(CatalogSourceErrorKind::InvalidPayload));
                }
                let catalog: Catalog = serde_json::from_slice(response.body())
                    .map_err(|_| catalog_error(CatalogSourceErrorKind::InvalidPayload))?;
                let models = catalog.models.into_iter()
                    .filter(|model| model.visibility == "list")
                    .map(|model| {
                        let id = ModelId::new(model.slug)
                            .map_err(|_| catalog_error(CatalogSourceErrorKind::InvalidPayload))?;
                        Ok(DiscoveredModel::new(id).with_metadata(ModelMetadataPatch {
                            access: Some(ModelAccess::Subscription),
                            display_name: model.display_name,
                            ..ModelMetadataPatch::default()
                        }))
                    }).collect::<Result<Vec<_>, CatalogSourceError>>()?;
                if token.is_cancelled() {
                    return Err(catalog_error(CatalogSourceErrorKind::Cancelled));
                }
                if auth.account_id().map_err(|_| catalog_error(CatalogSourceErrorKind::Authentication))?.as_deref() != Some(&account_id) {
                    return Err(catalog_error(CatalogSourceErrorKind::Authentication));
                }
                Ok(CatalogDiscoveryOutcome::Modified(
                    DiscoveredCatalog::new(scope, DiscoveryCoverage::CompleteAgentCatalog, SystemTime::now())
                        .with_models(models),
                ))
            }).await.map_err(|_| catalog_error(CatalogSourceErrorKind::Transient))?;
            cancel_on_drop.disarm();
            result
        })
    }
}

fn catalog_error(kind: CatalogSourceErrorKind) -> CatalogSourceError {
    CatalogSourceError::new(kind, "Could not fetch ChatGPT model catalog")
}

#[derive(Deserialize)]
struct Catalog {
    models: Vec<CatalogModel>,
}

#[derive(Deserialize)]
struct CatalogModel {
    slug: String,
    display_name: Option<String>,
    visibility: String,
}

use super::UpdateBroker;
use crate::model_catalog::ModelCatalog;
use crate::model_catalog::ModelCatalogRefreshError;
use ash_app_server_protocol::protocol::model::ModelCatalogEntry;
use ash_app_server_protocol::protocol::provider::ProviderModelsListFailureDto;
use ash_app_server_protocol::protocol::provider::ProviderModelsListResult;
use ash_app_server_protocol::protocol::provider::ProviderModelsUpdated;
use ash_login::LoginService;
use ash_protocol::ModelConnectionId;
use ash_subscriptions::ExternalModelsUpdate;
use ash_subscriptions::ModelsUpdate;
use ash_subscriptions::SubscriptionCatalog;
use ash_subscriptions::SubscriptionEvents;
use ash_subscriptions::SubscriptionObserver;
use std::sync::Arc;

pub(super) fn start(
    login: Arc<LoginService>,
    connections: Vec<&'static str>,
    catalog: Arc<dyn ModelCatalog>,
    updates: Arc<UpdateBroker>,
) -> SubscriptionObserver {
    let catalog: Arc<dyn SubscriptionCatalog<ModelCatalogEntry, ModelCatalogRefreshError>> =
        Arc::new(CatalogAdapter(catalog));
    let events: Arc<dyn SubscriptionEvents<ModelCatalogEntry, ModelCatalogRefreshError>> =
        Arc::new(EventsAdapter(updates));
    SubscriptionObserver::start(
        login,
        connections,
        vec!["kimi-desktop", "kimi-cli"],
        catalog,
        events,
    )
}

struct CatalogAdapter(Arc<dyn ModelCatalog>);

impl SubscriptionCatalog<ModelCatalogEntry, ModelCatalogRefreshError> for CatalogAdapter {
    fn external_scope(
        &self,
        connection: &ModelConnectionId,
    ) -> Result<Option<String>, ModelCatalogRefreshError> {
        self.0.external_scope(connection)
    }
    fn refresh(
        &self,
        connection: &ModelConnectionId,
    ) -> Result<Vec<ModelCatalogEntry>, ModelCatalogRefreshError> {
        self.0.refresh(connection)
    }
}

struct EventsAdapter(Arc<UpdateBroker>);

impl SubscriptionEvents<ModelCatalogEntry, ModelCatalogRefreshError> for EventsAdapter {
    fn external_models_updated(
        &self,
        update: ExternalModelsUpdate<ModelCatalogEntry, ModelCatalogRefreshError>,
    ) {
        let result = catalog_result(update.result);
        self.0
            .publish_provider_models_updated(ProviderModelsUpdated {
            authority:
                ash_app_server_protocol::protocol::provider::ProviderModelsAuthorityDto::External {
                    catalog_scope: ash_app_server_protocol::protocol::model::ModelCatalogScope {
                        connection: update.connection.clone(),
                        identity: update.scope,
                    },
                },
            connection: update.connection,
            result,
        });
    }

    fn models_updated(&self, update: ModelsUpdate<ModelCatalogEntry, ModelCatalogRefreshError>) {
        let result = catalog_result(update.result);
        self.0
            .publish_provider_models_updated(ProviderModelsUpdated {
                connection: update.connection,
                authority: ash_app_server_protocol::protocol::provider::ProviderModelsAuthorityDto::Subscription {
                    account_id: update.account_id, organization: update.organization, plan: update.plan,
                },
                result,
            });
    }
}

fn catalog_result(
    result: Result<Vec<ModelCatalogEntry>, ModelCatalogRefreshError>,
) -> ProviderModelsListResult {
    match result {
        Ok(models) if models.is_empty() => ProviderModelsListResult::Empty,
        Ok(models) => ProviderModelsListResult::Models { models },
        Err(error) => ProviderModelsListResult::Failed {
            failure: ProviderModelsListFailureDto {
                code: super::operations::provider_models_failure_code(error),
            },
        },
    }
}

#[cfg(test)]
#[path = "subscription_adapter_tests.rs"]
mod tests;

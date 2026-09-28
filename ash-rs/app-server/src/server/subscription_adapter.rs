use super::UpdateBroker;
use crate::model_catalog::ModelCatalog;
use crate::model_catalog::ModelCatalogRefreshError;
use ash_app_server_protocol::protocol::model::ModelCatalogEntry;
use ash_app_server_protocol::protocol::provider::ProviderModelsListFailureDto;
use ash_app_server_protocol::protocol::provider::ProviderModelsListResult;
use ash_app_server_protocol::protocol::provider::ProviderModelsUpdated;
use ash_login::LoginService;
use ash_protocol::ModelConnectionId;
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
    SubscriptionObserver::start(login, connections, catalog, events)
}

struct CatalogAdapter(Arc<dyn ModelCatalog>);

impl SubscriptionCatalog<ModelCatalogEntry, ModelCatalogRefreshError> for CatalogAdapter {
    fn refresh(
        &self,
        connection: &ModelConnectionId,
    ) -> Result<Vec<ModelCatalogEntry>, ModelCatalogRefreshError> {
        self.0.refresh(connection)
    }
}

struct EventsAdapter(Arc<UpdateBroker>);

impl SubscriptionEvents<ModelCatalogEntry, ModelCatalogRefreshError> for EventsAdapter {
    fn models_updated(&self, update: ModelsUpdate<ModelCatalogEntry, ModelCatalogRefreshError>) {
        let result = match update.result {
            Ok(models) if models.is_empty() => ProviderModelsListResult::Empty,
            Ok(models) => ProviderModelsListResult::Models { models },
            Err(error) => ProviderModelsListResult::Failed {
                failure: ProviderModelsListFailureDto {
                    code: super::operations::provider_models_failure_code(error),
                },
            },
        };
        self.0
            .publish_provider_models_updated(ProviderModelsUpdated {
                connection: update.connection,
                account_id: update.account_id,
                organization: update.organization,
                plan: update.plan,
                result,
            });
    }
}

#[cfg(test)]
#[path = "subscription_adapter_tests.rs"]
mod tests;

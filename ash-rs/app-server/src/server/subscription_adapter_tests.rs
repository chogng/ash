use super::*;
use crate::server::notification_queue::NotificationQueue;
use ash_protocol::ModelId;
use ash_protocol::ModelInfo;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;

#[test]
fn subscription_events_preserve_account_identity_and_map_catalog_outcomes() {
    let updates = Arc::new(UpdateBroker::default());
    let queue = NotificationQueue::default();
    updates.register(1, false, &queue);
    let adapter = EventsAdapter(updates);
    let model = ModelRef::new(
        ProviderId::new("openai").unwrap(),
        ModelId::new("test-model").unwrap(),
    );
    let entry =
        ModelCatalogEntry::from_info(model.clone(), &ModelInfo::new(model.model, "Test Model"));

    adapter.models_updated(ModelsUpdate {
        connection: "chatgpt-subscription".into(),
        account_id: "account-1".into(),
        organization: Some("org-1".into()),
        plan: Some("Plus".into()),
        result: Ok(vec![entry]),
    });
    adapter.models_updated(ModelsUpdate {
        connection: "chatgpt-subscription".into(),
        account_id: "account-1".into(),
        organization: Some("org-1".into()),
        plan: Some("Plus".into()),
        result: Err(ModelCatalogRefreshError::Authentication),
    });

    let notifications = queue.drain();
    assert_eq!(notifications.len(), 2);
    assert_eq!(notifications[0]["method"], "provider/models/updated");
    assert_eq!(notifications[0]["params"]["accountId"], "account-1");
    assert_eq!(notifications[0]["params"]["organization"], "org-1");
    assert_eq!(notifications[0]["params"]["plan"], "Plus");
    assert_eq!(notifications[0]["params"]["result"]["type"], "models");
    assert_eq!(
        notifications[0]["params"]["result"]["models"][0]["display_name"],
        "Test Model"
    );
    assert_eq!(notifications[1]["params"]["result"]["type"], "failed");
    assert_eq!(
        notifications[1]["params"]["result"]["failure"]["code"],
        "authentication"
    );
}

use super::*;
use crate::model_catalog::ModelCatalogRefreshError;
use crate::server::account_operations::AppServerLoginEvents;
use crate::server::notification_queue::NotificationQueue;
use ash_app_server_protocol::protocol::model::ModelCatalogEntry;
use ash_login::AccountMetadataRefresher;
use ash_login::AccountRef;
use ash_login::AccountSnapshot;
use ash_login::BeginLogin;
use ash_login::BeginLoginRequest;
use ash_login::CancelLoginOutcome;
use ash_login::InteractiveLoginDriver;
use ash_login::LoginError;
use ash_login::LoginId;
use ash_protocol::ModelAccess;
use ash_protocol::ModelId;
use ash_protocol::ModelInfo;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use core_api::CoreError;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

struct AccountDriver {
    account: Mutex<Option<AccountSnapshot>>,
}

struct MetadataDriver {
    account: Arc<AccountDriver>,
    next_plan: Mutex<Option<&'static str>>,
    calls: AtomicUsize,
}

impl AccountMetadataRefresher for MetadataDriver {
    fn provider_id(&self) -> &'static str {
        ash_chatgpt::CHATGPT_SUBSCRIPTION_PROVIDER_ID
    }

    fn refresh_account(
        &self,
        _: &str,
        _: &ash_async_utils::CancellationToken,
    ) -> Result<(), LoginError> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        if let Some(plan) = self.next_plan.lock().unwrap().take() {
            *self.account.account.lock().unwrap() = Some(account(plan));
        }
        Ok(())
    }
}

impl InteractiveLoginDriver for AccountDriver {
    fn provider_id(&self) -> &'static str {
        ash_chatgpt::CHATGPT_SUBSCRIPTION_PROVIDER_ID
    }

    fn read_account(&self) -> Result<Option<AccountSnapshot>, LoginError> {
        Ok(self.account.lock().unwrap().clone())
    }

    fn begin(&self, _: BeginLoginRequest) -> Result<BeginLogin, LoginError> {
        unreachable!("the observer only reads account state")
    }

    fn cancel(&self, _: &LoginId) -> Result<CancelLoginOutcome, LoginError> {
        unreachable!("the observer does not own login requests")
    }

    fn logout(&self, _: &AccountRef) -> Result<(), LoginError> {
        unreachable!("the observer does not own logout requests")
    }
}

struct Catalog {
    models: Mutex<Vec<ModelCatalogEntry>>,
    unavailable: AtomicBool,
    calls: AtomicUsize,
}

impl ModelCatalog for Catalog {
    fn refresh(
        &self,
        connection: &ModelConnectionId,
    ) -> Result<Vec<ModelCatalogEntry>, ModelCatalogRefreshError> {
        assert_eq!(
            connection.as_str(),
            ash_chatgpt::CHATGPT_SUBSCRIPTION_PROVIDER_ID
        );
        self.calls.fetch_add(1, Ordering::Relaxed);
        if self.unavailable.load(Ordering::Relaxed) {
            return Err(ModelCatalogRefreshError::Unreachable);
        }
        Ok(self.models.lock().unwrap().clone())
    }

    fn list(&self) -> Result<Vec<ModelCatalogEntry>, CoreError> {
        Ok(vec![])
    }

    fn current_access(&self, _: &ModelRef) -> Result<ModelAccess, CoreError> {
        Ok(ModelAccess::Unknown)
    }

    fn configured_default(&self) -> Result<Option<ModelRef>, CoreError> {
        Ok(None)
    }
}

fn account(plan: &str) -> AccountSnapshot {
    AccountSnapshot {
        account: AccountRef {
            provider: ash_chatgpt::CHATGPT_SUBSCRIPTION_PROVIDER_ID.into(),
            account_id: "account-1".into(),
        },
        email: Some("person@example.test".into()),
        display_name: None,
        organization: None,
        plan: Some(plan.into()),
        status: AccountStatus::Ready,
        credential_revision: 1,
    }
}

fn model(name: &str) -> ModelCatalogEntry {
    let model = ModelRef::new(
        ProviderId::new("openai").unwrap(),
        ModelId::new(name).unwrap(),
    );
    ModelCatalogEntry::from_info(model.clone(), &ModelInfo::new(model.model, name))
}

#[test]
fn account_and_model_changes_publish_once_without_opening_a_page() {
    let driver = Arc::new(AccountDriver {
        account: Mutex::new(Some(account("Plus"))),
    });
    let login = Arc::new(LoginService::deferred(driver.clone()));
    let catalog = Arc::new(Catalog {
        models: Mutex::new(vec![model("first")]),
        unavailable: AtomicBool::new(false),
        calls: AtomicUsize::new(0),
    });
    let updates = Arc::new(UpdateBroker::default());
    let queue = NotificationQueue::default();
    updates.register(1, false, &queue);
    login
        .install_events(Arc::new(AppServerLoginEvents::new(updates.clone())))
        .unwrap();
    let sources = Sources {
        login,
        subscriptions: vec![ash_chatgpt::CHATGPT_SUBSCRIPTION_PROVIDER_ID],
        catalog: catalog.clone(),
        updates,
    };
    let mut observed = Observed::default();
    let cancellation = CancellationSource::new();

    observed.check(&sources, false, &cancellation.token());
    let first = queue.drain();
    assert_eq!(first.len(), 2);
    assert_eq!(first[0]["method"], "account/updated");
    assert_eq!(first[1]["method"], "provider/models/updated");
    assert_eq!(
        first[1]["params"]["result"]["models"][0]["displayName"],
        "first"
    );
    observed.check(&sources, false, &cancellation.token());
    assert!(queue.drain().is_empty());

    *driver.account.lock().unwrap() = Some(account("Pro"));
    *catalog.models.lock().unwrap() = vec![model("second")];
    observed.check(&sources, false, &cancellation.token());
    let updated = queue.drain();
    assert_eq!(updated.len(), 2);
    assert_eq!(
        updated[0]["params"]["account"]["accounts"][0]["plan"],
        "Pro"
    );
    assert_eq!(updated[1]["params"]["plan"], "Pro");
    assert_eq!(
        updated[1]["params"]["result"]["models"][0]["displayName"],
        "second"
    );

    *catalog.models.lock().unwrap() = vec![model("third")];
    observed.check(&sources, true, &cancellation.token());
    let refreshed = queue.drain();
    assert_eq!(refreshed.len(), 1);
    assert_eq!(refreshed[0]["method"], "provider/models/updated");
    assert_eq!(
        refreshed[0]["params"]["result"]["models"][0]["displayName"],
        "third"
    );
}

#[test]
fn failed_discovery_waits_for_the_next_observation_period() {
    let driver = Arc::new(AccountDriver {
        account: Mutex::new(Some(account("Plus"))),
    });
    let catalog = Arc::new(Catalog {
        models: Mutex::new(vec![model("available")]),
        unavailable: AtomicBool::new(true),
        calls: AtomicUsize::new(0),
    });
    let updates = Arc::new(UpdateBroker::default());
    let queue = NotificationQueue::default();
    updates.register(1, false, &queue);
    let sources = Sources {
        login: Arc::new(LoginService::deferred(driver)),
        subscriptions: vec![ash_chatgpt::CHATGPT_SUBSCRIPTION_PROVIDER_ID],
        catalog: catalog.clone(),
        updates,
    };
    let mut observed = Observed::default();
    let cancellation = CancellationSource::new();

    observed.check(&sources, false, &cancellation.token());
    observed.check(&sources, false, &cancellation.token());
    assert_eq!(catalog.calls.load(Ordering::Relaxed), 1);
    let failure = queue.drain();
    assert_eq!(failure.len(), 1);
    assert_eq!(failure[0]["params"]["result"]["type"], "failed");

    catalog.unavailable.store(false, Ordering::Relaxed);
    observed.check(&sources, true, &cancellation.token());
    assert_eq!(catalog.calls.load(Ordering::Relaxed), 2);
    let recovered = queue.drain();
    assert_eq!(recovered[0]["method"], "provider/models/updated");
    assert_eq!(recovered[0]["params"]["result"]["type"], "models");
}

#[test]
fn remote_metadata_change_publishes_account_and_matching_models() {
    let driver = Arc::new(AccountDriver {
        account: Mutex::new(Some(account("Plus"))),
    });
    let metadata = Arc::new(MetadataDriver {
        account: driver.clone(),
        next_plan: Mutex::new(Some("Pro")),
        calls: AtomicUsize::new(0),
    });
    let login = Arc::new(
        LoginService::deferred(driver)
            .with_account_metadata_refreshers([metadata as Arc<dyn AccountMetadataRefresher>])
            .unwrap(),
    );
    let catalog = Arc::new(Catalog {
        models: Mutex::new(vec![model("available")]),
        unavailable: AtomicBool::new(false),
        calls: AtomicUsize::new(0),
    });
    let updates = Arc::new(UpdateBroker::default());
    let queue = NotificationQueue::default();
    updates.register(1, false, &queue);
    login
        .install_events(Arc::new(AppServerLoginEvents::new(updates.clone())))
        .unwrap();
    let sources = Sources {
        login,
        subscriptions: vec![ash_chatgpt::CHATGPT_SUBSCRIPTION_PROVIDER_ID],
        catalog,
        updates,
    };
    let mut observed = Observed::default();
    let cancellation = CancellationSource::new();

    observed.check(&sources, true, &cancellation.token());
    let notifications = queue.drain();
    assert_eq!(notifications.len(), 3);
    assert_eq!(notifications[0]["method"], "account/updated");
    assert_eq!(notifications[1]["method"], "account/updated");
    assert_eq!(
        notifications[1]["params"]["account"]["accounts"][0]["plan"],
        "Pro"
    );
    assert_eq!(notifications[2]["method"], "provider/models/updated");
    assert_eq!(notifications[2]["params"]["plan"], "Pro");
}

#[test]
fn signed_out_accounts_make_no_remote_requests_and_external_login_is_observed() {
    let driver = Arc::new(AccountDriver {
        account: Mutex::new(None),
    });
    let metadata = Arc::new(MetadataDriver {
        account: driver.clone(),
        next_plan: Mutex::new(None),
        calls: AtomicUsize::new(0),
    });
    let catalog = Arc::new(Catalog {
        models: Mutex::new(vec![model("available")]),
        unavailable: AtomicBool::new(false),
        calls: AtomicUsize::new(0),
    });
    let updates = Arc::new(UpdateBroker::default());
    let queue = NotificationQueue::default();
    updates.register(1, false, &queue);
    let login = Arc::new(
        LoginService::deferred(driver.clone())
            .with_account_metadata_refreshers([
                metadata.clone() as Arc<dyn AccountMetadataRefresher>
            ])
            .unwrap(),
    );
    login
        .install_events(Arc::new(AppServerLoginEvents::new(updates.clone())))
        .unwrap();
    let sources = Sources {
        login,
        subscriptions: vec![ash_chatgpt::CHATGPT_SUBSCRIPTION_PROVIDER_ID],
        catalog: catalog.clone(),
        updates,
    };
    let mut observed = Observed::default();
    let cancellation = CancellationSource::new();

    observed.check(&sources, true, &cancellation.token());
    assert_eq!(metadata.calls.load(Ordering::Relaxed), 0);
    assert_eq!(catalog.calls.load(Ordering::Relaxed), 0);
    assert!(queue.drain().is_empty());

    *driver.account.lock().unwrap() = Some(account("Plus"));
    observed.check(&sources, false, &cancellation.token());
    assert_eq!(metadata.calls.load(Ordering::Relaxed), 1);
    assert_eq!(catalog.calls.load(Ordering::Relaxed), 1);
    assert_eq!(queue.drain().len(), 2);

    *driver.account.lock().unwrap() = None;
    observed.check(&sources, false, &cancellation.token());
    assert_eq!(metadata.calls.load(Ordering::Relaxed), 1);
    assert_eq!(catalog.calls.load(Ordering::Relaxed), 1);
    assert_eq!(queue.drain()[0]["method"], "account/updated");

    *driver.account.lock().unwrap() = Some(account("Plus"));
    observed.check(&sources, false, &cancellation.token());
    assert_eq!(metadata.calls.load(Ordering::Relaxed), 2);
    assert_eq!(catalog.calls.load(Ordering::Relaxed), 2);
}

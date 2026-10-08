use super::*;
use ash_login::AccountMetadataRefresher;
use ash_login::AccountRef;
use ash_login::AccountSnapshot;
use ash_login::BeginLogin;
use ash_login::BeginLoginRequest;
use ash_login::CancelLoginOutcome;
use ash_login::InteractiveLoginDriver;
use ash_login::LoginCompletion;
use ash_login::LoginError;
use ash_login::LoginEvents;
use ash_login::LoginId;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;

const PROVIDER: &str = "chatgpt-subscription";

struct AccountDriver {
    account: Mutex<Option<AccountSnapshot>>,
}

impl InteractiveLoginDriver for AccountDriver {
    fn provider_id(&self) -> &'static str {
        PROVIDER
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

struct MetadataDriver {
    account: Arc<AccountDriver>,
    next_plan: Mutex<Option<&'static str>>,
    calls: AtomicUsize,
}

impl AccountMetadataRefresher for MetadataDriver {
    fn provider_id(&self) -> &'static str {
        PROVIDER
    }

    fn refresh_account(&self, _: &str, _: &CancellationToken) -> Result<(), LoginError> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        if let Some(plan) = self.next_plan.lock().unwrap().take() {
            *self.account.account.lock().unwrap() = Some(account(plan));
        }
        Ok(())
    }
}

struct Catalog {
    models: Mutex<Vec<String>>,
    unavailable: AtomicBool,
    calls: AtomicUsize,
}

struct SwitchingCatalog {
    login: Arc<LoginService>,
}

impl SubscriptionCatalog<String, &'static str> for SwitchingCatalog {
    fn external_scope(&self, _: &ModelConnectionId) -> Result<Option<String>, &'static str> {
        Ok(None)
    }
    fn refresh(&self, _: &ModelConnectionId) -> Result<Vec<String>, &'static str> {
        self.login.update_account(account("Pro")).unwrap();
        Ok(vec!["old-account-model".into()])
    }
}

impl SubscriptionCatalog<String, &'static str> for Catalog {
    fn external_scope(&self, _: &ModelConnectionId) -> Result<Option<String>, &'static str> {
        Ok(None)
    }
    fn refresh(&self, connection: &ModelConnectionId) -> Result<Vec<String>, &'static str> {
        assert_eq!(connection.as_str(), PROVIDER);
        self.calls.fetch_add(1, Ordering::Relaxed);
        if self.unavailable.load(Ordering::Relaxed) {
            return Err("unreachable");
        }
        Ok(self.models.lock().unwrap().clone())
    }
}

#[derive(Default)]
struct EventLog {
    order: Mutex<Vec<&'static str>>,
    models: Mutex<Vec<ModelsUpdate<String, &'static str>>>,
    accounts: Mutex<Vec<ash_login::AccountState>>,
    external: Mutex<Vec<ExternalModelsUpdate<String, &'static str>>>,
}

struct ChannelEvents(Mutex<mpsc::Sender<ModelsUpdate<String, &'static str>>>);

impl SubscriptionEvents<String, &'static str> for ChannelEvents {
    fn external_models_updated(&self, _: ExternalModelsUpdate<String, &'static str>) {
        unreachable!()
    }
    fn models_updated(&self, update: ModelsUpdate<String, &'static str>) {
        self.0.lock().unwrap().send(update).unwrap();
    }
}

impl LoginEvents for EventLog {
    fn login_completed(&self, _: LoginCompletion) {}

    fn account_updated(&self, state: ash_login::AccountState) {
        self.order.lock().unwrap().push("account");
        self.accounts.lock().unwrap().push(state);
    }
}

impl SubscriptionEvents<String, &'static str> for EventLog {
    fn external_models_updated(&self, update: ExternalModelsUpdate<String, &'static str>) {
        self.external.lock().unwrap().push(update);
    }
    fn models_updated(&self, update: ModelsUpdate<String, &'static str>) {
        self.order.lock().unwrap().push("models");
        self.models.lock().unwrap().push(update);
    }
}

fn account(plan: &str) -> AccountSnapshot {
    AccountSnapshot {
        account: AccountRef {
            provider: PROVIDER.into(),
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

fn catalog() -> Arc<Catalog> {
    Arc::new(Catalog {
        models: Mutex::new(vec!["first".into()]),
        unavailable: AtomicBool::new(false),
        calls: AtomicUsize::new(0),
    })
}

#[test]
fn account_and_model_changes_publish_in_order_once() {
    let driver = Arc::new(AccountDriver {
        account: Mutex::new(Some(account("Plus"))),
    });
    let login = Arc::new(LoginService::deferred(driver.clone()));
    let catalog = catalog();
    let events = Arc::new(EventLog::default());
    login.install_events(events.clone()).unwrap();
    let sources = Sources {
        login,
        connections: vec![PROVIDER],
        external_connections: Vec::new(),
        catalog: catalog.clone() as Arc<dyn SubscriptionCatalog<String, &'static str>>,
        events: events.clone() as Arc<dyn SubscriptionEvents<String, &'static str>>,
    };
    let mut observed = Observed::default();
    let cancellation = CancellationSource::new();

    observed.check(&sources, false, &cancellation.token());
    assert_eq!(
        events.order.lock().unwrap().as_slice(),
        &["account", "models"]
    );
    assert_eq!(
        events.models.lock().unwrap()[0].result,
        Ok(vec!["first".into()])
    );
    observed.check(&sources, false, &cancellation.token());
    assert_eq!(events.order.lock().unwrap().len(), 2);
    assert_eq!(catalog.calls.load(Ordering::Relaxed), 1);

    *driver.account.lock().unwrap() = Some(account("Pro"));
    *catalog.models.lock().unwrap() = vec!["second".into()];
    observed.check(&sources, false, &cancellation.token());
    assert_eq!(
        events.order.lock().unwrap().as_slice(),
        &["account", "models", "account", "models"]
    );
    assert_eq!(
        events.models.lock().unwrap()[1].plan.as_deref(),
        Some("Pro")
    );
    assert_eq!(
        events.models.lock().unwrap()[1].result,
        Ok(vec!["second".into()])
    );

    *catalog.models.lock().unwrap() = vec!["third".into()];
    observed.check(&sources, true, &cancellation.token());
    assert_eq!(
        events.models.lock().unwrap()[2].result,
        Ok(vec!["third".into()])
    );
    assert_eq!(events.order.lock().unwrap().last(), Some(&"models"));
}

#[test]
fn failed_discovery_waits_for_the_next_remote_interval() {
    let driver = Arc::new(AccountDriver {
        account: Mutex::new(Some(account("Plus"))),
    });
    let catalog = catalog();
    catalog.unavailable.store(true, Ordering::Relaxed);
    let events = Arc::new(EventLog::default());
    let sources = Sources {
        login: Arc::new(LoginService::deferred(driver)),
        connections: vec![PROVIDER],
        external_connections: Vec::new(),
        catalog: catalog.clone() as Arc<dyn SubscriptionCatalog<String, &'static str>>,
        events: events.clone() as Arc<dyn SubscriptionEvents<String, &'static str>>,
    };
    let mut observed = Observed::default();
    let cancellation = CancellationSource::new();

    observed.check(&sources, false, &cancellation.token());
    observed.check(&sources, false, &cancellation.token());
    assert_eq!(catalog.calls.load(Ordering::Relaxed), 1);
    assert_eq!(events.models.lock().unwrap()[0].result, Err("unreachable"));

    catalog.unavailable.store(false, Ordering::Relaxed);
    observed.check(&sources, true, &cancellation.token());
    assert_eq!(catalog.calls.load(Ordering::Relaxed), 2);
    assert_eq!(
        events.models.lock().unwrap()[1].result,
        Ok(vec!["first".into()])
    );
}

#[test]
fn remote_metadata_updates_account_before_matching_models() {
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
            .with_account_metadata_refreshers([
                metadata.clone() as Arc<dyn AccountMetadataRefresher>
            ])
            .unwrap(),
    );
    let events = Arc::new(EventLog::default());
    login.install_events(events.clone()).unwrap();
    let sources = Sources {
        login,
        connections: vec![PROVIDER],
        external_connections: Vec::new(),
        catalog: catalog() as Arc<dyn SubscriptionCatalog<String, &'static str>>,
        events: events.clone() as Arc<dyn SubscriptionEvents<String, &'static str>>,
    };
    let mut observed = Observed::default();
    let cancellation = CancellationSource::new();

    observed.check(&sources, true, &cancellation.token());
    assert_eq!(metadata.calls.load(Ordering::Relaxed), 1);
    assert_eq!(
        events.order.lock().unwrap().as_slice(),
        &["account", "account", "models"]
    );
    assert_eq!(
        events.accounts.lock().unwrap()[1].accounts[0]
            .plan
            .as_deref(),
        Some("Pro")
    );
    assert_eq!(
        events.models.lock().unwrap()[0].plan.as_deref(),
        Some("Pro")
    );
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
    let login = Arc::new(
        LoginService::deferred(driver.clone())
            .with_account_metadata_refreshers([
                metadata.clone() as Arc<dyn AccountMetadataRefresher>
            ])
            .unwrap(),
    );
    let catalog = catalog();
    let events = Arc::new(EventLog::default());
    login.install_events(events.clone()).unwrap();
    let sources = Sources {
        login,
        connections: vec![PROVIDER],
        external_connections: Vec::new(),
        catalog: catalog.clone() as Arc<dyn SubscriptionCatalog<String, &'static str>>,
        events: events.clone() as Arc<dyn SubscriptionEvents<String, &'static str>>,
    };
    let mut observed = Observed::default();
    let cancellation = CancellationSource::new();

    observed.check(&sources, true, &cancellation.token());
    assert_eq!(metadata.calls.load(Ordering::Relaxed), 0);
    assert_eq!(catalog.calls.load(Ordering::Relaxed), 0);

    *driver.account.lock().unwrap() = Some(account("Plus"));
    observed.check(&sources, false, &cancellation.token());
    assert_eq!(metadata.calls.load(Ordering::Relaxed), 1);
    assert_eq!(catalog.calls.load(Ordering::Relaxed), 1);

    *driver.account.lock().unwrap() = None;
    observed.check(&sources, false, &cancellation.token());
    assert_eq!(metadata.calls.load(Ordering::Relaxed), 1);
    assert_eq!(catalog.calls.load(Ordering::Relaxed), 1);

    *driver.account.lock().unwrap() = Some(account("Plus"));
    observed.check(&sources, false, &cancellation.token());
    assert_eq!(metadata.calls.load(Ordering::Relaxed), 2);
    assert_eq!(catalog.calls.load(Ordering::Relaxed), 2);
}

#[test]
fn account_change_during_discovery_discards_the_old_model_result() {
    let driver = Arc::new(AccountDriver {
        account: Mutex::new(Some(account("Plus"))),
    });
    let login = Arc::new(LoginService::deferred(driver));
    let events = Arc::new(EventLog::default());
    login.install_events(events.clone()).unwrap();
    let sources = Sources {
        login: login.clone(),
        connections: vec![PROVIDER],
        external_connections: Vec::new(),
        catalog: Arc::new(SwitchingCatalog { login })
            as Arc<dyn SubscriptionCatalog<String, &'static str>>,
        events: events.clone() as Arc<dyn SubscriptionEvents<String, &'static str>>,
    };
    let mut observed = Observed::default();
    let cancellation = CancellationSource::new();

    observed.check(&sources, false, &cancellation.token());
    assert!(events.models.lock().unwrap().is_empty());
    assert_eq!(
        events.accounts.lock().unwrap().last().unwrap().accounts[0]
            .plan
            .as_deref(),
        Some("Pro")
    );
}

#[test]
fn observer_starts_and_stops_with_its_owner() {
    let driver = Arc::new(AccountDriver {
        account: Mutex::new(Some(account("Plus"))),
    });
    let login = Arc::new(LoginService::deferred(driver));
    let (sender, receiver) = mpsc::channel();
    let observer = SubscriptionObserver::start(
        login,
        vec![PROVIDER],
        Vec::new(),
        catalog() as Arc<dyn SubscriptionCatalog<String, &'static str>>,
        Arc::new(ChannelEvents(Mutex::new(sender)))
            as Arc<dyn SubscriptionEvents<String, &'static str>>,
    );

    let update = receiver.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(update.account_id, "account-1");
    assert_eq!(update.result, Ok(vec!["first".into()]));
    drop(observer);
}

struct ExternalCatalog {
    scope: Mutex<Option<String>>,
    rotate_during_request: AtomicBool,
    unavailable: AtomicBool,
    calls: AtomicUsize,
}
impl SubscriptionCatalog<String, &'static str> for ExternalCatalog {
    fn external_scope(&self, _: &ModelConnectionId) -> Result<Option<String>, &'static str> {
        Ok(self.scope.lock().unwrap().clone())
    }
    fn refresh(&self, _: &ModelConnectionId) -> Result<Vec<String>, &'static str> {
        self.calls.fetch_add(1, Ordering::Relaxed);
        let scope = self.scope.lock().unwrap().clone().unwrap();
        if self.rotate_during_request.swap(false, Ordering::Relaxed) {
            *self.scope.lock().unwrap() = Some("new-scope".into());
        }
        if self.unavailable.load(Ordering::Relaxed) {
            return Err("unreachable");
        }
        Ok(vec![scope])
    }
}

#[test]
fn external_catalog_retires_before_failure_and_discards_late_credentials_without_login() {
    let catalog = Arc::new(ExternalCatalog {
        scope: Mutex::new(Some("old-scope".into())),
        rotate_during_request: AtomicBool::new(false),
        unavailable: AtomicBool::new(false),
        calls: AtomicUsize::new(0),
    });
    let events = Arc::new(EventLog::default());
    let sources = Sources {
        login: Arc::new(LoginService::deferred(Arc::new(AccountDriver {
            account: Mutex::new(None),
        }))),
        connections: Vec::new(),
        external_connections: vec!["kimi-desktop"],
        catalog: catalog.clone(),
        events: events.clone(),
    };
    let mut observed = Observed::default();
    let cancellation = CancellationSource::new();
    observed.check(&sources, false, &cancellation.token());
    assert_eq!(events.external.lock().unwrap().len(), 2);
    observed.check(&sources, false, &cancellation.token());
    assert_eq!(catalog.calls.load(Ordering::Relaxed), 1);
    catalog.rotate_during_request.store(true, Ordering::Relaxed);
    observed.check(&sources, true, &cancellation.token());
    assert_eq!(events.external.lock().unwrap().len(), 2);
    catalog.unavailable.store(true, Ordering::Relaxed);
    observed.check(&sources, false, &cancellation.token());
    let updates = events.external.lock().unwrap().clone();
    assert_eq!(updates[2].scope.as_deref(), Some("new-scope"));
    assert_eq!(updates[2].result, Ok(Vec::new()));
    assert_eq!(updates[3].result, Err("unreachable"));
    observed.check(&sources, false, &cancellation.token());
    assert_eq!(catalog.calls.load(Ordering::Relaxed), 3);
    *catalog.scope.lock().unwrap() = None;
    observed.check(&sources, false, &cancellation.token());
    assert_eq!(events.external.lock().unwrap().last().unwrap().scope, None);
    assert!(events.accounts.lock().unwrap().is_empty());
}

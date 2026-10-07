//! Background observation of subscription accounts and their model catalogs.
//!
//! The login service owns account state. A catalog port owns model discovery;
//! this crate owns the observation cadence and account-bound model notifications.

use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use ash_login::AccountStatus;
use ash_login::LoginService;
use ash_protocol::ModelConnectionId;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;
use std::time::Instant;

// Local sign-in publishes account changes immediately. This scan reconciles credentials
// changed by another process, so it does not need an interactive polling cadence.
const ACCOUNT_CHECK_INTERVAL: Duration = Duration::from_secs(60);
const REMOTE_CHECK_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// Discovers models for one subscription connection using its current account.
///
/// Implementations perform provider-specific discovery and return only model
/// metadata. The observer binds the result to the account it observed.
pub trait SubscriptionCatalog<M, E>: Send + Sync {
    fn refresh(&self, connection: &ModelConnectionId) -> Result<Vec<M>, E>;
}

/// Receives account-bound model changes from the subscription observer.
///
/// Product hosts convert these values to their own notification protocol.
pub trait SubscriptionEvents<M, E>: Send + Sync {
    fn models_updated(&self, update: ModelsUpdate<M, E>);
}

/// Model discovery outcome for one unchanged subscription account.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelsUpdate<M, E> {
    pub connection: String,
    pub account_id: String,
    pub organization: Option<String>,
    pub plan: Option<String>,
    pub result: Result<Vec<M>, E>,
}

/// Owns the lifetime of the subscription observation worker.
pub struct SubscriptionObserver {
    shutdown: Option<mpsc::Sender<()>>,
    cancellation: CancellationSource,
    thread: Option<JoinHandle<()>>,
}

struct Sources<M, E> {
    login: Arc<LoginService>,
    connections: Vec<&'static str>,
    catalog: Arc<dyn SubscriptionCatalog<M, E>>,
    events: Arc<dyn SubscriptionEvents<M, E>>,
}

struct Observed<M, E> {
    models: BTreeMap<String, ModelsUpdate<M, E>>,
    // A failed request waits for the next remote interval instead of retrying
    // on every local credential check.
    model_attempts: BTreeMap<String, CatalogIdentity>,
    remote_attempts: BTreeMap<String, String>,
}

impl<M, E> Default for Observed<M, E> {
    fn default() -> Self {
        Self {
            models: BTreeMap::new(),
            model_attempts: BTreeMap::new(),
            remote_attempts: BTreeMap::new(),
        }
    }
}

#[derive(Clone, Eq, PartialEq)]
struct CatalogIdentity {
    account_id: String,
    organization: Option<String>,
    plan: Option<String>,
}

impl SubscriptionObserver {
    pub fn start<M, E>(
        login: Arc<LoginService>,
        connections: Vec<&'static str>,
        catalog: Arc<dyn SubscriptionCatalog<M, E>>,
        events: Arc<dyn SubscriptionEvents<M, E>>,
    ) -> Self
    where
        M: Clone + Eq + Send + 'static,
        E: Clone + Eq + Send + std::fmt::Debug + 'static,
    {
        let sources = Sources {
            login,
            connections,
            catalog,
            events,
        };
        let cancellation = CancellationSource::new();
        let token = cancellation.token();
        let (shutdown, receiver) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("ash-subscription-observer".into())
            .spawn(move || {
                let mut observed = Observed::default();
                let mut next_remote = Instant::now();
                loop {
                    let remote_due = Instant::now() >= next_remote;
                    observed.check(&sources, remote_due, &token);
                    if remote_due {
                        next_remote = Instant::now() + REMOTE_CHECK_INTERVAL;
                    }
                    if receiver.recv_timeout(ACCOUNT_CHECK_INTERVAL).is_ok() {
                        break;
                    }
                }
            })
            .expect("subscription observer thread");
        Self {
            shutdown: Some(shutdown),
            cancellation,
            thread: Some(thread),
        }
    }
}

impl Drop for SubscriptionObserver {
    fn drop(&mut self) {
        self.cancellation.cancel();
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

impl<M: Clone + Eq, E: Clone + Eq + std::fmt::Debug> Observed<M, E> {
    fn check(
        &mut self,
        sources: &Sources<M, E>,
        remote_due: bool,
        cancellation: &CancellationToken,
    ) {
        let Ok(state) = sources.login.refresh() else {
            log::warn!("Subscription account observation failed");
            return;
        };
        if !state
            .accounts
            .iter()
            .any(|account| account.status == AccountStatus::Ready)
        {
            self.models.clear();
            self.model_attempts.clear();
            self.remote_attempts.clear();
            return;
        }
        for &connection in &sources.connections {
            if !sources.login.has_account_metadata_refresher(connection) {
                continue;
            }
            let Some(account) = state.accounts.iter().find(|account| {
                account.account.provider == connection && account.status == AccountStatus::Ready
            }) else {
                continue;
            };
            let changed = self.remote_attempts.get(connection) != Some(&account.account.account_id);
            if !remote_due && !changed {
                continue;
            }
            self.remote_attempts
                .insert(connection.into(), account.account.account_id.clone());
            if let Err(error) = sources.login.refresh_account_metadata(
                connection,
                &account.account.account_id,
                cancellation,
            ) {
                log::warn!("Subscription account refresh failed: {error}");
            }
        }
        let Ok(state) = sources.login.read() else {
            log::warn!("Subscription account observation failed after metadata refresh");
            return;
        };
        self.models.retain(|provider, _| {
            state.accounts.iter().any(|account| {
                account.account.provider == *provider && account.status == AccountStatus::Ready
            })
        });
        self.model_attempts.retain(|provider, _| {
            state.accounts.iter().any(|account| {
                account.account.provider == *provider && account.status == AccountStatus::Ready
            })
        });
        self.remote_attempts.retain(|provider, _| {
            state.accounts.iter().any(|account| {
                account.account.provider == *provider && account.status == AccountStatus::Ready
            })
        });
        for &connection in &sources.connections {
            let Some(account) = state.accounts.iter().find(|account| {
                account.account.provider == connection && account.status == AccountStatus::Ready
            }) else {
                continue;
            };
            let identity = CatalogIdentity {
                account_id: account.account.account_id.clone(),
                organization: account.organization.clone(),
                plan: account.plan.clone(),
            };
            let identity_changed = self.model_attempts.get(connection) != Some(&identity);
            if !remote_due && !identity_changed {
                continue;
            }
            if identity_changed {
                self.models.remove(connection);
            }
            self.model_attempts.insert(connection.into(), identity);
            let id = ModelConnectionId::new(connection.to_owned())
                .expect("registered subscription provider ID");
            let result = sources.catalog.refresh(&id);
            if let Err(error) = &result {
                log::warn!("Subscription model refresh failed: {error:?}");
            }
            let Ok(current) = sources.login.read() else {
                log::warn!("Subscription account observation failed after model refresh");
                continue;
            };
            if !current.accounts.iter().any(|current| {
                current.account.provider == connection
                    && current.account.account_id == account.account.account_id
                    && current.organization == account.organization
                    && current.plan == account.plan
                    && current.status == AccountStatus::Ready
            }) {
                self.models.remove(connection);
                continue;
            }
            let update = ModelsUpdate {
                connection: connection.into(),
                account_id: account.account.account_id.clone(),
                organization: account.organization.clone(),
                plan: account.plan.clone(),
                result,
            };
            if self.models.get(connection) != Some(&update) {
                sources.events.models_updated(update.clone());
                self.models.insert(connection.into(), update);
            }
        }
    }
}

#[cfg(test)]
#[path = "subscription_tests.rs"]
mod tests;

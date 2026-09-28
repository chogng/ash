use super::UpdateBroker;
use crate::model_catalog::ModelCatalog;
use ash_app_server_protocol::protocol::provider::ProviderModelsListFailureDto;
use ash_app_server_protocol::protocol::provider::ProviderModelsListResult;
use ash_app_server_protocol::protocol::provider::ProviderModelsUpdated;
use ash_async_utils::CancellationSource;
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

pub(super) struct SubscriptionMonitor {
    shutdown: Option<mpsc::Sender<()>>,
    cancellation: CancellationSource,
    thread: Option<JoinHandle<()>>,
}

struct Sources {
    login: Arc<LoginService>,
    subscriptions: Vec<&'static str>,
    catalog: Arc<dyn ModelCatalog>,
    updates: Arc<UpdateBroker>,
}

#[derive(Default)]
struct Observed {
    models: BTreeMap<String, ProviderModelsUpdated>,
    // Remember attempts as well as successes so a failed remote request waits for the
    // next remote interval instead of retrying on every local credential check.
    model_attempts: BTreeMap<String, CatalogIdentity>,
    remote_attempts: BTreeMap<String, String>,
}

#[derive(Clone, Eq, PartialEq)]
struct CatalogIdentity {
    account_id: String,
    organization: Option<String>,
    plan: Option<String>,
}

impl SubscriptionMonitor {
    pub(super) fn start(
        login: Arc<LoginService>,
        subscriptions: Vec<&'static str>,
        catalog: Arc<dyn ModelCatalog>,
        updates: Arc<UpdateBroker>,
    ) -> Self {
        let sources = Sources {
            login,
            subscriptions,
            catalog,
            updates,
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

impl Drop for SubscriptionMonitor {
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

impl Observed {
    fn check(
        &mut self,
        sources: &Sources,
        remote_due: bool,
        cancellation: &ash_async_utils::CancellationToken,
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
        for &connection in &sources.subscriptions {
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
        for &connection in &sources.subscriptions {
            let Some(account) = state.accounts.iter().find(|account| {
                account.account.provider == connection && account.status == AccountStatus::Ready
            }) else {
                continue;
            };
            let provider = connection;
            let identity = CatalogIdentity {
                account_id: account.account.account_id.clone(),
                organization: account.organization.clone(),
                plan: account.plan.clone(),
            };
            let identity_changed = self.model_attempts.get(provider) != Some(&identity);
            if !remote_due && !identity_changed {
                continue;
            }
            if identity_changed {
                self.models.remove(provider);
            }
            self.model_attempts.insert(provider.into(), identity);
            let connection = ModelConnectionId::new(provider.to_owned())
                .expect("registered subscription provider ID");
            let result = match sources.catalog.refresh(&connection) {
                Ok(models) if models.is_empty() => ProviderModelsListResult::Empty,
                Ok(models) => ProviderModelsListResult::Models { models },
                Err(error) => {
                    log::warn!("Subscription model refresh failed: {error:?}");
                    ProviderModelsListResult::Failed {
                        failure: ProviderModelsListFailureDto {
                            code: super::operations::provider_models_failure_code(error),
                        },
                    }
                }
            };
            let updated = ProviderModelsUpdated {
                connection: provider.into(),
                account_id: account.account.account_id.clone(),
                organization: account.organization.clone(),
                plan: account.plan.clone(),
                result,
            };
            if self.models.get(provider) != Some(&updated) {
                sources
                    .updates
                    .publish_provider_models_updated(updated.clone());
                self.models.insert(provider.into(), updated);
            }
        }
    }
}

#[cfg(test)]
#[path = "subscription_runtime_tests.rs"]
mod tests;

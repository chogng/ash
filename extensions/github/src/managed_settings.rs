use crate::Error;
use crate::GitHub;
use crate::Result;
use ash_http_client::HttpMethod;
use github::GitHubAuthorization;
use github::ManagedSettingsFailure;
use github::ManagedSettingsReadMode;
use github::ManagedSettingsRefresh;
use github::ManagedSettingsSnapshot;
use serde_json::Value;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

/// Shared by the GitHub extension's invocations, never by renderer windows.
#[derive(Default)]
pub(crate) struct ManagedSettingsStore {
    entries: Mutex<Vec<(GitHubAuthorization, Arc<Entry>)>>,
}

#[derive(Default)]
struct Entry {
    state: Mutex<EntryState>,
    changed: Condvar,
}

#[derive(Default)]
struct EntryState {
    refreshing: bool,
    // A cancelled owner publishes nothing: explicit waiters must then start their own attempt.
    generation: u64,
    snapshot: Option<ManagedSettingsSnapshot>,
    refreshed_at: Option<Instant>,
}

impl ManagedSettingsStore {
    pub(crate) fn read(
        &self,
        client: &GitHub,
        mode: ManagedSettingsReadMode,
    ) -> Result<ManagedSettingsSnapshot> {
        client.validate_authorization().map_err(Error::from)?;
        client.cancellation.check().map_err(|_| Error::Cancelled)?;
        let entry = {
            let mut entries = self.entries.lock().map_err(|_| unavailable())?;
            // Exact grant identity isolates replacement credentials. A late old-grant
            // invocation must not remove a newer grant's in-flight entry.
            if let Some((_, entry)) = entries
                .iter()
                .find(|(grant, _)| grant == &client.authorization)
            {
                entry.clone()
            } else {
                // Inactive account snapshots are a bounded cache, not persistent account state.
                if entries.len() == 32 {
                    let inactive = entries
                        .iter()
                        .position(|(_, entry)| Arc::strong_count(entry) == 1)
                        .ok_or_else(unavailable)?;
                    entries.remove(inactive);
                }
                let entry = Arc::new(Entry::default());
                entries.push((client.authorization.clone(), entry.clone()));
                entry
            }
        };
        let mut state = entry.state.lock().map_err(|_| unavailable())?;
        let generation = state.generation;
        let mut joined = false;
        while state.refreshing {
            joined = true;
            state = entry
                .changed
                .wait_timeout(state, Duration::from_millis(20))
                .map_err(|_| unavailable())?
                .0;
            drop(state);
            client.cancellation.check().map_err(|_| Error::Cancelled)?;
            client.validate_authorization().map_err(Error::from)?;
            state = entry.state.lock().map_err(|_| unavailable())?;
        }
        if let Some(snapshot) = &state.snapshot {
            let reusable = matches!(snapshot.refresh, ManagedSettingsRefresh::Failed { .. })
                || state
                    .refreshed_at
                    .is_some_and(|at| at.elapsed() < Duration::from_secs(60));
            if joined && generation != state.generation
                || mode == ManagedSettingsReadMode::Automatic && reusable
            {
                let snapshot = snapshot.clone();
                drop(state);
                client.validate_authorization().map_err(Error::from)?;
                client.cancellation.check().map_err(|_| Error::Cancelled)?;
                return Ok(snapshot);
            }
        }
        state.refreshing = true;
        let previous = state.snapshot.clone();
        drop(state);

        let result = (|| {
            let last_attempt_at = now()?;
            let runtime = tokio::runtime::Builder::new_current_thread()
                .enable_time()
                .build()
                .map_err(|_| unavailable())?;
            let result = runtime.block_on(client.managed_settings());
            client.cancellation.check().map_err(|_| Error::Cancelled)?;
            client.validate_authorization().map_err(Error::from)?;
            match result {
                Ok(settings) => Ok(ManagedSettingsSnapshot {
                    settings,
                    refresh: ManagedSettingsRefresh::Ready {
                        last_attempt_at,
                        last_success_at: now()?,
                    },
                }),
                Err(Error::Cancelled) => Err(Error::Cancelled),
                Err(error) => {
                    let last_success_at =
                        previous
                            .as_ref()
                            .and_then(|snapshot| match snapshot.refresh {
                                ManagedSettingsRefresh::Ready {
                                    last_success_at, ..
                                } => Some(last_success_at),
                                ManagedSettingsRefresh::Failed {
                                    last_success_at, ..
                                } => last_success_at,
                            });
                    let failure = match error {
                        Error::AuthenticationRequired => {
                            ManagedSettingsFailure::AuthenticationRequired
                        }
                        Error::PermissionDenied => ManagedSettingsFailure::PermissionDenied,
                        Error::RateLimited => ManagedSettingsFailure::RateLimited,
                        Error::ManagedSettingsUpdateRequired => {
                            ManagedSettingsFailure::UpdateRequired
                        }
                        Error::InvalidResponse(_) | Error::InvalidInput(_) => {
                            ManagedSettingsFailure::InvalidResponse
                        }
                        Error::TimedOut => ManagedSettingsFailure::TimedOut,
                        Error::NotFound
                        | Error::Conflict(_)
                        | Error::Unavailable(_)
                        | Error::SubmissionUncertain
                        | Error::OperationFailed(_) => ManagedSettingsFailure::Unavailable,
                        Error::Cancelled => unreachable!(),
                    };
                    Ok(ManagedSettingsSnapshot {
                        settings: previous.and_then(|snapshot| snapshot.settings),
                        refresh: ManagedSettingsRefresh::Failed {
                            last_attempt_at,
                            last_success_at,
                            failure,
                        },
                    })
                }
            }
        })();
        let mut state = entry.state.lock().map_err(|_| unavailable())?;
        state.refreshing = false;
        if let Ok(snapshot) = &result {
            state.snapshot = Some(snapshot.clone());
            state.refreshed_at = Some(Instant::now());
            state.generation += 1;
        }
        entry.changed.notify_all();
        result
    }
}

fn now() -> Result<u64> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| unavailable())?
        .as_millis();
    u64::try_from(millis).map_err(|_| unavailable())
}

fn unavailable() -> Error {
    Error::Unavailable("GitHub managed settings are unavailable".into())
}

impl GitHub {
    /// Reads enterprise settings with this client's exact account grant.
    /// A missing file is an authoritative empty result; other failures retain their category.
    pub async fn managed_settings(&self) -> Result<Option<Value>> {
        match self
            .account_api::<Value>(HttpMethod::Get, "copilot_internal/managed_settings", None)
            .await
        {
            Ok(value) if value.is_object() => Ok(Some(value)),
            Ok(_) => Err(Error::InvalidResponse(
                "Invalid managed settings response".into(),
            )),
            Err(Error::NotFound) => Ok(None),
            Err(error) => Err(error),
        }
    }
}

use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use crate::ConnectorConnectionGeneration;
use crate::ConnectorDefinition;
use crate::ConnectorId;
use crate::ConnectorSnapshotGeneration;
use ash_secrets::SecretValue;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use url::Url;

use crate::ConnectorApiTokenConnectRequest;
use crate::ConnectorCommandId;
use crate::ConnectorCommandResult;
use crate::ConnectorCredentialService;
use crate::ConnectorDisconnectResult;
use crate::ConnectorOAuthError;
use crate::ConnectorOAuthErrorKind;
use crate::ConnectorOAuthFlowId;

mod provider;

pub use provider::ConnectorDeviceOAuthGrant;
pub use provider::ConnectorDeviceOAuthPoll;
pub use provider::ConnectorDeviceOAuthPollRequest;
pub use provider::ConnectorDeviceOAuthProvider;

const MAX_DEVICE_FLOW_LIFETIME: Duration = Duration::from_secs(30 * 60);
const MAX_POLL_INTERVAL: Duration = Duration::from_secs(5 * 60);
const SLOW_DOWN_INCREMENT: Duration = Duration::from_secs(5);

/// Retry identity and authority generation for one OAuth device attempt.
pub struct ConnectorDeviceOAuthStartRequest {
    pub command_id: ConnectorCommandId,
    pub expected_generation: ConnectorSnapshotGeneration,
    pub connector_id: ConnectorId,
    pub connection_generation: ConnectorConnectionGeneration,
}

/// Non-secret values shown to a user while authorizing a device.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectorDeviceOAuthAuthorization {
    pub flow_id: ConnectorOAuthFlowId,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in_seconds: u64,
    pub poll_interval_seconds: u64,
}

/// Current result of polling an in-memory device authorization attempt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectorDeviceOAuthPollResult {
    Pending { retry_after_seconds: u64 },
    Connected(ConnectorCommandResult),
}

/// Coordinates provider device codes with the canonical Connector authority and secret store.
pub struct ConnectorDeviceOAuthService {
    credentials: Arc<ConnectorCredentialService>,
    providers: BTreeMap<ConnectorId, Arc<dyn ConnectorDeviceOAuthProvider>>,
    pending: Mutex<BTreeMap<ConnectorOAuthFlowId, PendingDeviceOAuthAttempt>>,
}

impl ConnectorDeviceOAuthService {
    pub fn new(
        credentials: Arc<ConnectorCredentialService>,
        providers: impl IntoIterator<Item = (ConnectorId, Arc<dyn ConnectorDeviceOAuthProvider>)>,
    ) -> Self {
        Self {
            credentials,
            providers: providers.into_iter().collect(),
            pending: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn supports(&self, connector_id: &ConnectorId) -> bool {
        self.providers.contains_key(connector_id)
    }

    pub fn supports_remote_revoke(&self, connector_id: &ConnectorId) -> bool {
        self.providers
            .get(connector_id)
            .is_some_and(|provider| provider.supports_remote_revoke())
    }

    pub fn start(
        &self,
        request: ConnectorDeviceOAuthStartRequest,
    ) -> Result<ConnectorDeviceOAuthAuthorization, ConnectorOAuthError> {
        self.expire_pending();
        let snapshot = self.credentials.authority().snapshot();
        let definition = snapshot
            .entry(&request.connector_id)
            .ok_or_else(provider_unavailable)?
            .definition()
            .clone();
        let provider = self
            .providers
            .get(&request.connector_id)
            .ok_or_else(provider_unavailable)?;
        let grant = provider.start(&definition)?;
        validate_grant(&grant)?;
        let flow_id = ConnectorOAuthFlowId::new(random_base64url()?)?;
        let begin = self.credentials.begin_connect_attempt(
            &request.command_id,
            request.expected_generation,
            request.connector_id.clone(),
            request.connection_generation,
        )?;
        let now = Instant::now();
        let authorization = ConnectorDeviceOAuthAuthorization {
            flow_id: flow_id.clone(),
            user_code: grant.user_code.clone(),
            verification_uri: grant.verification_uri.clone(),
            expires_in_seconds: ceil_seconds(grant.expires_in),
            poll_interval_seconds: ceil_seconds(grant.poll_interval),
        };
        self.pending.lock().map_err(|_| internal_error())?.insert(
            flow_id,
            PendingDeviceOAuthAttempt {
                started_at: now,
                expires_in: grant.expires_in,
                next_poll_at: now + grant.poll_interval,
                poll_interval: grant.poll_interval,
                command_id: request.command_id,
                expected_generation: request.expected_generation,
                authority_generation: begin.generation,
                connector_id: request.connector_id,
                definition_digest: definition.digest(),
                connection_generation: request.connection_generation,
                device_code: grant.device_code,
            },
        );
        Ok(authorization)
    }

    pub fn poll(
        &self,
        flow_id: &ConnectorOAuthFlowId,
    ) -> Result<ConnectorDeviceOAuthPollResult, ConnectorOAuthError> {
        let mut attempt = self
            .pending
            .lock()
            .map_err(|_| internal_error())?
            .remove(flow_id)
            .ok_or_else(flow_unavailable)?;
        if attempt.started_at.elapsed() >= attempt.expires_in {
            self.fail_attempt(&attempt);
            return Err(expired_error());
        }
        let now = Instant::now();
        if now < attempt.next_poll_at {
            let retry_after_seconds = ceil_seconds(attempt.next_poll_at.duration_since(now));
            self.reinsert(flow_id.clone(), attempt)?;
            return Ok(ConnectorDeviceOAuthPollResult::Pending {
                retry_after_seconds,
            });
        }
        let definition = match self.current_definition(&attempt) {
            Ok(definition) => definition,
            Err(error) => {
                self.fail_attempt(&attempt);
                return Err(error);
            }
        };
        let provider = match self.providers.get(&attempt.connector_id) {
            Some(provider) => provider,
            None => {
                self.fail_attempt(&attempt);
                return Err(provider_unavailable());
            }
        };
        let outcome = provider.poll(
            &definition,
            ConnectorDeviceOAuthPollRequest {
                device_code: &attempt.device_code,
            },
        );
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => {
                attempt.next_poll_at = Instant::now() + attempt.poll_interval;
                self.reinsert(flow_id.clone(), attempt)?;
                return Err(error);
            }
        };
        match outcome {
            ConnectorDeviceOAuthPoll::Pending => {
                attempt.next_poll_at = Instant::now() + attempt.poll_interval;
                let retry_after_seconds = ceil_seconds(attempt.poll_interval);
                self.reinsert(flow_id.clone(), attempt)?;
                Ok(ConnectorDeviceOAuthPollResult::Pending {
                    retry_after_seconds,
                })
            }
            ConnectorDeviceOAuthPoll::SlowDown => {
                attempt.poll_interval = attempt
                    .poll_interval
                    .saturating_add(SLOW_DOWN_INCREMENT)
                    .min(MAX_POLL_INTERVAL);
                attempt.next_poll_at = Instant::now() + attempt.poll_interval;
                let retry_after_seconds = ceil_seconds(attempt.poll_interval);
                self.reinsert(flow_id.clone(), attempt)?;
                Ok(ConnectorDeviceOAuthPollResult::Pending {
                    retry_after_seconds,
                })
            }
            ConnectorDeviceOAuthPoll::Complete(credential) => {
                let result = self.credentials.connect_oauth_credential(
                    ConnectorApiTokenConnectRequest {
                        command_id: attempt.command_id.clone(),
                        expected_generation: attempt.expected_generation,
                        connector_id: attempt.connector_id.clone(),
                        connection_generation: attempt.connection_generation,
                        account_id: credential.account_id,
                        account_display_name: credential.account_display_name,
                        token: credential.secret,
                    },
                    credential.runtime_secret,
                );
                match result {
                    Ok(result) => Ok(ConnectorDeviceOAuthPollResult::Connected(result)),
                    Err(error) => {
                        self.fail_attempt(&attempt);
                        Err(error.into())
                    }
                }
            }
            ConnectorDeviceOAuthPoll::Denied => {
                self.fail_attempt(&attempt);
                Err(ConnectorOAuthError::new(
                    ConnectorOAuthErrorKind::InvalidRequest,
                    "Connector device authorization was denied",
                ))
            }
            ConnectorDeviceOAuthPoll::Expired => {
                self.fail_attempt(&attempt);
                Err(expired_error())
            }
        }
    }

    pub fn cancel(
        &self,
        flow_id: &ConnectorOAuthFlowId,
    ) -> Result<ConnectorCommandResult, ConnectorOAuthError> {
        let attempt = self
            .pending
            .lock()
            .map_err(|_| internal_error())?
            .remove(flow_id)
            .ok_or_else(flow_unavailable)?;
        self.credentials
            .mark_connect_unavailable(
                &attempt.command_id,
                attempt.authority_generation,
                attempt.connector_id,
                attempt.connection_generation,
            )
            .map_err(Into::into)
    }

    pub fn refresh(&self, connector_id: &ConnectorId) -> Result<(), ConnectorOAuthError> {
        let snapshot = self.credentials.authority().snapshot();
        let entry = snapshot
            .entry(connector_id)
            .ok_or_else(provider_unavailable)?;
        let definition = entry.definition().clone();
        let connection_generation = entry.connection().generation();
        let definition_digest = definition.digest();
        let provider = self
            .providers
            .get(connector_id)
            .ok_or_else(provider_unavailable)?;
        self.credentials
            .authority()
            .with_authorized_invocation(
                connector_id,
                connection_generation,
                &definition_digest,
                || {
                    let credential = self.credentials.load_connected_credential(connector_id)?;
                    let replacement = provider.refresh(
                        &definition,
                        crate::ConnectorOAuthRefreshRequest { credential },
                    )?;
                    self.credentials.replace_connected_oauth_credential(
                        connector_id,
                        replacement.runtime_secret,
                        replacement.secret,
                    )?;
                    Ok::<(), ConnectorOAuthError>(())
                },
            )
            .ok_or_else(connection_changed)?
    }

    pub fn revoke_and_disconnect(
        &self,
        command_id: ConnectorCommandId,
        expected_generation: ConnectorSnapshotGeneration,
        connector_id: ConnectorId,
    ) -> Result<ConnectorDisconnectResult, ConnectorOAuthError> {
        let snapshot = self.credentials.authority().snapshot();
        if snapshot.generation() != expected_generation {
            return Err(connection_changed());
        }
        let entry = snapshot
            .entry(&connector_id)
            .ok_or_else(provider_unavailable)?;
        let definition = entry.definition().clone();
        let connection_generation = entry.connection().generation();
        let definition_digest = definition.digest();
        let provider = self
            .providers
            .get(&connector_id)
            .ok_or_else(provider_unavailable)?;
        if !provider.supports_remote_revoke() {
            return Err(provider_unavailable());
        }
        self.credentials
            .authority()
            .with_authorized_invocation(
                &connector_id,
                connection_generation,
                &definition_digest,
                || {
                    let credential = self.credentials.load_connected_credential(&connector_id)?;
                    provider.revoke(
                        &definition,
                        crate::ConnectorOAuthRevokeRequest { credential },
                    )
                },
            )
            .ok_or_else(connection_changed)??;
        self.credentials
            .disconnect(command_id, expected_generation, connector_id)
            .map_err(Into::into)
    }

    pub fn expire_pending(&self) -> usize {
        let expired = {
            let mut pending = self
                .pending
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let ids = pending
                .iter()
                .filter(|(_, attempt)| attempt.started_at.elapsed() >= attempt.expires_in)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            ids.into_iter()
                .filter_map(|id| pending.remove(&id))
                .collect::<Vec<_>>()
        };
        let count = expired.len();
        for attempt in expired {
            self.fail_attempt(&attempt);
        }
        count
    }

    fn current_definition(
        &self,
        attempt: &PendingDeviceOAuthAttempt,
    ) -> Result<ConnectorDefinition, ConnectorOAuthError> {
        self.credentials
            .authority()
            .snapshot()
            .entry(&attempt.connector_id)
            .filter(|entry| entry.definition().digest() == attempt.definition_digest)
            .map(|entry| entry.definition().clone())
            .ok_or_else(connection_changed)
    }

    fn reinsert(
        &self,
        flow_id: ConnectorOAuthFlowId,
        attempt: PendingDeviceOAuthAttempt,
    ) -> Result<(), ConnectorOAuthError> {
        self.pending
            .lock()
            .map_err(|_| internal_error())?
            .insert(flow_id, attempt);
        Ok(())
    }

    fn fail_attempt(&self, attempt: &PendingDeviceOAuthAttempt) {
        let _ = self.credentials.mark_connect_unavailable(
            &attempt.command_id,
            attempt.authority_generation,
            attempt.connector_id.clone(),
            attempt.connection_generation,
        );
    }
}

struct PendingDeviceOAuthAttempt {
    started_at: Instant,
    expires_in: Duration,
    next_poll_at: Instant,
    poll_interval: Duration,
    command_id: ConnectorCommandId,
    expected_generation: ConnectorSnapshotGeneration,
    authority_generation: ConnectorSnapshotGeneration,
    connector_id: ConnectorId,
    definition_digest: crate::ConnectorDefinitionDigest,
    connection_generation: ConnectorConnectionGeneration,
    device_code: SecretValue,
}

fn validate_grant(grant: &ConnectorDeviceOAuthGrant) -> Result<(), ConnectorOAuthError> {
    let verification_uri = Url::parse(&grant.verification_uri).map_err(|_| provider_failure())?;
    if verification_uri.scheme() != "https"
        || !verification_uri.username().is_empty()
        || verification_uri.password().is_some()
        || verification_uri.fragment().is_some()
        || grant.device_code.expose().is_empty()
        || grant.user_code.is_empty()
        || grant.user_code.len() > 128
        || grant.user_code.contains(char::is_control)
        || grant.expires_in.is_zero()
        || grant.expires_in > MAX_DEVICE_FLOW_LIFETIME
        || grant.poll_interval.is_zero()
        || grant.poll_interval > MAX_POLL_INTERVAL
    {
        return Err(provider_failure());
    }
    Ok(())
}

fn random_base64url() -> Result<String, ConnectorOAuthError> {
    let mut random = [0_u8; 32];
    getrandom::getrandom(&mut random).map_err(|_| internal_error())?;
    Ok(URL_SAFE_NO_PAD.encode(random))
}

fn ceil_seconds(duration: Duration) -> u64 {
    duration
        .as_secs()
        .saturating_add(u64::from(duration.subsec_nanos() > 0))
}

fn provider_unavailable() -> ConnectorOAuthError {
    ConnectorOAuthError::new(
        ConnectorOAuthErrorKind::ProviderUnavailable,
        "Connector OAuth provider is unavailable",
    )
}

fn flow_unavailable() -> ConnectorOAuthError {
    ConnectorOAuthError::new(
        ConnectorOAuthErrorKind::InvalidRequest,
        "Connector device OAuth flow is unavailable",
    )
}

fn connection_changed() -> ConnectorOAuthError {
    ConnectorOAuthError::new(
        ConnectorOAuthErrorKind::InvalidRequest,
        "Connector connection changed during device OAuth",
    )
}

fn expired_error() -> ConnectorOAuthError {
    ConnectorOAuthError::new(
        ConnectorOAuthErrorKind::Expired,
        "Connector device OAuth flow expired",
    )
}

fn provider_failure() -> ConnectorOAuthError {
    ConnectorOAuthError::new(
        ConnectorOAuthErrorKind::ProviderFailure,
        "Connector device OAuth provider returned an invalid response",
    )
}

fn internal_error() -> ConnectorOAuthError {
    ConnectorOAuthError::new(
        ConnectorOAuthErrorKind::ProviderFailure,
        "Connector device OAuth operation failed",
    )
}

#[cfg(test)]
#[path = "device_oauth_tests.rs"]
mod tests;

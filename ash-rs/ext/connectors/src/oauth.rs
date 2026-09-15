use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use crate::ConnectorAccountId;
use crate::ConnectorConnectionGeneration;
use crate::ConnectorDefinition;
use crate::ConnectorId;
use crate::ConnectorSnapshotGeneration;
use ash_secrets::SecretValue;
use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use sha2::Digest;
use sha2::Sha256;
use url::Url;
use zeroize::Zeroize;

use crate::ConnectorApiTokenConnectRequest;
use crate::ConnectorCommandId;
use crate::ConnectorCommandResult;
use crate::ConnectorCredentialService;
use crate::ConnectorCredentialServiceError;

const FLOW_LIFETIME: Duration = Duration::from_secs(10 * 60);

/// PKCE and callback values supplied to one exact Connector OAuth adapter.
pub struct ConnectorOAuthChallenge<'a> {
    pub state: &'a str,
    pub code_challenge: &'a str,
    pub redirect_uri: &'a str,
}

/// Provider-produced authorization URL for a browser interaction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectorOAuthAuthorization {
    pub flow_id: ConnectorOAuthFlowId,
    pub authorization_url: String,
}

/// Secret-bearing one-shot exchange input owned by an exact provider adapter.
pub struct ConnectorOAuthExchangeRequest<'a> {
    pub authorization_code: SecretValue,
    pub pkce_verifier: &'a str,
    pub redirect_uri: &'a str,
}

/// Opaque stored credential supplied for a provider-owned token refresh.
pub struct ConnectorOAuthRefreshRequest {
    pub credential: SecretValue,
}

/// Opaque stored credential supplied for provider-owned remote revocation.
pub struct ConnectorOAuthRevokeRequest {
    pub credential: SecretValue,
}

/// Provider-validated account projection and opaque credential payload.
pub struct ConnectorOAuthCredential {
    pub account_id: ConnectorAccountId,
    pub account_display_name: String,
    pub runtime_secret: SecretValue,
    pub secret: SecretValue,
}

/// Rotated runtime and lifecycle values produced by a provider refresh.
pub struct ConnectorOAuthCredentialReplacement {
    pub runtime_secret: SecretValue,
    pub secret: SecretValue,
}

/// Exact product/provider adapter for one Connector's OAuth wire protocol.
///
/// Implementations own provider endpoints, client identity, scopes, token response parsing,
/// refresh/revoke semantics, and account lookup. Errors must be sanitized.
pub trait ConnectorOAuthProvider: Send + Sync {
    fn authorization_url(
        &self,
        connector: &ConnectorDefinition,
        challenge: ConnectorOAuthChallenge<'_>,
    ) -> Result<String, ConnectorOAuthError>;

    fn exchange(
        &self,
        connector: &ConnectorDefinition,
        request: ConnectorOAuthExchangeRequest<'_>,
    ) -> Result<ConnectorOAuthCredential, ConnectorOAuthError>;

    fn refresh(
        &self,
        connector: &ConnectorDefinition,
        request: ConnectorOAuthRefreshRequest,
    ) -> Result<ConnectorOAuthCredentialReplacement, ConnectorOAuthError>;

    fn revoke(
        &self,
        connector: &ConnectorDefinition,
        request: ConnectorOAuthRevokeRequest,
    ) -> Result<(), ConnectorOAuthError>;
}

/// Retry identity and authority generation for one browser OAuth attempt.
pub struct ConnectorOAuthStartRequest {
    pub command_id: ConnectorCommandId,
    pub expected_generation: ConnectorSnapshotGeneration,
    pub connector_id: ConnectorId,
    pub connection_generation: ConnectorConnectionGeneration,
    pub redirect_uri: String,
}

/// Callback values for exactly one previously started OAuth attempt.
pub struct ConnectorOAuthCompleteRequest {
    pub flow_id: ConnectorOAuthFlowId,
    pub state: SecretValue,
    pub authorization_code: SecretValue,
}

/// Opaque in-memory identity for one OAuth attempt.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ConnectorOAuthFlowId(String);

impl ConnectorOAuthFlowId {
    pub fn new(value: impl Into<String>) -> Result<Self, ConnectorOAuthError> {
        let value = value.into();
        if value.len() != 43
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(oauth_error(
                ConnectorOAuthErrorKind::InvalidRequest,
                "invalid Connector OAuth flow identity",
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Coordinates ephemeral PKCE/state with the durable Connector authority and secret owner.
pub struct ConnectorOAuthService {
    credentials: Arc<ConnectorCredentialService>,
    providers: BTreeMap<ConnectorId, Arc<dyn ConnectorOAuthProvider>>,
    pending: Mutex<BTreeMap<ConnectorOAuthFlowId, PendingOAuthAttempt>>,
}

impl ConnectorOAuthService {
    pub fn new(
        credentials: Arc<ConnectorCredentialService>,
        providers: impl IntoIterator<Item = (ConnectorId, Arc<dyn ConnectorOAuthProvider>)>,
    ) -> Self {
        Self {
            credentials,
            providers: providers.into_iter().collect(),
            pending: Mutex::new(BTreeMap::new()),
        }
    }

    /// Returns whether an exact Connector has a product-owned OAuth adapter.
    pub fn supports(&self, connector_id: &ConnectorId) -> bool {
        self.providers.contains_key(connector_id)
    }

    pub fn start(
        &self,
        request: ConnectorOAuthStartRequest,
    ) -> Result<ConnectorOAuthAuthorization, ConnectorOAuthError> {
        self.expire_pending();
        validate_redirect_uri(&request.redirect_uri)?;
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
        let flow_id = ConnectorOAuthFlowId::new(random_base64url()?)?;
        let state = random_base64url()?;
        let verifier = random_base64url()?;
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let authorization_url = provider.authorization_url(
            &definition,
            ConnectorOAuthChallenge {
                state: &state,
                code_challenge: &challenge,
                redirect_uri: &request.redirect_uri,
            },
        )?;
        validate_authorization_url(
            &authorization_url,
            &state,
            &challenge,
            &request.redirect_uri,
        )?;
        let begin = self.credentials.begin_connect_attempt(
            &request.command_id,
            request.expected_generation,
            request.connector_id.clone(),
            request.connection_generation,
        )?;
        let attempt = PendingOAuthAttempt {
            started_at: Instant::now(),
            command_id: request.command_id,
            expected_generation: request.expected_generation,
            authority_generation: begin.generation,
            connector_id: request.connector_id,
            definition_digest: definition.digest(),
            connection_generation: request.connection_generation,
            redirect_uri: request.redirect_uri,
            state,
            verifier,
        };
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(flow_id.clone(), attempt);
        Ok(ConnectorOAuthAuthorization {
            flow_id,
            authorization_url,
        })
    }

    pub fn complete(
        &self,
        request: ConnectorOAuthCompleteRequest,
    ) -> Result<ConnectorCommandResult, ConnectorOAuthError> {
        let attempt = self
            .pending
            .lock()
            .map_err(|_| internal_error())?
            .remove(&request.flow_id)
            .ok_or_else(|| {
                oauth_error(
                    ConnectorOAuthErrorKind::InvalidRequest,
                    "Connector OAuth flow is unavailable",
                )
            })?;
        if attempt.started_at.elapsed() > FLOW_LIFETIME {
            self.fail_attempt(&attempt);
            return Err(oauth_error(
                ConnectorOAuthErrorKind::Expired,
                "Connector OAuth flow expired",
            ));
        }
        if !constant_time_eq(attempt.state.as_bytes(), request.state.expose()) {
            self.fail_attempt(&attempt);
            return Err(oauth_error(
                ConnectorOAuthErrorKind::StateMismatch,
                "Connector OAuth callback state did not match",
            ));
        }
        let snapshot = self.credentials.authority().snapshot();
        let definition = match snapshot.entry(&attempt.connector_id) {
            Some(entry) if entry.definition().digest() == attempt.definition_digest => {
                entry.definition().clone()
            }
            None => {
                self.fail_attempt(&attempt);
                return Err(provider_unavailable());
            }
            Some(_) => {
                self.fail_attempt(&attempt);
                return Err(oauth_error(
                    ConnectorOAuthErrorKind::InvalidRequest,
                    "Connector definition changed during OAuth authorization",
                ));
            }
        };
        let provider = match self.providers.get(&attempt.connector_id) {
            Some(provider) => provider,
            None => {
                self.fail_attempt(&attempt);
                return Err(provider_unavailable());
            }
        };
        let credential = match provider.exchange(
            &definition,
            ConnectorOAuthExchangeRequest {
                authorization_code: request.authorization_code,
                pkce_verifier: &attempt.verifier,
                redirect_uri: &attempt.redirect_uri,
            },
        ) {
            Ok(credential) => credential,
            Err(error) => {
                self.fail_attempt(&attempt);
                return Err(error);
            }
        };
        match self.credentials.connect_oauth_credential(
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
        ) {
            Ok(result) => Ok(result),
            Err(error) => {
                self.fail_attempt(&attempt);
                Err(error.into())
            }
        }
    }

    /// Cancels one exact browser attempt and moves its Connector out of `Connecting`.
    pub fn cancel(
        &self,
        flow_id: &ConnectorOAuthFlowId,
    ) -> Result<ConnectorCommandResult, ConnectorOAuthError> {
        let attempt = self
            .pending
            .lock()
            .map_err(|_| internal_error())?
            .remove(flow_id)
            .ok_or_else(|| {
                oauth_error(
                    ConnectorOAuthErrorKind::InvalidRequest,
                    "Connector OAuth flow is unavailable",
                )
            })?;
        self.credentials
            .mark_connect_unavailable(
                &attempt.command_id,
                attempt.authority_generation,
                attempt.connector_id.clone(),
                attempt.connection_generation,
            )
            .map_err(Into::into)
    }

    /// Refreshes one credential under the exact live connection lease.
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
                    let replacement = provider
                        .refresh(&definition, ConnectorOAuthRefreshRequest { credential })?;
                    self.credentials.replace_connected_oauth_credential(
                        connector_id,
                        replacement.runtime_secret,
                        replacement.secret,
                    )?;
                    Ok::<(), ConnectorOAuthError>(())
                },
            )
            .ok_or_else(|| {
                oauth_error(
                    ConnectorOAuthErrorKind::InvalidRequest,
                    "Connector connection changed during OAuth refresh",
                )
            })?
    }

    /// Revokes the provider token before committing the local disconnect.
    ///
    /// A remote failure leaves the exact local connection ready so the user can retry. Once
    /// revocation succeeds, the ordinary disconnect fence drains in-flight calls and removes the
    /// credential from the local secret store.
    pub fn revoke_and_disconnect(
        &self,
        command_id: ConnectorCommandId,
        expected_generation: ConnectorSnapshotGeneration,
        connector_id: ConnectorId,
    ) -> Result<crate::ConnectorDisconnectResult, ConnectorOAuthError> {
        let snapshot = self.credentials.authority().snapshot();
        if snapshot.generation() != expected_generation {
            return Err(oauth_error(
                ConnectorOAuthErrorKind::InvalidRequest,
                "Connector generation changed before OAuth revocation",
            ));
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
        self.credentials
            .authority()
            .with_authorized_invocation(
                &connector_id,
                connection_generation,
                &definition_digest,
                || {
                    let credential = self.credentials.load_connected_credential(&connector_id)?;
                    provider.revoke(&definition, ConnectorOAuthRevokeRequest { credential })
                },
            )
            .ok_or_else(|| {
                oauth_error(
                    ConnectorOAuthErrorKind::InvalidRequest,
                    "Connector connection changed during OAuth revocation",
                )
            })??;
        self.credentials
            .disconnect(command_id, expected_generation, connector_id)
            .map_err(Into::into)
    }

    fn fail_attempt(&self, attempt: &PendingOAuthAttempt) {
        let _ = self.credentials.mark_connect_unavailable(
            &attempt.command_id,
            attempt.authority_generation,
            attempt.connector_id.clone(),
            attempt.connection_generation,
        );
    }

    /// Expires abandoned browser flows and revokes their connecting state.
    pub fn expire_pending(&self) -> usize {
        let expired = {
            let mut pending = self
                .pending
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let expired_ids = pending
                .iter()
                .filter(|(_, attempt)| attempt.started_at.elapsed() > FLOW_LIFETIME)
                .map(|(id, _)| id.clone())
                .collect::<Vec<_>>();
            expired_ids
                .into_iter()
                .filter_map(|id| pending.remove(&id))
                .collect::<Vec<_>>()
        };
        let count = expired.len();
        for attempt in expired {
            self.fail_attempt(&attempt);
        }
        count
    }
}

struct PendingOAuthAttempt {
    started_at: Instant,
    command_id: ConnectorCommandId,
    expected_generation: ConnectorSnapshotGeneration,
    authority_generation: ConnectorSnapshotGeneration,
    connector_id: ConnectorId,
    definition_digest: crate::ConnectorDefinitionDigest,
    connection_generation: ConnectorConnectionGeneration,
    redirect_uri: String,
    state: String,
    verifier: String,
}

impl Drop for PendingOAuthAttempt {
    fn drop(&mut self) {
        self.state.zeroize();
        self.verifier.zeroize();
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectorOAuthErrorKind {
    ProviderUnavailable,
    InvalidRequest,
    StateMismatch,
    Expired,
    ProviderFailure,
    Credential,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectorOAuthError {
    kind: ConnectorOAuthErrorKind,
    message: String,
}

impl ConnectorOAuthError {
    pub fn new(kind: ConnectorOAuthErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn kind(&self) -> ConnectorOAuthErrorKind {
        self.kind
    }
}

impl fmt::Display for ConnectorOAuthError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ConnectorOAuthError {}

impl From<ConnectorCredentialServiceError> for ConnectorOAuthError {
    fn from(_: ConnectorCredentialServiceError) -> Self {
        oauth_error(
            ConnectorOAuthErrorKind::Credential,
            "Connector credential operation failed",
        )
    }
}

fn random_base64url() -> Result<String, ConnectorOAuthError> {
    let mut random = [0_u8; 32];
    getrandom::getrandom(&mut random).map_err(|_| internal_error())?;
    Ok(URL_SAFE_NO_PAD.encode(random))
}

fn validate_redirect_uri(value: &str) -> Result<(), ConnectorOAuthError> {
    let url = Url::parse(value).map_err(|_| invalid_redirect())?;
    let local_http = url.scheme() == "http"
        && matches!(
            url.host_str(),
            Some("127.0.0.1" | "::1" | "[::1]" | "localhost")
        );
    if (url.scheme() != "https" && !local_http)
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid_redirect());
    }
    Ok(())
}

fn validate_authorization_url(
    value: &str,
    state: &str,
    challenge: &str,
    redirect_uri: &str,
) -> Result<(), ConnectorOAuthError> {
    let url = Url::parse(value).map_err(|_| invalid_authorization())?;
    if url.scheme() != "https"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(invalid_authorization());
    }
    let mut values = BTreeMap::new();
    for (key, value) in url.query_pairs() {
        if values.insert(key, value).is_some() {
            return Err(invalid_authorization());
        }
    }
    if values.get("state").map(|value| value.as_ref()) != Some(state)
        || values.get("code_challenge").map(|value| value.as_ref()) != Some(challenge)
        || values
            .get("code_challenge_method")
            .map(|value| value.as_ref())
            != Some("S256")
        || values.get("redirect_uri").map(|value| value.as_ref()) != Some(redirect_uri)
    {
        return Err(invalid_authorization());
    }
    Ok(())
}

fn constant_time_eq(left: &[u8], right: &[u8]) -> bool {
    let mut difference = left.len() ^ right.len();
    for index in 0..left.len().max(right.len()) {
        difference |= usize::from(left.get(index).copied().unwrap_or_default())
            ^ usize::from(right.get(index).copied().unwrap_or_default());
    }
    difference == 0
}

fn provider_unavailable() -> ConnectorOAuthError {
    oauth_error(
        ConnectorOAuthErrorKind::ProviderUnavailable,
        "Connector OAuth provider is unavailable",
    )
}

fn invalid_redirect() -> ConnectorOAuthError {
    oauth_error(
        ConnectorOAuthErrorKind::InvalidRequest,
        "Connector OAuth redirect URI is invalid",
    )
}

fn invalid_authorization() -> ConnectorOAuthError {
    oauth_error(
        ConnectorOAuthErrorKind::ProviderFailure,
        "Connector OAuth provider returned an invalid authorization URL",
    )
}

fn internal_error() -> ConnectorOAuthError {
    oauth_error(
        ConnectorOAuthErrorKind::ProviderFailure,
        "Connector OAuth operation failed",
    )
}

fn oauth_error(kind: ConnectorOAuthErrorKind, message: impl Into<String>) -> ConnectorOAuthError {
    ConnectorOAuthError::new(kind, message)
}

#[cfg(test)]
#[path = "oauth_tests.rs"]
mod tests;

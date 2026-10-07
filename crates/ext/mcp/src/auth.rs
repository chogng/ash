use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::time::Duration;
use std::time::Instant;

use ash_config::McpCredentialBinding;
use ash_config::McpServerConfig;
use ash_config::McpServerId;
use ash_config::McpTransportConfig;
use ash_secrets::DeleteSecretOutcome;
use ash_secrets::SecretStore;
use ash_secrets::SecretValue;
use url::Url;
use zeroize::Zeroize;

mod credential;
mod error;
mod flow;

use ash_secrets::SecretKey;
use credential::encode_oauth_credential;
use credential::oauth_lifecycle_credential;
pub(crate) use credential::project_runtime_credential;
pub use error::McpOAuthError;
pub use error::McpOAuthErrorKind;
use error::oauth_error;
use flow::constant_time_eq;
use flow::pkce_challenge;
use flow::random_base64url;
use flow::target_digest;
use flow::validate_authorization_url;
use flow::validate_redirect_uri;

const FLOW_LIFETIME: Duration = Duration::from_secs(10 * 60);
const MAX_PENDING_OAUTH_FLOWS: usize = 64;
/// Immutable, non-secret OAuth target derived from one standalone MCP declaration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct McpOAuthTarget {
    server_id: McpServerId,
    endpoint: Url,
    credential_key: SecretKey,
    digest: String,
}

impl McpOAuthTarget {
    /// Resolves an OAuth-capable HTTPS target without reading credential bytes.
    pub fn from_config(config: &McpServerConfig) -> Result<Self, McpOAuthError> {
        let endpoint = match &config.transport {
            McpTransportConfig::StreamableHttp { url } => Url::parse(url).map_err(|_| {
                oauth_error(
                    McpOAuthErrorKind::InvalidRequest,
                    "MCP OAuth endpoint is invalid",
                )
            })?,
            McpTransportConfig::Stdio { .. } => {
                return Err(oauth_error(
                    McpOAuthErrorKind::InvalidRequest,
                    "MCP OAuth requires a Streamable HTTP server",
                ));
            }
        };
        if endpoint.scheme() != "https"
            || !endpoint.username().is_empty()
            || endpoint.password().is_some()
            || endpoint.fragment().is_some()
        {
            return Err(oauth_error(
                McpOAuthErrorKind::InvalidRequest,
                "MCP OAuth requires a credential-free HTTPS endpoint",
            ));
        }
        let credential_ref = match &config.credential {
            McpCredentialBinding::Reference { credential_ref } => credential_ref,
            McpCredentialBinding::Unauthenticated => {
                return Err(oauth_error(
                    McpOAuthErrorKind::InvalidRequest,
                    "MCP OAuth requires a configured credential reference",
                ));
            }
        };
        let credential_key = SecretKey::new(credential_ref.clone()).map_err(|_| {
            oauth_error(
                McpOAuthErrorKind::InvalidRequest,
                "MCP OAuth credential reference is invalid",
            )
        })?;
        let digest = target_digest(&config.id, &endpoint, &credential_key);
        Ok(Self {
            server_id: config.id.clone(),
            endpoint,
            credential_key,
            digest,
        })
    }

    pub fn server_id(&self) -> &McpServerId {
        &self.server_id
    }

    pub fn endpoint(&self) -> &Url {
        &self.endpoint
    }

    pub fn credential_key(&self) -> &SecretKey {
        &self.credential_key
    }
}

/// PKCE and callback values supplied to one exact MCP OAuth provider adapter.
pub struct McpOAuthChallenge<'a> {
    pub state: &'a str,
    pub code_challenge: &'a str,
    pub redirect_uri: &'a str,
    pub resource: &'a Url,
}

/// Provider-produced authorization URL for a browser interaction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct McpOAuthAuthorization {
    pub flow_id: McpOAuthFlowId,
    pub authorization_url: String,
}

/// Secret-bearing one-shot exchange input owned by an exact provider adapter.
pub struct McpOAuthExchangeRequest<'a> {
    pub authorization_code: SecretValue,
    pub pkce_verifier: &'a str,
    pub redirect_uri: &'a str,
    pub resource: &'a Url,
}

/// Opaque stored lifecycle credential supplied for provider-owned refresh.
pub struct McpOAuthRefreshRequest<'a> {
    pub credential: SecretValue,
    pub resource: &'a Url,
}

/// Opaque stored lifecycle credential supplied for provider-owned remote revocation.
pub struct McpOAuthRevokeRequest<'a> {
    pub credential: SecretValue,
    pub resource: &'a Url,
}

/// Runtime bearer material and opaque refresh/revoke state returned by a provider.
pub struct McpOAuthCredential {
    pub runtime_secret: SecretValue,
    pub lifecycle_secret: SecretValue,
}

/// Rotated runtime and lifecycle values produced by a provider refresh.
pub struct McpOAuthCredentialReplacement {
    pub runtime_secret: SecretValue,
    pub lifecycle_secret: SecretValue,
}

/// Exact product/provider adapter for one standalone MCP server's OAuth wire protocol.
///
/// Implementations own authorization-server discovery, endpoint allowlisting, client identity,
/// scopes, token response parsing, audience validation, refresh, and remote revocation. Errors
/// must be sanitized and must never contain credential material.
pub trait McpOAuthProvider: Send + Sync {
    fn authorization_url(
        &self,
        target: &McpOAuthTarget,
        challenge: McpOAuthChallenge<'_>,
    ) -> Result<String, McpOAuthError>;

    fn exchange(
        &self,
        target: &McpOAuthTarget,
        request: McpOAuthExchangeRequest<'_>,
    ) -> Result<McpOAuthCredential, McpOAuthError>;

    fn refresh(
        &self,
        target: &McpOAuthTarget,
        request: McpOAuthRefreshRequest<'_>,
    ) -> Result<McpOAuthCredentialReplacement, McpOAuthError>;

    fn revoke(
        &self,
        target: &McpOAuthTarget,
        request: McpOAuthRevokeRequest<'_>,
    ) -> Result<(), McpOAuthError>;
}

/// Browser OAuth start input bound to one exact MCP configuration target.
pub struct McpOAuthStartRequest {
    pub target: McpOAuthTarget,
    pub redirect_uri: String,
}

/// Callback values for exactly one previously started MCP OAuth attempt.
pub struct McpOAuthCompleteRequest {
    pub flow_id: McpOAuthFlowId,
    pub state: SecretValue,
    pub authorization_code: SecretValue,
    pub current_target: McpOAuthTarget,
}

/// Opaque in-memory identity for one MCP OAuth attempt.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct McpOAuthFlowId(String);

impl McpOAuthFlowId {
    pub fn new(value: impl Into<String>) -> Result<Self, McpOAuthError> {
        let value = value.into();
        if value.len() != 43
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
        {
            return Err(oauth_error(
                McpOAuthErrorKind::InvalidRequest,
                "invalid MCP OAuth flow identity",
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Coordinates ephemeral PKCE/state with the MCP auth domain's opaque secret persistence.
pub struct McpOAuthService {
    secrets: Arc<dyn SecretStore>,
    providers: BTreeMap<McpServerId, Arc<dyn McpOAuthProvider>>,
    pending: Mutex<BTreeMap<McpOAuthFlowId, PendingOAuthAttempt>>,
}

impl McpOAuthService {
    pub fn new(
        secrets: Arc<dyn SecretStore>,
        providers: impl IntoIterator<Item = (McpServerId, Arc<dyn McpOAuthProvider>)>,
    ) -> Self {
        Self {
            secrets,
            providers: providers.into_iter().collect(),
            pending: Mutex::new(BTreeMap::new()),
        }
    }

    pub fn supports(&self, server_id: &McpServerId) -> bool {
        self.providers.contains_key(server_id)
    }

    /// Returns the target server without consuming the flow; `complete` remains the expiry owner.
    pub fn pending_server_id(&self, flow_id: &McpOAuthFlowId) -> Option<McpServerId> {
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(flow_id)
            .map(|attempt| attempt.target.server_id().clone())
    }

    pub fn start(
        &self,
        request: McpOAuthStartRequest,
    ) -> Result<McpOAuthAuthorization, McpOAuthError> {
        self.expire_pending();
        validate_redirect_uri(&request.redirect_uri)?;
        let provider = self
            .providers
            .get(request.target.server_id())
            .ok_or_else(provider_unavailable)?;
        let flow_id = McpOAuthFlowId::new(random_base64url()?)?;
        let state = random_base64url()?;
        let verifier = random_base64url()?;
        let challenge = pkce_challenge(&verifier);
        let authorization_url = provider.authorization_url(
            &request.target,
            McpOAuthChallenge {
                state: &state,
                code_challenge: &challenge,
                redirect_uri: &request.redirect_uri,
                resource: request.target.endpoint(),
            },
        )?;
        validate_authorization_url(
            &authorization_url,
            &state,
            &challenge,
            &request.redirect_uri,
            request.target.endpoint(),
        )?;
        let mut pending = self.pending.lock().map_err(|_| internal_error())?;
        if pending.len() >= MAX_PENDING_OAUTH_FLOWS {
            return Err(oauth_error(
                McpOAuthErrorKind::ProviderFailure,
                "MCP OAuth service has too many pending flows",
            ));
        }
        if pending.contains_key(&flow_id) {
            return Err(internal_error());
        }
        pending.insert(
            flow_id.clone(),
            PendingOAuthAttempt {
                started_at: Instant::now(),
                target: request.target,
                redirect_uri: request.redirect_uri,
                state,
                verifier,
            },
        );
        Ok(McpOAuthAuthorization {
            flow_id,
            authorization_url,
        })
    }

    pub fn complete(&self, request: McpOAuthCompleteRequest) -> Result<McpServerId, McpOAuthError> {
        let attempt = self
            .pending
            .lock()
            .map_err(|_| internal_error())?
            .remove(&request.flow_id)
            .ok_or_else(|| {
                oauth_error(
                    McpOAuthErrorKind::InvalidRequest,
                    "MCP OAuth flow is unavailable",
                )
            })?;
        if attempt.started_at.elapsed() > FLOW_LIFETIME {
            return Err(oauth_error(
                McpOAuthErrorKind::Expired,
                "MCP OAuth flow expired",
            ));
        }
        if !constant_time_eq(attempt.state.as_bytes(), request.state.expose()) {
            return Err(oauth_error(
                McpOAuthErrorKind::StateMismatch,
                "MCP OAuth callback state did not match",
            ));
        }
        if attempt.target.digest != request.current_target.digest {
            return Err(oauth_error(
                McpOAuthErrorKind::InvalidRequest,
                "MCP server definition changed during OAuth authorization",
            ));
        }
        let provider = self
            .providers
            .get(attempt.target.server_id())
            .ok_or_else(provider_unavailable)?;
        let credential = provider.exchange(
            &attempt.target,
            McpOAuthExchangeRequest {
                authorization_code: request.authorization_code,
                pkce_verifier: &attempt.verifier,
                redirect_uri: &attempt.redirect_uri,
                resource: attempt.target.endpoint(),
            },
        )?;
        let value =
            encode_oauth_credential(credential.runtime_secret, credential.lifecycle_secret)?;
        self.secrets
            .store(attempt.target.credential_key(), &value)
            .map_err(|_| credential_error())?;
        Ok(attempt.target.server_id.clone())
    }

    pub fn refresh(&self, target: &McpOAuthTarget) -> Result<(), McpOAuthError> {
        let provider = self
            .providers
            .get(target.server_id())
            .ok_or_else(provider_unavailable)?;
        let stored = self
            .secrets
            .load(target.credential_key())
            .map_err(|_| credential_error())?
            .ok_or_else(credential_unavailable)?;
        let credential = oauth_lifecycle_credential(stored)?;
        let replacement = provider.refresh(
            target,
            McpOAuthRefreshRequest {
                credential,
                resource: target.endpoint(),
            },
        )?;
        let value =
            encode_oauth_credential(replacement.runtime_secret, replacement.lifecycle_secret)?;
        self.secrets
            .store(target.credential_key(), &value)
            .map_err(|_| credential_error())
    }

    /// Revokes the provider token before deleting the local credential envelope.
    pub fn revoke(&self, target: &McpOAuthTarget) -> Result<DeleteSecretOutcome, McpOAuthError> {
        let provider = self
            .providers
            .get(target.server_id())
            .ok_or_else(provider_unavailable)?;
        let stored = self
            .secrets
            .load(target.credential_key())
            .map_err(|_| credential_error())?
            .ok_or_else(credential_unavailable)?;
        let credential = oauth_lifecycle_credential(stored)?;
        provider.revoke(
            target,
            McpOAuthRevokeRequest {
                credential,
                resource: target.endpoint(),
            },
        )?;
        self.secrets
            .delete(target.credential_key())
            .map_err(|_| credential_error())
    }

    pub fn expire_pending(&self) -> usize {
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let before = pending.len();
        pending.retain(|_, attempt| attempt.started_at.elapsed() <= FLOW_LIFETIME);
        before.saturating_sub(pending.len())
    }
}

struct PendingOAuthAttempt {
    started_at: Instant,
    target: McpOAuthTarget,
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

fn provider_unavailable() -> McpOAuthError {
    oauth_error(
        McpOAuthErrorKind::ProviderUnavailable,
        "MCP OAuth provider is unavailable",
    )
}

fn credential_unavailable() -> McpOAuthError {
    oauth_error(
        McpOAuthErrorKind::Credential,
        "MCP OAuth credential is unavailable",
    )
}

pub(super) fn credential_error() -> McpOAuthError {
    oauth_error(
        McpOAuthErrorKind::Credential,
        "MCP OAuth credential operation failed",
    )
}

pub(super) fn internal_error() -> McpOAuthError {
    oauth_error(
        McpOAuthErrorKind::ProviderFailure,
        "MCP OAuth operation failed",
    )
}

#[cfg(test)]
#[path = "auth_tests.rs"]
mod tests;

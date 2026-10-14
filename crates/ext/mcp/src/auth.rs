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
mod provider;
pub use provider::HttpOAuthProvider;
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
#[derive(Clone, Debug, Default)]
pub struct McpOAuthOptions {
    pub client_id: Option<String>,
    pub client_metadata_url: Option<String>,
    pub scopes: Vec<String>,
}

pub struct McpOAuthChallenge<'a> {
    pub options: &'a McpOAuthOptions,
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
    pub issuer: Option<&'a str>,
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

    /// Releases ephemeral registration state; implementations must not perform network IO.
    fn cancel(&self, _code_challenge: &str) {}

    /// Checks the stored issuer/resource binding before exposing any bearer, including unexpired tokens.
    fn validate_credential(
        &self,
        _target: &McpOAuthTarget,
        _credential: &SecretValue,
    ) -> Result<(), McpOAuthError> {
        Ok(())
    }

    /// Reports expiry from the provider-owned lifecycle envelope.
    fn needs_refresh(&self, _credential: &SecretValue) -> Result<bool, McpOAuthError> {
        Ok(false)
    }
    /// Allows an unexpired access token after a transient early-refresh failure.
    fn access_is_usable(&self, _credential: &SecretValue) -> Result<bool, McpOAuthError> {
        Ok(false)
    }

    fn revoke(
        &self,
        target: &McpOAuthTarget,
        request: McpOAuthRevokeRequest<'_>,
    ) -> Result<(), McpOAuthError>;
}

/// Browser OAuth start input bound to one exact MCP configuration target.
pub struct McpOAuthStartRequest {
    pub owner: u64,
    pub options: McpOAuthOptions,
    pub target: McpOAuthTarget,
    pub redirect_uri: String,
}

/// Callback values for exactly one previously started MCP OAuth attempt.
pub struct McpOAuthCompleteRequest {
    pub owner: u64,
    pub issuer: Option<String>,
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

enum CredentialState {
    Active,
    Closed,
}

#[repr(u8)]
enum FlowCommitState {
    Pending,
    Cancelled,
    Committed,
}

/// Coordinates ephemeral PKCE/state with the MCP auth domain's opaque secret persistence.
pub struct McpOAuthService {
    secrets: Arc<dyn SecretStore>,
    providers: BTreeMap<McpServerId, Arc<dyn McpOAuthProvider>>,
    pending: Mutex<BTreeMap<McpOAuthFlowId, PendingOAuthAttempt>>,
    cancellations:
        Mutex<BTreeMap<McpOAuthFlowId, (u64, std::sync::Weak<std::sync::atomic::AtomicU8>)>>,
    default_provider: Option<Arc<dyn McpOAuthProvider>>,
    transaction: Mutex<()>,
    lock_directory: Option<std::path::PathBuf>,
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
            cancellations: Mutex::new(BTreeMap::new()),
            default_provider: None,
            transaction: Mutex::new(()),
            lock_directory: None,
        }
    }

    /// Production hosts share the lock directory across all directory runtimes in a profile.
    pub fn with_http_provider(
        mut self,
        http: Arc<dyn ash_http_client::HttpClient>,
        directory: std::path::PathBuf,
    ) -> Self {
        self.default_provider = Some(Arc::new(HttpOAuthProvider::new(http)));
        self.lock_directory = Some(directory);
        self
    }

    fn provider(
        &self,
        target: &McpOAuthTarget,
    ) -> Result<&Arc<dyn McpOAuthProvider>, McpOAuthError> {
        self.providers
            .get(target.server_id())
            .or(self.default_provider.as_ref())
            .ok_or_else(provider_unavailable)
    }

    pub fn supports(&self, server_id: &McpServerId) -> bool {
        self.providers.contains_key(server_id) || self.default_provider.is_some()
    }

    fn credential_identity(target: &McpOAuthTarget) -> String {
        use sha2::Digest;
        format!(
            "{:x}",
            sha2::Sha256::digest(target.credential_key().as_str().as_bytes())
        )
    }

    fn epoch_key(target: &McpOAuthTarget) -> Result<SecretKey, McpOAuthError> {
        SecretKey::new(format!(
            "mcp/oauth/epoch/{}",
            Self::credential_identity(target)
        ))
        .map_err(|_| credential_error())
    }

    fn epoch(&self, target: &McpOAuthTarget) -> Result<Vec<u8>, McpOAuthError> {
        Ok(self
            .secrets
            .load(&Self::epoch_key(target)?)
            .map_err(|_| credential_error())?
            .map(|value| value.expose().to_vec())
            .unwrap_or_default())
    }

    fn advance_epoch(
        &self,
        target: &McpOAuthTarget,
        state: CredentialState,
    ) -> Result<(), McpOAuthError> {
        let prefix = match state {
            CredentialState::Active => "active:",
            CredentialState::Closed => "closed:",
        };
        self.secrets
            .store(
                &Self::epoch_key(target)?,
                &SecretValue::new(format!("{prefix}{}", random_base64url()?).into_bytes()),
            )
            .map_err(|_| credential_error())
    }

    fn lock(
        &self,
        target: &McpOAuthTarget,
    ) -> Result<(std::sync::MutexGuard<'_, ()>, Option<std::fs::File>), McpOAuthError> {
        let guard = self.transaction.lock().map_err(|_| internal_error())?;
        let file = if let Some(directory) = &self.lock_directory {
            std::fs::create_dir_all(directory).map_err(|_| credential_error())?;
            let file = std::fs::OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(directory.join(format!("{}.lock", Self::credential_identity(target))))
                .map_err(|_| credential_error())?;
            let deadline = Instant::now() + Duration::from_secs(60);
            loop {
                match fs2::FileExt::try_lock_exclusive(&file) {
                    Ok(()) => break,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < deadline =>
                    {
                        std::thread::sleep(Duration::from_millis(20))
                    }
                    Err(_) => return Err(credential_error()),
                }
            }
            Some(file)
        } else {
            None
        };
        Ok((guard, file))
    }

    /// Cancel a browser interaction without affecting another client's account or flow.
    pub fn cancel(&self, flow_id: &McpOAuthFlowId, owner: u64) {
        use std::sync::atomic::Ordering;
        let flags = self
            .cancellations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some((flow_owner, flag)) = flags.get(flow_id)
            && *flow_owner == owner
            && let Some(flag) = flag.upgrade()
        {
            let _ = flag.compare_exchange(
                FlowCommitState::Pending as u8,
                FlowCommitState::Cancelled as u8,
                Ordering::SeqCst,
                Ordering::SeqCst,
            );
        }
        drop(flags);
        let mut pending = self
            .pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if pending
            .get(flow_id)
            .is_some_and(|attempt| attempt.owner == owner)
        {
            pending.remove(flow_id);
        }
    }

    pub fn cancel_owner(&self, owner: u64) {
        use std::sync::atomic::Ordering;
        self.cancellations
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|_, (flow_owner, flag)| {
                if *flow_owner != owner {
                    return flag.strong_count() != 0;
                }
                if let Some(flag) = flag.upgrade() {
                    let _ = flag.compare_exchange(
                        FlowCommitState::Pending as u8,
                        FlowCommitState::Cancelled as u8,
                        Ordering::SeqCst,
                        Ordering::SeqCst,
                    );
                }
                false
            });
        self.pending
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|_, attempt| attempt.owner != owner);
    }

    /// Local logout works even when the authorization service is unavailable.
    pub fn logout(&self, target: &McpOAuthTarget) -> Result<(), McpOAuthError> {
        let _lock = self.lock(target)?;
        self.advance_epoch(target, CredentialState::Closed)?;
        if let Some(value) = self
            .secrets
            .load(target.credential_key())
            .map_err(|_| credential_error())?
            && value.expose().starts_with(b"ash-mcp-oauth-credential-v1\0")
        {
            self.secrets
                .delete(target.credential_key())
                .map_err(|_| credential_error())?;
        }
        self.pending
            .lock()
            .map_err(|_| internal_error())?
            .retain(|_, attempt| attempt.target.digest != target.digest);
        Ok(())
    }

    /// Bind a transport to this login generation; it may refresh but never adopt a later login.
    pub fn authorization(
        self: &Arc<Self>,
        target: McpOAuthTarget,
    ) -> Result<Arc<dyn ash_rmcp_client::HttpCredentialProvider>, McpOAuthError> {
        let _lock = self.lock(&target)?;
        let epoch = self.epoch(&target)?;
        if epoch.starts_with(b"closed:") {
            return Err(oauth_error(
                McpOAuthErrorKind::ReauthenticationRequired,
                "MCP OAuth requires sign-in",
            ));
        }
        Ok(Arc::new(ManagedCredential {
            service: Arc::clone(self),
            target,
            epoch,
        }))
    }

    fn token(
        &self,
        target: &McpOAuthTarget,
        epoch: &[u8],
        rejected: Option<&str>,
    ) -> Result<String, McpOAuthError> {
        let _lock = self.lock(target)?;
        if self.epoch(target)? != epoch {
            return Err(credential_unavailable());
        }
        let stored = self
            .secrets
            .load(target.credential_key())
            .map_err(|_| credential_error())?
            .ok_or_else(credential_unavailable)?;
        let bearer = project_runtime_credential(SecretValue::new(stored.expose().to_vec()))?;
        let bearer = std::str::from_utf8(bearer.expose()).map_err(|_| credential_error())?;
        let lifecycle = oauth_lifecycle_credential(stored)?;
        let provider = self.provider(target)?;
        provider.validate_credential(target, &lifecycle)?;
        if provider.needs_refresh(&lifecycle)? || rejected == Some(bearer) {
            if let Err(error) = self.refresh_locked(target) {
                if rejected.is_some()
                    || error.kind() != McpOAuthErrorKind::ProviderFailure
                    || !provider.access_is_usable(&lifecycle)?
                {
                    return Err(error);
                }
                return Ok(bearer.to_owned());
            }
            let stored = self
                .secrets
                .load(target.credential_key())
                .map_err(|_| credential_error())?
                .ok_or_else(credential_unavailable)?;
            let bearer = project_runtime_credential(stored)?;
            return String::from_utf8(bearer.expose().to_vec()).map_err(|_| credential_error());
        }
        Ok(bearer.to_owned())
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
        let flow_id = McpOAuthFlowId::new(random_base64url()?)?;
        let cancellation = Arc::new(std::sync::atomic::AtomicU8::new(
            FlowCommitState::Pending as u8,
        ));
        {
            let mut owners = self.cancellations.lock().map_err(|_| internal_error())?;
            owners.retain(|_, (_, flag)| flag.strong_count() != 0);
            owners.insert(
                flow_id.clone(),
                (request.owner, Arc::downgrade(&cancellation)),
            );
        }
        validate_redirect_uri(&request.redirect_uri)?;
        let _lock = self.lock(&request.target)?;
        let epoch = self.epoch(&request.target)?;
        let provider = self.provider(&request.target)?;

        let state = random_base64url()?;
        let verifier = random_base64url()?;
        let challenge = pkce_challenge(&verifier);
        let authorization_url = provider.authorization_url(
            &request.target,
            McpOAuthChallenge {
                options: &request.options,
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
        if cancellation.load(std::sync::atomic::Ordering::SeqCst) != FlowCommitState::Pending as u8
        {
            provider.cancel(&challenge);
            return Err(credential_unavailable());
        }
        let mut pending = self.pending.lock().map_err(|_| internal_error())?;
        if cancellation.load(std::sync::atomic::Ordering::SeqCst) != FlowCommitState::Pending as u8
        {
            provider.cancel(&challenge);
            return Err(credential_unavailable());
        }
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
                owner: request.owner,
                cancellation,
                provider: Arc::clone(provider),
                started_at: Instant::now(),
                epoch,
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
        let attempt = {
            let mut pending = self.pending.lock().map_err(|_| internal_error())?;
            if !pending
                .get(&request.flow_id)
                .is_some_and(|attempt| attempt.owner == request.owner)
            {
                return Err(credential_unavailable());
            }
            pending
                .remove(&request.flow_id)
                .ok_or_else(credential_unavailable)?
        };
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
        let _lock = self.lock(&attempt.target)?;
        if self.epoch(&attempt.target)? != attempt.epoch {
            return Err(credential_unavailable());
        }
        let provider = self.provider(&attempt.target)?;
        let credential = provider.exchange(
            &attempt.target,
            McpOAuthExchangeRequest {
                issuer: request.issuer.as_deref(),
                authorization_code: request.authorization_code,
                pkce_verifier: &attempt.verifier,
                redirect_uri: &attempt.redirect_uri,
                resource: attempt.target.endpoint(),
            },
        )?;
        let value =
            encode_oauth_credential(credential.runtime_secret, credential.lifecycle_secret)?;
        // The CAS is the completion/cancellation linearization point. A closing client cannot
        // write credentials if cancellation won while the token exchange was in flight.
        attempt
            .cancellation
            .compare_exchange(
                FlowCommitState::Pending as u8,
                FlowCommitState::Committed as u8,
                std::sync::atomic::Ordering::SeqCst,
                std::sync::atomic::Ordering::SeqCst,
            )
            .map_err(|_| credential_unavailable())?;
        // Closing before the two persistence writes keeps any old envelope unusable if storing
        // the replacement fails. Only a fully stored credential can reopen the login generation.
        self.advance_epoch(&attempt.target, CredentialState::Closed)?;
        self.secrets
            .store(attempt.target.credential_key(), &value)
            .map_err(|_| credential_error())?;
        self.advance_epoch(&attempt.target, CredentialState::Active)?;
        Ok(attempt.target.server_id.clone())
    }

    pub fn refresh(&self, target: &McpOAuthTarget) -> Result<(), McpOAuthError> {
        let _lock = self.lock(target)?;
        self.refresh_locked(target)
    }

    fn refresh_locked(&self, target: &McpOAuthTarget) -> Result<(), McpOAuthError> {
        if self.epoch(target)?.starts_with(b"closed:") {
            return Err(oauth_error(
                McpOAuthErrorKind::ReauthenticationRequired,
                "MCP OAuth requires sign-in",
            ));
        }
        let provider = self.provider(target)?;
        let stored = self
            .secrets
            .load(target.credential_key())
            .map_err(|_| credential_error())?
            .ok_or_else(credential_unavailable)?;
        let credential = oauth_lifecycle_credential(stored)?;
        let replacement = match provider.refresh(
            target,
            McpOAuthRefreshRequest {
                credential,
                resource: target.endpoint(),
            },
        ) {
            Ok(value) => value,
            Err(error) => {
                if error.kind() == McpOAuthErrorKind::ReauthenticationRequired {
                    self.advance_epoch(target, CredentialState::Closed)?;
                    self.secrets
                        .delete(target.credential_key())
                        .map_err(|_| credential_error())?;
                }
                return Err(error);
            }
        };
        let value =
            encode_oauth_credential(replacement.runtime_secret, replacement.lifecycle_secret)?;
        self.secrets
            .store(target.credential_key(), &value)
            .map_err(|_| credential_error())
    }

    /// Revokes the provider token before deleting the local credential envelope.
    pub fn revoke(&self, target: &McpOAuthTarget) -> Result<DeleteSecretOutcome, McpOAuthError> {
        let _lock = self.lock(target)?;
        self.advance_epoch(target, CredentialState::Closed)?;
        let provider = self.provider(target)?;
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
    owner: u64,
    cancellation: Arc<std::sync::atomic::AtomicU8>,
    provider: Arc<dyn McpOAuthProvider>,
    epoch: Vec<u8>,
    started_at: Instant,
    target: McpOAuthTarget,
    redirect_uri: String,
    state: String,
    verifier: String,
}

impl Drop for PendingOAuthAttempt {
    fn drop(&mut self) {
        self.provider.cancel(&pkce_challenge(&self.verifier));
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

struct ManagedCredential {
    service: Arc<McpOAuthService>,
    target: McpOAuthTarget,
    epoch: Vec<u8>,
}

impl ash_rmcp_client::HttpCredentialProvider for ManagedCredential {
    fn bearer(&self, rejected: Option<&str>) -> Result<String, std::io::Error> {
        self.service
            .token(&self.target, &self.epoch, rejected)
            .map_err(|_| std::io::Error::other("MCP OAuth requires sign-in"))
    }
}

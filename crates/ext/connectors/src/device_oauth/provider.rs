use std::time::Duration;

use crate::ConnectorDefinition;
use ash_secrets::SecretValue;

use crate::ConnectorOAuthCredential;
use crate::ConnectorOAuthCredentialReplacement;
use crate::ConnectorOAuthError;
use crate::ConnectorOAuthRefreshRequest;
use crate::ConnectorOAuthRevokeRequest;

/// Secret-bearing provider response that starts one OAuth device authorization grant.
pub struct ConnectorDeviceOAuthGrant {
    pub device_code: SecretValue,
    pub user_code: String,
    pub verification_uri: String,
    pub expires_in: Duration,
    pub poll_interval: Duration,
}

/// Provider poll input for one exact in-memory device code.
pub struct ConnectorDeviceOAuthPollRequest<'a> {
    pub device_code: &'a SecretValue,
}

/// Provider result for one protocol-compliant device authorization poll.
pub enum ConnectorDeviceOAuthPoll {
    Pending,
    SlowDown,
    Complete(ConnectorOAuthCredential),
    Denied,
    Expired,
}

/// Exact product/provider adapter for one Connector's OAuth device wire protocol.
///
/// Implementations own provider endpoints, public client identity, scopes, polling error mapping,
/// refresh behavior, and remote revocation behavior. Provider errors must not contain secrets.
pub trait ConnectorDeviceOAuthProvider: Send + Sync {
    fn start(
        &self,
        connector: &ConnectorDefinition,
    ) -> Result<ConnectorDeviceOAuthGrant, ConnectorOAuthError>;

    fn poll(
        &self,
        connector: &ConnectorDefinition,
        request: ConnectorDeviceOAuthPollRequest<'_>,
    ) -> Result<ConnectorDeviceOAuthPoll, ConnectorOAuthError>;

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

    fn supports_remote_revoke(&self) -> bool;
}

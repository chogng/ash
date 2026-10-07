use std::fmt;
use std::fmt::Write;
use std::sync::Arc;

use crate::ConnectorAccount;
use crate::ConnectorAccountId;
use crate::ConnectorConnectionGeneration;
use crate::ConnectorConnectionState;
use crate::ConnectorCredentialRef;
use crate::ConnectorError;
use crate::ConnectorId;
use crate::ConnectorSnapshotGeneration;
use ash_secrets::DeleteSecretOutcome;
use ash_secrets::SecretKey;
use ash_secrets::SecretStore;
use ash_secrets::SecretStoreError;
use ash_secrets::SecretValue;
use sha2::Digest;
use sha2::Sha256;

use crate::ConnectorAuthority;
use crate::ConnectorAuthorityCommand;
use crate::ConnectorAuthorityError;
use crate::ConnectorCommandDisposition;
use crate::ConnectorCommandId;
use crate::ConnectorCommandRequest;
use crate::ConnectorCommandResult;

const AUTH_COMMAND_DOMAIN: &[u8] = b"ash-connector-auth-command-v1\0";
const CREDENTIAL_KEY_DOMAIN: &[u8] = b"ash-connector-credential-key-v1\0";
const OAUTH_CREDENTIAL_MAGIC: &[u8] = b"ash-oauth-credential-v1\0";

/// Ephemeral API-token connection request. The token is never cloneable or persisted in authority.
pub struct ConnectorApiTokenConnectRequest {
    pub command_id: ConnectorCommandId,
    pub expected_generation: ConnectorSnapshotGeneration,
    pub connector_id: ConnectorId,
    pub connection_generation: ConnectorConnectionGeneration,
    pub account_id: ConnectorAccountId,
    pub account_display_name: String,
    pub token: SecretValue,
}

/// Result of best-effort credential cleanup after runtime readiness has been revoked.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectorCredentialCleanup {
    Deleted,
    AlreadyAbsent,
    RetryRequired,
}

/// Disconnect result separates authoritative revocation from secret cleanup status.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConnectorDisconnectResult {
    pub command: ConnectorCommandResult,
    pub credential_cleanup: ConnectorCredentialCleanup,
}

/// Coordinates one Connector authority with its opaque secret persistence backend.
pub struct ConnectorCredentialService {
    authority: ConnectorAuthority,
    secrets: Arc<dyn SecretStore>,
}

impl ConnectorCredentialService {
    pub fn new(authority: ConnectorAuthority, secrets: Arc<dyn SecretStore>) -> Self {
        Self { authority, secrets }
    }

    pub fn authority(&self) -> &ConnectorAuthority {
        &self.authority
    }

    /// Loads the opaque credential for one exact connected account.
    ///
    /// This is restricted to authentication adapters. Callers must validate the account and
    /// connection generation through Connector authority before using or replacing the value.
    pub(crate) fn load_connected_credential(
        &self,
        connector_id: &ConnectorId,
    ) -> Result<SecretValue, ConnectorCredentialServiceError> {
        let snapshot = self.authority.snapshot();
        let entry = snapshot.entry(connector_id).ok_or_else(|| {
            ConnectorCredentialServiceError::new(
                ConnectorCredentialServiceErrorKind::Authority,
                "connector is unavailable",
            )
        })?;
        let account = match entry.connection().state() {
            ConnectorConnectionState::Connected(account) => account,
            ConnectorConnectionState::Disconnected
            | ConnectorConnectionState::Connecting
            | ConnectorConnectionState::Unavailable { .. }
            | ConnectorConnectionState::ReauthorizationRequired { .. } => {
                return Err(ConnectorCredentialServiceError::new(
                    ConnectorCredentialServiceErrorKind::Authority,
                    "connector is not connected",
                ));
            }
        };
        let key = SecretKey::new(account.credential_reference().as_str().to_owned()).map_err(
            |error| {
                ConnectorCredentialServiceError::new(
                    ConnectorCredentialServiceErrorKind::InvalidValue,
                    error.to_string(),
                )
            },
        )?;
        let stored = self.secrets.load(&key)?.ok_or_else(|| {
            ConnectorCredentialServiceError::new(
                ConnectorCredentialServiceErrorKind::SecretStore,
                "connector credential is unavailable",
            )
        })?;
        oauth_credential_part(stored, OAuthCredentialPart::Lifecycle)
    }

    pub(crate) fn replace_connected_oauth_credential(
        &self,
        connector_id: &ConnectorId,
        runtime_secret: SecretValue,
        lifecycle_secret: SecretValue,
    ) -> Result<(), ConnectorCredentialServiceError> {
        let key = credential_key(connector_id)?;
        let value = encode_oauth_credential(runtime_secret, lifecycle_secret)?;
        self.secrets.store(&key, &value)?;
        Ok(())
    }

    pub(crate) fn connect_oauth_credential(
        &self,
        mut request: ConnectorApiTokenConnectRequest,
        runtime_secret: SecretValue,
    ) -> Result<ConnectorCommandResult, ConnectorCredentialServiceError> {
        request.token = encode_oauth_credential(runtime_secret, request.token)?;
        self.connect_api_token(request)
    }

    pub(crate) fn begin_connect_attempt(
        &self,
        command_id: &ConnectorCommandId,
        expected_generation: ConnectorSnapshotGeneration,
        connector_id: ConnectorId,
        connection_generation: ConnectorConnectionGeneration,
    ) -> Result<ConnectorCommandResult, ConnectorCredentialServiceError> {
        self.authority
            .apply(ConnectorCommandRequest {
                command_id: phase_command_id(command_id, "begin")?,
                expected_generation,
                connector_id,
                command: ConnectorAuthorityCommand::BeginConnect {
                    generation: connection_generation,
                },
            })
            .map_err(Into::into)
    }

    pub(crate) fn mark_connect_unavailable(
        &self,
        command_id: &ConnectorCommandId,
        expected_generation: ConnectorSnapshotGeneration,
        connector_id: ConnectorId,
        connection_generation: ConnectorConnectionGeneration,
    ) -> Result<ConnectorCommandResult, ConnectorCredentialServiceError> {
        self.authority
            .apply(ConnectorCommandRequest {
                command_id: phase_command_id(command_id, "unavailable")?,
                expected_generation,
                connector_id,
                command: ConnectorAuthorityCommand::MarkUnavailable {
                    generation: connection_generation,
                    reason: "Connector authorization failed".into(),
                },
            })
            .map_err(Into::into)
    }

    /// Stores an API token and publishes a connected account under two retry-safe authority steps.
    pub fn connect_api_token(
        &self,
        request: ConnectorApiTokenConnectRequest,
    ) -> Result<ConnectorCommandResult, ConnectorCredentialServiceError> {
        let snapshot = self.authority.snapshot();
        snapshot.entry(&request.connector_id).ok_or_else(|| {
            ConnectorCredentialServiceError::new(
                ConnectorCredentialServiceErrorKind::Authority,
                "connector is unavailable",
            )
        })?;
        let secret_key = credential_key(&request.connector_id)?;
        let credential_reference = ConnectorCredentialRef::new(secret_key.as_str().to_string())?;
        let account = ConnectorAccount::new(
            request.account_id,
            request.account_display_name,
            credential_reference,
            request.connection_generation,
        )?;
        let begin = self.begin_connect_attempt(
            &request.command_id,
            request.expected_generation,
            request.connector_id.clone(),
            request.connection_generation,
        )?;
        let complete_command_id = phase_command_id(&request.command_id, "complete")?;
        if begin.disposition == ConnectorCommandDisposition::Replayed {
            let current = self.authority.snapshot();
            let still_in_exact_attempt =
                current.entry(&request.connector_id).is_some_and(|entry| {
                    entry.connection().generation() == request.connection_generation
                        && matches!(
                            entry.connection().state(),
                            ConnectorConnectionState::Connecting
                        )
                });
            if !still_in_exact_attempt {
                return self
                    .authority
                    .apply(ConnectorCommandRequest {
                        command_id: complete_command_id,
                        expected_generation: begin.generation,
                        connector_id: request.connector_id,
                        command: ConnectorAuthorityCommand::CompleteConnect { account },
                    })
                    .map_err(Into::into);
            }
        }
        if let Err(error) = self.secrets.store(&secret_key, &request.token) {
            let _ = self.mark_connect_unavailable(
                &request.command_id,
                begin.generation,
                request.connector_id,
                request.connection_generation,
            );
            return Err(error.into());
        }
        match self.authority.apply(ConnectorCommandRequest {
            command_id: complete_command_id,
            expected_generation: begin.generation,
            connector_id: request.connector_id.clone(),
            command: ConnectorAuthorityCommand::CompleteConnect { account },
        }) {
            Ok(result) => Ok(result),
            Err(error) => {
                let _ = self.secrets.delete(&secret_key);
                let _ = self.mark_connect_unavailable(
                    &request.command_id,
                    begin.generation,
                    request.connector_id,
                    request.connection_generation,
                );
                Err(error.into())
            }
        }
    }

    /// Revokes readiness first, then removes the credential without rolling revocation back.
    pub fn disconnect(
        &self,
        command_id: ConnectorCommandId,
        expected_generation: ConnectorSnapshotGeneration,
        connector_id: ConnectorId,
    ) -> Result<ConnectorDisconnectResult, ConnectorCredentialServiceError> {
        let snapshot = self.authority.snapshot();
        let entry = snapshot.entry(&connector_id).ok_or_else(|| {
            ConnectorCredentialServiceError::new(
                ConnectorCredentialServiceErrorKind::Authority,
                "connector is unavailable",
            )
        })?;
        let credential_reference = match entry.connection().state() {
            ConnectorConnectionState::Connected(account)
            | ConnectorConnectionState::ReauthorizationRequired { account, .. } => {
                Some(account.credential_reference().as_str().to_string())
            }
            ConnectorConnectionState::Disconnected
            | ConnectorConnectionState::Connecting
            | ConnectorConnectionState::Unavailable { .. } => credential_key(&connector_id)
                .ok()
                .map(|key| key.as_str().to_string()),
        };
        let connection_generation = entry.connection().generation();
        let next_connection_generation = if snapshot.generation() == expected_generation {
            connection_generation
                .get()
                .checked_add(1)
                .map(ConnectorConnectionGeneration::new)
                .ok_or_else(|| {
                    ConnectorCredentialServiceError::new(
                        ConnectorCredentialServiceErrorKind::Authority,
                        "connector connection generation exhausted",
                    )
                })?
        } else {
            connection_generation
        };
        let command = self.authority.apply(ConnectorCommandRequest {
            command_id,
            expected_generation,
            connector_id: connector_id.clone(),
            command: ConnectorAuthorityCommand::Disconnect {
                generation: next_connection_generation,
            },
        })?;
        let credential_cleanup = self.delete_credential(&connector_id, credential_reference);
        Ok(ConnectorDisconnectResult {
            command,
            credential_cleanup,
        })
    }

    /// Retries one durable credential-deletion obligation without changing connection state.
    pub fn retry_credential_cleanup(
        &self,
        connector_id: &ConnectorId,
    ) -> ConnectorCredentialCleanup {
        if !self.authority.credential_cleanup_pending(connector_id) {
            return ConnectorCredentialCleanup::AlreadyAbsent;
        }
        let reference = credential_key(connector_id)
            .ok()
            .map(|key| key.as_str().to_owned());
        self.delete_credential(connector_id, reference)
    }

    fn delete_credential(
        &self,
        connector_id: &ConnectorId,
        reference: Option<String>,
    ) -> ConnectorCredentialCleanup {
        let outcome = match reference.and_then(|reference| SecretKey::new(reference).ok()) {
            Some(key) => match self.secrets.delete(&key) {
                Ok(DeleteSecretOutcome::Deleted) => ConnectorCredentialCleanup::Deleted,
                Ok(DeleteSecretOutcome::NotFound) => ConnectorCredentialCleanup::AlreadyAbsent,
                Err(_) => return ConnectorCredentialCleanup::RetryRequired,
            },
            None => ConnectorCredentialCleanup::AlreadyAbsent,
        };
        if self
            .authority
            .complete_credential_cleanup(connector_id)
            .is_err()
        {
            ConnectorCredentialCleanup::RetryRequired
        } else {
            outcome
        }
    }
}

/// Projects only the invocation-time value from a stored Connector credential.
///
/// API tokens are returned unchanged. OAuth envelopes expose the access token while retaining the
/// provider lifecycle bundle solely for refresh and revoke adapters.
pub fn project_runtime_credential(
    stored: SecretValue,
) -> Result<SecretValue, ConnectorCredentialServiceError> {
    oauth_credential_part(stored, OAuthCredentialPart::Runtime)
}

#[derive(Clone, Copy)]
enum OAuthCredentialPart {
    Runtime,
    Lifecycle,
}

fn encode_oauth_credential(
    runtime_secret: SecretValue,
    lifecycle_secret: SecretValue,
) -> Result<SecretValue, ConnectorCredentialServiceError> {
    let runtime_len = u32::try_from(runtime_secret.expose().len()).map_err(|_| {
        ConnectorCredentialServiceError::new(
            ConnectorCredentialServiceErrorKind::InvalidValue,
            "OAuth runtime credential is too large",
        )
    })?;
    let mut encoded = Vec::with_capacity(
        OAUTH_CREDENTIAL_MAGIC.len()
            + std::mem::size_of::<u32>()
            + runtime_secret.expose().len()
            + lifecycle_secret.expose().len(),
    );
    encoded.extend_from_slice(OAUTH_CREDENTIAL_MAGIC);
    encoded.extend_from_slice(&runtime_len.to_be_bytes());
    encoded.extend_from_slice(runtime_secret.expose());
    encoded.extend_from_slice(lifecycle_secret.expose());
    Ok(SecretValue::new(encoded))
}

fn oauth_credential_part(
    stored: SecretValue,
    part: OAuthCredentialPart,
) -> Result<SecretValue, ConnectorCredentialServiceError> {
    if !stored.expose().starts_with(OAUTH_CREDENTIAL_MAGIC) {
        return Ok(stored);
    }
    let length_start = OAUTH_CREDENTIAL_MAGIC.len();
    let length_end = length_start + std::mem::size_of::<u32>();
    let length = stored
        .expose()
        .get(length_start..length_end)
        .and_then(|bytes| <[u8; 4]>::try_from(bytes).ok())
        .map(u32::from_be_bytes)
        .and_then(|length| usize::try_from(length).ok())
        .ok_or_else(invalid_oauth_credential)?;
    let runtime_start = length_end;
    let runtime_end = runtime_start
        .checked_add(length)
        .filter(|end| *end <= stored.expose().len())
        .ok_or_else(invalid_oauth_credential)?;
    let bytes = match part {
        OAuthCredentialPart::Runtime => stored.expose().get(runtime_start..runtime_end),
        OAuthCredentialPart::Lifecycle => stored.expose().get(runtime_end..),
    }
    .filter(|bytes| !bytes.is_empty())
    .ok_or_else(invalid_oauth_credential)?;
    Ok(SecretValue::new(bytes.to_vec()))
}

fn invalid_oauth_credential() -> ConnectorCredentialServiceError {
    ConnectorCredentialServiceError::new(
        ConnectorCredentialServiceErrorKind::InvalidValue,
        "OAuth credential envelope is invalid",
    )
}

/// Stable classification for credential orchestration failures.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectorCredentialServiceErrorKind {
    Authority,
    CommandConflict,
    GenerationConflict,
    SecretStore,
    InvalidValue,
}

/// Sanitized Connector credential orchestration failure.
#[derive(Debug)]
pub struct ConnectorCredentialServiceError {
    kind: ConnectorCredentialServiceErrorKind,
    message: String,
}

impl ConnectorCredentialServiceError {
    fn new(kind: ConnectorCredentialServiceErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn kind(&self) -> ConnectorCredentialServiceErrorKind {
        self.kind
    }
}

impl fmt::Display for ConnectorCredentialServiceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ConnectorCredentialServiceError {}

impl From<ConnectorAuthorityError> for ConnectorCredentialServiceError {
    fn from(error: ConnectorAuthorityError) -> Self {
        let kind = match error.kind() {
            crate::ConnectorAuthorityErrorKind::CommandConflict => {
                ConnectorCredentialServiceErrorKind::CommandConflict
            }
            crate::ConnectorAuthorityErrorKind::GenerationConflict => {
                ConnectorCredentialServiceErrorKind::GenerationConflict
            }
            crate::ConnectorAuthorityErrorKind::InvalidCommand
            | crate::ConnectorAuthorityErrorKind::Domain
            | crate::ConnectorAuthorityErrorKind::Persistence => {
                ConnectorCredentialServiceErrorKind::Authority
            }
        };
        Self::new(kind, error.to_string())
    }
}

impl From<SecretStoreError> for ConnectorCredentialServiceError {
    fn from(error: SecretStoreError) -> Self {
        Self::new(
            ConnectorCredentialServiceErrorKind::SecretStore,
            error.to_string(),
        )
    }
}

impl From<ConnectorError> for ConnectorCredentialServiceError {
    fn from(error: ConnectorError) -> Self {
        Self::new(
            ConnectorCredentialServiceErrorKind::InvalidValue,
            error.to_string(),
        )
    }
}

pub(crate) fn phase_command_id(
    parent: &ConnectorCommandId,
    phase: &str,
) -> Result<ConnectorCommandId, ConnectorCredentialServiceError> {
    let mut digest = Sha256::new();
    digest.update(AUTH_COMMAND_DOMAIN);
    digest.update((parent.as_str().len() as u64).to_be_bytes());
    digest.update(parent.as_str().as_bytes());
    digest.update(phase.as_bytes());
    ConnectorCommandId::new(format!(
        "connector-auth-{phase}-{}",
        hex_digest(digest.finalize())
    ))
    .map_err(Into::into)
}

pub(crate) fn credential_key(
    connector_id: &ConnectorId,
) -> Result<SecretKey, ConnectorCredentialServiceError> {
    let mut digest = Sha256::new();
    digest.update(CREDENTIAL_KEY_DOMAIN);
    digest.update((connector_id.as_str().len() as u64).to_be_bytes());
    digest.update(connector_id.as_str().as_bytes());
    SecretKey::new(format!("connector/{}", hex_digest(digest.finalize()))).map_err(|error| {
        ConnectorCredentialServiceError::new(
            ConnectorCredentialServiceErrorKind::InvalidValue,
            error.to_string(),
        )
    })
}

fn hex_digest(bytes: impl IntoIterator<Item = u8>) -> String {
    let mut value = String::with_capacity(64);
    for byte in bytes {
        write!(value, "{byte:02x}").expect("writing to a String cannot fail");
    }
    value
}

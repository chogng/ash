use std::fmt;
use std::fmt::Write;

use crate::ConnectorAccount;
use crate::ConnectorConnectionGeneration;
use crate::ConnectorId;
use crate::ConnectorSnapshotGeneration;
use sha2::Digest;
use sha2::Sha256;

const MAX_COMMAND_ID_BYTES: usize = 256;
const COMMAND_DIGEST_DOMAIN: &[u8] = b"ash-connector-command-v1\0";

/// Retry identity for one Connector authority mutation.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct ConnectorCommandId(String);

impl ConnectorCommandId {
    pub fn new(value: impl Into<String>) -> Result<Self, ConnectorAuthorityError> {
        let value = value.into();
        if value.is_empty()
            || value.trim() != value
            || value.len() > MAX_COMMAND_ID_BYTES
            || value.chars().any(char::is_control)
        {
            return Err(ConnectorAuthorityError::new(
                ConnectorAuthorityErrorKind::InvalidCommand,
                "connector command ID must be bounded non-empty plain text",
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Typed mutation accepted by the durable Connector authority.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConnectorAuthorityCommand {
    BeginConnect {
        generation: ConnectorConnectionGeneration,
    },
    CompleteConnect {
        account: ConnectorAccount,
    },
    MarkUnavailable {
        generation: ConnectorConnectionGeneration,
        reason: String,
    },
    Disconnect {
        generation: ConnectorConnectionGeneration,
    },
}

/// Retry-safe Connector authority request at one exact observed snapshot generation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectorCommandRequest {
    pub command_id: ConnectorCommandId,
    pub expected_generation: ConnectorSnapshotGeneration,
    pub connector_id: ConnectorId,
    pub command: ConnectorAuthorityCommand,
}

/// Whether an authority command committed a new snapshot or replayed its exact receipt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectorCommandDisposition {
    Updated,
    Replayed,
}

/// Result of one committed or exactly replayed Connector command.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ConnectorCommandResult {
    pub generation: ConnectorSnapshotGeneration,
    pub disposition: ConnectorCommandDisposition,
}

/// Stable classification for Connector authority failures.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConnectorAuthorityErrorKind {
    InvalidCommand,
    CommandConflict,
    GenerationConflict,
    Domain,
    Persistence,
}

/// Sanitized failure returned by Connector authority commands and persistence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectorAuthorityError {
    kind: ConnectorAuthorityErrorKind,
    message: String,
}

impl ConnectorAuthorityError {
    pub(crate) fn new(kind: ConnectorAuthorityErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn kind(&self) -> ConnectorAuthorityErrorKind {
        self.kind
    }
}

impl fmt::Display for ConnectorAuthorityError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ConnectorAuthorityError {}

pub(crate) fn command_digest(request: &ConnectorCommandRequest) -> String {
    let mut digest = Sha256::new();
    digest.update(COMMAND_DIGEST_DOMAIN);
    update_field(&mut digest, request.connector_id.as_str());
    match &request.command {
        ConnectorAuthorityCommand::BeginConnect { generation } => {
            update_field(&mut digest, "begin");
            update_field(&mut digest, &generation.get().to_string());
        }
        ConnectorAuthorityCommand::CompleteConnect { account } => {
            update_field(&mut digest, "complete");
            update_field(&mut digest, account.account_id().as_str());
            update_field(&mut digest, account.display_name());
            update_field(&mut digest, account.credential_reference().as_str());
            update_field(
                &mut digest,
                &account.connection_generation().get().to_string(),
            );
        }
        ConnectorAuthorityCommand::MarkUnavailable { generation, reason } => {
            update_field(&mut digest, "unavailable");
            update_field(&mut digest, &generation.get().to_string());
            update_field(&mut digest, reason);
        }
        ConnectorAuthorityCommand::Disconnect { generation } => {
            update_field(&mut digest, "disconnect");
            update_field(&mut digest, &generation.get().to_string());
        }
    }
    let mut value = String::with_capacity(64);
    for byte in digest.finalize() {
        write!(value, "{byte:02x}").expect("writing to a String cannot fail");
    }
    value
}

fn update_field(digest: &mut Sha256, value: &str) {
    digest.update((value.len() as u64).to_be_bytes());
    digest.update(value.as_bytes());
}

use crate::ConnectorAccountId;
use crate::ConnectorConnectionGeneration;
use crate::ConnectorCredentialRef;
use crate::ConnectorDefinitionDigest;
use crate::ConnectorError;
use crate::ConnectorErrorKind;
use crate::definition::validate_text;

const MAX_ACCOUNT_DISPLAY_NAME_BYTES: usize = 4 * 1024;
const MAX_UNAVAILABLE_REASON_BYTES: usize = 4 * 1024;

/// Non-secret projection of one connected external product account.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectorAccount {
    account_id: ConnectorAccountId,
    display_name: String,
    credential_reference: ConnectorCredentialRef,
    connection_generation: ConnectorConnectionGeneration,
}

impl ConnectorAccount {
    pub fn new(
        account_id: ConnectorAccountId,
        display_name: impl Into<String>,
        credential_reference: ConnectorCredentialRef,
        connection_generation: ConnectorConnectionGeneration,
    ) -> Result<Self, ConnectorError> {
        let display_name = display_name.into();
        validate_text(
            "connector account display name",
            &display_name,
            MAX_ACCOUNT_DISPLAY_NAME_BYTES,
        )?;
        Ok(Self {
            account_id,
            display_name,
            credential_reference,
            connection_generation,
        })
    }

    pub fn account_id(&self) -> &ConnectorAccountId {
        &self.account_id
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    pub fn credential_reference(&self) -> &ConnectorCredentialRef {
        &self.credential_reference
    }

    pub fn connection_generation(&self) -> ConnectorConnectionGeneration {
        self.connection_generation
    }
}

/// Current lifecycle state of one Connector account connection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConnectorConnectionState {
    Disconnected,
    Connecting,
    Connected(ConnectorAccount),
    Unavailable {
        reason: String,
    },
    ReauthorizationRequired {
        account: ConnectorAccount,
        previous_definition: ConnectorDefinitionDigest,
    },
}

/// One validated connection lifecycle value and its monotonic generation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectorConnection {
    generation: ConnectorConnectionGeneration,
    state: ConnectorConnectionState,
}

impl ConnectorConnection {
    pub fn disconnected() -> Self {
        Self {
            generation: ConnectorConnectionGeneration::INITIAL,
            state: ConnectorConnectionState::Disconnected,
        }
    }

    pub fn generation(&self) -> ConnectorConnectionGeneration {
        self.generation
    }

    pub fn state(&self) -> &ConnectorConnectionState {
        &self.state
    }

    /// Restores one previously validated durable connection projection.
    ///
    /// Persistence adapters must still construct every identity/account through its validated
    /// public constructor before calling this method.
    pub fn restore(
        generation: ConnectorConnectionGeneration,
        state: ConnectorConnectionState,
    ) -> Result<Self, ConnectorError> {
        match &state {
            ConnectorConnectionState::Disconnected => {}
            ConnectorConnectionState::Connecting | ConnectorConnectionState::Unavailable { .. } => {
                if generation == ConnectorConnectionGeneration::INITIAL {
                    return Err(invalid_transition(
                        "an active Connector state requires a non-initial connection generation",
                    ));
                }
            }
            ConnectorConnectionState::Connected(account)
            | ConnectorConnectionState::ReauthorizationRequired { account, .. } => {
                if generation == ConnectorConnectionGeneration::INITIAL
                    || account.connection_generation() != generation
                {
                    return Err(ConnectorError::new(
                        ConnectorErrorKind::StaleGeneration,
                        "restored Connector account does not match its connection generation",
                    ));
                }
            }
        }
        Ok(Self { generation, state })
    }

    pub(crate) fn apply(&self, update: ConnectorConnectionUpdate) -> Result<Self, ConnectorError> {
        match update {
            ConnectorConnectionUpdate::Begin { generation } => {
                self.require_newer_generation(generation)?;
                Ok(Self {
                    generation,
                    state: ConnectorConnectionState::Connecting,
                })
            }
            ConnectorConnectionUpdate::Connected { account } => {
                if !matches!(self.state, ConnectorConnectionState::Connecting) {
                    return Err(invalid_transition(
                        "a Connector can become connected only from the connecting state",
                    ));
                }
                if account.connection_generation() != self.generation {
                    return Err(ConnectorError::new(
                        ConnectorErrorKind::StaleGeneration,
                        "connected account generation does not match the active connection attempt",
                    ));
                }
                Ok(Self {
                    generation: self.generation,
                    state: ConnectorConnectionState::Connected(account),
                })
            }
            ConnectorConnectionUpdate::Disconnect { generation } => {
                self.require_newer_generation(generation)?;
                Ok(Self {
                    generation,
                    state: ConnectorConnectionState::Disconnected,
                })
            }
            ConnectorConnectionUpdate::Unavailable { generation, reason } => {
                if !matches!(
                    self.state,
                    ConnectorConnectionState::Connecting | ConnectorConnectionState::Connected(_)
                ) {
                    return Err(invalid_transition(
                        "only a connecting or connected Connector can become unavailable",
                    ));
                }
                if generation != self.generation {
                    return Err(ConnectorError::new(
                        ConnectorErrorKind::StaleGeneration,
                        "unavailable state generation does not match the active connection",
                    ));
                }
                validate_text(
                    "connector unavailable reason",
                    &reason,
                    MAX_UNAVAILABLE_REASON_BYTES,
                )?;
                Ok(Self {
                    generation,
                    state: ConnectorConnectionState::Unavailable { reason },
                })
            }
            ConnectorConnectionUpdate::DefinitionChanged {
                previous_definition,
            } => {
                let ConnectorConnectionState::Connected(account) = &self.state else {
                    return Err(invalid_transition(
                        "only a connected Connector can require reauthorization",
                    ));
                };
                Ok(Self {
                    generation: self.generation,
                    state: ConnectorConnectionState::ReauthorizationRequired {
                        account: account.clone(),
                        previous_definition,
                    },
                })
            }
        }
    }

    fn require_newer_generation(
        &self,
        generation: ConnectorConnectionGeneration,
    ) -> Result<(), ConnectorError> {
        if generation <= self.generation {
            return Err(ConnectorError::new(
                ConnectorErrorKind::StaleGeneration,
                "connector connection generation must advance monotonically",
            ));
        }
        Ok(())
    }
}

/// Requested lifecycle transition for one Connector connection.
///
/// Hosts must obtain credential material before publishing `Connected`; this value only carries a
/// non-secret reference. A consumer applies the update through `ConnectorSnapshot`, which also
/// advances the catalog generation atomically.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConnectorConnectionUpdate {
    Begin {
        generation: ConnectorConnectionGeneration,
    },
    Connected {
        account: ConnectorAccount,
    },
    Disconnect {
        generation: ConnectorConnectionGeneration,
    },
    Unavailable {
        generation: ConnectorConnectionGeneration,
        reason: String,
    },
    DefinitionChanged {
        previous_definition: ConnectorDefinitionDigest,
    },
}

fn invalid_transition(message: &'static str) -> ConnectorError {
    ConnectorError::new(ConnectorErrorKind::InvalidTransition, message)
}

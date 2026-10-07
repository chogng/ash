use crate::ConnectorConnection;
use crate::ConnectorConnectionState;
use crate::ConnectorConnectionUpdate;
use crate::ConnectorDefinition;
use crate::ConnectorError;
use crate::ConnectorErrorKind;
use crate::ConnectorId;
use crate::ConnectorSnapshotGeneration;

/// One Connector definition and its independently evolving account connection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectorEntry {
    definition: ConnectorDefinition,
    connection: ConnectorConnection,
}

impl ConnectorEntry {
    pub fn restore(definition: ConnectorDefinition, connection: ConnectorConnection) -> Self {
        Self {
            definition,
            connection,
        }
    }

    pub fn definition(&self) -> &ConnectorDefinition {
        &self.definition
    }

    pub fn connection(&self) -> &ConnectorConnection {
        &self.connection
    }

    pub fn is_ready(&self) -> bool {
        matches!(
            self.connection.state(),
            ConnectorConnectionState::Connected(_)
        )
    }
}

/// Immutable, generation-bound catalog of Connector definitions and connection state.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectorSnapshot {
    generation: ConnectorSnapshotGeneration,
    entries: Vec<ConnectorEntry>,
}

impl ConnectorSnapshot {
    pub fn new(
        generation: ConnectorSnapshotGeneration,
        definitions: impl IntoIterator<Item = ConnectorDefinition>,
    ) -> Result<Self, ConnectorError> {
        let mut entries = definitions
            .into_iter()
            .map(|definition| ConnectorEntry {
                definition,
                connection: ConnectorConnection::disconnected(),
            })
            .collect::<Vec<_>>();
        entries.sort_by(|left, right| left.definition.id().cmp(right.definition.id()));
        if entries
            .windows(2)
            .any(|window| window[0].definition.id() == window[1].definition.id())
        {
            return Err(ConnectorError::new(
                ConnectorErrorKind::DuplicateIdentity,
                "connector snapshot contains a duplicate connector ID",
            ));
        }
        Ok(Self {
            generation,
            entries,
        })
    }

    /// Restores a durable set of already validated definitions and connections.
    pub fn restore(
        generation: ConnectorSnapshotGeneration,
        mut entries: Vec<ConnectorEntry>,
    ) -> Result<Self, ConnectorError> {
        entries.sort_by(|left, right| left.definition.id().cmp(right.definition.id()));
        if entries
            .windows(2)
            .any(|window| window[0].definition.id() == window[1].definition.id())
        {
            return Err(ConnectorError::new(
                ConnectorErrorKind::DuplicateIdentity,
                "restored Connector snapshot contains a duplicate connector ID",
            ));
        }
        Ok(Self {
            generation,
            entries,
        })
    }

    pub fn generation(&self) -> ConnectorSnapshotGeneration {
        self.generation
    }

    pub fn entries(&self) -> &[ConnectorEntry] {
        &self.entries
    }

    pub fn entry(&self, id: &ConnectorId) -> Option<&ConnectorEntry> {
        self.entries
            .binary_search_by(|entry| entry.definition.id().cmp(id))
            .ok()
            .map(|index| &self.entries[index])
    }

    pub fn ready_entries(&self) -> impl Iterator<Item = &ConnectorEntry> {
        self.entries.iter().filter(|entry| entry.is_ready())
    }

    /// Applies one connection transition and publishes it under a newer snapshot generation.
    pub fn with_connection_update(
        &self,
        next_generation: ConnectorSnapshotGeneration,
        id: &ConnectorId,
        update: ConnectorConnectionUpdate,
    ) -> Result<Self, ConnectorError> {
        if next_generation <= self.generation {
            return Err(ConnectorError::new(
                ConnectorErrorKind::StaleGeneration,
                "connector snapshot generation must advance monotonically",
            ));
        }
        let mut next = self.clone();
        let entry = next
            .entries
            .iter_mut()
            .find(|entry| entry.definition.id() == id)
            .ok_or_else(|| {
                ConnectorError::new(
                    ConnectorErrorKind::MissingConnector,
                    "connector update targets an unknown connector ID",
                )
            })?;
        entry.connection = entry.connection.apply(update)?;
        next.generation = next_generation;
        Ok(next)
    }
}

use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::mpsc;
use std::time::Duration;

use crate::ConnectorConnection;
use crate::ConnectorConnectionState;
use crate::ConnectorConnectionUpdate;
use crate::ConnectorDefinition;
use crate::ConnectorDefinitionDigest;
use crate::ConnectorEntry;
use crate::ConnectorError;
use crate::ConnectorId;
use crate::ConnectorSnapshot;
use crate::ConnectorSnapshotGeneration;

use crate::ConnectorAuthorityCommand;
use crate::ConnectorAuthorityError;
use crate::ConnectorAuthorityErrorKind;
use crate::ConnectorCommandDisposition;
use crate::ConnectorCommandRequest;
use crate::ConnectorCommandResult;
use crate::command::command_digest;

mod sqlite;

use sqlite::SqliteAuthority;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct CommandReceipt {
    pub expected_generation: ConnectorSnapshotGeneration,
    pub connector_id: ConnectorId,
    pub command_digest: String,
    pub result_generation: ConnectorSnapshotGeneration,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum AuthorityEvent {
    Begin {
        connector_id: ConnectorId,
        generation: crate::ConnectorConnectionGeneration,
        definition_digest: ConnectorDefinitionDigest,
    },
    Complete {
        connector_id: ConnectorId,
        account: crate::ConnectorAccount,
        definition_digest: ConnectorDefinitionDigest,
    },
    Unavailable {
        connector_id: ConnectorId,
        generation: crate::ConnectorConnectionGeneration,
        reason: String,
    },
    Disconnect {
        connector_id: ConnectorId,
        generation: crate::ConnectorConnectionGeneration,
    },
}

impl AuthorityEvent {
    pub(super) fn connector_id(&self) -> &ConnectorId {
        match self {
            Self::Begin { connector_id, .. }
            | Self::Complete { connector_id, .. }
            | Self::Unavailable { connector_id, .. }
            | Self::Disconnect { connector_id, .. } => connector_id,
        }
    }
}

struct AuthorityState {
    snapshot: ConnectorSnapshot,
    receipts: BTreeMap<String, CommandReceipt>,
    retired_entries: BTreeMap<ConnectorId, ConnectorEntry>,
    in_flight: BTreeMap<InvocationKey, usize>,
    credential_cleanup_pending: BTreeSet<ConnectorId>,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct InvocationKey {
    connector_id: ConnectorId,
    connection_generation: crate::ConnectorConnectionGeneration,
    definition_digest: ConnectorDefinitionDigest,
}

enum Persistence {
    Memory,
    Sqlite(SqliteAuthority),
}

impl Persistence {
    fn persist(
        &self,
        event: &AuthorityEvent,
        result_generation: ConnectorSnapshotGeneration,
        command_id: &str,
        receipt: &CommandReceipt,
    ) -> Result<(), ConnectorAuthorityError> {
        match self {
            Self::Memory => Ok(()),
            Self::Sqlite(sqlite) => sqlite.persist(event, result_generation, command_id, receipt),
        }
    }

    fn persist_generation(
        &self,
        generation: ConnectorSnapshotGeneration,
    ) -> Result<(), ConnectorAuthorityError> {
        match self {
            Self::Memory => Ok(()),
            Self::Sqlite(sqlite) => sqlite.persist_generation(generation),
        }
    }

    fn restore_connections(
        &self,
        definitions: &[ConnectorDefinition],
    ) -> Result<BTreeMap<ConnectorId, ConnectorConnection>, ConnectorAuthorityError> {
        match self {
            Self::Memory => Ok(BTreeMap::new()),
            Self::Sqlite(sqlite) => sqlite.restore_connections(definitions),
        }
    }

    fn clear_credential_cleanup(
        &self,
        connector_id: &ConnectorId,
    ) -> Result<(), ConnectorAuthorityError> {
        match self {
            Self::Memory => Ok(()),
            Self::Sqlite(sqlite) => sqlite.clear_credential_cleanup(connector_id),
        }
    }
}

struct ConnectorAuthorityInner {
    state: Mutex<AuthorityState>,
    drained: Condvar,
    persistence: Persistence,
    subscribers: Mutex<Vec<mpsc::Sender<ConnectorSnapshotGeneration>>>,
}

/// Durable authority for Connector connection state and retry-safe mutation receipts.
///
/// Definitions are supplied by validated sources. This authority persists account projections and
/// credential references, never credential bytes or live MCP state.
#[derive(Clone)]
pub struct ConnectorAuthority {
    inner: Arc<ConnectorAuthorityInner>,
}

impl ConnectorAuthority {
    pub fn in_memory(
        definitions: impl IntoIterator<Item = ConnectorDefinition>,
    ) -> Result<Self, ConnectorAuthorityError> {
        let snapshot = ConnectorSnapshot::new(ConnectorSnapshotGeneration::new(1), definitions)
            .map_err(domain_error)?;
        Ok(Self::from_parts(
            snapshot,
            BTreeMap::new(),
            BTreeSet::new(),
            Persistence::Memory,
        ))
    }

    pub fn open_sqlite(
        path: impl AsRef<Path>,
        definitions: impl IntoIterator<Item = ConnectorDefinition>,
    ) -> Result<Self, ConnectorAuthorityError> {
        let definitions = definitions.into_iter().collect::<Vec<_>>();
        let loaded = SqliteAuthority::open(path.as_ref(), definitions)?;
        Ok(Self::from_parts(
            loaded.snapshot,
            loaded.receipts,
            loaded.credential_cleanup_pending,
            Persistence::Sqlite(loaded.authority),
        ))
    }

    fn from_parts(
        snapshot: ConnectorSnapshot,
        receipts: BTreeMap<String, CommandReceipt>,
        credential_cleanup_pending: BTreeSet<ConnectorId>,
        persistence: Persistence,
    ) -> Self {
        Self {
            inner: Arc::new(ConnectorAuthorityInner {
                state: Mutex::new(AuthorityState {
                    snapshot,
                    receipts,
                    retired_entries: BTreeMap::new(),
                    in_flight: BTreeMap::new(),
                    credential_cleanup_pending,
                }),
                drained: Condvar::new(),
                persistence,
                subscribers: Mutex::new(Vec::new()),
            }),
        }
    }

    pub fn snapshot(&self) -> ConnectorSnapshot {
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .snapshot
            .clone()
    }

    pub fn subscribe(&self) -> ConnectorAuthoritySubscription {
        let (sender, receiver) = mpsc::channel();
        self.inner
            .subscribers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(sender);
        ConnectorAuthoritySubscription { receiver }
    }

    /// Returns whether a committed disconnect still owns a durable secret-deletion obligation.
    pub fn credential_cleanup_pending(&self, connector_id: &ConnectorId) -> bool {
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .credential_cleanup_pending
            .contains(connector_id)
    }

    pub(crate) fn complete_credential_cleanup(
        &self,
        connector_id: &ConnectorId,
    ) -> Result<(), ConnectorAuthorityError> {
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| persistence_error("connector authority lock poisoned"))?;
        if !state.credential_cleanup_pending.contains(connector_id) {
            return Ok(());
        }
        self.inner
            .persistence
            .clear_credential_cleanup(connector_id)?;
        state.credential_cleanup_pending.remove(connector_id);
        Ok(())
    }

    pub fn apply(
        &self,
        request: ConnectorCommandRequest,
    ) -> Result<ConnectorCommandResult, ConnectorAuthorityError> {
        let request_digest = command_digest(&request);
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| persistence_error("connector authority lock poisoned"))?;
        if let Some(receipt) = state.receipts.get(request.command_id.as_str()) {
            if receipt.expected_generation != request.expected_generation
                || receipt.connector_id != request.connector_id
                || receipt.command_digest != request_digest
            {
                return Err(ConnectorAuthorityError::new(
                    ConnectorAuthorityErrorKind::CommandConflict,
                    "connector command ID was already used for a different request",
                ));
            }
            return Ok(ConnectorCommandResult {
                generation: receipt.result_generation,
                disposition: ConnectorCommandDisposition::Replayed,
            });
        }
        if state.snapshot.generation() != request.expected_generation {
            return Err(ConnectorAuthorityError::new(
                ConnectorAuthorityErrorKind::GenerationConflict,
                format!(
                    "connector generation conflict: expected {}, actual {}",
                    request.expected_generation.get(),
                    state.snapshot.generation().get()
                ),
            ));
        }
        let result_generation = next_generation(state.snapshot.generation())?;
        let event = event_for_request(&state.snapshot, &request)?;
        let next_snapshot = apply_event(&state.snapshot, result_generation, &event)?;
        let drained = revoked_invocations(&state.snapshot, &next_snapshot);
        let receipt = CommandReceipt {
            expected_generation: request.expected_generation,
            connector_id: request.connector_id,
            command_digest: request_digest,
            result_generation,
        };
        self.inner.persistence.persist(
            &event,
            result_generation,
            request.command_id.as_str(),
            &receipt,
        )?;
        state
            .receipts
            .insert(request.command_id.as_str().to_string(), receipt);
        match &event {
            AuthorityEvent::Disconnect { connector_id, .. } => {
                state
                    .credential_cleanup_pending
                    .insert(connector_id.clone());
            }
            AuthorityEvent::Complete { connector_id, .. } => {
                state.credential_cleanup_pending.remove(connector_id);
            }
            AuthorityEvent::Begin { .. } | AuthorityEvent::Unavailable { .. } => {}
        }
        state.snapshot = next_snapshot;
        drop(state);
        self.publish(result_generation);
        self.wait_for_drain(&drained)?;
        Ok(ConnectorCommandResult {
            generation: result_generation,
            disposition: ConnectorCommandDisposition::Updated,
        })
    }

    /// Replaces the active Connector definition catalog while retaining durable account state.
    ///
    /// Removed definitions disappear from new snapshots without deleting their credential or
    /// connection records. Reintroduced exact definitions recover those records; changed
    /// definitions require reauthorization before becoming ready again.
    pub fn reconcile_definitions(
        &self,
        definitions: impl IntoIterator<Item = ConnectorDefinition>,
    ) -> Result<ConnectorSnapshotGeneration, ConnectorAuthorityError> {
        let definitions = definitions.into_iter().collect::<Vec<_>>();
        let restored = self.inner.persistence.restore_connections(&definitions)?;
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| persistence_error("connector authority lock poisoned"))?;
        let mut retired_entries = state.retired_entries.clone();
        let mut current = state
            .snapshot
            .entries()
            .iter()
            .map(|entry| (entry.definition().id().clone(), entry.clone()))
            .collect::<BTreeMap<_, _>>();
        let mut entries = Vec::with_capacity(definitions.len());
        for definition in definitions {
            let connection = match current.remove(definition.id()) {
                Some(entry) => connection_for_definition(&entry, &definition)?,
                None => match retired_entries.remove(definition.id()) {
                    Some(entry) => connection_for_definition(&entry, &definition)?,
                    None => restored
                        .get(definition.id())
                        .cloned()
                        .unwrap_or_else(ConnectorConnection::disconnected),
                },
            };
            entries.push(ConnectorEntry::restore(definition, connection));
        }
        for (connector_id, entry) in current {
            retired_entries.insert(connector_id, entry);
        }
        let candidate = ConnectorSnapshot::restore(state.snapshot.generation(), entries)
            .map_err(domain_error)?;
        if candidate.entries() == state.snapshot.entries() {
            return Ok(state.snapshot.generation());
        }
        let generation = next_generation(state.snapshot.generation())?;
        let next = ConnectorSnapshot::restore(generation, candidate.entries().to_vec())
            .map_err(domain_error)?;
        let drained = revoked_invocations(&state.snapshot, &next);
        self.inner.persistence.persist_generation(generation)?;
        state.snapshot = next;
        state.retired_entries = retired_entries;
        drop(state);
        self.publish(generation);
        self.wait_for_drain(&drained)?;
        Ok(generation)
    }

    /// Checks the live generation and definition digest used by a prepared Connector tool call.
    pub fn authorizes(
        &self,
        connector_id: &ConnectorId,
        connection_generation: crate::ConnectorConnectionGeneration,
        definition_digest: &ConnectorDefinitionDigest,
    ) -> bool {
        let state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(entry) = state.snapshot.entry(connector_id) else {
            return false;
        };
        entry.definition().digest() == *definition_digest
            && entry.connection().generation() == connection_generation
            && matches!(
                entry.connection().state(),
                ConnectorConnectionState::Connected(_)
            )
    }

    /// Runs an invocation under an exact connection-generation lease.
    ///
    /// Admission is serialized with revocation, but the operation itself does not hold the global
    /// authority lock. A committed disconnect rejects future admissions and waits only for calls
    /// already leased against the revoked exact connection.
    pub fn with_authorized_invocation<T>(
        &self,
        connector_id: &ConnectorId,
        connection_generation: crate::ConnectorConnectionGeneration,
        definition_digest: &ConnectorDefinitionDigest,
        operation: impl FnOnce() -> T,
    ) -> Option<T> {
        let lease =
            self.acquire_invocation(connector_id, connection_generation, definition_digest)?;
        let result = operation();
        drop(lease);
        Some(result)
    }

    fn acquire_invocation(
        &self,
        connector_id: &ConnectorId,
        connection_generation: crate::ConnectorConnectionGeneration,
        definition_digest: &ConnectorDefinitionDigest,
    ) -> Option<ConnectorInvocationLease> {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let entry = state.snapshot.entry(connector_id)?;
        if entry.definition().digest() != *definition_digest
            || entry.connection().generation() != connection_generation
            || !matches!(
                entry.connection().state(),
                ConnectorConnectionState::Connected(_)
            )
        {
            return None;
        }
        let key = InvocationKey {
            connector_id: connector_id.clone(),
            connection_generation,
            definition_digest: definition_digest.clone(),
        };
        *state.in_flight.entry(key.clone()).or_default() += 1;
        Some(ConnectorInvocationLease {
            authority: self.clone(),
            key: Some(key),
        })
    }

    fn release_invocation(&self, key: &InvocationKey) {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let remove = state.in_flight.get_mut(key).is_some_and(|count| {
            *count = count.saturating_sub(1);
            *count == 0
        });
        if remove {
            state.in_flight.remove(key);
            self.inner.drained.notify_all();
        }
    }

    fn wait_for_drain(&self, keys: &[InvocationKey]) -> Result<(), ConnectorAuthorityError> {
        if keys.is_empty() {
            return Ok(());
        }
        let mut state = self
            .inner
            .state
            .lock()
            .map_err(|_| persistence_error("connector authority lock poisoned"))?;
        while keys
            .iter()
            .any(|key| state.in_flight.get(key).copied().unwrap_or_default() != 0)
        {
            state = self
                .inner
                .drained
                .wait(state)
                .map_err(|_| persistence_error("connector invocation drain unavailable"))?;
        }
        Ok(())
    }

    fn publish(&self, generation: ConnectorSnapshotGeneration) {
        self.inner
            .subscribers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain(|subscriber| subscriber.send(generation).is_ok());
    }
}

struct ConnectorInvocationLease {
    authority: ConnectorAuthority,
    key: Option<InvocationKey>,
}

impl Drop for ConnectorInvocationLease {
    fn drop(&mut self) {
        if let Some(key) = self.key.take() {
            self.authority.release_invocation(&key);
        }
    }
}

fn revoked_invocations(
    previous: &ConnectorSnapshot,
    next: &ConnectorSnapshot,
) -> Vec<InvocationKey> {
    previous
        .ready_entries()
        .filter(|entry| {
            next.entry(entry.definition().id())
                .is_none_or(|next_entry| {
                    next_entry.definition().digest() != entry.definition().digest()
                        || next_entry.connection().generation() != entry.connection().generation()
                        || !matches!(
                            next_entry.connection().state(),
                            ConnectorConnectionState::Connected(_)
                        )
                })
        })
        .map(|entry| InvocationKey {
            connector_id: entry.definition().id().clone(),
            connection_generation: entry.connection().generation(),
            definition_digest: entry.definition().digest(),
        })
        .collect()
}

fn connection_for_definition(
    entry: &ConnectorEntry,
    definition: &ConnectorDefinition,
) -> Result<ConnectorConnection, ConnectorAuthorityError> {
    if entry.definition().digest() == definition.digest() {
        return Ok(entry.connection().clone());
    }
    let generation = entry.connection().generation();
    let state = match entry.connection().state() {
        ConnectorConnectionState::Connected(account)
        | ConnectorConnectionState::ReauthorizationRequired { account, .. } => {
            ConnectorConnectionState::ReauthorizationRequired {
                account: account.clone(),
                previous_definition: entry.definition().digest(),
            }
        }
        ConnectorConnectionState::Disconnected
        | ConnectorConnectionState::Connecting
        | ConnectorConnectionState::Unavailable { .. } => ConnectorConnectionState::Disconnected,
    };
    ConnectorConnection::restore(generation, state).map_err(domain_error)
}

/// Blocking subscription to committed Connector authority generations.
pub struct ConnectorAuthoritySubscription {
    receiver: mpsc::Receiver<ConnectorSnapshotGeneration>,
}

impl ConnectorAuthoritySubscription {
    pub fn try_recv(&self) -> Result<ConnectorSnapshotGeneration, mpsc::TryRecvError> {
        self.receiver.try_recv()
    }

    pub fn recv_timeout(
        &self,
        timeout: Duration,
    ) -> Result<ConnectorSnapshotGeneration, mpsc::RecvTimeoutError> {
        self.receiver.recv_timeout(timeout)
    }
}

pub(super) fn event_for_request(
    snapshot: &ConnectorSnapshot,
    request: &ConnectorCommandRequest,
) -> Result<AuthorityEvent, ConnectorAuthorityError> {
    let entry = snapshot.entry(&request.connector_id).ok_or_else(|| {
        ConnectorAuthorityError::new(
            ConnectorAuthorityErrorKind::InvalidCommand,
            "connector command targets an unavailable connector",
        )
    })?;
    Ok(match &request.command {
        ConnectorAuthorityCommand::BeginConnect { generation } => AuthorityEvent::Begin {
            connector_id: request.connector_id.clone(),
            generation: *generation,
            definition_digest: entry.definition().digest(),
        },
        ConnectorAuthorityCommand::CompleteConnect { account } => AuthorityEvent::Complete {
            connector_id: request.connector_id.clone(),
            account: account.clone(),
            definition_digest: entry.definition().digest(),
        },
        ConnectorAuthorityCommand::MarkUnavailable { generation, reason } => {
            AuthorityEvent::Unavailable {
                connector_id: request.connector_id.clone(),
                generation: *generation,
                reason: reason.clone(),
            }
        }
        ConnectorAuthorityCommand::Disconnect { generation } => AuthorityEvent::Disconnect {
            connector_id: request.connector_id.clone(),
            generation: *generation,
        },
    })
}

pub(super) fn apply_event(
    snapshot: &ConnectorSnapshot,
    result_generation: ConnectorSnapshotGeneration,
    event: &AuthorityEvent,
) -> Result<ConnectorSnapshot, ConnectorAuthorityError> {
    let update = match event {
        AuthorityEvent::Begin { generation, .. } => ConnectorConnectionUpdate::Begin {
            generation: *generation,
        },
        AuthorityEvent::Complete { account, .. } => ConnectorConnectionUpdate::Connected {
            account: account.clone(),
        },
        AuthorityEvent::Unavailable {
            generation, reason, ..
        } => ConnectorConnectionUpdate::Unavailable {
            generation: *generation,
            reason: reason.clone(),
        },
        AuthorityEvent::Disconnect { generation, .. } => ConnectorConnectionUpdate::Disconnect {
            generation: *generation,
        },
    };
    snapshot
        .with_connection_update(result_generation, event.connector_id(), update)
        .map_err(domain_error)
}

fn next_generation(
    generation: ConnectorSnapshotGeneration,
) -> Result<ConnectorSnapshotGeneration, ConnectorAuthorityError> {
    generation
        .get()
        .checked_add(1)
        .map(ConnectorSnapshotGeneration::new)
        .ok_or_else(|| persistence_error("connector snapshot generation exhausted"))
}

pub(super) fn domain_error(error: ConnectorError) -> ConnectorAuthorityError {
    ConnectorAuthorityError::new(ConnectorAuthorityErrorKind::Domain, error.to_string())
}

pub(super) fn persistence_error(message: impl Into<String>) -> ConnectorAuthorityError {
    ConnectorAuthorityError::new(ConnectorAuthorityErrorKind::Persistence, message)
}

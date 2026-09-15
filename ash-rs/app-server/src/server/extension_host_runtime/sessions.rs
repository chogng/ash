use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use ash_editor_extension_host::CancelReason;
use ash_editor_extension_host::ExtensionHostError;
use ash_editor_extension_host::ExtensionInvocationHandle;
use ash_editor_extension_host::InvokeResult;
use serde_json::Value;

use super::ExtensionHostInvocationCancelDisposition;
use super::ExtensionHostInvocationRead;
use super::ExtensionHostRuntimeError;
use super::projection::ExtensionHostFailureKind;
use super::projection::runtime_failure;

const TERMINAL_SESSION_TTL: Duration = Duration::from_secs(60);

pub(super) struct InvocationSessionStore {
    sessions: BTreeMap<String, InvocationSession>,
    owner_counts: BTreeMap<u64, usize>,
    maximum_global: usize,
    maximum_per_owner: usize,
}

struct InvocationSession {
    owner: u64,
    incarnation: u64,
    handle: Option<Arc<ExtensionInvocationHandle>>,
    terminal: Option<InvocationTerminal>,
    terminal_at: Option<Instant>,
    detached: bool,
    cancellation: Option<CancelReason>,
}

enum InvocationTerminal {
    Succeeded(Value),
    Failed(super::projection::ExtensionHostRuntimeFailure),
    Cancelled(CancelReason),
}

impl InvocationSessionStore {
    pub(super) fn new(maximum_global: usize, maximum_per_owner: usize) -> Self {
        Self {
            sessions: BTreeMap::new(),
            owner_counts: BTreeMap::new(),
            maximum_global,
            maximum_per_owner,
        }
    }

    pub(super) fn reserve(
        &mut self,
        id: String,
        owner: u64,
        incarnation: u64,
    ) -> Result<(), ExtensionHostRuntimeError> {
        self.sweep_expired(Instant::now());
        if self.sessions.len() >= self.maximum_global
            || self.owner_counts.get(&owner).copied().unwrap_or_default() >= self.maximum_per_owner
        {
            return Err(ExtensionHostRuntimeError::QuotaExceeded);
        }
        if self.sessions.contains_key(&id) {
            return Err(ExtensionHostRuntimeError::Internal);
        }
        self.sessions.insert(
            id,
            InvocationSession {
                owner,
                incarnation,
                handle: None,
                terminal: None,
                terminal_at: None,
                detached: false,
                cancellation: None,
            },
        );
        *self.owner_counts.entry(owner).or_default() += 1;
        Ok(())
    }

    pub(super) fn install(
        &mut self,
        id: &str,
        handle: Arc<ExtensionInvocationHandle>,
    ) -> Result<(), ExtensionHostRuntimeError> {
        let session = self
            .sessions
            .get_mut(id)
            .ok_or(ExtensionHostRuntimeError::Internal)?;
        if session.handle.replace(handle).is_some() {
            return Err(ExtensionHostRuntimeError::Internal);
        }
        Ok(())
    }

    pub(super) fn release(&mut self, id: &str) {
        let Some(session) = self.sessions.remove(id) else {
            return;
        };
        self.decrement_owner(session.owner);
    }

    pub(super) fn complete(&mut self, id: &str, result: Result<InvokeResult, ExtensionHostError>) {
        let Some(session) = self.sessions.get_mut(id) else {
            return;
        };
        if session.detached {
            let owner = session.owner;
            self.sessions.remove(id);
            self.decrement_owner(owner);
            return;
        }
        let terminal = match result {
            Ok(result) => InvocationTerminal::Succeeded(result.payload),
            Err(error) => {
                let failure = runtime_failure(&error, Some(session.incarnation));
                if failure.code == ExtensionHostFailureKind::Cancelled {
                    InvocationTerminal::Cancelled(
                        session.cancellation.unwrap_or(CancelReason::Caller),
                    )
                } else {
                    InvocationTerminal::Failed(failure)
                }
            }
        };
        session.terminal = Some(terminal);
        session.terminal_at = Some(Instant::now());
        session.handle = None;
    }

    pub(super) fn read(
        &mut self,
        owner: u64,
        id: &str,
    ) -> Result<ExtensionHostInvocationRead, ExtensionHostRuntimeError> {
        let session = self
            .sessions
            .get_mut(id)
            .filter(|session| session.owner == owner && !session.detached)
            .ok_or(ExtensionHostRuntimeError::InvocationNotFound)?;
        let Some(terminal) = session.terminal.take() else {
            return Ok(ExtensionHostInvocationRead::Pending);
        };
        let owner = session.owner;
        self.sessions.remove(id);
        self.decrement_owner(owner);
        Ok(match terminal {
            InvocationTerminal::Succeeded(payload) => {
                ExtensionHostInvocationRead::Succeeded(payload)
            }
            InvocationTerminal::Failed(failure) => ExtensionHostInvocationRead::Failed(failure),
            InvocationTerminal::Cancelled(reason) => ExtensionHostInvocationRead::Cancelled(reason),
        })
    }

    pub(super) fn cancel(
        &mut self,
        owner: u64,
        id: &str,
        reason: CancelReason,
    ) -> Result<ExtensionHostInvocationCancelDisposition, ExtensionHostRuntimeError> {
        let session = self
            .sessions
            .get_mut(id)
            .filter(|session| session.owner == owner && !session.detached)
            .ok_or(ExtensionHostRuntimeError::InvocationNotFound)?;
        if session.terminal.is_some() {
            return Ok(ExtensionHostInvocationCancelDisposition::AlreadyTerminal);
        }
        let handle = session
            .handle
            .clone()
            .ok_or(ExtensionHostRuntimeError::Internal)?;
        handle
            .cancel(reason)
            .map_err(ExtensionHostRuntimeError::Host)?;
        session.cancellation = Some(reason);
        Ok(ExtensionHostInvocationCancelDisposition::Requested)
    }

    pub(super) fn detach_owner(
        &mut self,
        owner: u64,
        reason: CancelReason,
    ) -> Vec<Arc<ExtensionInvocationHandle>> {
        self.detach_where(reason, |session| session.owner == owner)
    }

    pub(super) fn detach_all(
        &mut self,
        reason: CancelReason,
    ) -> Vec<Arc<ExtensionInvocationHandle>> {
        self.detach_where(reason, |_| true)
    }

    fn detach_where(
        &mut self,
        reason: CancelReason,
        predicate: impl Fn(&InvocationSession) -> bool,
    ) -> Vec<Arc<ExtensionInvocationHandle>> {
        let mut handles = Vec::new();
        let ids = self
            .sessions
            .iter()
            .filter_map(|(id, session)| predicate(session).then_some(id.clone()))
            .collect::<Vec<_>>();
        for id in ids {
            let remove = match self.sessions.get_mut(&id) {
                Some(session) if session.handle.is_some() => {
                    session.detached = true;
                    session.cancellation = Some(reason);
                    handles.extend(session.handle.iter().cloned());
                    false
                }
                Some(_) => true,
                None => false,
            };
            if remove {
                self.release(&id);
            }
        }
        handles
    }

    pub(super) fn sweep_expired(&mut self, now: Instant) {
        let expired = self
            .sessions
            .iter()
            .filter_map(|(id, session)| {
                session
                    .terminal_at
                    .is_some_and(|completed| {
                        now.saturating_duration_since(completed) >= TERMINAL_SESSION_TTL
                    })
                    .then_some(id.clone())
            })
            .collect::<Vec<_>>();
        for id in expired {
            self.release(&id);
        }
    }

    fn decrement_owner(&mut self, owner: u64) {
        let remove = match self.owner_counts.get_mut(&owner) {
            Some(count) => {
                *count = count.saturating_sub(1);
                *count == 0
            }
            None => false,
        };
        if remove {
            self.owner_counts.remove(&owner);
        }
    }
}

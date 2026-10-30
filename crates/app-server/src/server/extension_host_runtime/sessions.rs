use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::num::NonZeroU64;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use ash_external_ext::CancelReason;
use ash_external_ext::ExtensionHostError;
use ash_external_ext::ExtensionHostStatus;
use ash_external_ext::ExtensionHostSupervisor;
use ash_external_ext::ExtensionInvocation;
use ash_external_ext::ExtensionInvocationHandle;
use ash_external_ext::ExtensionInvocationTarget;
use ash_external_ext::InvokeResult;
use ash_external_ext::RegistrationKind;
use serde_json::Value;

use super::ExtensionHostInvocationCancelDisposition;
use super::ExtensionHostInvocationRead;
use super::ExtensionHostRuntimeError;
use super::projection::ExtensionHostFailureKind;
use super::projection::runtime_failure;

const TERMINAL_SESSION_TTL: Duration = Duration::from_secs(60);

pub(in crate::server) enum ResultRetention {
    Retain,
    Discard,
}

pub(super) struct InvocationSessionStore {
    sessions: BTreeMap<String, InvocationSession>,
    owner_counts: BTreeMap<u64, usize>,
    maximum_global: usize,
    maximum_per_owner: usize,
}

struct InvocationSession {
    owner: u64,
    extension_id: String,
    incarnation: u64,
    handle: Option<Arc<ExtensionInvocationHandle>>,
    terminal: Option<InvocationTerminal>,
    terminal_at: Option<Instant>,
    detached: bool,
    cancellation: Option<CancelReason>,
    result_cleanup: Option<ProfileResultCleanup>,
}

/// Until successful first resource IO, this invocation owns its issued profile resource.
/// Discard and expiry release it through the same supervisor and immutable process fence.
pub(super) struct ProfileResultCleanup {
    supervisor: ExtensionHostSupervisor,
    target: ExtensionInvocationTarget,
}

impl ProfileResultCleanup {
    pub(super) fn new(
        supervisor: ExtensionHostSupervisor,
        target: ExtensionInvocationTarget,
    ) -> Self {
        Self { supervisor, target }
    }

    fn discard(&self, payload: &Value) {
        if let Some(resource) = ProfilePtyResource::parse(payload) {
            self.discard_resource(resource);
        }
    }

    fn discard_resource(&self, resource: ProfilePtyResource) {
        let ProfilePtyResource {
            registration_id,
            pty_id,
        } = resource;
        let supervisor = self.supervisor.clone();
        let target = self.target;
        // A session is often dropped under its store lock. Dispatch and wait outside
        // that lock because a registration event can re-enter the runtime session owner.
        if std::thread::Builder::new()
            .name("ash-terminal-profile-cleanup".into())
            .spawn(move || {
                let snapshot = supervisor.snapshot();
                if snapshot.status != ExtensionHostStatus::Ready
                    || snapshot.incarnation != target.incarnation.get()
                    || snapshot.activation_generation != target.activation_generation.get()
                    || !snapshot.registrations.iter().any(|entry| {
                        entry.registration_id == registration_id
                            && matches!(entry.kind, RegistrationKind::TerminalPty {})
                    })
                {
                    return;
                }
                let deadline = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_millis() as u64
                    + 5_000;
                // The existing fenced entry may recover a crashed host, but this close
                // can never be replayed into that replacement incarnation.
                let invocation = ExtensionInvocation {
                    registration_id,
                    operation: "closeTaskTerminal".into(),
                    payload: serde_json::json!({"ptyId": pty_id}),
                    deadline_unix_millis: NonZeroU64::new(deadline)
                        .expect("cleanup deadline is positive"),
                };
                if let Ok(handle) = supervisor.begin_fenced_invoke(target, invocation) {
                    let _ = handle.wait();
                }
            })
            .is_err()
        {
            log::warn!("failed to start discarded terminal profile cleanup");
        }
    }
}

struct ProfilePtyResource {
    registration_id: String,
    pty_id: String,
}

impl ProfilePtyResource {
    fn parse(payload: &Value) -> Option<Self> {
        let pty = payload.get("pty")?.as_object()?;
        let id = |field| {
            pty.get(field).and_then(Value::as_str).filter(|value| {
                !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control)
            })
        };
        Some(Self {
            registration_id: id("registrationId")?.to_owned(),
            pty_id: id("ptyId")?.to_owned(),
        })
    }
}

/// Moving a delivered lease out of the invocation map frees quota for its first IO.
/// A failed dispatch still drops and closes the lease; successful dispatch adopts it.
pub(super) struct ProfileResultLease(InvocationSession);
impl ProfileResultLease {
    pub(super) fn adopt(mut self) {
        self.0.result_cleanup = None;
    }
}

impl Drop for InvocationSession {
    fn drop(&mut self) {
        let Some(cleanup) = &self.result_cleanup else {
            return;
        };
        match &self.terminal {
            Some(InvocationTerminal::Succeeded(payload)) => cleanup.discard(payload),
            Some(InvocationTerminal::DeliveredProfileResource(resource)) => cleanup
                .discard_resource(ProfilePtyResource {
                    registration_id: resource.registration_id.clone(),
                    pty_id: resource.pty_id.clone(),
                }),
            None | Some(InvocationTerminal::Failed(_)) | Some(InvocationTerminal::Cancelled(_)) => {
            }
        }
    }
}

enum InvocationTerminal {
    Succeeded(Value),
    DeliveredProfileResource(ProfilePtyResource),
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
        extension_id: String,
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
                extension_id,
                incarnation,
                handle: None,
                terminal: None,
                terminal_at: None,
                detached: false,
                cancellation: None,
                result_cleanup: None,
            },
        );
        *self.owner_counts.entry(owner).or_default() += 1;
        Ok(())
    }

    pub(super) fn install(
        &mut self,
        id: &str,
        handle: Arc<ExtensionInvocationHandle>,
        result_cleanup: Option<ProfileResultCleanup>,
    ) -> Result<(), ExtensionHostRuntimeError> {
        let session = self
            .sessions
            .get_mut(id)
            .ok_or(ExtensionHostRuntimeError::Internal)?;
        if session.handle.replace(handle).is_some() {
            return Err(ExtensionHostRuntimeError::Internal);
        }
        session.result_cleanup = result_cleanup;
        Ok(())
    }

    #[cfg(test)]
    pub(super) fn is_completed(&self, id: &str) -> bool {
        self.sessions
            .get(id)
            .is_some_and(|session| session.terminal.is_some())
    }

    pub(super) fn take_profile_resource(
        &mut self,
        owner: u64,
        extension_id: &str,
        target: ExtensionInvocationTarget,
        registration_id: &str,
        pty_id: &str,
    ) -> Option<ProfileResultLease> {
        let id = self.sessions.iter().find_map(|(id, session)| {
            let cleanup = session.result_cleanup.as_ref()?;
            let InvocationTerminal::DeliveredProfileResource(resource) =
                session.terminal.as_ref()?
            else {
                return None;
            };
            (session.owner == owner
                && session.extension_id == extension_id
                && cleanup.target == target
                && resource.registration_id == registration_id
                && resource.pty_id == pty_id)
                .then(|| id.clone())
        })?;
        let session = self.sessions.remove(&id)?;
        self.decrement_owner(session.owner);
        Some(ProfileResultLease(session))
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
        let terminal = match result {
            Ok(result) => InvocationTerminal::Succeeded(result.payload),
            Err(error) => {
                let mut failure = runtime_failure(&error, Some(session.incarnation));
                if failure.code == ExtensionHostFailureKind::Cancelled {
                    InvocationTerminal::Cancelled(
                        session.cancellation.unwrap_or(CancelReason::Caller),
                    )
                } else {
                    // HostFailure carries the extension's validated, caller-facing message.
                    // Keep it for invocation errors; lifecycle and process diagnostics stay sanitized.
                    if let ExtensionHostError::HostRejected { message, .. } = error {
                        failure.message = message;
                    }
                    InvocationTerminal::Failed(failure)
                }
            }
        };
        session.terminal = Some(terminal);
        if session.detached {
            let owner = session.owner;
            self.sessions.remove(id);
            self.decrement_owner(owner);
            return;
        }
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
        let result = match terminal {
            InvocationTerminal::Succeeded(payload) => {
                if let Some(resource) = session
                    .result_cleanup
                    .as_ref()
                    .and_then(|_| ProfilePtyResource::parse(&payload))
                {
                    session.terminal = Some(InvocationTerminal::DeliveredProfileResource(resource));
                    return Ok(ExtensionHostInvocationRead::Succeeded(payload));
                }
                ExtensionHostInvocationRead::Succeeded(payload)
            }
            InvocationTerminal::DeliveredProfileResource(resource) => {
                session.terminal = Some(InvocationTerminal::DeliveredProfileResource(resource));
                return Err(ExtensionHostRuntimeError::InvocationNotFound);
            }
            InvocationTerminal::Failed(failure) => ExtensionHostInvocationRead::Failed(failure),
            InvocationTerminal::Cancelled(reason) => ExtensionHostInvocationRead::Cancelled(reason),
        };
        let owner = session.owner;
        self.sessions.remove(id);
        self.decrement_owner(owner);
        Ok(result)
    }

    pub(super) fn cancel(
        &mut self,
        owner: u64,
        id: &str,
        reason: CancelReason,
        retention: ResultRetention,
    ) -> Result<ExtensionHostInvocationCancelDisposition, ExtensionHostRuntimeError> {
        let session = self
            .sessions
            .get_mut(id)
            .filter(|session| session.owner == owner && !session.detached)
            .ok_or(ExtensionHostRuntimeError::InvocationNotFound)?;
        if session.terminal.is_some() {
            if matches!(retention, ResultRetention::Discard) {
                self.release(id);
            }
            return Ok(ExtensionHostInvocationCancelDisposition::AlreadyTerminal);
        }
        let handle = session
            .handle
            .clone()
            .ok_or(ExtensionHostRuntimeError::Internal)?;
        // Abandonment survives a failed cancellation write or an already-dead host.
        // The completion task still owns the in-flight quota until it actually ends.
        session.cancellation = Some(reason);
        session.detached = matches!(retention, ResultRetention::Discard);
        handle
            .cancel(reason)
            .map_err(ExtensionHostRuntimeError::Host)?;
        Ok(ExtensionHostInvocationCancelDisposition::Requested)
    }

    pub(super) fn detach_owner(
        &mut self,
        owner: u64,
        reason: CancelReason,
    ) -> Vec<Arc<ExtensionInvocationHandle>> {
        self.detach_where(reason, |session| session.owner == owner)
    }

    pub(super) fn detach_except(
        &mut self,
        retained: &BTreeSet<String>,
        reason: CancelReason,
    ) -> Vec<Arc<ExtensionInvocationHandle>> {
        self.detach_where(reason, |session| !retained.contains(&session.extension_id))
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

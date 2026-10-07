use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::thread;
use std::time::Instant;

use crate::ActivateResult;
use crate::ActivationLease;
use crate::ExtensionActivationSpec;
use crate::ExtensionHostError;
use crate::ExtensionHostLauncher;
use crate::ExtensionHostLimits;
use crate::ExtensionHostProcess;
use crate::ExtensionHostRequest;
use crate::ExtensionHostResponse;
use crate::ExtensionLaunchCommand;
use crate::HostRequestKind;
use crate::HostResponseKind;
use crate::HostSuccess;
use crate::InitializeParams;
use crate::PROTOCOL_VERSION;
use crate::PackageBinding;
use crate::PendingHostRequest;
use crate::RegistrationDescriptor;
use crate::RequestContext;
use crate::RestartDecision;
use crate::RestartPolicy;
use crate::RestartTracker;
use crate::SequencedExtensionHostOutputEvent;

mod invocation;

pub use invocation::ExtensionInvocation;
pub use invocation::ExtensionInvocationHandle;
pub use invocation::ExtensionInvocationTarget;

/// Observable lifecycle of one per-extension runtime process.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ExtensionHostStatus {
    Stopped,
    Starting,
    Ready,
    Recovering,
    CrashLoop,
}

/// Immutable state projection for App Server composition and diagnostics.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExtensionHostSnapshot {
    pub extension_id: String,
    pub runtime_api_version: u16,
    pub package: PackageBinding,
    pub status: ExtensionHostStatus,
    pub incarnation: u64,
    pub activation_generation: u64,
    pub registrations: Vec<RegistrationDescriptor>,
    pub stderr: String,
    pub output_events: Vec<SequencedExtensionHostOutputEvent>,
}

struct RetainedOutputEvent {
    event: SequencedExtensionHostOutputEvent,
    bytes: usize,
}

struct SupervisorState {
    status: ExtensionHostStatus,
    incarnation: u64,
    process: Option<Arc<dyn ExtensionHostProcess>>,
    process_lease: Option<Box<dyn ActivationLease>>,
    registrations: Vec<RegistrationDescriptor>,
    invocation_leases: BTreeMap<u64, Box<dyn ActivationLease>>,
    restart: RestartTracker,
    output_events: VecDeque<RetainedOutputEvent>,
    output_event_bytes: usize,
    next_output_event_sequence: u64,
}

struct SupervisorInner {
    launcher: Arc<dyn ExtensionHostLauncher>,
    command: ExtensionLaunchCommand,
    activation: ExtensionActivationSpec,
    limits: ExtensionHostLimits,
    state: Mutex<SupervisorState>,
    lifecycle: Mutex<()>,
    next_request_id: AtomicU64,
    started_at: Instant,
}

/// Supervises one authorized extension-owned executable speaking Ash Host RPC v1.
///
/// Each instance owns exactly one extension contribution and at most one live process incarnation.
/// It never loads JavaScript or other package code itself; the package executable implements the
/// narrow protocol directly. Crashed incarnations are fenced, restarted within policy, and then
/// re-handshaken and reactivated before their registrations become visible again.
#[derive(Clone)]
pub struct ExtensionHostSupervisor {
    inner: Arc<SupervisorInner>,
}

impl ExtensionHostSupervisor {
    pub fn new(
        launcher: Arc<dyn ExtensionHostLauncher>,
        command: ExtensionLaunchCommand,
        activation: ExtensionActivationSpec,
        limits: ExtensionHostLimits,
        restart_policy: RestartPolicy,
    ) -> Result<Self, ExtensionHostError> {
        limits.validate()?;
        let restart = RestartTracker::new(restart_policy)?;
        Ok(Self {
            inner: Arc::new(SupervisorInner {
                launcher,
                command,
                activation,
                limits,
                state: Mutex::new(SupervisorState {
                    status: ExtensionHostStatus::Stopped,
                    incarnation: 0,
                    process: None,
                    process_lease: None,
                    registrations: Vec::new(),
                    invocation_leases: BTreeMap::new(),
                    restart,
                    output_events: VecDeque::new(),
                    output_event_bytes: 0,
                    next_output_event_sequence: 1,
                }),
                lifecycle: Mutex::new(()),
                next_request_id: AtomicU64::new(1),
                started_at: Instant::now(),
            }),
        })
    }

    pub fn start(&self) -> Result<ExtensionHostSnapshot, ExtensionHostError> {
        let _lifecycle = self
            .inner
            .lifecycle
            .lock()
            .map_err(|_| ExtensionHostError::HostExited)?;
        let (status, process) = {
            let state = self
                .inner
                .state
                .lock()
                .map_err(|_| ExtensionHostError::HostExited)?;
            (state.status, state.process.clone())
        };
        match status {
            ExtensionHostStatus::Ready
                if process
                    .as_ref()
                    .is_some_and(|process| !process.has_exited()) =>
            {
                return Ok(self.snapshot());
            }
            ExtensionHostStatus::Ready => {
                self.recover_locked()?;
                return Ok(self.snapshot());
            }
            ExtensionHostStatus::CrashLoop => return Err(ExtensionHostError::CrashLoop),
            ExtensionHostStatus::Stopped
            | ExtensionHostStatus::Starting
            | ExtensionHostStatus::Recovering => {}
        }
        match self.launch_and_activate() {
            Ok(()) => Ok(self.snapshot()),
            Err(error) if restartable(&error) => {
                self.recover_locked()?;
                Ok(self.snapshot())
            }
            Err(error) => Err(error),
        }
    }

    /// Reconciles an idle runtime that exited since its last request.
    ///
    /// App Server should call this from its runtime health loop. A deliberately stopped host stays
    /// stopped; a ready host whose process exited consumes restart budget and replays activation.
    pub fn reconcile(&self) -> Result<ExtensionHostSnapshot, ExtensionHostError> {
        let (status, incarnation, exited) = {
            let state = self
                .inner
                .state
                .lock()
                .map_err(|_| ExtensionHostError::HostExited)?;
            (
                state.status,
                state.incarnation,
                state
                    .process
                    .as_ref()
                    .is_some_and(|process| process.has_exited()),
            )
        };
        match status {
            ExtensionHostStatus::Ready if exited => {
                self.recover_failed_incarnation(incarnation)?;
            }
            ExtensionHostStatus::CrashLoop => return Err(ExtensionHostError::CrashLoop),
            ExtensionHostStatus::Stopped
            | ExtensionHostStatus::Starting
            | ExtensionHostStatus::Ready
            | ExtensionHostStatus::Recovering => {}
        }
        Ok(self.snapshot())
    }

    pub fn shutdown(&self) -> Result<(), ExtensionHostError> {
        let _lifecycle = self
            .inner
            .lifecycle
            .lock()
            .map_err(|_| ExtensionHostError::HostExited)?;
        let (process, incarnation) = {
            let mut state = self
                .inner
                .state
                .lock()
                .map_err(|_| ExtensionHostError::HostExited)?;
            state.status = ExtensionHostStatus::Stopped;
            state.registrations.clear();
            (state.process.clone(), state.incarnation)
        };
        let Some(process) = process else {
            let mut state = self
                .inner
                .state
                .lock()
                .map_err(|_| ExtensionHostError::HostExited)?;
            state.process_lease = None;
            state.invocation_leases.clear();
            return Ok(());
        };
        let deactivate = self.request(&process, incarnation, HostRequestKind::Deactivate);
        let _ = deactivate.and_then(|pending| {
            require_success(
                pending.recv_timeout(self.inner.limits.shutdown_timeout)?,
                |success| matches!(success, HostSuccess::Deactivated),
            )
            .map(|_| ())
        });
        let shutdown = self.request(&process, incarnation, HostRequestKind::Shutdown);
        let graceful = shutdown.and_then(|pending| {
            require_success(
                pending.recv_timeout(self.inner.limits.shutdown_timeout)?,
                |success| matches!(success, HostSuccess::Shutdown),
            )
            .map(|_| ())
        });
        terminate_confirmed(&process)?;
        {
            let mut state = self
                .inner
                .state
                .lock()
                .map_err(|_| ExtensionHostError::HostExited)?;
            if state.incarnation == incarnation {
                state.process = None;
                state.process_lease = None;
                state.invocation_leases.clear();
            }
        }
        graceful
    }

    pub fn snapshot(&self) -> ExtensionHostSnapshot {
        let mut state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let process = state.process.clone();
        if let Some(process) = &process {
            for event in process.drain_output_events() {
                if event.context.incarnation != state.incarnation
                    || event.context.activation_generation
                        != self.inner.activation.activation_generation().get()
                {
                    continue;
                }
                let bytes = serde_json::to_vec(&event).map_or(0, |encoded| encoded.len());
                let sequence = state.next_output_event_sequence;
                state.next_output_event_sequence = state
                    .next_output_event_sequence
                    .checked_add(1)
                    .unwrap_or(u64::MAX);
                state.output_event_bytes = state.output_event_bytes.saturating_add(bytes);
                state.output_events.push_back(RetainedOutputEvent {
                    event: SequencedExtensionHostOutputEvent { sequence, event },
                    bytes,
                });
                while state.output_events.len() > self.inner.limits.maximum_output_event_count
                    || state.output_event_bytes > self.inner.limits.maximum_output_bytes
                {
                    let Some(expired) = state.output_events.pop_front() else {
                        break;
                    };
                    state.output_event_bytes =
                        state.output_event_bytes.saturating_sub(expired.bytes);
                }
            }
        }
        ExtensionHostSnapshot {
            extension_id: self.inner.activation.params().extension_id.clone(),
            runtime_api_version: self.inner.activation.params().runtime_api_version,
            package: self.inner.activation.params().package.clone(),
            status: state.status,
            incarnation: state.incarnation,
            activation_generation: self.inner.activation.activation_generation().get(),
            registrations: state.registrations.clone(),
            stderr: process
                .as_ref()
                .map(|process| process.stderr())
                .unwrap_or_default(),
            output_events: state
                .output_events
                .iter()
                .map(|retained| retained.event.clone())
                .collect(),
        }
    }

    fn ensure_ready(&self) -> Result<(), ExtensionHostError> {
        let ready = self.ready_process();
        if ready.is_some_and(|process| !process.has_exited()) {
            return Ok(());
        }
        self.start().map(|_| ())
    }

    fn ready_process(&self) -> Option<Arc<dyn ExtensionHostProcess>> {
        let state = self.inner.state.lock().ok()?;
        (state.status == ExtensionHostStatus::Ready)
            .then(|| state.process.clone())
            .flatten()
    }

    fn launch_and_activate(&self) -> Result<(), ExtensionHostError> {
        let lease = self
            .inner
            .activation
            .acquire()
            .ok_or(ExtensionHostError::AuthorityDenied)?;
        let process = self
            .inner
            .launcher
            .spawn(&self.inner.command, &self.inner.limits)?;
        let incarnation = {
            let mut state = self
                .inner
                .state
                .lock()
                .map_err(|_| ExtensionHostError::HostExited)?;
            state.incarnation = state
                .incarnation
                .checked_add(1)
                .ok_or(ExtensionHostError::CrashLoop)?;
            state.status = ExtensionHostStatus::Starting;
            state.process = Some(Arc::clone(&process));
            state.registrations.clear();
            state.incarnation
        };
        let result = self.initialize_and_activate(&process, incarnation);
        match result {
            Ok(registrations) => {
                let mut state = self
                    .inner
                    .state
                    .lock()
                    .map_err(|_| ExtensionHostError::HostExited)?;
                if state.incarnation != incarnation {
                    terminate_confirmed(&process)?;
                    return Err(ExtensionHostError::HostRestarted);
                }
                state.status = ExtensionHostStatus::Ready;
                state.registrations = registrations;
                state.process_lease = Some(lease);
                state.restart.record_healthy();
                Ok(())
            }
            Err(error) => {
                let terminated = terminate_confirmed(&process);
                let mut state = self
                    .inner
                    .state
                    .lock()
                    .map_err(|_| ExtensionHostError::HostExited)?;
                if state.incarnation == incarnation {
                    state.status = ExtensionHostStatus::Stopped;
                    state.process = None;
                }
                drop(state);
                drop(lease);
                terminated.and(Err(error))
            }
        }
    }

    fn initialize_and_activate(
        &self,
        process: &Arc<dyn ExtensionHostProcess>,
        incarnation: u64,
    ) -> Result<Vec<RegistrationDescriptor>, ExtensionHostError> {
        let initialize = self.request(
            process,
            incarnation,
            HostRequestKind::Initialize(InitializeParams {
                extension_id: self.inner.activation.params().extension_id.clone(),
                runtime_api_version: self.inner.activation.params().runtime_api_version,
            }),
        )?;
        let response = initialize
            .recv_timeout(self.inner.limits.startup_timeout)?
            .ok_or(ExtensionHostError::StartupTimedOut)?;
        let initialized = require_success(Some(response), |success| {
            matches!(success, HostSuccess::Initialized(_))
        })?;
        let HostSuccess::Initialized(initialized) = initialized else {
            unreachable!();
        };
        if initialized.protocol_version != PROTOCOL_VERSION
            || initialized.runtime_api_version != self.inner.activation.params().runtime_api_version
        {
            return Err(ExtensionHostError::InvalidProtocol(
                "runtime handshake version does not match activation".into(),
            ));
        }
        let activate = self.request(
            process,
            incarnation,
            HostRequestKind::Activate(self.inner.activation.params().clone()),
        )?;
        let response = activate
            .recv_timeout(self.inner.limits.startup_timeout)?
            .ok_or(ExtensionHostError::StartupTimedOut)?;
        let activated = require_success(Some(response), |success| {
            matches!(success, HostSuccess::Activated(_))
        })?;
        let HostSuccess::Activated(ActivateResult { registrations }) = activated else {
            unreachable!();
        };
        Ok(registrations)
    }

    fn request(
        &self,
        process: &Arc<dyn ExtensionHostProcess>,
        incarnation: u64,
        request: HostRequestKind,
    ) -> Result<PendingHostRequest, ExtensionHostError> {
        let request = ExtensionHostRequest {
            context: self.context(incarnation)?,
            request,
        };
        let pending = process.dispatch(request)?;
        Ok(pending)
    }

    fn context(&self, incarnation: u64) -> Result<RequestContext, ExtensionHostError> {
        let request_id = self
            .inner
            .next_request_id
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |current| {
                (current != 0).then(|| current.checked_add(1)).flatten()
            })
            .map_err(|_| ExtensionHostError::RequestIdentityExhausted)?;
        Ok(RequestContext::new(
            request_id,
            incarnation,
            self.inner.activation.activation_generation().get(),
        ))
    }

    fn release_invocation(&self, request_id: u64) {
        if let Ok(mut state) = self.inner.state.lock() {
            state.invocation_leases.remove(&request_id);
        }
    }

    fn recover_failed_incarnation(&self, incarnation: u64) -> Result<(), ExtensionHostError> {
        let _lifecycle = self
            .inner
            .lifecycle
            .lock()
            .map_err(|_| ExtensionHostError::HostExited)?;
        if self
            .inner
            .state
            .lock()
            .map_err(|_| ExtensionHostError::HostExited)?
            .incarnation
            != incarnation
        {
            return Ok(());
        }
        self.recover_locked()
    }

    fn recover_locked(&self) -> Result<(), ExtensionHostError> {
        loop {
            let (process, incarnation, decision) = {
                let mut state = self
                    .inner
                    .state
                    .lock()
                    .map_err(|_| ExtensionHostError::HostExited)?;
                state.status = ExtensionHostStatus::Recovering;
                state.registrations.clear();
                let process = state.process.clone();
                let incarnation = state.incarnation;
                let decision = state
                    .restart
                    .record_failure(self.inner.started_at.elapsed());
                (process, incarnation, decision)
            };
            if let Some(process) = process {
                terminate_confirmed(&process)?;
                let mut state = self
                    .inner
                    .state
                    .lock()
                    .map_err(|_| ExtensionHostError::HostExited)?;
                if state.incarnation == incarnation {
                    state.process = None;
                    state.process_lease = None;
                    state.invocation_leases.clear();
                }
            }
            let RestartDecision::RestartAfter(delay) = decision else {
                self.inner
                    .state
                    .lock()
                    .map_err(|_| ExtensionHostError::HostExited)?
                    .status = ExtensionHostStatus::CrashLoop;
                return Err(ExtensionHostError::CrashLoop);
            };
            thread::sleep(delay);
            if !self.inner.activation.authority().authorizes() {
                self.inner
                    .state
                    .lock()
                    .map_err(|_| ExtensionHostError::HostExited)?
                    .status = ExtensionHostStatus::Stopped;
                return Err(ExtensionHostError::AuthorityDenied);
            }
            match self.launch_and_activate() {
                Ok(()) => return Ok(()),
                Err(error) if restartable(&error) => continue,
                Err(error) => return Err(error),
            }
        }
    }
}

fn terminate_confirmed(process: &Arc<dyn ExtensionHostProcess>) -> Result<(), ExtensionHostError> {
    if process.has_exited() {
        return Ok(());
    }
    process.terminate()?;
    if process.has_exited() {
        Ok(())
    } else {
        Err(ExtensionHostError::HostExited)
    }
}

pub(super) fn require_success(
    response: Option<ExtensionHostResponse>,
    expected: impl FnOnce(&HostSuccess) -> bool,
) -> Result<HostSuccess, ExtensionHostError> {
    let response = response.ok_or(ExtensionHostError::RequestTimedOut)?;
    match response.response {
        HostResponseKind::Success(success) if expected(&success) => Ok(success),
        HostResponseKind::Success(_) => Err(ExtensionHostError::InvalidProtocol(
            "response kind did not match the request".into(),
        )),
        HostResponseKind::Failure(failure) => Err(ExtensionHostError::HostRejected {
            code: failure.code,
            message: failure.message,
        }),
    }
}

fn restartable(error: &ExtensionHostError) -> bool {
    matches!(
        error,
        ExtensionHostError::HostExited
            | ExtensionHostError::HostRestarted
            | ExtensionHostError::SpawnFailed
            | ExtensionHostError::StartupTimedOut
            | ExtensionHostError::Transport(_)
    )
}

#[cfg(test)]
#[path = "supervisor_tests.rs"]
mod tests;

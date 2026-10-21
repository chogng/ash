use std::collections::BTreeMap;
use std::collections::BTreeSet;
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

mod client;
mod invocation;
mod product;

use client::BackgroundClientWorker;
pub use client::ExtensionBackgroundClientHandler;

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
    initialization: Option<external_ext_protocol::ExtensionHostInitialization>,
    client_handler: Option<Arc<ExtensionBackgroundClientHandler>>,
    client_worker: Option<BackgroundClientWorker>,
    status: ExtensionHostStatus,
    incarnation: u64,
    process: Option<Arc<dyn ExtensionHostProcess>>,
    process_lease: Option<Box<dyn ActivationLease>>,
    registrations: Vec<RegistrationDescriptor>,
    registration_revision: u64,
    speech_registration_generation: u64,
    terminal_registration_ids: BTreeSet<String>,
    pending_registrations: Option<crate::ExtensionHostRegistrationEvent>,
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
    registration_listener: Mutex<Option<Arc<dyn Fn(crate::HostEventContext) + Send + Sync>>>,
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
                    initialization: None,
                    client_handler: None,
                    client_worker: None,
                    status: ExtensionHostStatus::Stopped,
                    incarnation: 0,
                    process: None,
                    process_lease: None,
                    registrations: Vec::new(),
                    registration_revision: 0,
                    speech_registration_generation: 0,
                    terminal_registration_ids: BTreeSet::new(),
                    pending_registrations: None,
                    invocation_leases: BTreeMap::new(),
                    restart,
                    output_events: VecDeque::new(),
                    output_event_bytes: 0,
                    next_output_event_sequence: 1,
                }),
                lifecycle: Mutex::new(()),
                next_request_id: AtomicU64::new(1),
                started_at: Instant::now(),
                registration_listener: Mutex::new(None),
            }),
        })
    }

    pub fn start(&self) -> Result<ExtensionHostSnapshot, ExtensionHostError> {
        self.start_with_initialization(None)
    }

    /// Binds the product fleet's existing snapshot publisher to admitted registry changes.
    pub fn set_registration_listener(
        &self,
        listener: Arc<dyn Fn(crate::HostEventContext) + Send + Sync>,
    ) {
        *self
            .inner
            .registration_listener
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(listener);
    }

    /// Binds window facts to the first incarnation; recovery retains this activation's snapshot.
    pub fn start_with_initialization(
        &self,
        initialization: Option<external_ext_protocol::ExtensionHostInitialization>,
    ) -> Result<ExtensionHostSnapshot, ExtensionHostError> {
        self.start_with_client(initialization, None)
    }

    /// Binds standard Node service calls to the initiating product client. Recovery reuses it.
    pub fn start_with_client(
        &self,
        initialization: Option<external_ext_protocol::ExtensionHostInitialization>,
        handler: Option<Arc<ExtensionBackgroundClientHandler>>,
    ) -> Result<ExtensionHostSnapshot, ExtensionHostError> {
        let _lifecycle = self
            .inner
            .lifecycle
            .lock()
            .map_err(|_| ExtensionHostError::HostExited)?;
        let (status, process) = {
            let mut state = self
                .inner
                .state
                .lock()
                .map_err(|_| ExtensionHostError::HostExited)?;
            if state.status == ExtensionHostStatus::Stopped {
                state.initialization = initialization
                    .or_else(|| state.initialization.clone())
                    .or_else(|| self.inner.activation.params().initialization.clone());
                state.client_handler = handler;
            }
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
        let (process, incarnation, client_worker) = {
            let mut state = self
                .inner
                .state
                .lock()
                .map_err(|_| ExtensionHostError::HostExited)?;
            state.status = ExtensionHostStatus::Stopped;
            state.registrations.clear();
            (
                state.process.clone(),
                state.incarnation,
                state.client_worker.take(),
            )
        };
        drop(client_worker);
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

    /// Reports the current process without activating or recovering an exited instance.
    pub fn is_running(&self) -> bool {
        let state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state.status == ExtensionHostStatus::Ready
            && state
                .process
                .as_ref()
                .is_some_and(|process| !process.has_exited())
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
            state.registration_revision = 0;
            state.speech_registration_generation = 0;
            state.terminal_registration_ids.clear();
            state.pending_registrations = None;
            state.incarnation
        };
        let weak = Arc::downgrade(&self.inner);
        process.set_registration_handler(Arc::new(move |event| {
            if let Some(inner) = weak.upgrade() {
                inner.update_registrations(event)?;
            }
            Ok(())
        }));
        let handler = self
            .inner
            .state
            .lock()
            .map_err(|_| ExtensionHostError::HostExited)?
            .client_handler
            .clone();
        let weak = Arc::downgrade(&self.inner);
        let handler = handler.map(|handler| {
            let guarded: Arc<ExtensionBackgroundClientHandler> =
                Arc::new(move |context, operation, token, timeout| {
                    client::service_background_operation(
                        &weak,
                        context.incarnation,
                        operation,
                        |operation| handler(context, operation, token, timeout),
                    )
                });
            guarded
        });
        let worker = handler
            .map(|handler| {
                BackgroundClientWorker::start(
                    Arc::clone(&process),
                    self.inner.activation.clone(),
                    handler,
                    self.inner.limits.request_timeout,
                )
            })
            .transpose();
        let worker = match worker {
            Ok(worker) => worker,
            Err(error) => {
                terminate_confirmed(&process)?;
                let mut state = self
                    .inner
                    .state
                    .lock()
                    .map_err(|_| ExtensionHostError::HostExited)?;
                state.status = ExtensionHostStatus::Stopped;
                state.process = None;
                return Err(error);
            }
        };
        // Startup needs the same pump as background listeners; retain it only after activation.
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
                state.terminal_registration_ids.extend(
                    registrations.iter().filter(|registration| {
                        matches!(registration.kind,
                            external_ext_protocol::RegistrationKind::TerminalProfileProvider { .. }
                            | external_ext_protocol::RegistrationKind::TerminalPty {}
                            | external_ext_protocol::RegistrationKind::TerminalLinkProvider {}
                            | external_ext_protocol::RegistrationKind::TerminalCompletionProvider { .. }
                            | external_ext_protocol::RegistrationKind::TerminalQuickFixProvider { .. })
                    }).map(|registration| registration.registration_id.clone())
                );
                state.registrations = registrations;
                state.speech_registration_generation = state.speech_registration_generation.max(
                    state
                        .registrations
                        .iter()
                        .filter_map(|registration| match registration.kind {
                            external_ext_protocol::RegistrationKind::SpeechProvider {
                                registration_generation,
                                ..
                            } => Some(registration_generation),
                            _ => None,
                        })
                        .max()
                        .unwrap_or(0),
                );
                if let Some(event) = state.pending_registrations.take() {
                    if let Err(error) = self.inner.replace_dynamic_registrations(&mut state, &event)
                    {
                        state.status = ExtensionHostStatus::Stopped;
                        state.registrations.clear();
                        state.process = None;
                        drop(state);
                        drop(worker);
                        terminate_confirmed(&process)?;
                        return Err(error);
                    }
                }
                state.status = ExtensionHostStatus::Ready;
                state.process_lease = Some(lease);
                state.client_worker = worker;
                state.restart.record_healthy();
                Ok(())
            }
            Err(error) => {
                drop(worker);
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
                environment: self.inner.command.extension_environment().clone(),
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
        let handler = self
            .inner
            .state
            .lock()
            .map_err(|_| ExtensionHostError::HostExited)?
            .client_handler
            .clone();
        if self.inner.command.is_node_host() {
            if let Some(handler) = handler {
                // Recovery must query the same window owners before package evaluation: facts
                // may have changed while this process was offline. The process lease covers IO.
                let cancellation = ash_async_utils::CancellationSource::new();
                let result = handler(
                    crate::HostEventContext::new(
                        incarnation,
                        self.inner.activation.activation_generation().get(),
                    ),
                    external_ext_protocol::ExtensionClientOperation::ReadInitialization {},
                    &cancellation.token(),
                    self.inner.limits.startup_timeout,
                )
                .map_err(|failure| ExtensionHostError::HostRejected {
                    code: failure.code,
                    message: failure.message,
                })?;
                let external_ext_protocol::ExtensionClientResult::Initialization { initialization } =
                    result
                else {
                    return Err(ExtensionHostError::InvalidProtocol(
                        "initialization reply has another result kind".into(),
                    ));
                };
                initialization.validate()?;
                self.inner
                    .state
                    .lock()
                    .map_err(|_| ExtensionHostError::HostExited)?
                    .initialization = Some(initialization);
            }
        }
        let mut params = self.inner.activation.params().clone();
        params.initialization = self
            .inner
            .state
            .lock()
            .map_err(|_| ExtensionHostError::HostExited)?
            .initialization
            .clone();
        let activate = self.request(process, incarnation, HostRequestKind::Activate(params))?;
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
            let (process, incarnation, decision, client_worker) = {
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
                (process, incarnation, decision, state.client_worker.take())
            };
            drop(client_worker);
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

impl SupervisorInner {
    fn admit_speech_generations(
        &self,
        state: &mut SupervisorState,
        event: &crate::ExtensionHostRegistrationEvent,
    ) -> Result<(), ExtensionHostError> {
        let previous = state
            .pending_registrations
            .as_ref()
            .map(|event| event.speech_providers.as_slice())
            .unwrap_or(&state.registrations);
        let mut maximum = state.speech_registration_generation;
        for registration in &event.speech_providers {
            let external_ext_protocol::RegistrationKind::SpeechProvider {
                registration_generation,
                ..
            } = registration.kind
            else {
                return Err(ExtensionHostError::InvalidProtocol(
                    "registration event may only change Speech".into(),
                ));
            };
            if !previous.contains(registration)
                && registration_generation <= state.speech_registration_generation
            {
                return Err(ExtensionHostError::InvalidProtocol(
                    "Speech registration generation was reused".into(),
                ));
            }
            maximum = maximum.max(registration_generation);
        }
        state.speech_registration_generation = maximum;
        Ok(())
    }

    fn admit_terminal_handles(
        &self,
        state: &mut SupervisorState,
        event: &crate::ExtensionHostRegistrationEvent,
    ) -> Result<(), ExtensionHostError> {
        let previous = state
            .pending_registrations
            .as_ref()
            .map(|event| event.terminal_providers.as_slice())
            .unwrap_or(&state.registrations);
        let mut added = Vec::new();
        for registration in &event.terminal_providers {
            if previous.contains(registration) {
                continue;
            }
            if state
                .terminal_registration_ids
                .contains(&registration.registration_id)
            {
                return Err(ExtensionHostError::InvalidProtocol(
                    "terminal provider handle was reused".into(),
                ));
            }
            added.push(registration.registration_id.clone());
        }
        // Old callback handles must never revive within an incarnation. Bound this
        // tombstone set so a rapidly rotating provider cannot retain memory forever.
        if state
            .terminal_registration_ids
            .len()
            .saturating_add(added.len())
            > self.limits.maximum_registrations.saturating_mul(64)
        {
            return Err(ExtensionHostError::QuotaExceeded(
                "terminal provider handles",
            ));
        }
        state.terminal_registration_ids.extend(added);
        Ok(())
    }

    fn replace_dynamic_registrations(
        &self,
        state: &mut SupervisorState,
        event: &crate::ExtensionHostRegistrationEvent,
    ) -> Result<(), ExtensionHostError> {
        let mut registrations = state
            .registrations
            .iter()
            .filter(|registration| {
                !matches!(
                    registration.kind,
                    external_ext_protocol::RegistrationKind::SpeechProvider { .. }
                        | external_ext_protocol::RegistrationKind::TerminalProfileProvider { .. }
                        | external_ext_protocol::RegistrationKind::TerminalPty {}
                        | external_ext_protocol::RegistrationKind::TerminalLinkProvider {}
                        | external_ext_protocol::RegistrationKind::TerminalCompletionProvider { .. }
                        | external_ext_protocol::RegistrationKind::TerminalQuickFixProvider { .. }
                )
            })
            .cloned()
            .collect::<Vec<_>>();
        registrations.extend(event.speech_providers.iter().cloned());
        registrations.extend(event.terminal_providers.iter().cloned());
        let snapshot = ActivateResult { registrations };
        snapshot
            .validate(
                &self.activation.params().capabilities,
                &self.limits.protocol_limits(),
            )
            .map_err(|error| ExtensionHostError::InvalidProtocol(error.to_string()))?;
        state.registrations = snapshot.registrations;
        Ok(())
    }

    fn update_registrations(
        &self,
        event: crate::ExtensionHostRegistrationEvent,
    ) -> Result<(), ExtensionHostError> {
        let _lease = self
            .activation
            .acquire()
            .ok_or(ExtensionHostError::AuthorityDenied)?;
        let mut state = self
            .state
            .lock()
            .map_err(|_| ExtensionHostError::HostExited)?;
        if event.context.incarnation != state.incarnation
            || event.context.activation_generation != self.activation.activation_generation().get()
            || !matches!(
                state.status,
                ExtensionHostStatus::Starting | ExtensionHostStatus::Ready
            )
            || event.revision <= state.registration_revision
        {
            return Ok(());
        }
        // Event validation fixes the mutable subset; admission still belongs to this activation.
        ActivateResult {
            registrations: event
                .speech_providers
                .iter()
                .chain(&event.terminal_providers)
                .cloned()
                .collect(),
        }
        .validate(
            &self.activation.params().capabilities,
            &self.limits.protocol_limits(),
        )
        .map_err(|error| ExtensionHostError::InvalidProtocol(error.to_string()))?;
        self.admit_speech_generations(&mut state, &event)?;
        self.admit_terminal_handles(&mut state, &event)?;
        state.registration_revision = event.revision;
        if state.status == ExtensionHostStatus::Starting {
            state.pending_registrations = Some(event);
            return Ok(());
        }
        self.replace_dynamic_registrations(&mut state, &event)?;
        drop(state);
        let listener = self
            .registration_listener
            .lock()
            .map_err(|_| ExtensionHostError::HostExited)?
            .clone();
        if let Some(listener) = listener {
            listener(event.context);
        }
        Ok(())
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

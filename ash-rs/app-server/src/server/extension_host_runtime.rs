use std::collections::BTreeMap;
use std::num::NonZeroU64;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::thread::JoinHandle;
use std::time::Duration;

use ash_core_plugins::PluginActivationAuthority;
use ash_core_plugins::PluginsManager;
use ash_editor_extension_host::CancelReason;
use ash_editor_extension_host::ExtensionHostError;
use ash_editor_extension_host::ExtensionHostLauncher;
use ash_editor_extension_host::ExtensionHostLimits;
use ash_editor_extension_host::ExtensionHostStatus;
use ash_editor_extension_host::ExtensionHostSupervisor;
use ash_editor_extension_host::ExtensionInvocation;
use ash_editor_extension_host::ExtensionInvocationTarget;
use ash_editor_extension_host::LanguageProviderOperation;
use ash_editor_extension_host::RegistrationKind;
use ash_editor_extension_host::RestartPolicy;
use ash_file_access::Authorization;
use ash_file_access::Permission;
use serde_json::Value;

use super::update_broker::UpdateBroker;

mod authority;
mod fleet;
mod projection;
mod sessions;
pub(crate) mod source;

use projection::ExtensionHostExtensionSnapshot;
pub(super) use projection::ExtensionHostFailureKind;
pub(super) use projection::ExtensionHostFleetSnapshot;
pub(super) use projection::ExtensionHostLifecycle;
pub(super) use projection::ExtensionHostRuntimeFailure;
use sessions::InvocationSessionStore;

const MAXIMUM_FLEET_EXTENSIONS: usize = 128;
const MAXIMUM_GLOBAL_INVOCATIONS: usize = 256;
const MAXIMUM_CONNECTION_INVOCATIONS: usize = 32;
const HEALTH_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Clone)]
pub(super) struct ExtensionHostRuntime {
    inner: Arc<RuntimeInner>,
}

struct RuntimeInner {
    plugin_authority: Option<PluginActivationAuthority>,
    plugins_manager: Option<Arc<PluginsManager>>,
    marketplace_admission: Option<Arc<dyn crate::MarketplaceEditorExtensionAdmission>>,
    launcher: Arc<dyn ExtensionHostLauncher>,
    limits: ExtensionHostLimits,
    restart_policy: RestartPolicy,
    updates: Arc<UpdateBroker>,
    state: Mutex<FleetState>,
    reconcile_gate: Mutex<()>,
    sessions: Mutex<InvocationSessionStore>,
    next_invocation_id: AtomicU64,
    shutdown: Mutex<Option<std::sync::mpsc::Sender<()>>>,
    worker: Mutex<Option<JoinHandle<()>>>,
}

struct FleetState {
    generation: u64,
    authority_generation: u64,
    source_revision: source::EditorExtensionSourceRevision,
    authorization: Option<Authorization>,
    entries: BTreeMap<String, RuntimeEntry>,
    published: Vec<ExtensionHostExtensionSnapshot>,
}

struct RuntimeEntry {
    version: String,
    supervisor: Option<ExtensionHostSupervisor>,
    fallback: ExtensionHostExtensionSnapshot,
    failure: Option<ExtensionHostRuntimeFailure>,
}

pub(super) enum ExtensionHostReconcileMode {
    Refresh,
    RestartFailed,
}

pub(super) struct ExtensionHostInvocationRequest {
    pub(super) extension_id: String,
    pub(super) registration_id: String,
    pub(super) activation_generation: u64,
    pub(super) incarnation: u64,
    pub(super) operation: String,
    pub(super) payload: Value,
    pub(super) deadline_unix_millis: u64,
}

pub(super) enum ExtensionHostInvocationRead {
    Pending,
    Succeeded(Value),
    Failed(ExtensionHostRuntimeFailure),
    Cancelled(CancelReason),
}

#[derive(Clone, Copy)]
pub(super) enum ExtensionHostInvocationCancelDisposition {
    Requested,
    AlreadyTerminal,
}

#[derive(Debug)]
pub(super) enum ExtensionHostRuntimeError {
    Stale,
    InvocationNotFound,
    QuotaExceeded,
    Host(ExtensionHostError),
    Internal,
}

impl ExtensionHostRuntime {
    pub(super) fn start(
        plugin_authority: Option<PluginActivationAuthority>,
        plugins_manager: Option<Arc<PluginsManager>>,
        marketplace_admission: Option<Arc<dyn crate::MarketplaceEditorExtensionAdmission>>,
        launcher: Arc<dyn ExtensionHostLauncher>,
        limits: ExtensionHostLimits,
        restart_policy: RestartPolicy,
        updates: Arc<UpdateBroker>,
    ) -> Result<Self, ExtensionHostError> {
        limits.validate()?;
        restart_policy.validate()?;
        let plugin_changes = plugin_authority
            .as_ref()
            .map(PluginActivationAuthority::subscribe);
        let marketplace_changes = plugins_manager
            .as_ref()
            .and_then(|manager| manager.subscribe().ok());
        let marketplace_admission_changes = marketplace_admission
            .as_ref()
            .and_then(|admission| admission.subscribe());
        let (shutdown, shutdown_receiver) = std::sync::mpsc::channel();
        let inner = Arc::new(RuntimeInner {
            plugin_authority,
            plugins_manager,
            marketplace_admission,
            launcher,
            limits,
            restart_policy,
            updates,
            state: Mutex::new(FleetState {
                generation: 1,
                authority_generation: 0,
                source_revision: source::EditorExtensionSourceRevision::default(),
                authorization: None,
                entries: BTreeMap::new(),
                published: Vec::new(),
            }),
            reconcile_gate: Mutex::new(()),
            sessions: Mutex::new(InvocationSessionStore::new(
                MAXIMUM_GLOBAL_INVOCATIONS,
                MAXIMUM_CONNECTION_INVOCATIONS,
            )),
            next_invocation_id: AtomicU64::new(1),
            shutdown: Mutex::new(Some(shutdown)),
            worker: Mutex::new(None),
        });
        let weak = Arc::downgrade(&inner);
        let worker = std::thread::Builder::new()
            .name("ash-editor-extension-hosts".into())
            .spawn(move || {
                runtime_worker(
                    weak,
                    plugin_changes,
                    marketplace_changes,
                    marketplace_admission_changes,
                    shutdown_receiver,
                )
            })
            .map_err(|_| ExtensionHostError::SpawnFailed)?;
        *inner
            .worker
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(worker);
        Ok(Self { inner })
    }

    pub(super) fn bind_dir(
        &self,
        authorization: Authorization,
    ) -> Result<ExtensionHostFleetSnapshot, ExtensionHostRuntimeError> {
        if authorization.permission() != Permission::DiscoverPlugins
            || authorization.ensure_active().is_err()
        {
            return Err(ExtensionHostRuntimeError::Host(
                ExtensionHostError::AuthorityDenied,
            ));
        }
        let _gate = self
            .inner
            .reconcile_gate
            .lock()
            .map_err(|_| ExtensionHostRuntimeError::Internal)?;
        self.inner.retire_current(CancelReason::AuthorityRevoked)?;
        self.inner
            .state
            .lock()
            .map_err(|_| ExtensionHostRuntimeError::Internal)?
            .authorization = Some(authorization);
        self.inner.reconcile_authority_locked(true)
    }

    pub(super) fn unbind_dir(&self) {
        let Ok(_gate) = self.inner.reconcile_gate.lock() else {
            return;
        };
        let _ = self.inner.retire_current(CancelReason::AuthorityRevoked);
        let generation = {
            let Ok(mut state) = self.inner.state.lock() else {
                return;
            };
            state.authorization = None;
            state.authority_generation = 0;
            state.source_revision = source::EditorExtensionSourceRevision::default();
            self.inner
                .refresh_generation_locked(&mut state)
                .ok()
                .flatten()
        };
        self.inner.publish(generation);
    }

    pub(super) fn reconcile(
        &self,
        mode: ExtensionHostReconcileMode,
    ) -> Result<ExtensionHostFleetSnapshot, ExtensionHostRuntimeError> {
        let _gate = self
            .inner
            .reconcile_gate
            .lock()
            .map_err(|_| ExtensionHostRuntimeError::Internal)?;
        match mode {
            ExtensionHostReconcileMode::Refresh => {
                self.inner.reconcile_authority_locked(false)?;
                self.inner.reconcile_health_locked()
            }
            ExtensionHostReconcileMode::RestartFailed => self.inner.restart_failed_locked(),
        }
    }

    pub(super) fn snapshot(&self) -> ExtensionHostFleetSnapshot {
        self.inner.snapshot()
    }

    pub(super) fn start_invocation(
        &self,
        owner: u64,
        request: ExtensionHostInvocationRequest,
    ) -> Result<String, ExtensionHostRuntimeError> {
        self.inner.start_invocation(owner, request)
    }

    pub(super) fn read_invocation(
        &self,
        owner: u64,
        id: &str,
    ) -> Result<ExtensionHostInvocationRead, ExtensionHostRuntimeError> {
        self.inner
            .sessions
            .lock()
            .map_err(|_| ExtensionHostRuntimeError::Internal)?
            .read(owner, id)
    }

    pub(super) fn cancel_invocation(
        &self,
        owner: u64,
        id: &str,
    ) -> Result<ExtensionHostInvocationCancelDisposition, ExtensionHostRuntimeError> {
        self.inner
            .sessions
            .lock()
            .map_err(|_| ExtensionHostRuntimeError::Internal)?
            .cancel(owner, id, CancelReason::Caller)
    }

    pub(super) fn close_owner(&self, owner: u64) {
        let handles = self
            .inner
            .sessions
            .lock()
            .map(|mut sessions| sessions.detach_owner(owner, CancelReason::Shutdown))
            .unwrap_or_default();
        cancel_handles(handles, CancelReason::Shutdown);
    }
}

impl RuntimeInner {
    fn start_invocation(
        self: &Arc<Self>,
        owner: u64,
        request: ExtensionHostInvocationRequest,
    ) -> Result<String, ExtensionHostRuntimeError> {
        let _gate = self
            .reconcile_gate
            .lock()
            .map_err(|_| ExtensionHostRuntimeError::Internal)?;
        let supervisor = {
            let state = self
                .state
                .lock()
                .map_err(|_| ExtensionHostRuntimeError::Internal)?;
            let entry = state
                .entries
                .get(&request.extension_id)
                .ok_or(ExtensionHostRuntimeError::Stale)?;
            let supervisor = entry
                .supervisor
                .clone()
                .ok_or_else(|| entry_host_error(entry))?;
            let snapshot = supervisor.snapshot();
            let registration = snapshot
                .registrations
                .iter()
                .find(|registration| registration.registration_id == request.registration_id);
            if snapshot.status != ExtensionHostStatus::Ready
                || snapshot.activation_generation != request.activation_generation
                || snapshot.incarnation != request.incarnation
            {
                return Err(ExtensionHostRuntimeError::Stale);
            }
            let registration = registration.ok_or(ExtensionHostRuntimeError::Stale)?;
            if !registration_allows_operation(&registration.kind, &request.operation) {
                return Err(ExtensionHostRuntimeError::Stale);
            }
            supervisor
        };
        let deadline = NonZeroU64::new(request.deadline_unix_millis)
            .ok_or(ExtensionHostRuntimeError::Stale)?;
        let target = ExtensionInvocationTarget {
            incarnation: NonZeroU64::new(request.incarnation)
                .ok_or(ExtensionHostRuntimeError::Stale)?,
            activation_generation: NonZeroU64::new(request.activation_generation)
                .ok_or(ExtensionHostRuntimeError::Stale)?,
        };
        let id = self.allocate_invocation_id(owner)?;
        self.sessions
            .lock()
            .map_err(|_| ExtensionHostRuntimeError::Internal)?
            .reserve(id.clone(), owner, request.incarnation)?;
        let handle = match supervisor.begin_fenced_invoke(
            target,
            ExtensionInvocation {
                registration_id: request.registration_id,
                operation: request.operation,
                payload: request.payload,
                deadline_unix_millis: deadline,
            },
        ) {
            Ok(handle) => Arc::new(handle),
            Err(error) => {
                self.sessions
                    .lock()
                    .map_err(|_| ExtensionHostRuntimeError::Internal)?
                    .release(&id);
                return Err(ExtensionHostRuntimeError::Host(error));
            }
        };
        self.sessions
            .lock()
            .map_err(|_| ExtensionHostRuntimeError::Internal)?
            .install(&id, Arc::clone(&handle))?;
        let weak = Arc::downgrade(self);
        let invocation_id = id.clone();
        if std::thread::Builder::new()
            .name("ash-extension-invocation".into())
            .spawn(move || {
                let result = handle.wait();
                if let Some(runtime) = weak.upgrade() {
                    runtime.complete_invocation(&invocation_id, result);
                }
            })
            .is_err()
        {
            self.sessions
                .lock()
                .map_err(|_| ExtensionHostRuntimeError::Internal)?
                .release(&id);
            return Err(ExtensionHostRuntimeError::Internal);
        }
        let generation = {
            let mut state = self
                .state
                .lock()
                .map_err(|_| ExtensionHostRuntimeError::Internal)?;
            self.refresh_generation_locked(&mut state)?
        };
        self.publish(generation);
        Ok(id)
    }

    fn complete_invocation(
        &self,
        id: &str,
        result: Result<ash_editor_extension_host::InvokeResult, ExtensionHostError>,
    ) {
        if let Ok(mut sessions) = self.sessions.lock() {
            sessions.complete(id, result);
        }
        let Ok(_gate) = self.reconcile_gate.lock() else {
            return;
        };
        let _ = self.reconcile_health_locked();
    }

    fn allocate_invocation_id(&self, owner: u64) -> Result<String, ExtensionHostRuntimeError> {
        self.next_invocation_id
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                value.checked_add(1)
            })
            .map(|value| format!("eh-{owner}-{value}"))
            .map_err(|_| ExtensionHostRuntimeError::Internal)
    }
}

impl Drop for RuntimeInner {
    fn drop(&mut self) {
        if let Some(shutdown) = self
            .shutdown
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            let _ = shutdown.send(());
        }
        if let Some(worker) = self
            .worker
            .get_mut()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
            && worker.thread().id() != std::thread::current().id()
        {
            let _ = worker.join();
        }
        let entries = self
            .state
            .get_mut()
            .map(|state| std::mem::take(&mut state.entries))
            .unwrap_or_default();
        for entry in entries.into_values() {
            if let Some(supervisor) = entry.supervisor {
                let _ = supervisor.shutdown();
            }
        }
    }
}

fn registration_allows_operation(registration: &RegistrationKind, operation: &str) -> bool {
    match registration {
        RegistrationKind::Command { .. } => operation == "execute",
        RegistrationKind::LanguageProvider { operations, .. } => operations
            .iter()
            .any(|candidate| language_operation_name(*candidate) == operation),
        RegistrationKind::DebugAdapter { .. } => false,
        RegistrationKind::TaskProvider { .. } => operation == "provideTasks",
        RegistrationKind::TestProfileProvider { .. } => operation == "provideTestProfiles",
    }
}

fn language_operation_name(operation: LanguageProviderOperation) -> &'static str {
    match operation {
        LanguageProviderOperation::Completion => "completion",
        LanguageProviderOperation::ParameterHints => "parameterHints",
        LanguageProviderOperation::Definition => "definition",
        LanguageProviderOperation::Hover => "hover",
        LanguageProviderOperation::References => "references",
        LanguageProviderOperation::Rename => "rename",
        LanguageProviderOperation::Formatting => "formatting",
        LanguageProviderOperation::CodeAction => "codeAction",
        LanguageProviderOperation::CodeLens => "codeLens",
        LanguageProviderOperation::DocumentSymbols => "documentSymbols",
        LanguageProviderOperation::DocumentLinks => "documentLinks",
        LanguageProviderOperation::DocumentColors => "documentColors",
        LanguageProviderOperation::FoldingRanges => "foldingRanges",
        LanguageProviderOperation::SemanticTokens => "semanticTokens",
        LanguageProviderOperation::InlayHints => "inlayHints",
        LanguageProviderOperation::LinkedEditing => "linkedEditing",
    }
}

fn runtime_worker(
    runtime: Weak<RuntimeInner>,
    plugin_changes: Option<ash_core_plugins::PluginAuthoritySubscription>,
    marketplace_changes: Option<std::sync::mpsc::Receiver<u64>>,
    marketplace_admission_changes: Option<std::sync::mpsc::Receiver<u64>>,
    shutdown: std::sync::mpsc::Receiver<()>,
) {
    loop {
        if shutdown.try_recv().is_ok() {
            break;
        }
        let plugin_changed = match plugin_changes.as_ref() {
            Some(changes) => match changes.recv_timeout(HEALTH_INTERVAL) {
                Ok(_) => true,
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => false,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => false,
            },
            None => {
                std::thread::sleep(HEALTH_INTERVAL);
                false
            }
        };
        let marketplace_changed = marketplace_changes
            .as_ref()
            .is_some_and(|changes| changes.try_recv().is_ok());
        let marketplace_admission_changed = marketplace_admission_changes
            .as_ref()
            .is_some_and(|changes| changes.try_recv().is_ok());
        let changed = plugin_changed || marketplace_changed || marketplace_admission_changed;
        let Some(runtime) = runtime.upgrade() else {
            break;
        };
        if let Ok(mut sessions) = runtime.sessions.lock() {
            sessions.sweep_expired(std::time::Instant::now());
        }
        let Ok(_gate) = runtime.reconcile_gate.lock() else {
            break;
        };
        let result = if changed {
            runtime.reconcile_authority_locked(false)
        } else {
            runtime.reconcile_health_locked()
        };
        if let Err(error) = result {
            log::warn!(
                "failed to reconcile executable Editor Extensions: {}",
                error_name(&error)
            );
        }
    }
}

fn cancel_handles(
    handles: Vec<Arc<ash_editor_extension_host::ExtensionInvocationHandle>>,
    reason: CancelReason,
) {
    for handle in handles {
        let _ = handle.cancel(reason);
    }
}

fn nonzero_incarnation(supervisor: &ExtensionHostSupervisor) -> Option<u64> {
    let incarnation = supervisor.snapshot().incarnation;
    (incarnation != 0).then_some(incarnation)
}

fn entry_host_error(entry: &RuntimeEntry) -> ExtensionHostRuntimeError {
    entry
        .failure
        .as_ref()
        .map(|failure| match failure.code {
            projection::ExtensionHostFailureKind::QuotaExceeded => {
                ExtensionHostRuntimeError::QuotaExceeded
            }
            _ => ExtensionHostRuntimeError::Stale,
        })
        .unwrap_or(ExtensionHostRuntimeError::Stale)
}

fn error_name(error: &ExtensionHostRuntimeError) -> &'static str {
    match error {
        ExtensionHostRuntimeError::Stale => "stale extension snapshot",
        ExtensionHostRuntimeError::InvocationNotFound => "invocation not found",
        ExtensionHostRuntimeError::QuotaExceeded => "extension host quota exceeded",
        ExtensionHostRuntimeError::Host(_) => "extension host failure",
        ExtensionHostRuntimeError::Internal => "extension host runtime unavailable",
    }
}

#[cfg(test)]
#[path = "extension_host_runtime_tests.rs"]
mod tests;

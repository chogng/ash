use std::collections::BTreeMap;
use std::num::NonZeroU64;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::thread::JoinHandle;
use std::time::Duration;

use ash_core_plugins::ExtensionPackageManager;
use ash_core_plugins::PluginActivationAuthority;
use ash_external_ext::CancelReason;
use ash_external_ext::ExtensionHostError;
use ash_external_ext::ExtensionHostLauncher;
use ash_external_ext::ExtensionHostLimits;
use ash_external_ext::ExtensionHostStatus;
use ash_external_ext::ExtensionHostSupervisor;
use ash_external_ext::ExtensionInvocation;
use ash_external_ext::ExtensionInvocationTarget;
use ash_external_ext::LanguageProviderOperation;
use ash_external_ext::RegistrationKind;
use ash_external_ext::RestartPolicy;
use ash_file_access::Authorization;
use ash_file_access::Permission;
use serde_json::Value;

use super::update_broker::UpdateBroker;

mod authority;
mod client;
mod fleet;
mod private_services;
mod projection;
mod secrets;
mod sessions;
pub(crate) mod source;
mod storage;

use projection::ExtensionHostExtensionSnapshot;
pub(super) use projection::ExtensionHostFailureKind;
pub(super) use projection::ExtensionHostFleetSnapshot;
pub(super) use projection::ExtensionHostLifecycle;
pub(super) use projection::ExtensionHostRuntimeFailure;
use sessions::InvocationSessionStore;
use sessions::ProfileResultCleanup;
pub(super) use sessions::ResultRetention;

const MAXIMUM_FLEET_EXTENSIONS: usize = 128;
const MAXIMUM_GLOBAL_INVOCATIONS: usize = 256;
const MAXIMUM_CONNECTION_INVOCATIONS: usize = 32;
const HEALTH_INTERVAL: Duration = Duration::from_millis(500);

#[derive(Clone)]
pub(super) struct ExtensionHostRuntime {
    inner: Arc<RuntimeInner>,
}

impl std::fmt::Debug for ExtensionHostRuntime {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("ExtensionHostRuntime")
            .finish_non_exhaustive()
    }
}

type CredentialHandler = dyn Fn(
        &str,
        Option<&str>,
        &ash_async_utils::CancellationToken,
    ) -> Result<
        external_ext_protocol::services::CoreServiceResponse,
        ash_external_ext::HostFailure,
    > + Send
    + Sync;

struct RuntimeInner {
    secrets: Mutex<Option<Arc<dyn ash_secrets::SecretStore>>>,
    storage: Mutex<Option<Arc<ash_state::SqliteExtensionStateStore>>>,
    credential_services: Arc<Mutex<BTreeMap<String, Arc<CredentialHandler>>>>,
    environment: Option<BTreeMap<String, Option<String>>>,
    built_in_extensions: source::BuiltInEditorExtensions,
    plugin_authority: Option<PluginActivationAuthority>,
    plugins_manager: Option<Arc<ExtensionPackageManager>>,
    extension_packages_admission: Option<Arc<dyn crate::ExtensionsEditorExtensionAdmission>>,
    launcher: Arc<dyn ExtensionHostLauncher>,
    limits: ExtensionHostLimits,
    restart_policy: RestartPolicy,
    updates: Arc<UpdateBroker>,
    client_host: Arc<crate::client_host::ClientHost>,
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
    // Standard extension instances belong to the renderer connection that supplied their facts.
    windows: BTreeMap<u64, BTreeMap<String, RuntimeEntry>>,
    window_published: BTreeMap<u64, Vec<ExtensionHostExtensionSnapshot>>,
}

impl FleetState {
    fn entry(&self, owner: u64, id: &str) -> Option<&RuntimeEntry> {
        let entry = self.entries.get(id)?;
        if entry.is_window_template() {
            self.windows.get(&owner).and_then(|entries| entries.get(id))
        } else {
            Some(entry)
        }
    }

    fn entry_mut(&mut self, owner: u64, id: &str) -> Option<&mut RuntimeEntry> {
        if self.entries.get(id)?.is_window_template() {
            self.windows
                .get_mut(&owner)
                .and_then(|entries| entries.get_mut(id))
        } else {
            self.entries.get_mut(id)
        }
    }

    fn snapshot_for(&self, owner: u64) -> ExtensionHostFleetSnapshot {
        let window = self.window_published.get(&owner);
        ExtensionHostFleetSnapshot {
            generation: self.generation,
            extensions: self
                .published
                .iter()
                .map(|base| {
                    window
                        .and_then(|entries| entries.iter().find(|entry| entry.id == base.id))
                        .unwrap_or(base)
                        .clone()
                })
                .collect(),
        }
    }
}

enum EditorClientScope {
    Unsupported,
    Pending,
    Bound { owner: u64 },
}

struct RuntimeEntry {
    scope: source::EditorExtensionScope,
    activation_gate: Arc<Mutex<()>>,
    version: String,
    workspace_read: source::WorkspaceReadAccess,
    backend_channels: BTreeMap<String, String>,
    supervisor: Option<ExtensionHostSupervisor>,
    fallback: ExtensionHostExtensionSnapshot,
    failure: Option<ExtensionHostRuntimeFailure>,
    pending_activation: Option<source::ActivationPlan>,
    client_scope: EditorClientScope,
    // Base entries retain their launch facts for selective catalog reconciliation.
    // Per-window instances borrow the base's identity and have no deployment recipe.
    deployment: Option<source::EditorExtensionDeployment>,
}

impl RuntimeEntry {
    fn is_window_template(&self) -> bool {
        self.deployment
            .as_ref()
            .is_some_and(source::EditorExtensionDeployment::is_window_scoped)
    }
}

pub(super) enum ExtensionHostReconcileMode {
    Refresh,
    RestartFailed,
}

enum ReconcileScope {
    All,
    Window(u64),
}

pub(super) struct ExtensionHostInvocationRequest {
    pub(super) extension_id: String,
    pub(super) registration_id: String,
    pub(super) registration_generation: Option<u64>,
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
    pub(super) fn bind_secrets(&self, secrets: Arc<dyn ash_secrets::SecretStore>) {
        *self
            .inner
            .secrets
            .lock()
            .expect("extension secret store lock") = Some(secrets);
    }
    pub(super) fn bind_storage(&self, storage: Arc<ash_state::SqliteExtensionStateStore>) {
        *self
            .inner
            .storage
            .lock()
            .expect("extension state store lock") = Some(storage);
    }
    pub(super) fn register_credentials(&self, provider: String, handler: Arc<CredentialHandler>) {
        self.inner
            .credential_services
            .lock()
            .expect("credential registry lock")
            .insert(provider, handler);
    }
    pub(super) fn start(
        built_in_extensions: source::BuiltInEditorExtensions,
        plugin_authority: Option<PluginActivationAuthority>,
        plugins_manager: Option<Arc<ExtensionPackageManager>>,
        extension_packages_admission: Option<Arc<dyn crate::ExtensionsEditorExtensionAdmission>>,
        launcher: Arc<dyn ExtensionHostLauncher>,
        limits: ExtensionHostLimits,
        restart_policy: RestartPolicy,
        updates: Arc<UpdateBroker>,
        client_host: Arc<crate::client_host::ClientHost>,
        environment: Option<BTreeMap<String, Option<String>>>,
    ) -> Result<Self, ExtensionHostError> {
        if let Some(environment) = &environment {
            external_ext_protocol::validate_environment(environment)
                .map_err(|error| ExtensionHostError::InvalidProtocol(error.to_string()))?;
        }
        limits.validate()?;
        restart_policy.validate()?;
        let plugin_changes = plugin_authority
            .as_ref()
            .map(PluginActivationAuthority::subscribe);
        let extension_packages_changes = plugins_manager
            .as_ref()
            .and_then(|manager| manager.subscribe().ok());
        let extension_packages_admission_changes = extension_packages_admission
            .as_ref()
            .and_then(|admission| admission.subscribe());
        let (shutdown, shutdown_receiver) = std::sync::mpsc::channel();
        let inner = Arc::new(RuntimeInner {
            secrets: Mutex::new(None),
            storage: Mutex::new(None),
            credential_services: Arc::new(Mutex::new(BTreeMap::new())),
            environment,
            built_in_extensions,
            plugin_authority,
            plugins_manager,
            extension_packages_admission,
            launcher,
            limits,
            restart_policy,
            updates,
            client_host,
            state: Mutex::new(FleetState {
                generation: 1,
                authority_generation: 0,
                source_revision: source::EditorExtensionSourceRevision::default(),
                authorization: None,
                entries: BTreeMap::new(),
                published: Vec::new(),
                windows: BTreeMap::new(),
                window_published: BTreeMap::new(),
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
        inner
            .reconcile_authority_locked(true)
            .map_err(|_| ExtensionHostError::SpawnFailed)?;
        let weak = Arc::downgrade(&inner);
        let worker = std::thread::Builder::new()
            .name("ash-external-exts".into())
            .spawn(move || {
                runtime_worker(
                    weak,
                    plugin_changes,
                    extension_packages_changes,
                    extension_packages_admission_changes,
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

    /// A remote window has its own extension processes but shares installation and grant owners.
    pub(super) fn fork(
        &self,
        environment: BTreeMap<String, Option<String>>,
    ) -> Result<Self, ExtensionHostError> {
        let runtime = Self::start(
            self.inner.built_in_extensions,
            self.inner.plugin_authority.clone(),
            self.inner.plugins_manager.clone(),
            self.inner.extension_packages_admission.clone(),
            Arc::clone(&self.inner.launcher),
            self.inner.limits.clone(),
            self.inner.restart_policy,
            Arc::clone(&self.inner.updates),
            Arc::clone(&self.inner.client_host),
            Some(environment),
        )?;
        if let Some(storage) = self
            .inner
            .storage
            .lock()
            .map_err(|_| ExtensionHostError::HostExited)?
            .clone()
        {
            runtime.bind_storage(storage);
        }
        if let Some(secrets) = self
            .inner
            .secrets
            .lock()
            .map_err(|_| ExtensionHostError::HostExited)?
            .clone()
        {
            runtime.bind_secrets(secrets);
        }
        let authorization = self
            .inner
            .state
            .lock()
            .map_err(|_| ExtensionHostError::HostExited)?
            .authorization
            .clone();
        if let Some(authorization) = authorization {
            runtime
                .bind_dir(authorization)
                .map_err(|_| ExtensionHostError::AuthorityDenied)?;
        }
        Ok(runtime)
    }

    pub(super) fn shutdown(&self) {
        if let Some(shutdown) = self
            .inner
            .shutdown
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            let _ = shutdown.send(());
        }
        if let Some(worker) = self
            .inner
            .worker
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .take()
        {
            let _ = worker.join();
        }
        if let Ok(_gate) = self.inner.reconcile_gate.lock() {
            let _ = self.inner.retire_current(CancelReason::Shutdown);
        }
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
        {
            let Ok(mut state) = self.inner.state.lock() else {
                return;
            };
            state.authorization = None;
            // Package fences remain monotonic across directory changes: a delayed editor
            // event must never acquire the same generation in a different directory.
            state.source_revision = source::EditorExtensionSourceRevision::default();
        }
        let _ = self.inner.reconcile_authority_locked(true);
    }

    pub(super) fn reconcile(
        &self,
        mode: ExtensionHostReconcileMode,
    ) -> Result<ExtensionHostFleetSnapshot, ExtensionHostRuntimeError> {
        self.reconcile_in_scope(ReconcileScope::All, mode)
    }

    pub(super) fn reconcile_for(
        &self,
        owner: u64,
        mode: ExtensionHostReconcileMode,
    ) -> Result<ExtensionHostFleetSnapshot, ExtensionHostRuntimeError> {
        self.reconcile_in_scope(ReconcileScope::Window(owner), mode)?;
        Ok(self.snapshot_for(owner))
    }

    fn reconcile_in_scope(
        &self,
        scope: ReconcileScope,
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
            ExtensionHostReconcileMode::RestartFailed => self.inner.restart_failed_locked(scope),
        }
    }

    pub(super) fn activate_by_event(
        &self,
        owner: u64,
        extension_id: &str,
        generation: u64,
        event: source::ActivationEvent,
        initialization: Option<external_ext_protocol::ExtensionHostInitialization>,
        files: Result<Arc<dyn ash_file_system::FileSystem>, ash_external_ext::HostFailure>,
    ) -> Result<ExtensionHostFleetSnapshot, ExtensionHostRuntimeError> {
        // Serialize duplicate first-use calls per extension. Holding the fleet gate while
        // activate awaits editor IO would deadlock commands that activate another extension.
        let activation_gate = {
            let _gate = self
                .inner
                .reconcile_gate
                .lock()
                .map_err(|_| ExtensionHostRuntimeError::Internal)?;
            self.inner.reconcile_authority_locked(false)?;
            self.inner
                .ensure_window_entry(owner, extension_id, generation, &event)?;
            self.inner
                .state
                .lock()
                .map_err(|_| ExtensionHostRuntimeError::Internal)?
                .entry(owner, extension_id)
                .ok_or(ExtensionHostRuntimeError::Stale)?
                .activation_gate
                .clone()
        };
        let _activation = activation_gate
            .lock()
            .map_err(|_| ExtensionHostRuntimeError::Internal)?;
        let gate = self
            .inner
            .reconcile_gate
            .lock()
            .map_err(|_| ExtensionHostRuntimeError::Internal)?;
        self.inner.reconcile_authority_locked(false)?;
        let (supervisor, handler) = {
            let mut state = self
                .inner
                .state
                .lock()
                .map_err(|_| ExtensionHostRuntimeError::Internal)?;
            let entry = state
                .entry_mut(owner, extension_id)
                .ok_or(ExtensionHostRuntimeError::Stale)?;
            if entry.fallback.activation_generation != generation {
                return Err(ExtensionHostRuntimeError::Stale);
            }
            let Some(plan) = &entry.pending_activation else {
                // A fresh window instance may fail its authority check before a host starts.
                // Publish that result before returning, including when no health tick ran yet.
                let published = self.inner.refresh_generation_locked(&mut state)?;
                let snapshot = state.snapshot_for(owner);
                drop(state);
                drop(gate);
                self.inner.publish(published);
                return Ok(snapshot);
            };
            if !plan.matches(&event) {
                return Err(ExtensionHostRuntimeError::Stale);
            }
            let supervisor = entry
                .supervisor
                .clone()
                .ok_or_else(|| entry_host_error(entry))?;
            let handler = match entry.client_scope {
                EditorClientScope::Pending => {
                    let client_host = Arc::clone(&self.inner.client_host);
                    let extension_id = extension_id.to_owned();
                    let workspace_read = entry.workspace_read;
                    let binding = EditorClientBinding {
                        runtime: Arc::downgrade(&self.inner),
                        activation: Arc::downgrade(&entry.activation_gate),
                        backend_channels: entry.backend_channels.clone(),
                        client_host,
                        owner,
                        extension_id,
                        workspace_read,
                        credential_providers: entry
                            .deployment
                            .as_ref()
                            .map(|deployment| deployment.credential_providers.clone())
                            .unwrap_or_default(),
                        credential_services: Arc::clone(&self.inner.credential_services),
                        files,
                    };
                    let handler: Arc<ash_external_ext::ExtensionBackgroundClientHandler> =
                        Arc::new(move |context, operation, token, timeout| {
                            binding.request(context, operation, token, timeout)
                        });
                    entry.client_scope = EditorClientScope::Bound { owner };
                    Some(handler)
                }
                EditorClientScope::Unsupported => None,
                EditorClientScope::Bound { .. } => return Err(ExtensionHostRuntimeError::Stale),
            };
            entry.pending_activation = None;
            (supervisor, handler)
        };
        drop(gate);
        let runtime = Arc::downgrade(&self.inner);
        let registered_extension = extension_id.to_owned();
        supervisor.set_registration_listener(Arc::new(move |context| {
            let Some(runtime) = runtime.upgrade() else {
                return;
            };
            let published = {
                let Ok(mut state) = runtime.state.lock() else {
                    return;
                };
                let current = state
                    .entry(owner, &registered_extension)
                    .and_then(|entry| entry.supervisor.as_ref())
                    .map(ExtensionHostSupervisor::snapshot);
                if !current.is_some_and(|snapshot| {
                    snapshot.incarnation == context.incarnation
                        && snapshot.activation_generation == context.activation_generation
                }) {
                    return;
                }
                runtime.refresh_generation_locked(&mut state).ok().flatten()
            };
            runtime.publish(published);
        }));
        let failure = supervisor
            .start_with_client(initialization, handler)
            .err()
            .map(|error| projection::runtime_failure(&error, nonzero_incarnation(&supervisor)));
        let gate = self
            .inner
            .reconcile_gate
            .lock()
            .map_err(|_| ExtensionHostRuntimeError::Internal)?;
        let current = self
            .inner
            .state
            .lock()
            .map_err(|_| ExtensionHostRuntimeError::Internal)?
            .entry(owner, extension_id)
            .is_some_and(|entry| {
                entry.fallback.activation_generation == generation
                    && match entry.client_scope {
                        EditorClientScope::Unsupported => true,
                        EditorClientScope::Pending => false,
                        EditorClientScope::Bound {
                            owner: bound_owner, ..
                        } => owner == bound_owner,
                    }
            });
        if !current {
            drop(gate);
            let _ = supervisor.shutdown();
            return Err(ExtensionHostRuntimeError::Stale);
        }
        let published = {
            let mut state = self
                .inner
                .state
                .lock()
                .map_err(|_| ExtensionHostRuntimeError::Internal)?;
            state
                .entry_mut(owner, extension_id)
                .ok_or(ExtensionHostRuntimeError::Stale)?
                .failure = failure;
            self.inner.refresh_generation_locked(&mut state)?
        };
        self.inner.publish(published);
        Ok(self.snapshot_for(owner))
    }

    pub(super) fn snapshot_for(&self, owner: u64) -> ExtensionHostFleetSnapshot {
        self.inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .snapshot_for(owner)
    }

    /// Product runtime identities come from release deployments, never renderer input.
    pub(super) fn product_extension_states(&self) -> Vec<(String, bool)> {
        let state = self
            .inner
            .state
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        state
            .entries
            .iter()
            .filter(|(_, entry)| entry.scope == source::EditorExtensionScope::Product)
            .map(|(id, entry)| {
                // Shared Rust providers and per-window providers belong to the same
                // product catalog; neither execution scope implies enablement.
                let running = std::iter::once(entry)
                    .chain(state.windows.values().filter_map(|entries| entries.get(id)))
                    .any(|entry| {
                        entry.supervisor.as_ref().is_some_and(|supervisor| {
                            supervisor.snapshot().status
                                == ash_external_ext::ExtensionHostStatus::Ready
                        })
                    });
                (id.clone(), running)
            })
            .collect()
    }

    pub(super) fn start_invocation(
        &self,
        owner: u64,
        request: ExtensionHostInvocationRequest,
        files: Result<Arc<dyn ash_file_system::FileSystem>, ash_external_ext::HostFailure>,
    ) -> Result<String, ExtensionHostRuntimeError> {
        self.inner.start_invocation(owner, request, files)
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
        retention: ResultRetention,
    ) -> Result<ExtensionHostInvocationCancelDisposition, ExtensionHostRuntimeError> {
        self.inner
            .sessions
            .lock()
            .map_err(|_| ExtensionHostRuntimeError::Internal)?
            .cancel(owner, id, CancelReason::Caller, retention)
    }

    pub(super) fn close_owner(&self, owner: u64) {
        let (entries, handles) = {
            let Ok(_gate) = self.inner.reconcile_gate.lock() else {
                return;
            };
            let entries = self
                .inner
                .state
                .lock()
                .map(|mut state| state.windows.remove(&owner).unwrap_or_default())
                .unwrap_or_default();
            let handles = self
                .inner
                .sessions
                .lock()
                .map(|mut sessions| sessions.detach_owner(owner, CancelReason::Shutdown))
                .unwrap_or_default();
            if let Ok(mut state) = self.inner.state.lock() {
                if let Ok(published) = self.inner.refresh_generation_locked(&mut state) {
                    drop(state);
                    self.inner.publish(published);
                }
            }
            (entries, handles)
        };
        // Retire the owner's registrations and invocation sessions before any blocking I/O.
        // A slow deactivate/exit belongs to this window; it must not hold the fleet gate
        // needed by a reloaded window or another client's activation. Cleanup still joins.
        cancel_handles(handles, CancelReason::Shutdown);
        for entry in entries.into_values() {
            if let Some(supervisor) = entry.supervisor {
                let _ = supervisor.shutdown();
            }
        }
        let resolvers = self
            .inner
            .state
            .lock()
            .map(|state| {
                state
                    .entries
                    .values()
                    .filter_map(|entry| entry.supervisor.as_ref())
                    .flat_map(|supervisor| {
                        let snapshot = supervisor.snapshot();
                        snapshot
                            .registrations
                            .into_iter()
                            .filter_map(move |registration| {
                                if snapshot.status != ExtensionHostStatus::Ready
                                    || !matches!(
                                        registration.kind,
                                        RegistrationKind::RemoteAuthorityResolver { .. }
                                    )
                                {
                                    return None;
                                }
                                Some((
                                    supervisor.clone(),
                                    registration.registration_id,
                                    snapshot.incarnation,
                                    snapshot.activation_generation,
                                ))
                            })
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        if resolvers.is_empty() {
            return;
        }
        // Socket resources outlive individual invocations, but never their owning connection.
        // Cleanup stays in the SDK owner and cannot issue client requests after disconnect.
        let _ = std::thread::Builder::new()
            .name("ash-extension-connection-cleanup".into())
            .spawn(move || {
                for (supervisor, registration_id, incarnation, activation_generation) in resolvers {
                    let (Some(incarnation), Some(activation_generation)) = (
                        NonZeroU64::new(incarnation),
                        NonZeroU64::new(activation_generation),
                    ) else {
                        continue;
                    };
                    let deadline = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .unwrap_or_default()
                        .as_millis() as u64
                        + 10_000;
                    let request = ExtensionInvocation {
                        registration_id,
                        operation: "remoteReleaseOwner".into(),
                        payload: serde_json::json!({"__connectionOwner": owner.to_string()}),
                        deadline_unix_millis: NonZeroU64::new(deadline)
                            .expect("cleanup deadline is positive"),
                    };
                    if let Ok(handle) = supervisor.begin_fenced_invoke(
                        ExtensionInvocationTarget {
                            registration_generation: None,
                            incarnation,
                            activation_generation,
                        },
                        request,
                    ) {
                        let _ = handle.wait();
                    }
                }
            });
    }
}

struct EditorClientBinding {
    runtime: Weak<RuntimeInner>,
    // The entry identity fences replacement supervisors whose local counters may repeat.
    activation: Weak<Mutex<()>>,
    backend_channels: BTreeMap<String, String>,
    credential_providers: Vec<String>,
    credential_services: Arc<Mutex<BTreeMap<String, Arc<CredentialHandler>>>>,
    client_host: Arc<crate::client_host::ClientHost>,
    owner: u64,
    extension_id: String,
    workspace_read: source::WorkspaceReadAccess,
    files: Result<Arc<dyn ash_file_system::FileSystem>, ash_external_ext::HostFailure>,
}

impl EditorClientBinding {
    /// A product grant binds a channel to one exact provider deployment. A package
    /// cannot replace a disabled provider by registering the same channel name.
    fn request_channel(
        &self,
        channel: &str,
        payload: Value,
        token: &ash_async_utils::CancellationToken,
        timeout: Duration,
    ) -> Result<external_ext_protocol::ExtensionClientResult, ash_external_ext::HostFailure> {
        use ash_external_ext::HostErrorCode;
        use ash_external_ext::HostFailure;
        let failure = |code, message: &str| HostFailure {
            code,
            message: message.into(),
        };
        let deadline = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
            .saturating_add(timeout.as_millis());
        let host_failure = |error: ExtensionHostError| {
            let code = match &error {
                ExtensionHostError::HostRejected { code, .. } => *code,
                ExtensionHostError::RequestTimedOut
                | ExtensionHostError::StartupTimedOut
                | ExtensionHostError::ShutdownTimedOut => HostErrorCode::DeadlineExceeded,
                ExtensionHostError::QuotaExceeded(_)
                | ExtensionHostError::RequestIdentityExhausted => HostErrorCode::QuotaExceeded,
                ExtensionHostError::AuthorityDenied => HostErrorCode::PermissionDenied,
                ExtensionHostError::RegistrationNotFound => HostErrorCode::RegistrationNotFound,
                ExtensionHostError::CrashLoop
                | ExtensionHostError::IsolationUnavailable
                | ExtensionHostError::InvalidLimits(_)
                | ExtensionHostError::InvalidProtocol(_)
                | ExtensionHostError::HostRestarted
                | ExtensionHostError::HostExited
                | ExtensionHostError::OutcomeIndeterminate
                | ExtensionHostError::SpawnFailed
                | ExtensionHostError::Transport(_) => HostErrorCode::RegistrationNotFound,
            };
            failure(code, "capability invocation failed")
        };
        let provider = self
            .backend_channels
            .get(channel)
            .filter(|provider| *provider != &self.extension_id)
            .ok_or_else(|| {
                failure(
                    HostErrorCode::PermissionDenied,
                    "capability is not granted to this package",
                )
            })?;
        token
            .check()
            .map_err(|_| failure(HostErrorCode::Cancelled, "capability request cancelled"))?;
        let runtime = self.runtime.upgrade().ok_or_else(|| {
            failure(
                HostErrorCode::RegistrationNotFound,
                "capability host is unavailable",
            )
        })?;
        let activation = {
            let state = runtime.state.lock().map_err(|_| {
                failure(
                    HostErrorCode::Internal,
                    "capability registry is unavailable",
                )
            })?;
            let entry = state.entry(self.owner, provider).ok_or_else(|| {
                failure(
                    HostErrorCode::RegistrationNotFound,
                    "capability provider is unavailable",
                )
            })?;
            entry
                .pending_activation
                .as_ref()
                .map(|_| entry.fallback.activation_generation)
        };
        if let Some(generation) = activation {
            ExtensionHostRuntime {
                inner: Arc::clone(&runtime),
            }
            .activate_by_event(
                self.owner,
                provider,
                generation,
                source::ActivationEvent::Capability(channel.into()),
                None,
                self.files.clone(),
            )
            .map_err(|_| {
                failure(
                    HostErrorCode::RegistrationNotFound,
                    "capability activation failed",
                )
            })?;
            token
                .check()
                .map_err(|_| failure(HostErrorCode::Cancelled, "capability request cancelled"))?;
        }
        let (supervisor, snapshot, binding) = {
            let state = runtime.state.lock().map_err(|_| {
                failure(
                    HostErrorCode::Internal,
                    "capability registry is unavailable",
                )
            })?;
            let entry = state.entry(self.owner, provider).ok_or_else(|| {
                failure(
                    HostErrorCode::RegistrationNotFound,
                    "capability provider is unavailable",
                )
            })?;
            let supervisor = entry.supervisor.clone().ok_or_else(|| {
                failure(
                    HostErrorCode::RegistrationNotFound,
                    "capability provider is unavailable",
                )
            })?;
            let snapshot = supervisor.snapshot();
            if snapshot.status != ExtensionHostStatus::Ready || !snapshot.registrations.iter().any(|registration| {
                registration.registration_id == channel
                    && matches!(&registration.kind, RegistrationKind::DataChannel { channel_id } if channel_id == channel)
            }) {
                return Err(failure(HostErrorCode::RegistrationNotFound, "capability provider is unavailable"));
            }
            let binding = EditorClientBinding {
                runtime: self.runtime.clone(),
                activation: Arc::downgrade(&entry.activation_gate),
                backend_channels: entry.backend_channels.clone(),
                credential_providers: Vec::new(),
                credential_services: Arc::clone(&self.credential_services),
                client_host: Arc::clone(&self.client_host),
                owner: self.owner,
                extension_id: provider.clone(),
                workspace_read: entry.workspace_read,
                files: self.files.clone(),
            };
            (supervisor, snapshot, binding)
        };
        let handle = supervisor
            .begin_fenced_invoke(
                ExtensionInvocationTarget {
                    registration_generation: None,
                    incarnation: NonZeroU64::new(snapshot.incarnation).ok_or_else(|| {
                        failure(
                            HostErrorCode::RegistrationNotFound,
                            "capability host is unavailable",
                        )
                    })?,
                    activation_generation: NonZeroU64::new(snapshot.activation_generation)
                        .ok_or_else(|| {
                            failure(
                                HostErrorCode::RegistrationNotFound,
                                "capability host is unavailable",
                            )
                        })?,
                },
                ExtensionInvocation {
                    registration_id: channel.into(),
                    operation: "receiveData".into(),
                    payload,
                    deadline_unix_millis: NonZeroU64::new(deadline.min(u64::MAX as u128) as u64)
                        .ok_or_else(|| {
                            failure(
                                HostErrorCode::DeadlineExceeded,
                                "capability deadline exceeded",
                            )
                        })?,
                },
            )
            .map_err(&host_failure)?;
        let result = std::thread::scope(|scope| {
            let (done, completion) = std::sync::mpsc::channel();
            let handle_ref = &handle;
            scope.spawn(move || {
                while completion.recv_timeout(Duration::from_millis(10))
                    == Err(std::sync::mpsc::RecvTimeoutError::Timeout)
                {
                    if token.is_cancelled() {
                        let _ = handle_ref.cancel(CancelReason::Caller);
                        break;
                    }
                }
            });
            let result = handle.wait_with_client(|operation, token, remaining| {
                binding.request(
                    ash_external_ext::HostEventContext::new(
                        snapshot.incarnation,
                        snapshot.activation_generation,
                    ),
                    operation,
                    token,
                    remaining,
                )
            });
            let _ = done.send(());
            result
        })
        .map_err(host_failure)?;
        token
            .check()
            .map_err(|_| failure(HostErrorCode::Cancelled, "capability request cancelled"))?;
        Ok(external_ext_protocol::ExtensionClientResult::Value {
            value: result.payload,
        })
    }

    fn request(
        &self,
        context: ash_external_ext::HostEventContext,
        operation: external_ext_protocol::ExtensionClientOperation,
        token: &ash_async_utils::CancellationToken,
        timeout: Duration,
    ) -> Result<external_ext_protocol::ExtensionClientResult, ash_external_ext::HostFailure> {
        if let external_ext_protocol::ExtensionClientOperation::BackendRequest {
            capability,
            method,
            params,
            progress: None,
        } = &operation
            && method == "receiveData"
        {
            return self.request_channel(capability, params.clone(), token, timeout);
        }
        if let external_ext_protocol::ExtensionClientOperation::ReadWorkspaceFile { path } =
            &operation
        {
            return client::read_workspace_file(self.workspace_read, &self.files, path, token);
        }
        if matches!(
            operation,
            external_ext_protocol::ExtensionClientOperation::ReadResourceFile { .. }
                | external_ext_protocol::ExtensionClientOperation::StatResource { .. }
                | external_ext_protocol::ExtensionClientOperation::ReadResourceDirectory { .. }
        ) && self.workspace_read == source::WorkspaceReadAccess::Denied
        {
            return Err(external_ext_protocol::HostFailure {
                code: external_ext_protocol::HostErrorCode::PermissionDenied,
                message: "extension has no directory read permission".into(),
            });
        }
        if let external_ext_protocol::ExtensionClientOperation::CoreService { request } = &operation
        {
            if matches!(
                request,
                external_ext_protocol::services::CoreServiceRequest::StorageGet { .. }
                    | external_ext_protocol::services::CoreServiceRequest::StorageSet { .. }
                    | external_ext_protocol::services::CoreServiceRequest::StorageDelete { .. }
            ) {
                return self.storage(context, request, token, timeout);
            }
            if matches!(
                request,
                external_ext_protocol::services::CoreServiceRequest::SecretLoad { .. }
                    | external_ext_protocol::services::CoreServiceRequest::SecretStore { .. }
                    | external_ext_protocol::services::CoreServiceRequest::SecretDelete { .. }
            ) {
                return self.secrets(context, request, token, timeout);
            }
            let denied = || external_ext_protocol::HostFailure {
                code: external_ext_protocol::HostErrorCode::PermissionDenied,
                message: "credential service is not granted to this package".into(),
            };
            let external_ext_protocol::services::CoreServiceRequest::CredentialGet {
                provider_id,
                host,
                account_id,
            } = request
            else {
                return Err(denied());
            };
            if !self.credential_providers.contains(provider_id)
                || host.is_empty()
                || host.len() > 253
                || host.chars().any(char::is_control)
                || account_id.as_ref().is_some_and(|id| id.len() > 1024)
            {
                return Err(denied());
            }
            let parsed = url::Url::parse(&format!("https://{host}/")).map_err(|_| denied())?;
            if parsed.host_str() != Some(host)
                || parsed.port().is_some()
                || !parsed.username().is_empty()
                || parsed.password().is_some()
            {
                return Err(denied());
            }
            token.check().map_err(|_| denied())?;
            let handler = self
                .credential_services
                .lock()
                .map_err(|_| denied())?
                .get(provider_id)
                .cloned()
                .ok_or_else(denied)?;
            let response = handler(host, account_id.as_deref(), token)?;
            token.check().map_err(|_| denied())?;
            return Ok(external_ext_protocol::ExtensionClientResult::CoreService { response });
        }
        self.client_host
            .request_with_timeout(
                self.owner,
                ash_app_server_protocol::protocol::registry::HostMethod::ExtensionClientRequest,
                &ash_app_server_protocol::protocol::extension_host::ExtensionClientRequestParams {
                    extension_id: self.extension_id.clone(),
                    activation_generation: context.activation_generation,
                    incarnation: context.incarnation,
                    operation,
                },
                token,
                timeout,
            )
            .map_err(|error| {
                use crate::client_host::ClientHostError;
                let code = match error {
                    ClientHostError::Cancelled(_) | ClientHostError::CapabilityUnavailable => {
                        ash_external_ext::HostErrorCode::Cancelled
                    }
                    ClientHostError::TimedOut => ash_external_ext::HostErrorCode::DeadlineExceeded,
                    ClientHostError::Failed(_) => ash_external_ext::HostErrorCode::Internal,
                };
                ash_external_ext::HostFailure {
                    code,
                    message: "editor service request failed".into(),
                }
            })
    }
}

impl RuntimeInner {
    fn start_invocation(
        self: &Arc<Self>,
        owner: u64,
        mut request: ExtensionHostInvocationRequest,
        files: Result<Arc<dyn ash_file_system::FileSystem>, ash_external_ext::HostFailure>,
    ) -> Result<String, ExtensionHostRuntimeError> {
        let _gate = self
            .reconcile_gate
            .lock()
            .map_err(|_| ExtensionHostRuntimeError::Internal)?;
        let (supervisor, activation, workspace_read, credential_providers) = {
            let state = self
                .state
                .lock()
                .map_err(|_| ExtensionHostRuntimeError::Internal)?;
            let entry = state
                .entry(owner, &request.extension_id)
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
            if matches!(registration.kind, RegistrationKind::SpeechProvider { registration_generation, .. } if request.registration_generation != Some(registration_generation))
            {
                return Err(ExtensionHostRuntimeError::Stale);
            }
            if !registration_allows_operation(&registration.kind, &request.operation) {
                return Err(ExtensionHostRuntimeError::Stale);
            }
            if matches!(
                registration.kind,
                RegistrationKind::RemoteAuthorityResolver { .. }
            ) {
                let payload = request
                    .payload
                    .as_object_mut()
                    .ok_or(ExtensionHostRuntimeError::Stale)?;
                payload.insert("__connectionOwner".into(), Value::String(owner.to_string()));
            }
            (
                supervisor,
                Arc::downgrade(&entry.activation_gate),
                entry.workspace_read,
                entry
                    .deployment
                    .as_ref()
                    .map(|deployment| deployment.credential_providers.clone())
                    .unwrap_or_default(),
            )
        };
        let deadline = NonZeroU64::new(request.deadline_unix_millis)
            .ok_or(ExtensionHostRuntimeError::Stale)?;
        let target = ExtensionInvocationTarget {
            registration_generation: request.registration_generation,
            incarnation: NonZeroU64::new(request.incarnation)
                .ok_or(ExtensionHostRuntimeError::Stale)?,
            activation_generation: NonZeroU64::new(request.activation_generation)
                .ok_or(ExtensionHostRuntimeError::Stale)?,
        };
        // First resource IO adopts a delivered profile lease. Keep the moved
        // lease until dispatch succeeds so quota or transport failure still closes it.
        let adoption = if matches!(
            request.operation.as_str(),
            "openTaskTerminal"
                | "readTaskTerminal"
                | "inputTaskTerminal"
                | "resizeTaskTerminal"
                | "closeTaskTerminal"
        ) {
            request
                .payload
                .get("ptyId")
                .and_then(Value::as_str)
                .and_then(|pty_id| {
                    self.sessions.lock().ok()?.take_profile_resource(
                        owner,
                        &request.extension_id,
                        target,
                        &request.registration_id,
                        pty_id,
                    )
                })
        } else {
            None
        };
        let id = self.allocate_invocation_id(owner)?;
        self.sessions
            .lock()
            .map_err(|_| ExtensionHostRuntimeError::Internal)?
            .reserve(
                id.clone(),
                owner,
                request.incarnation,
                request.extension_id.clone(),
            )?;
        // This operation is admitted only on a terminal profile factory. Its
        // returned resource stays with the invocation until successful first resource IO.
        let result_cleanup = (request.operation == "createTerminalProfile")
            .then(|| ProfileResultCleanup::new(supervisor.clone(), target));
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
            .install(&id, Arc::clone(&handle), result_cleanup)?;
        let weak = Arc::downgrade(self);
        let invocation_id = id.clone();
        let client_host = Arc::clone(&self.client_host);
        let extension_id = request.extension_id;
        let activation_generation = request.activation_generation;
        let incarnation = request.incarnation;
        let binding = EditorClientBinding {
            runtime: Arc::downgrade(self),
            activation,
            backend_channels: {
                let state = self
                    .state
                    .lock()
                    .map_err(|_| ExtensionHostRuntimeError::Internal)?;
                state
                    .entry(owner, &extension_id)
                    .ok_or(ExtensionHostRuntimeError::Stale)?
                    .backend_channels
                    .clone()
            },
            client_host,
            owner,
            extension_id,
            workspace_read,
            credential_providers,
            credential_services: Arc::clone(&self.credential_services),
            files,
        };
        if std::thread::Builder::new()
            .name("ash-extension-invocation".into())
            .spawn(move || {
                let result = handle.wait_with_client(|operation, token, remaining| {
                    binding.request(
                        ash_external_ext::HostEventContext::new(incarnation, activation_generation),
                        operation,
                        token,
                        remaining,
                    )
                });
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
        if let Some(adoption) = adoption {
            adoption.adopt();
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
        result: Result<ash_external_ext::InvokeResult, ExtensionHostError>,
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
            .map(|state| {
                let mut entries = std::mem::take(&mut state.entries)
                    .into_values()
                    .collect::<Vec<_>>();
                entries.extend(
                    std::mem::take(&mut state.windows)
                        .into_values()
                        .flat_map(BTreeMap::into_values),
                );
                entries
            })
            .unwrap_or_default();
        for entry in entries {
            if let Some(supervisor) = entry.supervisor {
                let _ = supervisor.shutdown();
            }
        }
    }
}

fn registration_allows_operation(registration: &RegistrationKind, operation: &str) -> bool {
    match registration {
        RegistrationKind::TreeDataProvider { .. } => operation == "tree",
        RegistrationKind::RemoteConnectionResolver { .. } => operation == "resolveConnection",
        RegistrationKind::RemoteAuthorityResolver { .. } => matches!(
            operation,
            "resolveAuthority"
                | "getCanonicalURI"
                | "remoteConnect"
                | "remoteRead"
                | "remoteWrite"
                | "remoteDrain"
                | "remoteEnd"
                | "remoteRelease"
        ),
        RegistrationKind::CustomTextEditor { .. } => operation == "resolveCustomTextEditor",
        RegistrationKind::SourceControl { .. } => operation == "scm",
        RegistrationKind::StatusBar { .. } => false,
        RegistrationKind::WorkspaceEvents {} => operation == "workspaceEvent",
        RegistrationKind::OutputEvents {} => operation == "outputEvent",
        RegistrationKind::TextDocumentEvents {} => operation == "documentEvent",
        RegistrationKind::DebugEvents {} => operation == "debugEvent",
        RegistrationKind::TaskEvents {} => matches!(
            operation,
            "taskEvent"
                | "createTaskTerminal"
                | "openTaskTerminal"
                | "readTaskTerminal"
                | "inputTaskTerminal"
                | "resizeTaskTerminal"
                | "closeTaskTerminal"
        ),
        RegistrationKind::ExternalUriOpener { .. } => {
            matches!(operation, "canOpenExternalUri" | "openExternalUri")
        }
        RegistrationKind::Command { .. } => operation == "execute",
        RegistrationKind::LanguageProvider { operations, .. } => operations
            .iter()
            .any(|candidate| language_operation_name(*candidate) == operation),
        RegistrationKind::DebugAdapter { .. } => matches!(
            operation,
            "createDebugAdapterDescriptor"
                | "sendInlineDebugAdapter"
                | "readInlineDebugAdapter"
                | "closeInlineDebugAdapter"
        ),
        RegistrationKind::DebugAdapterTracker { .. } => {
            matches!(
                operation,
                "createDebugAdapterTracker" | "debugAdapterTrackerEvent"
            )
        }
        RegistrationKind::DebugConfigurationProvider { .. } => matches!(
            operation,
            "provideDebugConfigurations"
                | "resolveDebugConfiguration"
                | "resolveDebugConfigurationWithSubstitutedVariables"
        ),
        RegistrationKind::TerminalProfileProvider { .. } => operation == "createTerminalProfile",
        RegistrationKind::TerminalPty {} => matches!(
            operation,
            "openTaskTerminal"
                | "readTaskTerminal"
                | "inputTaskTerminal"
                | "resizeTaskTerminal"
                | "closeTaskTerminal"
        ),
        RegistrationKind::TerminalCompletionProvider { .. } => {
            operation == "provideTerminalCompletions"
        }
        RegistrationKind::TerminalQuickFixProvider { .. } => matches!(
            operation,
            "provideTerminalQuickFixes" | "handleTerminalQuickFix"
        ),
        RegistrationKind::TerminalLinkProvider {} => {
            matches!(operation, "provideTerminalLinks" | "handleTerminalLink")
        }
        RegistrationKind::TerminalEnvironment {} => operation == "getTerminalEnvironment",
        RegistrationKind::TaskProvider { .. } => matches!(
            operation,
            "provideTasks"
                | "resolveTask"
                | "createTaskTerminal"
                | "openTaskTerminal"
                | "readTaskTerminal"
                | "inputTaskTerminal"
                | "resizeTaskTerminal"
                | "closeTaskTerminal"
        ),
        RegistrationKind::TestProfileProvider { .. } => operation == "provideTestProfiles",
        RegistrationKind::SpeechProvider { .. } => matches!(
            operation,
            "createSpeechSession" | "readSpeechSession" | "synthesizeSpeech" | "closeSpeechSession"
        ),
        RegistrationKind::DataChannel { .. } => operation == "receiveData",
        RegistrationKind::LinkPresentationProvider { .. } => operation == "provideLinkPresentation",
    }
}

fn language_operation_name(operation: LanguageProviderOperation) -> &'static str {
    match operation {
        LanguageProviderOperation::Diagnostics => "diagnostics",
        LanguageProviderOperation::SelectionRanges => "selectionRanges",
        LanguageProviderOperation::DocumentHighlights => "documentHighlights",
        LanguageProviderOperation::WorkspaceSymbols => "workspaceSymbols",
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
    extension_packages_changes: Option<std::sync::mpsc::Receiver<u64>>,
    extension_packages_admission_changes: Option<std::sync::mpsc::Receiver<u64>>,
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
        let extension_packages_changed = extension_packages_changes
            .as_ref()
            .is_some_and(|changes| changes.try_recv().is_ok());
        let extension_packages_admission_changed = extension_packages_admission_changes
            .as_ref()
            .is_some_and(|changes| changes.try_recv().is_ok());
        let changed =
            plugin_changed || extension_packages_changed || extension_packages_admission_changed;
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
    handles: Vec<Arc<ash_external_ext::ExtensionInvocationHandle>>,
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

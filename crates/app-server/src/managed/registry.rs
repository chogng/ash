use ash_async_utils::CancellationToken;
use ash_async_utils::FutureCancellationExt;
use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread;

use crate::AppServer;
use crate::AppServerOptions;
use crate::LocalProductServicesConfig;
use crate::LocalProfileRuntime;
use crate::open_app_server;

use ash_app_server_daemon::ConnectionOptions;
use ash_app_server_daemon::GrantSource;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_remote::RemoteDirPath;
use ash_remote::RemoteProfile;
use ash_remote::SshHost;
use ash_remote::SshTarget;
use ash_remote_profile_store::RemoteConnectionProfileStore;

const MAX_PRODUCT_SERVICES_IDENTITY_BYTES: u64 = 1024 * 1024;
const IDLE_DIRECTORY_CACHE_CAPACITY: usize = 4;
static DIRECTORY_ACCESS_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct DirRuntimeKey {
    dir_root: Option<PathBuf>,
    dir_grant_source: GrantSource,
    product_services_identity: Option<[u8; 32]>,
}

#[derive(Default)]
struct DirRuntime {
    server: OnceLock<Arc<AppServer>>,
    opening: Mutex<DirectoryOpening>,
    changed: Condvar,
    last_used: AtomicU64,
}

#[derive(Default)]
enum DirectoryOpening {
    #[default]
    Idle,
    Running {
        waiters: BTreeMap<u64, tokio::sync::oneshot::Sender<Result<Arc<AppServer>, String>>>,
    },
    Failed(String),
}

enum DirectoryWaiter {
    Queued(tokio::sync::oneshot::Sender<Result<Arc<AppServer>, String>>),
    Registered { directory: Arc<DirRuntime>, id: u64 },
    Released,
}

struct DirectoryAdmission {
    count: Arc<AtomicUsize>,
    waiter: Arc<Mutex<DirectoryWaiter>>,
}

impl Drop for DirectoryAdmission {
    fn drop(&mut self) {
        let waiter =
            std::mem::replace(&mut *self.waiter.lock().unwrap(), DirectoryWaiter::Released);
        // Release the registration lock before acquiring the directory lock. Admission
        // takes them in the opposite order, so dropping a wait cannot deadlock startup.
        if let DirectoryWaiter::Registered { directory, id } = waiter
            && let DirectoryOpening::Running { waiters } = &mut *directory.opening.lock().unwrap()
        {
            waiters.remove(&id);
        }
        self.count.fetch_sub(1, Ordering::AcqRel);
    }
}

pub(crate) struct ProfileAppServerRegistry {
    diff_handler: crate::DiffRequestHandler,
    host: ConnectionOptions,
    profile_runtime: Arc<LocalProfileRuntime>,
    servers: Arc<Mutex<BTreeMap<DirRuntimeKey, Arc<DirRuntime>>>>,
    startup: DirectoryStartup,
}

impl ProfileAppServerRegistry {
    #[cfg(test)]
    pub(crate) fn open(
        host: ConnectionOptions,
        diff_handler: crate::DiffRequestHandler,
    ) -> Result<Self, String> {
        Self::open_with_terminal_host(host, diff_handler, None)
    }

    pub(super) fn open_with_terminal_host(
        host: ConnectionOptions,
        diff_handler: crate::DiffRequestHandler,
        terminal_host: Option<PathBuf>,
    ) -> Result<Self, String> {
        if let Some(path) = host.product_services() {
            LocalProductServicesConfig::load(path, host.profile_root())
                .map_err(|error| error.to_string())?;
        }
        let mut profile_runtime =
            LocalProfileRuntime::open(host.profile_root()).map_err(|error| error.to_string())?;
        if let Some(exporter) = crate::trace::from_environment()? {
            profile_runtime = profile_runtime.with_trace_exporter(exporter);
        }
        profile_runtime.terminal_host = terminal_host;
        let profile_runtime = Arc::new(profile_runtime);
        let servers = Arc::new(Mutex::new(BTreeMap::new()));
        let startup = DirectoryStartup::start(
            host.clone(),
            Arc::clone(&profile_runtime),
            Arc::clone(&servers),
            diff_handler,
        )?;
        Ok(Self {
            diff_handler,
            host,
            profile_runtime,
            servers,
            startup,
        })
    }

    pub(crate) fn server_for(&self, prelude: ConnectionOptions) -> Result<Arc<AppServer>, String> {
        server_for(
            &self.host,
            &self.profile_runtime,
            &self.servers,
            prelude,
            self.diff_handler,
        )
    }

    /// A Web listener owns its directory set; it must never mutate the cached Desktop runtime.
    pub(crate) fn open_web_workspace(
        &self,
        options: &ConnectionOptions,
    ) -> Result<Arc<AppServer>, String> {
        open_server_with_profile_runtime(
            options,
            Arc::clone(&self.profile_runtime),
            self.diff_handler,
            DirectoryRuntimeScope::WebSession,
        )
        .map(AppServer::into_shared)
    }

    pub(crate) fn open_native_web_workspace(
        &self,
        options: &ConnectionOptions,
        grant: ash_file_access::Grant,
        authority_revision: ash_config::ConfigRevision,
    ) -> Result<Arc<AppServer>, String> {
        open_server_with_profile_runtime(
            options,
            Arc::clone(&self.profile_runtime),
            self.diff_handler,
            DirectoryRuntimeScope::ApprovedWeb {
                grant,
                authority_revision,
            },
        )
        .map(AppServer::into_shared)
    }

    fn local_options(&self, root: &Path) -> ConnectionOptions {
        ConnectionOptions::new(
            self.host.profile_root(),
            Some(root.to_path_buf()),
            GrantSource::UserConfig,
            self.host.product_services().map(Path::to_path_buf),
        )
    }

    pub(crate) async fn open_local_session(
        &self,
        root: &Path,
        cancellation: &CancellationToken,
    ) -> Result<Arc<AppServer>, String> {
        cancellation
            .check()
            .map_err(|_| "Directory connection closed".to_string())?;
        self.startup
            .waiters
            .try_update(Ordering::AcqRel, Ordering::Acquire, |count| {
                (count < 64).then_some(count + 1)
            })
            .map_err(|_| "Directory startup waiter capacity exhausted".to_string())?;
        let (response, received) = tokio::sync::oneshot::channel();
        let waiter = Arc::new(Mutex::new(DirectoryWaiter::Queued(response)));
        let _admission = DirectoryAdmission {
            count: Arc::clone(&self.startup.waiters),
            waiter: Arc::clone(&waiter),
        };
        self.startup
            .input
            .as_ref()
            .expect("registry owns startup sender")
            .try_send(DirectoryRequest {
                options: self.local_options(root),
                waiter,
                id: self.startup.next_waiter_id.fetch_add(1, Ordering::Relaxed),
            })
            .map_err(|_| "Directory startup capacity exhausted".to_string())?;
        received
            .with_cancellation(cancellation.clone())
            .await
            .map_err(|_| "Directory connection closed".to_string())?
            .map_err(|_| "Directory startup worker closed".to_string())?
    }

    /// Find an already-authorized local runtime without interpreting the visible Workspace.
    /// Discovery does not open arbitrary paths or grant access; the routed endpoint authorizes
    /// again, including after a grant is revoked between discovery and the file operation.
    pub(crate) fn file_execution_target(
        &self,
        path: &Path,
    ) -> Result<Option<ash_protocol::SessionExecutionTarget>, String> {
        let servers = self
            .servers
            .lock()
            .map_err(|_| "local App Server dir registry lock poisoned".to_string())?
            .iter()
            .filter_map(|(key, runtime)| {
                runtime
                    .server
                    .get()
                    .map(|server| (key.dir_root.clone(), Arc::clone(server)))
            })
            .collect::<Vec<_>>();
        // Prefer the narrowest authorized directory, just as fs/resolvePath does within one
        // runtime. Keep registry order for equal roots so selection cannot change the route.
        let mut selected = None;
        for (root, server) in servers {
            if let Ok(directory) = server.resolve_file_path(path) {
                let depth = directory.root.components().count();
                if selected.as_ref().is_none_or(|(best, _)| depth > *best) {
                    selected = Some((depth, root));
                }
            }
        }
        Ok(selected
            .and_then(|(_, root)| root)
            .map(|root| ash_protocol::SessionExecutionTarget::Local { root }))
    }

    pub(crate) fn local_session(
        &self,
        session_id: &SessionId,
    ) -> Result<Option<ash_protocol::Session>, String> {
        self.profile_runtime.local_session(session_id)
    }

    pub(crate) fn local_thread_session(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Option<ash_protocol::Session>, String> {
        self.profile_runtime.local_thread_session(thread_id)
    }

    pub(crate) fn remote_profiles(&self) -> Result<Vec<super::gateway::RemoteEndpoint>, String> {
        let imported = self.profile_runtime.imported_history_hosts()?;
        let mut profiles: Vec<super::gateway::RemoteEndpoint> =
            RemoteConnectionProfileStore::from_profile_root(self.host.profile_root())
                .connections()
                .map(|records| {
                    records
                        .into_iter()
                        .map(|record| record.active_profile())
                        .filter(|profile| {
                            !imported
                                .iter()
                                .any(|host| host == profile.target().host().as_str())
                        })
                        .map(super::gateway::RemoteEndpoint::Ssh)
                        .collect()
                })
                .map_err(|error| error.to_string())?;
        for target in self.profile_runtime.session_runtimes.targets() {
            profiles.push(self.remote_endpoint(&target)?);
        }
        Ok(profiles)
    }

    pub(crate) fn remote_endpoint(
        &self,
        target: &ash_protocol::SessionExecutionTarget,
    ) -> Result<super::gateway::RemoteEndpoint, String> {
        match target {
            ash_protocol::SessionExecutionTarget::Ssh { host, root } => self
                .remote_profile(host, root)
                .map(super::gateway::RemoteEndpoint::Ssh),
            ash_protocol::SessionExecutionTarget::Provider {
                provider_id,
                workspace,
                root,
            } => {
                let executable = self.profile_runtime.session_runtimes.executable(target)?;
                Ok(super::gateway::RemoteEndpoint::Provider {
                    key: super::gateway::RemoteKey::Provider {
                        provider_id: provider_id.clone(),
                        workspace: workspace.clone(),
                        root: root.clone(),
                    },
                    executable,
                    authority: self.profile_runtime.session_runtimes.clone(),
                    generation: self.profile_runtime.session_runtimes.generation(),
                    admission: super::gateway::ProviderConnectionAdmission::Admitted,
                })
            }
            ash_protocol::SessionExecutionTarget::Local { .. } => {
                Err("local target is not a remote endpoint".into())
            }
        }
    }

    pub(crate) fn admit_session_creation(
        &self,
        target: &ash_protocol::SessionExecutionTarget,
    ) -> Result<(), String> {
        if matches!(
            target,
            ash_protocol::SessionExecutionTarget::Provider { .. }
        ) && !self
            .profile_runtime
            .session_runtimes
            .targets()
            .contains(target)
        {
            return Err("Session creation requires a prepared Provider workspace".into());
        }
        Ok(())
    }

    pub(crate) fn remote_profile(&self, host: &str, root: &str) -> Result<RemoteProfile, String> {
        let target = SshTarget::new(
            SshHost::parse(host).map_err(|error| error.to_string())?,
            RemoteDirPath::parse(root).map_err(|error| error.to_string())?,
        );
        RemoteConnectionProfileStore::from_profile_root(self.host.profile_root())
            .connection(&target)
            .map_err(|error| error.to_string())?
            .map(|record| record.active_profile())
            .ok_or_else(|| format!("SSH runtime is not configured for {host}:{root}"))
    }

    pub(crate) fn active_terminal_count(&self) -> usize {
        self.ready_servers()
            .map(|servers| {
                servers
                    .iter()
                    .map(|server| server.active_terminal_count())
                    .sum()
            })
            .unwrap_or(1)
    }

    pub(crate) fn start_queue(self: &Arc<Self>) -> Result<queue::QueueRuntime, String> {
        queue::QueueRuntime::start(
            self.profile_runtime
                .queue_store()
                .map_err(|error| error.to_string())?,
            self.clone(),
        )
        .map_err(|error| error.to_string())
    }

    pub(crate) fn queue_needs_host(&self) -> Result<bool, String> {
        if self
            .profile_runtime
            .queue_store()
            .map_err(|error| error.to_string())?
            .needs_host()
            .map_err(|error| error.to_string())?
        {
            return Ok(true);
        }
        for server in self.ready_servers()? {
            if server.queue_needs_host()? {
                return Ok(true);
            }
        }
        Ok(false)
    }

    fn ready_servers(&self) -> Result<Vec<Arc<AppServer>>, String> {
        Ok(self
            .servers
            .lock()
            .map_err(|_| "local App Server dir registry lock poisoned".to_string())?
            .values()
            .filter_map(|runtime| runtime.server.get().map(Arc::clone))
            .collect())
    }

    pub(crate) fn start_symphony(self: &Arc<Self>) -> Result<ash_symphony::Runtime, String> {
        ash_symphony::Runtime::start(self.profile_runtime.symphony_store(), self.clone())
            .map_err(|error| error.to_string())
    }

    pub(crate) fn symphony_needs_host(&self) -> Result<bool, String> {
        self.profile_runtime
            .symphony_store()
            .needs_host()
            .map_err(|error| error.to_string())
    }

    pub(crate) fn start_automation(
        self: &Arc<Self>,
    ) -> Result<ash_automation::AutomationRuntime, String> {
        ash_automation::AutomationRuntime::start(
            self.profile_runtime.automation_store(),
            self.clone(),
        )
        .map_err(|error| error.to_string())
    }

    pub(crate) fn automation_needs_host(&self) -> Result<bool, String> {
        self.profile_runtime
            .automation_store()
            .needs_host()
            .map_err(|error| error.to_string())
    }
}

struct DirectoryRequest {
    options: ConnectionOptions,
    waiter: Arc<Mutex<DirectoryWaiter>>,
    id: u64,
}

/// Initialization belongs to the profile; a renderer owns only its cancellable wait. This
/// fixed pool also bounds cold-directory work across windows, including canonicalization.
struct DirectoryStartup {
    input: Option<mpsc::SyncSender<DirectoryRequest>>,
    workers: Vec<thread::JoinHandle<()>>,
    waiters: Arc<AtomicUsize>,
    next_waiter_id: AtomicU64,
}

impl DirectoryStartup {
    fn start(
        host: ConnectionOptions,
        profile: Arc<LocalProfileRuntime>,
        servers: Arc<Mutex<BTreeMap<DirRuntimeKey, Arc<DirRuntime>>>>,
        diff_handler: crate::DiffRequestHandler,
    ) -> Result<Self, String> {
        let (input, incoming) = mpsc::sync_channel::<DirectoryRequest>(32);
        let incoming = Arc::new(Mutex::new(incoming));
        let mut startup = Self {
            input: Some(input),
            workers: Vec::new(),
            waiters: Arc::new(AtomicUsize::new(0)),
            next_waiter_id: AtomicU64::new(0),
        };
        for index in 0..4 {
            let incoming = Arc::clone(&incoming);
            let host = host.clone();
            let profile = Arc::clone(&profile);
            let servers = Arc::clone(&servers);
            startup.workers.push(
                thread::Builder::new()
                    .name(format!("ash-directory-startup-{index}"))
                    .spawn(move || {
                        loop {
                            let Ok(request) = incoming.lock().unwrap().recv() else {
                                break;
                            };
                            if matches!(*request.waiter.lock().unwrap(), DirectoryWaiter::Released)
                            {
                                continue;
                            }
                            open_queued_directory(&host, &profile, &servers, request, diff_handler);
                        }
                    })
                    .map_err(|error| error.to_string())?,
            );
        }
        Ok(startup)
    }
}

impl Drop for DirectoryStartup {
    fn drop(&mut self) {
        self.input.take();
        for worker in self.workers.drain(..) {
            let _ = worker.join();
        }
    }
}

fn resolve_directory(
    host: &ConnectionOptions,
    servers: &Mutex<BTreeMap<DirRuntimeKey, Arc<DirRuntime>>>,
    prelude: ConnectionOptions,
) -> Result<(Arc<DirRuntime>, ConnectionOptions), String> {
    let dir_root = prelude
        .dir_root()
        .map(dunce::canonicalize)
        .transpose()
        .map_err(io_error)?;
    // A health probe or CLI client may omit distribution configuration. It shares
    // the running profile's provider authority rather than opening an empty one.
    let product_services = prelude
        .product_services()
        .or_else(|| host.product_services());
    let product_services_identity =
        product_services_identity(product_services, host.profile_root())?;
    let key = DirRuntimeKey {
        dir_root: dir_root.clone(),
        dir_grant_source: prelude.dir_grant_source(),
        product_services_identity,
    };
    // Directory startup can perform disk and provider work. Only the same directory waits
    // for it; the profile registry and already-open directories remain available.
    let runtime = Arc::clone(
        servers
            .lock()
            .map_err(|_| "local App Server dir registry lock poisoned".to_string())?
            .entry(key)
            .or_default(),
    );
    runtime.last_used.store(
        DIRECTORY_ACCESS_SEQUENCE.fetch_add(1, Ordering::Relaxed),
        Ordering::Relaxed,
    );
    prune_idle_directories(servers)?;
    let options = ConnectionOptions::new(
        host.profile_root(),
        dir_root,
        prelude.dir_grant_source(),
        product_services.map(Path::to_path_buf),
    );
    Ok((runtime, options))
}

/// Keep a small warm set without making every visited project live for the profile's lifetime.
/// Connections and directory admissions hold strong references; detached terminals and Agent
/// work also protect their services. Expensive idle checks and service destruction stay outside
/// the registry lock so another window can continue opening its directory.
fn prune_idle_directories(
    servers: &Mutex<BTreeMap<DirRuntimeKey, Arc<DirRuntime>>>,
) -> Result<(), String> {
    let candidates = servers
        .lock()
        .map_err(|_| "local App Server dir registry lock poisoned".to_string())?
        .iter()
        .filter(|(_, runtime)| {
            Arc::strong_count(runtime) == 1
                && runtime
                    .server
                    .get()
                    .is_some_and(|server| Arc::strong_count(server) == 1)
        })
        .map(|(key, runtime)| (key.clone(), Arc::clone(runtime)))
        .collect::<Vec<_>>();
    if candidates.len() <= IDLE_DIRECTORY_CACHE_CAPACITY {
        return Ok(());
    }
    let mut idle = candidates
        .into_iter()
        .filter(|(_, runtime)| {
            let server = runtime.server.get().expect("ready directory candidate");
            server.active_terminal_count() == 0 && matches!(server.queue_needs_host(), Ok(false))
        })
        .collect::<Vec<_>>();
    idle.sort_by_key(|(_, runtime)| runtime.last_used.load(Ordering::Relaxed));
    let excess = idle.len().saturating_sub(IDLE_DIRECTORY_CACHE_CAPACITY);
    let mut retired = Vec::new();
    {
        let mut entries = servers
            .lock()
            .map_err(|_| "local App Server dir registry lock poisoned".to_string())?;
        for (key, runtime) in idle.iter().take(excess) {
            // Recheck admission after the idle query: a new connection may have acquired
            // either reference while the registry lock was released.
            if Arc::strong_count(runtime) == 2
                && runtime
                    .server
                    .get()
                    .is_some_and(|server| Arc::strong_count(server) == 1)
                && entries
                    .get(key)
                    .is_some_and(|entry| Arc::ptr_eq(entry, runtime))
            {
                retired.extend(entries.remove(key));
            }
        }
    }
    drop(retired);
    Ok(())
}

fn finish_directory(
    runtime: &DirRuntime,
    result: Result<Arc<AppServer>, String>,
) -> Result<Arc<AppServer>, String> {
    let mut opening = runtime.opening.lock().unwrap();
    let DirectoryOpening::Running { waiters } =
        std::mem::replace(&mut *opening, DirectoryOpening::Idle)
    else {
        unreachable!("only an active directory initialization can complete");
    };
    // The attempt state owns pending subscribers. A successful service is published
    // once separately, so profile queries never wait for a cold directory's startup.
    let result = result.map(|server| Arc::clone(runtime.server.get_or_init(|| server)));
    if let Err(error) = &result {
        *opening = DirectoryOpening::Failed(error.clone());
    }
    runtime.changed.notify_all();
    drop(opening);
    for waiter in waiters.into_values() {
        let _ = waiter.send(result.clone());
    }
    result
}

fn server_for(
    host: &ConnectionOptions,
    profile_runtime: &Arc<LocalProfileRuntime>,
    servers: &Mutex<BTreeMap<DirRuntimeKey, Arc<DirRuntime>>>,
    prelude: ConnectionOptions,
    diff_handler: crate::DiffRequestHandler,
) -> Result<Arc<AppServer>, String> {
    let _directory = ash_app_server_daemon::startup_trace::StartupTrace::span("directory-open");
    let (runtime, options) = resolve_directory(host, servers, prelude)?;
    let mut opening = runtime
        .opening
        .lock()
        .map_err(|_| "Directory startup lock poisoned".to_string())?;
    if matches!(*opening, DirectoryOpening::Running { .. }) {
        while matches!(*opening, DirectoryOpening::Running { .. }) {
            opening = runtime.changed.wait(opening).unwrap();
        }
        if let DirectoryOpening::Failed(error) = &*opening {
            return Err(error.clone());
        }
    }
    if let Some(server) = runtime.server.get() {
        return Ok(Arc::clone(server));
    }
    *opening = DirectoryOpening::Running {
        waiters: BTreeMap::new(),
    };
    drop(opening);
    finish_directory(
        &runtime,
        open_server_with_profile_runtime(
            &options,
            Arc::clone(profile_runtime),
            diff_handler,
            DirectoryRuntimeScope::ProductHost,
        )
        .map(AppServer::into_shared),
    )
}

fn open_queued_directory(
    host: &ConnectionOptions,
    profile_runtime: &Arc<LocalProfileRuntime>,
    servers: &Mutex<BTreeMap<DirRuntimeKey, Arc<DirRuntime>>>,
    request: DirectoryRequest,
    diff_handler: crate::DiffRequestHandler,
) {
    let (runtime, options) = match resolve_directory(host, servers, request.options) {
        Ok(resolved) => resolved,
        Err(error) => {
            let waiter = std::mem::replace(
                &mut *request.waiter.lock().unwrap(),
                DirectoryWaiter::Released,
            );
            if let DirectoryWaiter::Queued(response) = waiter {
                let _ = response.send(Err(error));
            }
            return;
        }
    };
    let mut opening = runtime.opening.lock().unwrap();
    let mut waiter = request.waiter.lock().unwrap();
    let response = match std::mem::replace(&mut *waiter, DirectoryWaiter::Released) {
        DirectoryWaiter::Queued(response) => response,
        DirectoryWaiter::Released => return,
        DirectoryWaiter::Registered { .. } => unreachable!("directory request registers once"),
    };
    if let Some(server) = runtime.server.get() {
        let _ = response.send(Ok(Arc::clone(server)));
        return;
    }
    let start = match &mut *opening {
        DirectoryOpening::Running { waiters } => {
            waiters.insert(request.id, response);
            false
        }
        DirectoryOpening::Idle | DirectoryOpening::Failed(_) => {
            *opening = DirectoryOpening::Running {
                waiters: BTreeMap::from([(request.id, response)]),
            };
            true
        }
    };
    *waiter = DirectoryWaiter::Registered {
        directory: Arc::clone(&runtime),
        id: request.id,
    };
    drop(waiter);
    drop(opening);
    // Initialization belongs to the profile even after its first subscriber leaves;
    // subsequent subscribers attach without occupying additional startup workers.
    if start {
        let _ = finish_directory(
            &runtime,
            open_server_with_profile_runtime(
                &options,
                Arc::clone(profile_runtime),
                diff_handler,
                DirectoryRuntimeScope::ProductHost,
            )
            .map(AppServer::into_shared),
        );
    }
}

impl ash_symphony::Executor for ProfileAppServerRegistry {
    fn poll(
        &self,
        workflow: &ash_symphony::Workflow,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<Vec<ash_symphony::Issue>, String> {
        let server = self.server_for(self.local_options(Path::new(&workflow.directory)))?;
        let issues = server.poll_symphony(workflow, cancellation)?;
        server.cleanup_terminal_symphony(workflow, &issues, cancellation)?;
        Ok(issues)
    }

    fn advance(
        &self,
        job: &ash_symphony::Job,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<ash_symphony::Observation, String> {
        let workflow = &job
            .invocation
            .as_ref()
            .ok_or("Symphony invocation is missing")?
            .workflow;
        self.server_for(self.local_options(Path::new(&workflow.directory)))?
            .advance_symphony(job, cancellation)
    }

    fn changed(&self) {
        self.profile_runtime.symphony_changed();
    }

    fn cleanup(
        &self,
        job: &ash_symphony::Job,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<(), String> {
        let workflow = self
            .profile_runtime
            .symphony_store()
            .workflow(&job.workflow_id)
            .map_err(|error| error.to_string())?;
        self.server_for(self.local_options(Path::new(&workflow.directory)))?
            .cleanup_symphony(job, cancellation)
    }
    fn report_error(&self, message: &str) {
        eprintln!("symphony: {message}");
    }
}

impl ash_automation::AutomationExecutor for ProfileAppServerRegistry {
    fn advance(
        &self,
        run: &ash_protocol::AutomationRun,
        now: ash_protocol::UnixMillis,
    ) -> Result<ash_protocol::AutomationRun, String> {
        let options = ConnectionOptions::new(
            self.host.profile_root(),
            Some(PathBuf::from(&run.definition.directory)),
            GrantSource::UserConfig,
            self.host.product_services().map(Path::to_path_buf),
        );
        self.server_for(options)?.advance_automation_run(run, now)
    }

    fn changed(&self) {
        self.profile_runtime.automation_changed();
    }

    fn report_error(&self, message: &str) {
        eprintln!("automation: {message}");
    }
}

enum DirectoryRuntimeScope {
    ProductHost,
    WebSession,
    ApprovedWeb {
        grant: ash_file_access::Grant,
        authority_revision: ash_config::ConfigRevision,
    },
}

fn open_server_with_profile_runtime(
    host: &ConnectionOptions,
    profile_runtime: Arc<LocalProfileRuntime>,
    diff_handler: crate::DiffRequestHandler,
    scope: DirectoryRuntimeScope,
) -> Result<AppServer, String> {
    let mut options = AppServerOptions::new(host.profile_root())
        .with_host_grok_auth()
        .with_host_zcode_credentials()
        .with_profile_runtime(profile_runtime);
    options = options.with_pty_helper(std::env::current_exe().map_err(|error| error.to_string())?);
    if let Some(dir_root) = host.dir_root() {
        options = match host.dir_grant_source() {
            GrantSource::UserConfig => options.with_user_config_dir_root(dir_root),
            GrantSource::HostConfiguration => options.with_dir_root(dir_root),
        };
    }
    match scope {
        DirectoryRuntimeScope::ProductHost => {}
        DirectoryRuntimeScope::WebSession => options = options.with_web_directory_authority(),
        DirectoryRuntimeScope::ApprovedWeb {
            grant,
            authority_revision,
        } => options = options.with_native_web_directory(grant, authority_revision),
    }
    if let Some(executable) = crate::github_authentication::product_executable() {
        options = options.with_github_authentication_extension(executable);
    }
    if let Some(executable) = crate::github_extension::product_executable() {
        options = options.with_github_extension(executable);
    }
    if let Some(path) = host.product_services() {
        options = options.with_product_services(
            LocalProductServicesConfig::load(path, host.profile_root())
                .map_err(|error| error.to_string())?,
        );
    }
    open_app_server(options, diff_handler).map_err(|error| error.to_string())
}

fn product_services_identity(
    path: Option<&Path>,
    profile_root: &Path,
) -> Result<Option<[u8; 32]>, String> {
    let Some(path) = path else {
        return Ok(None);
    };
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_PRODUCT_SERVICES_IDENTITY_BYTES
    {
        return Err("Product services manifest is not a bounded regular file".into());
    }
    let services =
        LocalProductServicesConfig::load(path, profile_root).map_err(|error| error.to_string())?;
    Ok(Some(*services.authority_identity()))
}

fn io_error(error: io::Error) -> String {
    error.to_string()
}

#[cfg(test)]
#[path = "registry_tests.rs"]
mod tests;

impl queue::QueueExecutor for ProfileAppServerRegistry {
    fn ready(&self, message: &queue::QueuedMessage) -> Result<bool, String> {
        let options = ConnectionOptions::new(
            self.host.profile_root(),
            Some(PathBuf::from(&message.request.directory)),
            GrantSource::UserConfig,
            self.host.product_services().map(Path::to_path_buf),
        );
        self.server_for(options)?.queued_message_ready(message)
    }

    fn accepts(&self, _: &queue::QueuedMessage) -> bool {
        true
    }
    fn deliver(&self, message: &queue::QueuedMessage) -> Result<queue::Delivery, String> {
        let options = ConnectionOptions::new(
            self.host.profile_root(),
            Some(PathBuf::from(&message.request.directory)),
            GrantSource::UserConfig,
            self.host.product_services().map(Path::to_path_buf),
        );
        self.server_for(options)?.deliver_queued_message(message)
    }
    fn changed(&self) {
        self.profile_runtime.queue_changed();
    }
    fn report_error(&self, error: &str) {
        eprintln!("message queue: {error}");
    }
}

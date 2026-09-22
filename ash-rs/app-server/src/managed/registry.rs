use std::collections::BTreeMap;
use std::fs;
use std::io;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use crate::AppServer;
use crate::LocalAppServerOptions;
use crate::LocalProductServicesConfig;
use crate::LocalProfileRuntime;
use crate::open_local_app_server;

use ash_app_server_daemon::ConnectionOptions;
use ash_app_server_daemon::GrantSource;

const MAX_PRODUCT_SERVICES_IDENTITY_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct DirRuntimeKey {
    dir_root: Option<PathBuf>,
    dir_grant_source: GrantSource,
    product_services_identity: Option<[u8; 32]>,
}

pub(crate) struct ProfileAppServerRegistry {
    host: ConnectionOptions,
    profile_runtime: Arc<LocalProfileRuntime>,
    servers: Mutex<BTreeMap<DirRuntimeKey, Arc<AppServer>>>,
}

impl ProfileAppServerRegistry {
    pub(crate) fn open(host: ConnectionOptions) -> Result<Self, String> {
        let mut profile_runtime =
            LocalProfileRuntime::open(host.profile_root()).map_err(|error| error.to_string())?;
        if let Some(exporter) = crate::trace::from_environment()? {
            profile_runtime = profile_runtime.with_trace_exporter(exporter);
        }
        let profile_runtime = Arc::new(profile_runtime);
        Ok(Self {
            host,
            profile_runtime,
            servers: Mutex::new(BTreeMap::new()),
        })
    }

    pub(crate) fn server_for(&self, prelude: ConnectionOptions) -> Result<Arc<AppServer>, String> {
        let dir_root = prelude
            .dir_root()
            .map(dunce::canonicalize)
            .transpose()
            .map_err(io_error)?;
        let product_services_identity =
            product_services_identity(prelude.product_services(), self.host.profile_root())?;
        let key = DirRuntimeKey {
            dir_root: dir_root.clone(),
            dir_grant_source: prelude.dir_grant_source(),
            product_services_identity,
        };
        let mut servers = self
            .servers
            .lock()
            .map_err(|_| "local App Server dir registry lock poisoned".to_string())?;
        if let Some(server) = servers.get(&key) {
            return Ok(Arc::clone(server));
        }
        let host = ConnectionOptions::new(
            self.host.profile_root(),
            dir_root,
            prelude.dir_grant_source(),
            prelude.product_services().map(Path::to_path_buf),
        );
        let server = Arc::new(open_server_with_profile_runtime(
            &host,
            Arc::clone(&self.profile_runtime),
        )?);
        servers.insert(key, Arc::clone(&server));
        Ok(server)
    }

    pub(crate) fn active_terminal_count(&self) -> usize {
        self.servers
            .lock()
            .map(|servers| {
                servers
                    .values()
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
        for server in self
            .servers
            .lock()
            .map_err(|_| "queue server registry lock poisoned")?
            .values()
        {
            if server.queue_needs_host()? {
                return Ok(true);
            }
        }
        Ok(false)
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

fn open_server_with_profile_runtime(
    host: &ConnectionOptions,
    profile_runtime: Arc<LocalProfileRuntime>,
) -> Result<AppServer, String> {
    let mut options =
        LocalAppServerOptions::new(host.profile_root()).with_profile_runtime(profile_runtime);
    options = options.with_pty_helper(std::env::current_exe().map_err(|error| error.to_string())?);
    if let Some(dir_root) = host.dir_root() {
        options = match host.dir_grant_source() {
            GrantSource::UserConfig => options.with_user_config_dir_root(dir_root),
            GrantSource::HostConfiguration => options.with_dir_root(dir_root),
        };
    }
    if let Some(path) = host.product_services() {
        options = options.with_product_services(
            LocalProductServicesConfig::load(path, host.profile_root())
                .map_err(|error| error.to_string())?,
        );
    }
    open_local_app_server(options).map_err(|error| error.to_string())
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

use std::path::Path;
use std::path::PathBuf;

use anyhow::Result;
use anyhow::anyhow;
use ash_app_server_client::AppServerSession;
use ash_app_server_client::StdioAppServerCommand;
use ash_app_server_daemon::APP_SERVER_PATH_ENV;
use ash_app_server_protocol::protocol::common::ClientCapabilities;
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_app_server_protocol::protocol::common::DirPermissionsHostCapability;
use ash_remote::RemoteDirPath;
use ash_remote::RemoteProfile;
use ash_remote::SshHost;
use ash_remote::SshTarget;
use ash_remote_connections::SshAppServerConnectionOptions;

/// Application-owned App Server host context shared by Agent, Language, and Terminal adapters.
///
/// The host exposes one horizontal application backend contract. `Local` and `Remote` describe
/// how the App Server is reached; they do not create separate application APIs. Window state, panes,
/// commands, and Remote picker state remain owned by `app` outside this context.
#[derive(Clone, Debug)]
pub(crate) struct AppServerHost {
    backend: AppServerBackend,
}

#[derive(Clone, Debug)]
enum AppServerBackend {
    Local {
        cwd: PathBuf,
    },
    Remote {
        connection: SshAppServerConnectionOptions,
        cwd: PathBuf,
    },
}

impl AppServerHost {
    /// Selects the profile-scoped local App Server with an initial cwd.
    pub(crate) fn local(cwd: impl Into<PathBuf>) -> Self {
        Self {
            backend: AppServerBackend::Local { cwd: cwd.into() },
        }
    }

    /// Selects an SSH-hosted App Server and an optional application-provided OpenSSH executable.
    pub(crate) fn remote_with_executable(
        profile: RemoteProfile,
        ssh_executable: Option<&Path>,
    ) -> Self {
        let cwd = PathBuf::from(profile.target().dir().as_str());
        let mut connection = SshAppServerConnectionOptions::new(profile);
        if let Some(ssh_executable) = ssh_executable {
            connection = connection.with_ssh_executable(ssh_executable);
        }
        Self {
            backend: AppServerBackend::Remote { connection, cwd },
        }
    }

    /// Returns whether the host delegates its App Server authority to SSH.
    pub(crate) const fn is_remote(&self) -> bool {
        matches!(&self.backend, AppServerBackend::Remote { .. })
    }

    /// Returns the cwd used by App Server requests and UI context.
    pub(crate) fn cwd(&self) -> &Path {
        match &self.backend {
            AppServerBackend::Local { cwd } | AppServerBackend::Remote { cwd, .. } => cwd,
        }
    }

    /// Retargets the same local profile or SSH host/runtime to another cwd.
    pub(crate) fn with_cwd(&self, cwd: &Path) -> Result<Self> {
        match &self.backend {
            AppServerBackend::Local { .. } => Ok(Self::local(cwd)),
            AppServerBackend::Remote { connection, .. } => {
                let cwd = cwd
                    .to_str()
                    .ok_or_else(|| anyhow!("Remote cwd is not valid UTF-8"))?;
                let target = SshTarget::new(
                    connection.profile().target().host().clone(),
                    RemoteDirPath::parse(cwd).map_err(|error| anyhow!(error.to_string()))?,
                );
                Ok(Self::remote_with_executable(
                    RemoteProfile::new(target, connection.profile().runtime().clone()),
                    Some(connection.ssh_executable()),
                ))
            }
        }
    }

    /// Returns the host-owned SSH inputs reusable by sibling desktop Remote capabilities.
    pub(crate) fn ssh_transport(&self) -> Option<(&SshHost, &Path)> {
        match &self.backend {
            AppServerBackend::Local { .. } => None,
            AppServerBackend::Remote { connection, .. } => Some((
                connection.profile().target().host(),
                connection.ssh_executable(),
            )),
        }
    }

    /// Returns the Remote App Server connection backend when this host is remote.
    pub(crate) fn remote_connection(&self) -> Option<&SshAppServerConnectionOptions> {
        match &self.backend {
            AppServerBackend::Local { .. } => None,
            AppServerBackend::Remote { connection, .. } => Some(connection),
        }
    }

    /// Opens the selected backend and performs the canonical initialize/schema handshake.
    pub(crate) fn start(&self) -> Result<AppServerSession> {
        let client_info = ClientInfo {
            name: "app".into(),
            version: env!("CARGO_PKG_VERSION").into(),
        };
        match &self.backend {
            AppServerBackend::Local { cwd } => {
                let executable = std::env::current_exe()
                    .map_err(|error| anyhow!("could not resolve app executable: {error}"))?;
                let daemon_executable = Some(
                    ash_app_server_daemon::backend_executable_path()
                        .map_err(|error| anyhow!(error))?,
                );
                let command = local_app_server_command(
                    executable,
                    ash_utils_home_dir::find_ash_home()?,
                    cwd,
                    daemon_executable,
                );
                AppServerSession::start_stdio(command, client_info, local_client_capabilities())
                    .map_err(|error| anyhow!(error.to_string()))
            }
            AppServerBackend::Remote { connection, .. } => connection
                .connect(client_info, ClientCapabilities::default())
                .map_err(|error| anyhow!(error.to_string())),
        }
    }
}

impl ash_session::SessionRuntimeTarget for AppServerHost {
    fn is_remote(&self) -> bool {
        AppServerHost::is_remote(self)
    }

    fn cwd(&self) -> &Path {
        AppServerHost::cwd(self)
    }

    fn with_cwd(
        &self,
        cwd: &Path,
    ) -> ash_session::CommandResult<Box<dyn ash_session::SessionRuntimeTarget>> {
        self.with_cwd(cwd)
            .map(|target| Box::new(target) as Box<dyn ash_session::SessionRuntimeTarget>)
            .map_err(|error| error.to_string())
    }

    fn start(&self) -> ash_session::CommandResult<ash_app_server_client::AppServerSession> {
        AppServerHost::start(self).map_err(|error| error.to_string())
    }
}

impl ash_editor_host::RemoteLanguageSessionTarget for AppServerHost {
    fn is_remote(&self) -> bool {
        AppServerHost::is_remote(self)
    }

    fn start(&self) -> Result<AppServerSession> {
        AppServerHost::start(self)
    }
}

pub(crate) fn local_app_server_command(
    executable: PathBuf,
    profile_root: PathBuf,
    dir_root: &Path,
    daemon_executable: Option<PathBuf>,
) -> StdioAppServerCommand {
    let command = StdioAppServerCommand::new(executable)
        .with_argument("app-server-daemon")
        .with_argument("connect")
        .with_environment_variable("ASH_HOME", profile_root.into_os_string())
        .with_environment_variable("ASH_WORKSPACE_ROOT", dir_root.as_os_str().to_os_string());
    match daemon_executable {
        Some(daemon_executable) => command
            .with_environment_variable(APP_SERVER_PATH_ENV, daemon_executable.into_os_string()),
        None => command,
    }
}

fn local_client_capabilities() -> ClientCapabilities {
    ClientCapabilities {
        dir_permissions_host: Some(DirPermissionsHostCapability { version: 1 }),
        ..ClientCapabilities::default()
    }
}

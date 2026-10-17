use std::env;
use std::fmt;
use std::path::PathBuf;
use std::process::Command;

const DIR_ROOT_ENV: &str = "ASH_WORKSPACE_ROOT";
pub(crate) const PRODUCT_SERVICES_PATH_ENV: &str = "ASH_REMOTE_SERVER_PRODUCT_SERVICES_PATH";

/// Profile and directory inputs selected by one remote connector.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteServerOptions {
    profile_root: PathBuf,
    dir_root: Option<PathBuf>,
    product_services_path: Option<PathBuf>,
}

impl RemoteServerOptions {
    /// Creates the server options after the host has selected one remote profile and Directory.
    pub fn new(profile_root: impl Into<PathBuf>, dir_root: impl Into<PathBuf>) -> Self {
        Self {
            profile_root: profile_root.into(),
            dir_root: Some(dir_root.into()),
            product_services_path: None,
        }
    }

    /// Keeps the Remote connection available without granting a Directory authority.
    pub fn empty(profile_root: impl Into<PathBuf>) -> Self {
        Self {
            profile_root: profile_root.into(),
            dir_root: None,
            product_services_path: None,
        }
    }

    /// Returns the durable per-user state directory on the Remote host.
    pub fn profile_root(&self) -> &std::path::Path {
        &self.profile_root
    }

    /// Returns the remote Directory authority passed to the App Server.
    pub fn dir_root(&self) -> Option<&std::path::Path> {
        self.dir_root.as_deref()
    }

    /// Selects a product-host-owned services manifest without teaching this crate discovery policy.
    pub fn with_product_services_path(mut self, path: impl Into<PathBuf>) -> Self {
        self.product_services_path = Some(path.into());
        self
    }
}

/// Runs a direct diagnostic server or connects to the shared remote profile backend.
pub fn run_from_environment(
    arguments: impl IntoIterator<Item = String>,
) -> Result<(), RemoteServerError> {
    run_from_environment_with_product_services(arguments, None)
}

/// Runs the Remote Server with an optional product manifest discovered by the executable host.
pub fn run_from_environment_with_product_services(
    arguments: impl IntoIterator<Item = String>,
    product_services_path: Option<PathBuf>,
) -> Result<(), RemoteServerError> {
    let arguments = arguments.into_iter().collect::<Vec<_>>();
    if arguments.as_slice() == ["--version"] {
        println!(
            "{}",
            serde_json::to_string(&build_identity::current())
                .map_err(|error| RemoteServerError::new(error.to_string()))?
        );
        return Ok(());
    }
    let options = || {
        options_from_environment().map(|options| match &product_services_path {
            Some(path) => options.with_product_services_path(path),
            None => options,
        })
    };
    match arguments.as_slice() {
        [command, listen, address]
            if command == "app-server" && listen == "--listen" && address == "stdio://" =>
        {
            serve_stdio(options()?)
        }
        [command] if command == "connect" => connect(options()?),
        [command, receiver] if command == "history-export" => {
            let mut command = backend_command(&options()?)?;
            command.args(["history-export", receiver]);
            execute_backend(command)
        }
        [command, environment, tail @ ..] if command == "execution-connect" => {
            let network = match tail {
                [] => exec_server_protocol::NetworkAccess::Denied,
                [flag, value] if flag == "--network" => match value.as_str() {
                    "denied" => exec_server_protocol::NetworkAccess::Denied,
                    "managed" => exec_server_protocol::NetworkAccess::Managed,
                    "allowed" => exec_server_protocol::NetworkAccess::Allowed,
                    _ => return Err(RemoteServerError::new("Invalid execution network ceiling")),
                },
                _ => {
                    return Err(RemoteServerError::new(
                        "Invalid execution connection arguments",
                    ));
                }
            };
            exec_server_protocol::validate_id(environment)
                .map_err(|_| RemoteServerError::new("Invalid execution environment identity"))?;
            let options = options()?;
            let root = options
                .dir_root
                .ok_or_else(|| RemoteServerError::new("Execution requires ASH_WORKSPACE_ROOT"))?;
            let connection = ash_app_server_daemon::ConnectionOptions::new(
                options.profile_root,
                Some(root),
                ash_app_server_daemon::GrantSource::HostConfiguration,
                None,
            )
            .with_role(ash_app_server_daemon::ConnectionRole::Execution {
                environment: environment.clone(),
                network,
            });
            let executable =
                ash_app_server_daemon::backend_executable_path().map_err(RemoteServerError::new)?;
            ash_app_server_daemon::connect_selected(connection, &executable)
                .map_err(RemoteServerError::new)
        }
        _ => Err(RemoteServerError::new(
            "usage: ash-remote-server connect | execution-connect ENVIRONMENT | history-export RECEIVER | app-server --listen stdio://",
        )),
    }
}

fn connect(options: RemoteServerOptions) -> Result<(), RemoteServerError> {
    let connection = ash_app_server_daemon::ConnectionOptions::new(
        options.profile_root,
        options.dir_root,
        ash_app_server_daemon::GrantSource::HostConfiguration,
        options.product_services_path,
    )
    .with_role(ash_app_server_daemon::ConnectionRole::Remote);
    let executable =
        ash_app_server_daemon::backend_executable_path().map_err(RemoteServerError::new)?;
    // Directory authority belongs to this connection, never to the daemon identity. A remote
    // runtime selection changes the profile's backend generation through the same lifecycle
    // owner used by local products, so two directories cannot create competing profile writers.
    ash_app_server_daemon::connect_selected(connection, &executable).map_err(RemoteServerError::new)
}

/// Hands diagnostic stdio to the selected independent App Server executable.
pub fn serve_stdio(options: RemoteServerOptions) -> Result<(), RemoteServerError> {
    let mut command = backend_command(&options)?;
    command.arg("--remote-stdio");
    if let Some(path) = options.product_services_path {
        command.arg("--product-services").arg(path);
    }
    execute_backend(command)
}

fn backend_command(options: &RemoteServerOptions) -> Result<Command, RemoteServerError> {
    let executable =
        ash_app_server_daemon::backend_executable_path().map_err(RemoteServerError::new)?;
    let mut command = Command::new(executable);
    command.env("ASH_HOME", &options.profile_root);
    // The connector owns the remote directory grant, regardless of local host settings.
    command.env("ASH_DIR_GRANT_SOURCE", "hostConfiguration");
    if let Some(dir_root) = &options.dir_root {
        command.env(DIR_ROOT_ENV, dir_root);
    } else {
        command.env_remove(DIR_ROOT_ENV);
    }
    Ok(command)
}

fn execute_backend(mut command: Command) -> Result<(), RemoteServerError> {
    // Replacing the SSH child preserves signals, exit status and all three stdio streams.
    // The backend executable acquires its own package lease at startup.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        Err(RemoteServerError::new(command.exec().to_string()))
    }
    #[cfg(not(unix))]
    {
        let status = command
            .status()
            .map_err(|error| RemoteServerError::new(error.to_string()))?;
        if status.success() {
            Ok(())
        } else {
            Err(RemoteServerError::new(format!(
                "App Server exited with {status}"
            )))
        }
    }
}

fn options_from_environment() -> Result<RemoteServerOptions, RemoteServerError> {
    let dir_root = env::var_os(DIR_ROOT_ENV).map(PathBuf::from);
    if dir_root.as_ref().is_some_and(|path| !path.is_absolute()) {
        return Err(RemoteServerError::new(
            "ASH_WORKSPACE_ROOT must be an absolute Remote Directory path",
        ));
    }
    let profile_root = ash_utils_home_dir::find_ash_home()
        .map_err(|error| RemoteServerError::new(error.to_string()))?;
    if env::var_os("ASH_HOME").is_none() {
        check_legacy_home(&profile_root, legacy_home().as_deref())?;
    }
    let mut options = match dir_root {
        Some(dir_root) => RemoteServerOptions::new(profile_root, dir_root),
        None => RemoteServerOptions::empty(profile_root),
    };
    if let Some(path) = env::var_os(PRODUCT_SERVICES_PATH_ENV) {
        options = options.with_product_services_path(path);
    }
    Ok(options)
}

// Legacy location discovery is used only to require an explicit data-root migration.
// All normal reads and writes use the data root selected by ash-utils-home-dir.
fn legacy_home() -> Option<PathBuf> {
    #[cfg(target_os = "windows")]
    {
        env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .map(|root| root.join("Ash/remote-server"))
    }
    #[cfg(target_os = "macos")]
    {
        env::var_os("HOME")
            .map(PathBuf::from)
            .map(|root| root.join("Library/Application Support/Ash/remote-server"))
    }
    #[cfg(all(unix, not(target_os = "macos")))]
    {
        env::var_os("XDG_STATE_HOME")
            .map(PathBuf::from)
            .or_else(|| {
                env::var_os("HOME")
                    .map(PathBuf::from)
                    .map(|root| root.join(".local/state"))
            })
            .map(|root| root.join("ash/remote-server"))
    }
    #[cfg(not(any(unix, target_os = "windows")))]
    {
        None
    }
}

fn check_legacy_home(
    root: &std::path::Path,
    legacy: Option<&std::path::Path>,
) -> Result<(), RemoteServerError> {
    let Some(legacy) = legacy else {
        return Ok(());
    };
    match std::fs::symlink_metadata(legacy) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(RemoteServerError::new(error.to_string())),
        Ok(_) => {
            if ash_utils_home_dir::resolve_path(legacy)
                .map_err(|error| RemoteServerError::new(error.to_string()))?
                == root
            {
                return Ok(());
            }
            Err(RemoteServerError::new(format!(
                "Legacy Remote data exists at {}. Set ASH_HOME on the remote host to that directory to retain it, or stop all Ash services and migrate its contents to {} before removing the old directory; existing data roots must not be merged automatically",
                legacy.display(),
                root.display()
            )))
        }
    }
}

#[cfg(test)]
#[path = "home_tests.rs"]
mod home_tests;

/// An invalid Remote server invocation or App Server startup failure.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteServerError {
    message: String,
}

impl RemoteServerError {
    pub(crate) fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for RemoteServerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for RemoteServerError {}

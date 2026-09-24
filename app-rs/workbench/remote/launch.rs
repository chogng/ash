use std::fmt;
use std::path::Path;
use std::path::PathBuf;

use ash_app_server_protocol::protocol::common::ClientCapabilities;
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_remote::RemoteAddressError;
use ash_remote::RemoteDirPath;
use ash_remote::RemoteProfile;
use ash_remote::RemoteRuntime;
use ash_remote::SshHost;
use ash_remote::SshTarget;
use ash_remote_connections::RemoteConnectionError;
use ash_remote_connections::RemoteConnectionFailureKind;
use ash_remote_connections::RemoteConnectionProfileRecord;
use ash_remote_connections::RemoteConnectionProfileStore;
use ash_remote_connections::RemoteRuntimeCatalog;
use ash_remote_connections::RemoteRuntimeCatalogRelease;
use ash_remote_connections::RemoteRuntimeCatalogUpdater;
use ash_remote_connections::RemoteRuntimeDownloadCache;
use ash_remote_connections::RemoteRuntimeDownloadProgress;
use ash_remote_connections::RemoteRuntimeInstallProgress;
use ash_remote_connections::SshAppServerConnectionOptions;
use ash_remote_connections::SshRemoteRuntimeInstaller;

use crate::app_server::AppServerHost;

const DEFAULT_REMOTE_RUNTIME: &str = "ash-remote-server";
const BUNDLED_REMOTE_RUNTIME_CATALOG: &str = "ash-remote-runtimes/catalog.json";
const BUNDLED_REMOTE_RUNTIME_CATALOG_SHA256: Option<&str> =
    option_env!("APP_REMOTE_RUNTIME_CATALOG_SHA256");
const BUNDLED_REMOTE_RUNTIME_CATALOG_URL: Option<&str> =
    option_env!("APP_REMOTE_RUNTIME_CATALOG_URL");
const REMOTE_RUNTIME_DOWNLOAD_CACHE: &str = "remote-runtime-downloads";

/// Application-owned launch selection made before the desktop event loop starts.
///
/// A Remote launch carries only the SSH host, remote Directory path, runtime reference, and
/// optional OpenSSH executable. Credentials remain in the local OpenSSH configuration and agent.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum AppLaunch {
    Local,
    Remote {
        profile: RemoteProfile,
        ssh_executable: Option<PathBuf>,
        runtime_source: RemoteRuntimeSource,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum RemoteRuntimeSource {
    ExplicitRuntime,
    DefaultRuntime {
        catalog: Option<RemoteRuntimeCatalogSource>,
    },
    StoredRollback,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum RemoteRuntimeCatalogSource {
    Local {
        path: PathBuf,
        expected_sha256: String,
    },
    Network {
        release: RemoteRuntimeCatalogRelease,
        cache: RemoteRuntimeDownloadCache,
    },
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RemoteRuntimePreparationProgress {
    Download(RemoteRuntimeDownloadProgress),
    Install(RemoteRuntimeInstallProgress),
}

impl AppLaunch {
    /// Parses the small application-level launch surface used by `app`.
    pub(crate) fn parse(
        arguments: impl IntoIterator<Item = String>,
    ) -> Result<Self, LaunchParseError> {
        let mut remote_host = None;
        let mut remote_dir = None;
        let mut remote_runtime = None;
        let mut ssh_executable = None;
        let mut runtime_catalog = None;
        let mut runtime_catalog_url = None;
        let mut runtime_catalog_sha256 = None;
        let mut runtime_cache = None;
        let mut rollback_runtime = false;
        let mut arguments = arguments.into_iter().collect::<Vec<_>>().into_iter();
        while let Some(argument) = arguments.next() {
            let value = |flag: &'static str, arguments: &mut std::vec::IntoIter<String>| {
                arguments
                    .next()
                    .ok_or(LaunchParseError::MissingValue { flag })
            };
            match argument.as_str() {
                "--remote" => remote_host = Some(value("--remote", &mut arguments)?),
                "--dir" => remote_dir = Some(value("--dir", &mut arguments)?),
                "--runtime" => remote_runtime = Some(value("--runtime", &mut arguments)?),
                "--ssh" => ssh_executable = Some(PathBuf::from(value("--ssh", &mut arguments)?)),
                "--runtime-catalog" => {
                    runtime_catalog =
                        Some(PathBuf::from(value("--runtime-catalog", &mut arguments)?))
                }
                "--runtime-catalog-url" => {
                    runtime_catalog_url = Some(value("--runtime-catalog-url", &mut arguments)?)
                }
                "--runtime-catalog-sha256" => {
                    runtime_catalog_sha256 =
                        Some(value("--runtime-catalog-sha256", &mut arguments)?)
                }
                "--runtime-cache" => {
                    runtime_cache = Some(PathBuf::from(value("--runtime-cache", &mut arguments)?))
                }
                "--rollback-runtime" => rollback_runtime = true,
                "--help" | "-h" => return Err(LaunchParseError::HelpRequested),
                _ => return Err(LaunchParseError::UnknownArgument(argument)),
            }
        }

        let Some(remote_host) = remote_host else {
            if remote_dir.is_some()
                || remote_runtime.is_some()
                || ssh_executable.is_some()
                || runtime_catalog.is_some()
                || runtime_catalog_url.is_some()
                || runtime_catalog_sha256.is_some()
                || runtime_cache.is_some()
                || rollback_runtime
            {
                return Err(LaunchParseError::RemoteFlagRequired);
            }
            return Ok(Self::Local);
        };
        let remote_dir = remote_dir.ok_or(LaunchParseError::MissingValue { flag: "--dir" })?;
        let host = SshHost::parse(remote_host).map_err(LaunchParseError::Address)?;
        let dir = RemoteDirPath::parse(remote_dir).map_err(LaunchParseError::Address)?;
        if rollback_runtime
            && (remote_runtime.is_some()
                || runtime_catalog.is_some()
                || runtime_catalog_url.is_some()
                || runtime_catalog_sha256.is_some()
                || runtime_cache.is_some())
        {
            return Err(LaunchParseError::RollbackRuntimeConflictsWithSelection);
        }
        if remote_runtime.is_some()
            && (runtime_catalog.is_some()
                || runtime_catalog_url.is_some()
                || runtime_catalog_sha256.is_some()
                || runtime_cache.is_some())
        {
            return Err(LaunchParseError::RuntimeCatalogConflictsWithRuntime);
        }
        let runtime_source = match (
            rollback_runtime,
            runtime_catalog,
            runtime_catalog_url,
            runtime_catalog_sha256,
            runtime_cache,
        ) {
            (true, None, None, None, None) => RemoteRuntimeSource::StoredRollback,
            (false, Some(path), None, Some(expected_sha256), None) => {
                RemoteRuntimeSource::DefaultRuntime {
                    catalog: Some(RemoteRuntimeCatalogSource::Local {
                        path,
                        expected_sha256,
                    }),
                }
            }
            (false, None, Some(url), Some(expected_sha256), cache) => {
                let release = RemoteRuntimeCatalogRelease::new(url, expected_sha256)
                    .map_err(|error| LaunchParseError::InvalidRuntimeCatalog(error.to_string()))?;
                let cache = RemoteRuntimeDownloadCache::new(match cache {
                    Some(cache) => cache,
                    None => default_remote_runtime_download_cache()
                        .map_err(LaunchParseError::InvalidRuntimeCatalog)?,
                })
                .map_err(|error| LaunchParseError::InvalidRuntimeCatalog(error.to_string()))?;
                RemoteRuntimeSource::DefaultRuntime {
                    catalog: Some(RemoteRuntimeCatalogSource::Network { release, cache }),
                }
            }
            (false, None, None, None, None) if remote_runtime.is_some() => {
                RemoteRuntimeSource::ExplicitRuntime
            }
            (false, None, None, None, None) => {
                RemoteRuntimeSource::DefaultRuntime { catalog: None }
            }
            _ => return Err(LaunchParseError::IncompleteRuntimeCatalog),
        };
        let runtime =
            RemoteRuntime::new(remote_runtime.unwrap_or_else(|| DEFAULT_REMOTE_RUNTIME.into()))
                .map_err(LaunchParseError::Address)?;
        Ok(Self::Remote {
            profile: RemoteProfile::new(SshTarget::new(host, dir), runtime),
            ssh_executable,
            runtime_source,
        })
    }

    /// Resolves the App Server host used by Agent, Language, and Terminal connections.
    pub(crate) fn app_server_host(&self, local_dir_root: &Path) -> AppServerHost {
        match self {
            Self::Local => AppServerHost::local(local_dir_root),
            Self::Remote {
                profile,
                ssh_executable,
                ..
            } => AppServerHost::remote_with_executable(profile.clone(), ssh_executable.as_deref()),
        }
    }

    pub(crate) const fn is_remote(&self) -> bool {
        matches!(self, Self::Remote { .. })
    }

    /// Ensures a compatible runtime exists while projecting typed installation progress.
    ///
    /// An explicitly selected runtime is never replaced. The default runtime may be provisioned
    /// from a catalog authenticated by either the signed app binary or explicit launch input.
    pub(crate) fn prepare_remote_runtime_with_progress(
        &mut self,
        report_progress: &mut dyn FnMut(RemoteRuntimePreparationProgress),
    ) -> Result<(), String> {
        let store = RemoteConnectionProfileStore::from_profile_root(
            ash_utils_home_dir::find_ash_home().map_err(|error| error.to_string())?,
        );
        self.prepare_remote_runtime_with_store_and_progress(&store, report_progress)
    }

    #[cfg(all(test, unix))]
    pub(crate) fn prepare_remote_runtime_with_store(
        &mut self,
        store: &RemoteConnectionProfileStore,
    ) -> Result<(), String> {
        self.prepare_remote_runtime_with_store_and_progress(store, &mut |_| {})
    }

    fn prepare_remote_runtime_with_store_and_progress(
        &mut self,
        store: &RemoteConnectionProfileStore,
        report_progress: &mut dyn FnMut(RemoteRuntimePreparationProgress),
    ) -> Result<(), String> {
        let Self::Remote {
            profile,
            ssh_executable,
            runtime_source,
        } = self
        else {
            return Ok(());
        };
        match runtime_source.clone() {
            RemoteRuntimeSource::ExplicitRuntime => {
                match validate_remote_runtime(profile, ssh_executable.as_deref()) {
                    Ok(resolved) => {
                        *profile = resolved;
                        Ok(())
                    }
                    Err(error)
                        if matches!(
                            error.kind(),
                            RemoteConnectionFailureKind::RuntimeUnavailable
                                | RemoteConnectionFailureKind::ProtocolIncompatible
                        ) =>
                    {
                        Err(format!(
                            "{error}\nThe explicitly selected --runtime is unavailable or protocol-incompatible; app will not replace it automatically."
                        ))
                    }
                    Err(error) => Err(error.to_string()),
                }
            }
            RemoteRuntimeSource::DefaultRuntime { catalog } => prepare_default_remote_runtime(
                profile,
                ssh_executable.as_deref(),
                catalog,
                store,
                report_progress,
            ),
            RemoteRuntimeSource::StoredRollback => {
                prepare_remote_runtime_rollback(profile, ssh_executable.as_deref(), store)
            }
        }
    }
}

fn prepare_default_remote_runtime(
    profile: &mut RemoteProfile,
    ssh_executable: Option<&Path>,
    catalog_source: Option<RemoteRuntimeCatalogSource>,
    store: &RemoteConnectionProfileStore,
    report_progress: &mut dyn FnMut(RemoteRuntimePreparationProgress),
) -> Result<(), String> {
    let stored = load_connection_profile(store, profile.target())?;
    let rollback_available = stored
        .as_ref()
        .is_some_and(|record| record.previous_runtime().is_some());
    if let Some(stored) = stored {
        *profile = stored.active_profile();
    }
    let recovery_reason = match validate_remote_runtime(profile, ssh_executable) {
        Ok(resolved) => {
            *profile = resolved;
            activate_connection_profile(store, profile)?;
            return Ok(());
        }
        Err(error)
            if matches!(
                error.kind(),
                RemoteConnectionFailureKind::RuntimeUnavailable
                    | RemoteConnectionFailureKind::ProtocolIncompatible
            ) =>
        {
            error
        }
        Err(error) => return Err(error.to_string()),
    };
    let source = match catalog_source {
        Some(source) => source,
        None => bundled_remote_runtime_catalog_source()?.ok_or_else(|| {
            let rollback_hint = if rollback_available {
                " You can retry the previously verified generation with --rollback-runtime."
            } else {
                ""
            };
            format!(
                "{recovery_reason}\nThis app build has no authenticated Remote runtime catalog. Install a release package that bundles Remote runtimes, or pass an explicit --runtime.{rollback_hint}"
            )
        })?,
    };
    install_remote_runtime(profile, ssh_executable, &source, report_progress)?;
    let resolved = validate_remote_runtime(profile, ssh_executable).map_err(|error| {
        format!("installed Remote runtime failed its readiness or compatibility check: {error}")
    })?;
    *profile = resolved;
    activate_connection_profile(store, profile)
}

fn prepare_remote_runtime_rollback(
    profile: &mut RemoteProfile,
    ssh_executable: Option<&Path>,
    store: &RemoteConnectionProfileStore,
) -> Result<(), String> {
    let stored = load_connection_profile(store, profile.target())?.ok_or_else(|| {
        "this Remote host and Directory have no stored runtime generation to roll back".to_owned()
    })?;
    let previous = stored.previous_profile().ok_or_else(|| {
        "this Remote host and Directory have no previous runtime generation to roll back".to_owned()
    })?;
    let verified = validate_remote_runtime(&previous, ssh_executable).map_err(|error| {
        format!(
            "the previous Remote runtime was not activated because its readiness or compatibility check failed: {error}"
        )
    })?;
    let rolled_back = store
        .rollback_to_verified(&previous, &verified)
        .map_err(|error| profile_store_error("roll back", store, error))?
        .ok_or_else(|| {
            "the stored Remote runtime generations changed while rollback was being verified; retry the rollback"
                .to_owned()
        })?;
    *profile = rolled_back.active_profile();
    Ok(())
}

fn validate_remote_runtime(
    profile: &RemoteProfile,
    ssh_executable: Option<&Path>,
) -> Result<RemoteProfile, RemoteConnectionError> {
    let probe = remote_connection(profile, ssh_executable).probe_runtime()?;
    let resolved = RemoteProfile::new(profile.target().clone(), probe.resolved_runtime().clone());
    remote_connection(&resolved, ssh_executable)
        .probe_compatibility(compatibility_client_info(), ClientCapabilities::default())?;
    Ok(resolved)
}

fn install_remote_runtime(
    profile: &mut RemoteProfile,
    ssh_executable: Option<&Path>,
    source: &RemoteRuntimeCatalogSource,
    report_progress: &mut dyn FnMut(RemoteRuntimePreparationProgress),
) -> Result<(), String> {
    let mut installer = SshRemoteRuntimeInstaller::new(profile.target().host().clone());
    if let Some(ssh_executable) = ssh_executable {
        installer = installer.with_ssh_executable(ssh_executable);
    }
    let platform = installer
        .probe_platform()
        .map_err(|error| error.to_string())?;
    let artifact = match source {
        RemoteRuntimeCatalogSource::Local {
            path,
            expected_sha256,
        } => {
            let catalog =
                RemoteRuntimeCatalog::load_verified(path, expected_sha256).map_err(|error| {
                    format!("could not load the authenticated Remote runtime catalog: {error}")
                })?;
            catalog.artifact_for(platform).cloned().ok_or_else(|| {
                format!("authenticated Remote runtime catalog has no artifact for `{platform}`")
            })?
        }
        RemoteRuntimeCatalogSource::Network { release, cache } => {
            RemoteRuntimeCatalogUpdater::new(release.clone(), cache.clone())
                .fetch_for(platform, |progress| {
                    report_progress(RemoteRuntimePreparationProgress::Download(progress))
                })
                .map_err(|error| {
                    format!("could not download the authenticated Remote runtime: {error}")
                })?
        }
    };
    let installed = installer
        .install_with_progress(&artifact, |progress| {
            report_progress(RemoteRuntimePreparationProgress::Install(progress))
        })
        .map_err(|error| error.to_string())?;
    *profile = RemoteProfile::new(profile.target().clone(), installed.into_runtime());
    Ok(())
}

fn load_connection_profile(
    store: &RemoteConnectionProfileStore,
    target: &SshTarget,
) -> Result<Option<RemoteConnectionProfileRecord>, String> {
    store
        .connection(target)
        .map_err(|error| profile_store_error("load", store, error))
}

fn activate_connection_profile(
    store: &RemoteConnectionProfileStore,
    profile: &RemoteProfile,
) -> Result<(), String> {
    store
        .activate(profile)
        .map(|_| ())
        .map_err(|error| profile_store_error("persist", store, error))
}

fn profile_store_error(
    operation: &str,
    store: &RemoteConnectionProfileStore,
    error: impl fmt::Display,
) -> String {
    format!(
        "could not {operation} Remote connection profiles at `{}`: {error}",
        store.path().display()
    )
}

fn compatibility_client_info() -> ClientInfo {
    ClientInfo {
        name: "app-runtime-preflight".into(),
        version: env!("CARGO_PKG_VERSION").into(),
    }
}

fn remote_connection(
    profile: &RemoteProfile,
    ssh_executable: Option<&Path>,
) -> SshAppServerConnectionOptions {
    let mut connection = SshAppServerConnectionOptions::new(profile.clone());
    if let Some(ssh_executable) = ssh_executable {
        connection = connection.with_ssh_executable(ssh_executable);
    }
    connection
}

fn bundled_remote_runtime_catalog_source() -> Result<Option<RemoteRuntimeCatalogSource>, String> {
    match (
        BUNDLED_REMOTE_RUNTIME_CATALOG_URL,
        BUNDLED_REMOTE_RUNTIME_CATALOG_SHA256,
    ) {
        (Some(url), Some(expected_sha256)) => Ok(Some(RemoteRuntimeCatalogSource::Network {
            release: RemoteRuntimeCatalogRelease::new(url, expected_sha256)
                .map_err(|error| format!("invalid bundled Remote runtime release: {error}"))?,
            cache: RemoteRuntimeDownloadCache::new(default_remote_runtime_download_cache()?)
                .map_err(|error| format!("invalid Remote runtime download cache: {error}"))?,
        })),
        (None, Some(expected_sha256)) => {
            let executable = std::env::current_exe()
                .map_err(|error| format!("could not locate the app executable: {error}"))?;
            let package_root = executable
                .parent()
                .and_then(Path::parent)
                .ok_or_else(|| "app executable has no package root".to_owned())?;
            Ok(Some(RemoteRuntimeCatalogSource::Local {
                path: package_root.join(BUNDLED_REMOTE_RUNTIME_CATALOG),
                expected_sha256: expected_sha256.into(),
            }))
        }
        (None, None) => Ok(None),
        (Some(_), None) => {
            Err("app embeds a Remote runtime catalog URL without its signed SHA-256 binding".into())
        }
    }
}

fn default_remote_runtime_download_cache() -> Result<PathBuf, String> {
    Ok(ash_utils_home_dir::find_ash_home()
        .map_err(|error| error.to_string())?
        .join(REMOTE_RUNTIME_DOWNLOAD_CACHE))
}

/// A launch argument error that can be shown without starting the desktop event loop.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum LaunchParseError {
    HelpRequested,
    UnknownArgument(String),
    MissingValue { flag: &'static str },
    RemoteFlagRequired,
    IncompleteRuntimeCatalog,
    RuntimeCatalogConflictsWithRuntime,
    RollbackRuntimeConflictsWithSelection,
    InvalidRuntimeCatalog(String),
    Address(RemoteAddressError),
}

impl fmt::Display for LaunchParseError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::HelpRequested => formatter.write_str(usage()),
            Self::UnknownArgument(argument) => {
                write!(formatter, "unknown argument {argument}\n\n{}", usage())
            }
            Self::MissingValue { flag } => {
                write!(formatter, "{flag} requires a value\n\n{}", usage())
            }
            Self::RemoteFlagRequired => {
                write!(
                    formatter,
                    "Remote options require --remote <ssh-host>\n\n{}",
                    usage()
                )
            }
            Self::IncompleteRuntimeCatalog => write!(
                formatter,
                "select either --runtime-catalog or --runtime-catalog-url with --runtime-catalog-sha256; --runtime-cache is valid only with a URL\n\n{}",
                usage()
            ),
            Self::RuntimeCatalogConflictsWithRuntime => write!(
                formatter,
                "--runtime cannot be combined with a runtime catalog\n\n{}",
                usage()
            ),
            Self::RollbackRuntimeConflictsWithSelection => write!(
                formatter,
                "--rollback-runtime cannot be combined with --runtime or a runtime catalog\n\n{}",
                usage()
            ),
            Self::InvalidRuntimeCatalog(error) => write!(formatter, "{error}\n\n{}", usage()),
            Self::Address(error) => write!(formatter, "{error}"),
        }
    }
}

impl std::error::Error for LaunchParseError {}

pub(crate) const fn usage() -> &'static str {
    "usage: app [--remote <ssh-host> --dir <absolute-remote-path>]\n\
     [--runtime <remote-runtime>] [--ssh <openssh-path>]\n\
     [--runtime-catalog <local-catalog> --runtime-catalog-sha256 <digest>]\n\
     [--runtime-catalog-url <https-catalog.json> --runtime-catalog-sha256 <digest>]\n\
     [--runtime-cache <absolute-local-path>]\n\
     [--rollback-runtime]\n\
     app remote --help"
}

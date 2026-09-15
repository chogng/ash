use std::fs;
use std::path::Path;
use std::path::PathBuf;

use ash_app_server_client::AppServerSession;
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_install_context::InstallContext;
use ash_remote::RemoteProfile;
use ash_remote::RemoteRuntime;
use ash_remote::SshTarget;
use ash_remote_connections::RemoteConnectionError;
use ash_remote_connections::RemoteConnectionFailureKind;
use ash_remote_connections::RemoteConnectionProfileStore;
use ash_remote_connections::RemoteRuntimeCatalog;
use ash_remote_connections::RemoteRuntimeCatalogRelease;
use ash_remote_connections::RemoteRuntimeCatalogUpdater;
use ash_remote_connections::RemoteRuntimeDownloadCache;
use ash_remote_connections::SshAppServerConnectionOptions;
use ash_remote_connections::SshRemoteRuntimeInstaller;
use serde::Deserialize;

const DEFAULT_REMOTE_RUNTIME: &str = "ash-remote-server";
const PACKAGED_REMOTE_RUNTIME_CATALOG: &str = "ash-remote-runtimes/catalog.json";
const REMOTE_RUNTIME_DOWNLOAD_CACHE: &str = "remote-runtime-downloads";
const MAX_PACKAGE_METADATA_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) struct RemoteConnectRuntimeInput {
    pub(super) runtime: Option<RemoteRuntime>,
    pub(super) local_catalog: Option<PathBuf>,
    pub(super) catalog_url: Option<String>,
    pub(super) catalog_sha256: Option<String>,
    pub(super) runtime_cache: Option<PathBuf>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum RemoteConnectRuntimeSelection {
    Explicit(RemoteRuntime),
    Managed(RemoteRuntimeCatalogSelection),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum RemoteRuntimeCatalogSelection {
    ProductPackage,
    Local {
        path: PathBuf,
        expected_sha256: String,
    },
    Network {
        release: RemoteRuntimeCatalogRelease,
        cache: RemoteRuntimeCacheSelection,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(super) enum RemoteRuntimeCacheSelection {
    ProfileDefault,
    Explicit(RemoteRuntimeDownloadCache),
}

pub(super) struct ReadyRemoteRuntime {
    pub(super) profile: RemoteProfile,
    pub(super) session: AppServerSession,
}

impl RemoteConnectRuntimeSelection {
    pub(super) fn parse(input: RemoteConnectRuntimeInput) -> Result<Self, String> {
        let RemoteConnectRuntimeInput {
            runtime,
            local_catalog,
            catalog_url,
            catalog_sha256,
            runtime_cache,
        } = input;
        if let Some(runtime) = runtime {
            if local_catalog.is_some()
                || catalog_url.is_some()
                || catalog_sha256.is_some()
                || runtime_cache.is_some()
            {
                return Err(
                    "--runtime cannot be combined with Remote runtime catalog options".into(),
                );
            }
            return Ok(Self::Explicit(runtime));
        }
        let catalog = match (local_catalog, catalog_url, catalog_sha256, runtime_cache) {
            (None, None, None, None) => RemoteRuntimeCatalogSelection::ProductPackage,
            (Some(path), None, Some(expected_sha256), None) => {
                if !path.is_absolute() {
                    return Err("--runtime-catalog must be an absolute local path".into());
                }
                validate_sha256(&expected_sha256)?;
                RemoteRuntimeCatalogSelection::Local {
                    path,
                    expected_sha256,
                }
            }
            (None, Some(url), Some(expected_sha256), cache) => {
                let release = RemoteRuntimeCatalogRelease::new(url, expected_sha256)
                    .map_err(|error| error.to_string())?;
                let cache = match cache {
                    Some(path) => RemoteRuntimeCacheSelection::Explicit(
                        RemoteRuntimeDownloadCache::new(path).map_err(|error| error.to_string())?,
                    ),
                    None => RemoteRuntimeCacheSelection::ProfileDefault,
                };
                RemoteRuntimeCatalogSelection::Network { release, cache }
            }
            _ => {
                return Err(concat!(
                    "select either --runtime-catalog or --runtime-catalog-url with ",
                    "--runtime-catalog-sha256; --runtime-cache is valid only with a URL"
                )
                .into());
            }
        };
        Ok(Self::Managed(catalog))
    }
}

pub(super) fn connect(
    target: SshTarget,
    selection: RemoteConnectRuntimeSelection,
    ssh_executable: Option<&Path>,
    profile_root: &Path,
    store: &RemoteConnectionProfileStore,
) -> Result<ReadyRemoteRuntime, String> {
    let (requested_profile, catalog) = match selection {
        RemoteConnectRuntimeSelection::Explicit(runtime) => {
            let profile = RemoteProfile::new(target, runtime);
            return establish_session(&profile, ssh_executable).map_err(|error| {
                if recoverable(error.kind()) {
                    format!(
                        "{error}\nThe explicitly selected --runtime was not replaced automatically."
                    )
                } else {
                    error.to_string()
                }
            });
        }
        RemoteConnectRuntimeSelection::Managed(catalog) => {
            let profile = store
                .connection(&target)
                .map_err(|error| profile_store_error("load", store, error))?
                .map(|record| record.active_profile())
                .unwrap_or(RemoteProfile::new(
                    target,
                    RemoteRuntime::new(DEFAULT_REMOTE_RUNTIME).map_err(string_error)?,
                ));
            (profile, catalog)
        }
    };
    match establish_session(&requested_profile, ssh_executable) {
        Ok(ready) => Ok(ready),
        Err(error) if recoverable(error.kind()) => {
            let recovery_reason = error.to_string();
            let source = catalog
                .resolve(profile_root)
                .map_err(|source_error| format!("{recovery_reason}\n{source_error}"))?;
            eprintln!(
                "Preparing a compatible Remote runtime for {}...",
                requested_profile.target().host().as_str()
            );
            let installed = install_runtime(&requested_profile, ssh_executable, source)?;
            establish_session(&installed, ssh_executable).map_err(|error| {
                format!(
                    "installed Remote runtime failed its readiness or compatibility check: {error}"
                )
            })
        }
        Err(error) => Err(error.to_string()),
    }
}

pub(super) fn reconnect_exact(
    profile: &RemoteProfile,
    ssh_executable: Option<&Path>,
) -> Result<ReadyRemoteRuntime, RemoteConnectionError> {
    establish_session(profile, ssh_executable)
}

impl RemoteRuntimeCatalogSelection {
    fn resolve(self, profile_root: &Path) -> Result<RemoteRuntimeCatalogSource, String> {
        match self {
            Self::ProductPackage => product_package_catalog_source(profile_root),
            Self::Local {
                path,
                expected_sha256,
            } => Ok(RemoteRuntimeCatalogSource::Local {
                path,
                expected_sha256,
            }),
            Self::Network { release, cache } => Ok(RemoteRuntimeCatalogSource::Network {
                release,
                cache: cache.resolve(profile_root)?,
            }),
        }
    }
}

impl RemoteRuntimeCacheSelection {
    fn resolve(self, profile_root: &Path) -> Result<RemoteRuntimeDownloadCache, String> {
        match self {
            Self::ProfileDefault => {
                RemoteRuntimeDownloadCache::new(profile_root.join(REMOTE_RUNTIME_DOWNLOAD_CACHE))
                    .map_err(string_error)
            }
            Self::Explicit(cache) => Ok(cache),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum RemoteRuntimeCatalogSource {
    Local {
        path: PathBuf,
        expected_sha256: String,
    },
    Network {
        release: RemoteRuntimeCatalogRelease,
        cache: RemoteRuntimeDownloadCache,
    },
}

fn establish_session(
    requested_profile: &RemoteProfile,
    ssh_executable: Option<&Path>,
) -> Result<ReadyRemoteRuntime, RemoteConnectionError> {
    let probe = connection(requested_profile, ssh_executable).probe_runtime()?;
    let profile = RemoteProfile::new(
        requested_profile.target().clone(),
        probe.resolved_runtime().clone(),
    );
    let session = connection(&profile, ssh_executable).connect(
        ClientInfo {
            name: "ash-cli-remote".into(),
            version: env!("CARGO_PKG_VERSION").into(),
        },
        ash_tui::client_capabilities(),
    )?;
    Ok(ReadyRemoteRuntime { profile, session })
}

fn install_runtime(
    profile: &RemoteProfile,
    ssh_executable: Option<&Path>,
    source: RemoteRuntimeCatalogSource,
) -> Result<RemoteProfile, String> {
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
            eprintln!("Downloading the authenticated Remote runtime...");
            RemoteRuntimeCatalogUpdater::new(release, cache)
                .fetch_for(platform, |_| {})
                .map_err(|error| {
                    format!("could not download the authenticated Remote runtime: {error}")
                })?
        }
    };
    eprintln!("Installing the authenticated Remote runtime...");
    let installed = installer
        .install(&artifact)
        .map_err(|error| error.to_string())?;
    Ok(RemoteProfile::new(
        profile.target().clone(),
        installed.into_runtime(),
    ))
}

fn product_package_catalog_source(
    profile_root: &Path,
) -> Result<RemoteRuntimeCatalogSource, String> {
    let context = InstallContext::current();
    let layout = context.package_layout().ok_or_else(no_product_catalog)?;
    load_product_package_catalog_source(
        layout.metadata_file(),
        layout.package_directory(),
        profile_root,
    )
}

fn load_product_package_catalog_source(
    metadata_path: &Path,
    package_root: &Path,
    profile_root: &Path,
) -> Result<RemoteRuntimeCatalogSource, String> {
    let metadata = fs::symlink_metadata(metadata_path)
        .map_err(|error| format!("could not read Ash package metadata: {error}"))?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() == 0
        || metadata.len() > MAX_PACKAGE_METADATA_BYTES
    {
        return Err("Ash package metadata is not a bounded regular file".into());
    }
    let document: ProductPackageMetadata = serde_json::from_slice(
        &fs::read(metadata_path)
            .map_err(|error| format!("could not read Ash package metadata: {error}"))?,
    )
    .map_err(|error| format!("Ash package metadata is invalid: {error}"))?;
    let binding = document
        .remote_runtime_catalog
        .ok_or_else(no_product_catalog)?;
    if binding.trust_binding != "signedProductPackage" {
        return Err("Ash package Remote runtime catalog has no signed product binding".into());
    }
    validate_sha256(&binding.sha256)?;
    match (binding.path.as_deref(), binding.url.as_deref()) {
        (Some(PACKAGED_REMOTE_RUNTIME_CATALOG), None) => Ok(RemoteRuntimeCatalogSource::Local {
            path: package_root.join(PACKAGED_REMOTE_RUNTIME_CATALOG),
            expected_sha256: binding.sha256,
        }),
        (None, Some(url)) => Ok(RemoteRuntimeCatalogSource::Network {
            release: RemoteRuntimeCatalogRelease::new(url, binding.sha256)
                .map_err(|error| format!("invalid packaged Remote runtime release: {error}"))?,
            cache: RemoteRuntimeDownloadCache::new(
                profile_root.join(REMOTE_RUNTIME_DOWNLOAD_CACHE),
            )
            .map_err(string_error)?,
        }),
        _ => {
            Err("Ash package Remote runtime catalog selects an invalid or ambiguous source".into())
        }
    }
}

#[derive(Deserialize)]
struct ProductPackageMetadata {
    #[serde(rename = "remoteRuntimeCatalog")]
    remote_runtime_catalog: Option<ProductPackageCatalogBinding>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProductPackageCatalogBinding {
    trust_binding: String,
    path: Option<String>,
    url: Option<String>,
    sha256: String,
}

fn connection(
    profile: &RemoteProfile,
    ssh_executable: Option<&Path>,
) -> SshAppServerConnectionOptions {
    let connection = SshAppServerConnectionOptions::new(profile.clone());
    match ssh_executable {
        Some(executable) => connection.with_ssh_executable(executable),
        None => connection,
    }
}

fn recoverable(kind: RemoteConnectionFailureKind) -> bool {
    matches!(
        kind,
        RemoteConnectionFailureKind::RuntimeUnavailable
            | RemoteConnectionFailureKind::ProtocolIncompatible
    )
}

fn validate_sha256(value: &str) -> Result<(), String> {
    if value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
    {
        Ok(())
    } else {
        Err("Remote runtime catalog SHA-256 must be 64 lowercase hex characters".into())
    }
}

fn no_product_catalog() -> String {
    concat!(
        "This ash code installation has no authenticated Remote runtime catalog. ",
        "Use a release package that binds one, pass --runtime-catalog with its SHA-256, ",
        "or select an already installed runtime with --runtime."
    )
    .into()
}

fn profile_store_error(
    operation: &str,
    store: &RemoteConnectionProfileStore,
    error: impl std::fmt::Display,
) -> String {
    format!(
        "could not {operation} Remote connection profiles at `{}`: {error}",
        store.path().display()
    )
}

fn string_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[cfg(test)]
#[path = "remote_connect_runtime_tests.rs"]
mod tests;

//! The profile owns its App Server package after the first packaged client connects.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
#[cfg(windows)]
use std::sync::atomic::AtomicBool;
#[cfg(windows)]
use std::sync::atomic::AtomicUsize;
#[cfg(windows)]
use std::sync::atomic::Ordering;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use ash_package_store::PackageStore;
use ash_package_store::validate_package_identity;
use serde::Deserialize;

use crate::process::PackageDigest;

const STORE_DIRECTORY: &str = "app-server-packages";
const METADATA_FILE: &str = "ash-package.json";
const PIN_FILE: &str = "pinned-build-id";
const MAX_METADATA_BYTES: u64 = 1024 * 1024;

#[derive(Clone, Copy, Eq, PartialEq)]
pub(crate) enum ClientSelection {
    Initial,
    Explicit,
}

#[derive(Deserialize)]
struct PackageFiles {
    #[serde(rename = "buildId")]
    build_id: String,
    #[serde(rename = "buildProfile")]
    build_profile: String,
    files: BTreeMap<String, String>,
    #[serde(rename = "javascriptRuntime")]
    javascript_runtime: JavaScriptRuntime,
}

#[derive(Deserialize)]
struct JavaScriptRuntime {
    kind: String,
    #[serde(rename = "electronVersion")]
    electron_version: Option<String>,
}

pub(crate) fn selected_backend(
    profile_root: &Path,
    caller_backend: &Path,
    package_digest: PackageDigest<'_>,
) -> Result<PathBuf, String> {
    let electron = std::env::var_os(crate::runtime::ELECTRON_PATH_ENV).map(PathBuf::from);
    selected_backend_with_electron(
        profile_root,
        caller_backend,
        electron.as_deref(),
        package_digest,
    )
}

pub(crate) fn prepare_desktop_backend(
    profile_root: &Path,
    caller_backend: &Path,
    electron: &Path,
) -> Result<(), String> {
    let profile_root =
        ash_utils_home_dir::resolve_path(profile_root).map_err(|error| error.to_string())?;
    let endpoint = crate::endpoint::EndpointPaths::prepare(&profile_root)?;
    // A concurrent client can select the profile's first generation too.
    let _operation_lock = endpoint.acquire_operation_lock()?;
    selected_backend_with_electron(
        &profile_root,
        caller_backend,
        Some(electron),
        PackageDigest::NotProvided,
    )
    .map(drop)
}

fn selected_backend_with_electron(
    profile_root: &Path,
    caller_backend: &Path,
    electron: Option<&Path>,
    package_digest: PackageDigest<'_>,
) -> Result<PathBuf, String> {
    let store_root = profile_root.join(STORE_DIRECTORY);
    let store = PackageStore::open(&store_root).map_err(|error| error.to_string())?;
    if let Some(selected) = store.current().map_err(|error| error.to_string())? {
        return Ok(backend_in(&selected.package_root));
    }
    // The adjacent copy is an installation source. A profile with an installed
    // generation runs and verifies that generation instead.
    package_digest.verify(caller_backend)?;
    install_from_client_with_electron(
        profile_root,
        caller_backend,
        ClientSelection::Initial,
        electron,
    )
}

pub(crate) fn installed_version(profile_root: &Path) -> Result<Option<String>, String> {
    let store = PackageStore::open(profile_root.join(STORE_DIRECTORY))
        .map_err(|error| error.to_string())?;
    let Some(selected) = store.current().map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    let metadata =
        fs::read(selected.package_root.join(METADATA_FILE)).map_err(|error| error.to_string())?;
    let value: serde_json::Value =
        serde_json::from_slice(&metadata).map_err(|error| error.to_string())?;
    value["version"]
        .as_str()
        .map(|version| Some(version.to_owned()))
        .ok_or("selected App Server package has no version".into())
}

pub(crate) fn install_from_client(
    profile_root: &Path,
    caller_backend: &Path,
    selection: ClientSelection,
) -> Result<PathBuf, String> {
    let electron = std::env::var_os(crate::runtime::ELECTRON_PATH_ENV).map(PathBuf::from);
    install_from_client_with_electron(profile_root, caller_backend, selection, electron.as_deref())
}

fn install_from_client_with_electron(
    profile_root: &Path,
    caller_backend: &Path,
    selection: ClientSelection,
    electron: Option<&Path>,
) -> Result<PathBuf, String> {
    let source = caller_backend
        .parent()
        .and_then(Path::parent)
        .ok_or("App Server executable is outside a package")?;
    if !source.join(METADATA_FILE).is_file() {
        // Development binaries have no immutable package to install.
        return Ok(caller_backend.to_path_buf());
    }
    if caller_backend != backend_in(source) {
        return Err("App Server executable does not match its package entrypoint".into());
    }

    let metadata_path = source.join(METADATA_FILE);
    let metadata_kind = fs::symlink_metadata(&metadata_path).map_err(|error| error.to_string())?;
    if !metadata_kind.is_file() || metadata_kind.file_type().is_symlink() {
        return Err("App Server package metadata must be a regular file".into());
    }
    let mut metadata = Vec::new();
    fs::File::open(&metadata_path)
        .map_err(|error| error.to_string())?
        .take(MAX_METADATA_BYTES + 1)
        .read_to_end(&mut metadata)
        .map_err(|error| error.to_string())?;
    if metadata.len() as u64 > MAX_METADATA_BYTES {
        return Err("App Server package metadata exceeds the size limit".into());
    }
    let files: PackageFiles =
        serde_json::from_slice(&metadata).map_err(|error| error.to_string())?;
    let runtime_binding = match files.javascript_runtime.kind.as_str() {
        "packagedNode" if files.javascript_runtime.electron_version.is_none() => None,
        "hostProvidedNode" => match &files.javascript_runtime.electron_version {
            Some(version) => Some(crate::runtime::ElectronRuntimeBinding::capture(
                electron.ok_or("Desktop package requires its Electron runtime")?,
                version,
            )?),
            None if files.build_profile == "dev-small" => return Ok(caller_backend.to_path_buf()),
            None => return Err("App Server installation requires a self-contained package".into()),
        },
        _ => return Err("App Server JavaScript runtime contract is invalid".into()),
    };

    let store_root = profile_root.join(STORE_DIRECTORY);
    let store = PackageStore::open(&store_root).map_err(|error| error.to_string())?;
    let installation = runtime_binding
        .as_ref()
        .map(serde_json::to_value)
        .transpose()
        .map_err(|error| error.to_string())?;
    if let Some(current) = store.current().map_err(|error| error.to_string())?
        && current.installation == installation
    {
        // A different selection still goes through the normal installation path, so
        // updating can replace a damaged old package without trying to execute it.
        let mut selected_metadata = Vec::new();
        fs::File::open(current.package_root.join(METADATA_FILE))
            .map_err(|error| error.to_string())?
            .take(MAX_METADATA_BYTES + 1)
            .read_to_end(&mut selected_metadata)
            .map_err(|error| error.to_string())?;
        // Reconnecting must not copy and delete the entire package again. On Windows
        // those writes can outlast terminal leases. Verify both immutable packages
        // before reusing the selection, including a caller changed after packaging.
        if selected_metadata == metadata {
            let selected = validate_package_identity(&current.package_root)
                .map_err(|error| error.to_string())?;
            if selected.build_id == files.build_id
                && validate_package_identity(source).map_err(|error| error.to_string())? == selected
            {
                if selection == ClientSelection::Explicit {
                    write_pin(&store_root, &files.build_id)?;
                }
                return Ok(backend_in(&current.package_root));
            }
        }
    }
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let staging = store_root.join(format!(".install-{}-{nonce}", std::process::id()));
    fs::create_dir(&staging).map_err(|error| error.to_string())?;
    let result = (|| {
        fs::write(staging.join(METADATA_FILE), metadata).map_err(|error| error.to_string())?;
        copy_package_files(source, &staging, &files.files)?;
        let selected = match &runtime_binding {
            Some(binding) => store.publish_with_installation(
                &staging,
                serde_json::to_value(binding).map_err(|error| error.to_string())?,
            ),
            None => store.publish(&staging),
        }
        .map_err(|error| error.to_string())?;
        if selection == ClientSelection::Explicit {
            // A rejected package must leave the previously selected build pinned.
            write_pin(&store_root, &files.build_id)?;
        }
        Ok(backend_in(&selected.package_root))
    })();
    if result.is_err() {
        let _ = fs::remove_dir_all(staging);
    }
    result
}

fn copy_package_files(
    source: &Path,
    staging: &Path,
    files: &BTreeMap<String, String>,
) -> Result<(), String> {
    #[cfg(windows)]
    if files.len() > 1 {
        // Windows package installation spends much of its time in per-file I/O.
        // Bound concurrency while retaining independent copies and every path check.
        let names = files.keys().collect::<Vec<_>>();
        let next = AtomicUsize::new(0);
        let failed = AtomicBool::new(false);
        let workers = std::thread::available_parallelism()
            .map(usize::from)
            .unwrap_or(1)
            .min(8)
            .min(names.len());
        return std::thread::scope(|scope| {
            let mut handles = Vec::with_capacity(workers);
            let mut failure = None;
            for index in 0..workers {
                let names = &names;
                let next = &next;
                let failed = &failed;
                let worker = std::thread::Builder::new()
                    .name(format!("ash-package-copy-{index}"))
                    .spawn_scoped(scope, move || {
                        while !failed.load(Ordering::Relaxed) {
                            let Some(name) = names.get(next.fetch_add(1, Ordering::Relaxed)) else {
                                return Ok(());
                            };
                            if let Err(error) = copy_package_file(source, staging, name) {
                                failed.store(true, Ordering::Relaxed);
                                return Err(error);
                            }
                        }
                        Ok(())
                    });
                match worker {
                    Ok(handle) => handles.push(handle),
                    Err(error) => {
                        failed.store(true, Ordering::Relaxed);
                        failure = Some(error.to_string());
                        break;
                    }
                }
            }
            // Join every writer before publication or removal of a failed staging directory.
            for handle in handles {
                if let Err(error) = handle
                    .join()
                    .unwrap_or_else(|_| Err("App Server package copy worker panicked".into()))
                {
                    failure.get_or_insert(error);
                }
            }
            failure.map_or(Ok(()), Err)
        });
    }
    for name in files.keys() {
        copy_package_file(source, staging, name)?;
    }
    Ok(())
}

fn copy_package_file(source: &Path, staging: &Path, name: &str) -> Result<(), String> {
    let relative = Path::new(name);
    if relative.components().count() == 0
        || !relative
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
    {
        return Err(format!(
            "App Server package contains an invalid path: {name}"
        ));
    }
    let from = source.join(relative);
    let mut parent = source.to_path_buf();
    for part in relative.components() {
        parent.push(part);
        let kind = fs::symlink_metadata(&parent).map_err(|error| error.to_string())?;
        if kind.file_type().is_symlink() {
            return Err(format!(
                "App Server package contains a symbolic path: {name}"
            ));
        }
    }
    let target = staging.join(relative);
    fs::create_dir_all(
        target
            .parent()
            .ok_or("App Server package path has no parent")?,
    )
    .map_err(|error| error.to_string())?;
    fs::copy(&from, &target).map_err(|error| error.to_string())?;
    let permissions = fs::metadata(from)
        .map_err(|error| error.to_string())?
        .permissions();
    fs::set_permissions(target, permissions).map_err(|error| error.to_string())?;
    Ok(())
}

pub(crate) fn selected_is_pinned(profile_root: &Path) -> Result<bool, String> {
    let store_root = profile_root.join(STORE_DIRECTORY);
    let pin_path = store_root.join(PIN_FILE);
    let pin_kind = match fs::symlink_metadata(&pin_path) {
        Ok(kind) => kind,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(error.to_string()),
    };
    if !pin_kind.is_file() || pin_kind.file_type().is_symlink() || pin_kind.len() != 71 {
        return Err("App Server pinned build identity is invalid".into());
    }
    let pin = fs::read_to_string(pin_path).map_err(|error| error.to_string())?;
    if !pin.starts_with("sha256:")
        || !pin[7..]
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err("App Server pinned build identity is invalid".into());
    }
    let store = PackageStore::open(store_root).map_err(|error| error.to_string())?;
    let Some(selected) = store.current().map_err(|error| error.to_string())? else {
        return Ok(false);
    };
    let metadata: PackageFiles = serde_json::from_slice(
        &fs::read(selected.package_root.join(METADATA_FILE)).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    // A later selection must not inherit a pin belonging to an older build.
    Ok(pin == metadata.build_id)
}

pub(crate) fn clear_pin(profile_root: &Path) -> Result<(), String> {
    match fs::remove_file(profile_root.join(STORE_DIRECTORY).join(PIN_FILE)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error.to_string()),
    }
}

fn write_pin(store_root: &Path, build_id: &str) -> Result<(), String> {
    let temporary = store_root.join(format!(".{PIN_FILE}.{}", std::process::id()));
    fs::write(&temporary, build_id).map_err(|error| error.to_string())?;
    let pin = store_root.join(PIN_FILE);
    match fs::remove_file(&pin) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    fs::rename(temporary, pin).map_err(|error| error.to_string())
}

pub(crate) fn backend_in(package: &Path) -> PathBuf {
    package.join("bin").join(if cfg!(windows) {
        "ash-app-server.exe"
    } else {
        "ash-app-server"
    })
}

#[cfg(test)]
#[path = "installation_tests.rs"]
mod tests;

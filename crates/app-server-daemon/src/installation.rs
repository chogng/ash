//! The profile owns its App Server package after the first packaged client connects.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use ash_package_store::PackageStore;
use serde::Deserialize;

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
}

pub(crate) fn selected_backend(
    profile_root: &Path,
    caller_backend: &Path,
) -> Result<PathBuf, String> {
    let store_root = profile_root.join(STORE_DIRECTORY);
    let store = PackageStore::open(&store_root).map_err(|error| error.to_string())?;
    if let Some(selected) = store.current().map_err(|error| error.to_string())? {
        return Ok(backend_in(&selected.package_root));
    }
    install_from_client(profile_root, caller_backend, ClientSelection::Initial)
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
    if files.javascript_runtime.kind != "packagedNode" {
        if files.build_profile == "dev-small" {
            return Ok(caller_backend.to_path_buf());
        }
        return Err("App Server installation requires a self-contained package".into());
    }

    let store_root = profile_root.join(STORE_DIRECTORY);
    let store = PackageStore::open(&store_root).map_err(|error| error.to_string())?;
    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let staging = store_root.join(format!(".install-{}-{nonce}", std::process::id()));
    fs::create_dir(&staging).map_err(|error| error.to_string())?;
    let result = (|| {
        fs::write(staging.join(METADATA_FILE), metadata).map_err(|error| error.to_string())?;
        for name in files.files.keys() {
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
        }
        let selected = store.publish(&staging).map_err(|error| error.to_string())?;
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

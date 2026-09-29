//! Installs a signed App Server release without changing a running generation.

use std::collections::BTreeSet;
use std::fs;
use std::fs::File;
use std::io::Read;
use std::io::Write;
use std::path::Component;
use std::path::Path;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use ash_app_server_protocol::protocol::initialize::APP_SERVER_CAPABILITY_VERSION;
use ash_app_server_protocol::protocol::initialize::APP_SERVER_PROTOCOL_MAJOR;
use ash_package_store::PackageStore;
use ash_product_update::ExpectedRelease;
use ash_product_update::PackageFormat;
use ash_product_update::UpdatePolicy;
use ash_product_update::UpdateProduct;
use ash_product_update::UpdatePublicKey;
use semver::Version;
use serde::Deserialize;
use serde::Serialize;

use crate::endpoint::EndpointPaths;

const REPOSITORY: &str = "chogng/ash";
const MAX_DESCRIPTOR_BYTES: u64 = 64 * 1024;
const MAX_ARCHIVE_ENTRIES: usize = 100_000;
const MAX_UNPACKED_BYTES: u64 = 4 * 1024 * 1024 * 1024;

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct UpdateOutput {
    status: &'static str,
    installed_version: String,
    restart_required: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PackageMetadata {
    layout_version: u32,
    build_profile: String,
    entrypoint: String,
    version: String,
    target: String,
    javascript_runtime: JavascriptRuntime,
    protocol: ProtocolIdentity,
    components: serde_json::Value,
}

#[derive(Deserialize)]
struct JavascriptRuntime {
    kind: String,
}

#[derive(Deserialize)]
struct ProtocolIdentity {
    major: u32,
    #[serde(rename = "capabilityVersion")]
    capability_version: u32,
}

pub(crate) fn install_stable(
    profile_root: &Path,
    caller_backend: &Path,
) -> Result<UpdateOutput, String> {
    let source = caller_backend
        .parent()
        .and_then(Path::parent)
        .ok_or("App Server executable is outside a package")?;
    if caller_backend != crate::installation::backend_in(source) {
        return Err("App Server executable does not match its package entrypoint".into());
    }
    let key = update_public_key(source)?;
    let target = build_info::BuildInfo::current().target;
    let descriptor_url = format!(
        "https://github.com/{REPOSITORY}/releases/download/ash-app-server-stable/ash-app-server-stable-{target}.update.json"
    );
    let response = ureq::get(&descriptor_url)
        .set("User-Agent", "Ash-App-Server-Update")
        .set("Accept", "application/json")
        .call()
        .map_err(|error| format!("could not fetch App Server update: {error}"))?;
    let mut descriptor = Vec::new();
    response
        .into_reader()
        .take(MAX_DESCRIPTOR_BYTES + 1)
        .read_to_end(&mut descriptor)
        .map_err(|error| format!("could not read App Server update: {error}"))?;
    if descriptor.len() as u64 > MAX_DESCRIPTOR_BYTES {
        return Err("App Server update description exceeds the size limit".into());
    }
    let release = ash_product_update::verify_release(
        &descriptor,
        key,
        &ExpectedRelease {
            product: UpdateProduct::AppServer,
            policy: UpdatePolicy::Stable,
            target: target.clone(),
        },
    )
    .map_err(|error| error.to_string())?;
    let expected_url = format!(
        "https://github.com/{REPOSITORY}/releases/download/{}/{}",
        release.release_identity, release.package.file_name
    );
    if release.release_identity != format!("v{}", release.version)
        || release.package.url != expected_url
        || !matches!(
            release.package.format,
            PackageFormat::TarGz | PackageFormat::Zip
        )
    {
        return Err("signed App Server update has an invalid release identity".into());
    }

    let store_root = profile_root.join("app-server-packages");
    let store = PackageStore::open(&store_root).map_err(|error| error.to_string())?;
    if let Some(installed) = installed_version(&store)? {
        if release.version <= installed {
            return Ok(UpdateOutput {
                status: "current",
                installed_version: installed.to_string(),
                restart_required: false,
            });
        }
    }

    let nonce = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let staging = store_root.join(format!(".update-{}-{nonce}", std::process::id()));
    fs::create_dir(&staging).map_err(|error| error.to_string())?;
    let result = (|| {
        let archive = ash_product_update::stage_verified_package(&release.package, &staging)
            .map_err(|error| error.to_string())?;
        let package = staging.join("package");
        fs::create_dir(&package).map_err(|error| error.to_string())?;
        extract_archive(&archive, release.package.format, &package)?;
        let metadata = package_metadata(&package)?;
        let expected_entrypoint = if cfg!(windows) {
            "bin/ash-app-server.exe"
        } else {
            "bin/ash-app-server"
        };
        if metadata.layout_version != 2
            || metadata.build_profile != "release"
            || metadata.entrypoint != expected_entrypoint
            || metadata.version != release.version.to_string()
            || metadata.target != target
            || metadata.javascript_runtime.kind != "packagedNode"
            || metadata.protocol.major != APP_SERVER_PROTOCOL_MAJOR
            || metadata.protocol.capability_version != APP_SERVER_CAPABILITY_VERSION
            || !metadata
                .components
                .get("appServer")
                .is_some_and(serde_json::Value::is_object)
            || metadata.components.get("cli").is_some()
        {
            return Err("signed App Server package does not match this client and target".into());
        }
        // Keep network and extraction outside the lifecycle lock, then compare again so a
        // concurrently selected newer package cannot be replaced by this download.
        let endpoint = EndpointPaths::prepare(profile_root)?;
        let _operation_lock = endpoint.acquire_operation_lock()?;
        if let Some(installed) = installed_version(&store)?
            && release.version <= installed
        {
            return Ok(UpdateOutput {
                status: "current",
                installed_version: installed.to_string(),
                restart_required: false,
            });
        }
        store.publish(&package).map_err(|error| error.to_string())?;
        Ok(UpdateOutput {
            status: "installed",
            installed_version: release.version.to_string(),
            restart_required: true,
        })
    })();
    let _ = fs::remove_dir_all(staging);
    result
}

fn installed_version(store: &PackageStore) -> Result<Option<Version>, String> {
    let Some(current) = store.current().map_err(|error| error.to_string())? else {
        return Ok(None);
    };
    let metadata = package_metadata(&current.package_root)?;
    Version::parse(&metadata.version)
        .map(Some)
        .map_err(|error| error.to_string())
}

fn update_public_key(source: &Path) -> Result<UpdatePublicKey, String> {
    let metadata: serde_json::Value = serde_json::from_slice(
        &fs::read(source.join("ash-package.json")).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let value = if let Some(key) = metadata["components"]["cli"]["updatePublicKey"].as_str() {
        key.to_owned()
    } else {
        let desktop_key = source.join("update-public-key");
        let kind = fs::symlink_metadata(&desktop_key).map_err(|error| error.to_string())?;
        if !kind.is_file() || kind.file_type().is_symlink() || kind.len() > 128 {
            return Err("caller package has no trusted App Server update key".into());
        }
        fs::read_to_string(desktop_key).map_err(|error| error.to_string())?
    };
    UpdatePublicKey::from_hex(value.trim()).map_err(|error| error.to_string())
}

fn package_metadata(root: &Path) -> Result<PackageMetadata, String> {
    serde_json::from_slice(
        &fs::read(root.join("ash-package.json")).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())
}

fn extract_archive(
    archive: &Path,
    format: PackageFormat,
    destination: &Path,
) -> Result<(), String> {
    match format {
        PackageFormat::TarGz => extract_tar_gz(archive, destination),
        PackageFormat::Zip => extract_zip(archive, destination),
        _ => Err("App Server update package has an unsupported format".into()),
    }
}

fn extract_tar_gz(archive: &Path, destination: &Path) -> Result<(), String> {
    let file = File::open(archive).map_err(|error| error.to_string())?;
    let mut archive = tar::Archive::new(flate2::read::GzDecoder::new(file));
    let mut unpacked = 0u64;
    let mut paths = BTreeSet::new();
    for entry in archive.entries().map_err(|error| error.to_string())? {
        let mut entry = entry.map_err(|error| error.to_string())?;
        let path = entry
            .path()
            .map_err(|error| error.to_string())?
            .into_owned();
        if !safe_relative_path(&path) || !paths.insert(path.clone()) {
            return Err(format!(
                "App Server archive entry escapes or repeats the package: {}",
                path.display()
            ));
        }
        let kind = entry.header().entry_type();
        if !kind.is_file() && !kind.is_dir() {
            return Err(format!(
                "App Server archive entry has an unsupported type: {}",
                path.display()
            ));
        }
        unpacked = unpacked
            .checked_add(entry.size())
            .filter(|total| *total <= MAX_UNPACKED_BYTES)
            .ok_or("unpacked App Server package exceeds the size limit")?;
        entry
            .unpack_in(destination)
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn extract_zip(archive: &Path, destination: &Path) -> Result<(), String> {
    let file = File::open(archive).map_err(|error| error.to_string())?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| error.to_string())?;
    if archive.len() > MAX_ARCHIVE_ENTRIES {
        return Err("App Server archive contains too many entries".into());
    }
    let mut unpacked = 0u64;
    let mut paths = BTreeSet::new();
    for index in 0..archive.len() {
        let entry = archive.by_index(index).map_err(|error| error.to_string())?;
        let path = entry
            .enclosed_name()
            .ok_or_else(|| format!("App Server archive entry path is invalid: {}", entry.name()))?
            .to_owned();
        if !safe_relative_path(&path) || !paths.insert(path.clone()) {
            return Err(format!(
                "App Server archive entry escapes or repeats the package: {}",
                path.display()
            ));
        }
        if entry.is_symlink() || entry.encrypted() {
            return Err(format!(
                "App Server archive entry has an unsupported type: {}",
                path.display()
            ));
        }
        unpacked = unpacked
            .checked_add(entry.size())
            .filter(|total| *total <= MAX_UNPACKED_BYTES)
            .ok_or("unpacked App Server package exceeds the size limit")?;
        let output = destination.join(&path);
        if entry.is_dir() {
            fs::create_dir_all(output).map_err(|error| error.to_string())?;
            continue;
        }
        if !entry.is_file() {
            return Err(format!(
                "App Server archive entry has an unsupported type: {}",
                path.display()
            ));
        }
        fs::create_dir_all(
            output
                .parent()
                .ok_or("App Server archive entry has no parent")?,
        )
        .map_err(|error| error.to_string())?;
        let mut target = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&output)
            .map_err(|error| error.to_string())?;
        let size = entry.size();
        #[cfg(unix)]
        let mode = entry.unix_mode();
        let copied = std::io::copy(&mut entry.take(size + 1), &mut target)
            .map_err(|error| error.to_string())?;
        if copied != size {
            return Err(format!(
                "App Server archive entry is truncated: {}",
                path.display()
            ));
        }
        target.flush().map_err(|error| error.to_string())?;
        #[cfg(unix)]
        if let Some(mode) = mode {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(
                &output,
                fs::Permissions::from_mode(if mode & 0o111 == 0 { 0o644 } else { 0o755 }),
            )
            .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

fn safe_relative_path(path: &Path) -> bool {
    let mut components = path.components();
    components
        .next()
        .is_some_and(|component| matches!(component, Component::Normal(_)))
        && components.all(|component| matches!(component, Component::Normal(_)))
}

#[cfg(test)]
#[path = "update_tests.rs"]
mod tests;

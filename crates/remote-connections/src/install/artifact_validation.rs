use std::collections::BTreeSet;
use std::fs;
use std::fs::File;
use std::io::Read;
use std::io::Seek;
use std::io::SeekFrom;
use std::path::Component;
use std::path::Path;

use flate2::read::GzDecoder;
use serde_json::Value;
use sha2::Digest;
use sha2::Sha256;
use tar::Archive;

use super::RemoteRuntimeArtifact;
use super::RemoteRuntimeInstallError;

const MAX_PACKAGE_METADATA_BYTES: u64 = 64 * 1024;

pub(crate) fn open_and_validate_artifact(
    artifact: &RemoteRuntimeArtifact,
) -> Result<File, RemoteRuntimeInstallError> {
    let path_metadata = fs::symlink_metadata(&artifact.archive)
        .map_err(RemoteRuntimeInstallError::artifact_unavailable)?;
    if path_metadata.file_type().is_symlink() || !path_metadata.is_file() {
        return Err(RemoteRuntimeInstallError::artifact_integrity(
            "runtime artifact is not an unlinked regular file",
        ));
    }
    let mut file =
        File::open(&artifact.archive).map_err(RemoteRuntimeInstallError::artifact_unavailable)?;
    let metadata = file
        .metadata()
        .map_err(RemoteRuntimeInstallError::artifact_unavailable)?;
    if !metadata.is_file() {
        return Err(RemoteRuntimeInstallError::artifact_integrity(
            "runtime artifact is not a regular file",
        ));
    }
    if metadata.len() != artifact.integrity.archive_size.get() {
        return Err(RemoteRuntimeInstallError::artifact_integrity(format!(
            "runtime artifact size mismatch: expected {}, observed {}",
            artifact.integrity.archive_size,
            metadata.len()
        )));
    }

    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    loop {
        let read = file
            .read(&mut buffer)
            .map_err(RemoteRuntimeInstallError::artifact_unavailable)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
    }
    let observed = format!("{:x}", hasher.finalize());
    if observed != artifact.integrity.sha256 {
        return Err(RemoteRuntimeInstallError::artifact_integrity(format!(
            "runtime artifact SHA-256 mismatch: expected {}, observed {observed}",
            artifact.integrity.sha256
        )));
    }
    file.seek(SeekFrom::Start(0))
        .map_err(RemoteRuntimeInstallError::artifact_unavailable)?;
    validate_package_archive(&mut file, artifact)?;
    Ok(file)
}

fn validate_package_archive(
    file: &mut File,
    artifact: &RemoteRuntimeArtifact,
) -> Result<(), RemoteRuntimeInstallError> {
    let decoder = GzDecoder::new(file);
    let mut archive = Archive::new(decoder);
    let entries = archive.entries().map_err(|error| {
        RemoteRuntimeInstallError::artifact_integrity(format!(
            "runtime artifact is not a readable tar.gz: {error}"
        ))
    })?;
    let mut paths = BTreeSet::new();
    let mut unpacked_size = 0_u64;
    let mut metadata = None;
    for entry in entries {
        let mut entry = entry.map_err(|error| {
            RemoteRuntimeInstallError::artifact_integrity(format!(
                "runtime artifact contains an invalid tar entry: {error}"
            ))
        })?;
        let path = entry.path().map_err(|error| {
            RemoteRuntimeInstallError::artifact_integrity(format!(
                "runtime artifact contains an invalid path: {error}"
            ))
        })?;
        if !path
            .components()
            .all(|component| matches!(component, Component::Normal(_)))
        {
            return Err(RemoteRuntimeInstallError::artifact_integrity(format!(
                "runtime artifact path is not normalized: {}",
                path.display()
            )));
        }
        let path = path.into_owned();
        if !paths.insert(path.clone()) {
            return Err(RemoteRuntimeInstallError::artifact_integrity(format!(
                "runtime artifact repeats path: {}",
                path.display()
            )));
        }
        let entry_type = entry.header().entry_type();
        if !entry_type.is_file() && !entry_type.is_dir() {
            return Err(RemoteRuntimeInstallError::artifact_integrity(format!(
                "runtime artifact contains a linked or special entry: {}",
                path.display()
            )));
        }
        if entry_type.is_file() {
            unpacked_size = unpacked_size.checked_add(entry.size()).ok_or_else(|| {
                RemoteRuntimeInstallError::artifact_integrity(
                    "runtime artifact unpacked size overflowed",
                )
            })?;
        }
        if path == Path::new("ash-package.json") {
            if !entry_type.is_file() || entry.size() > MAX_PACKAGE_METADATA_BYTES {
                return Err(RemoteRuntimeInstallError::artifact_integrity(
                    "runtime package metadata is not a bounded regular file",
                ));
            }
            let mut bytes = Vec::with_capacity(entry.size() as usize);
            entry.read_to_end(&mut bytes).map_err(|error| {
                RemoteRuntimeInstallError::artifact_integrity(format!(
                    "could not read runtime package metadata: {error}"
                ))
            })?;
            metadata = Some(bytes);
        }
    }
    if unpacked_size != artifact.integrity.unpacked_size.get() {
        return Err(RemoteRuntimeInstallError::artifact_integrity(format!(
            "runtime artifact unpacked size mismatch: expected {}, observed {unpacked_size}",
            artifact.integrity.unpacked_size
        )));
    }
    for required in [
        "ash-package.json",
        "bin/ash-app-server-daemon",
        "bin/ash-remote-server",
        "bin/ash-app-server",
        "ash-path/rg",
        "ash-resources/tgrep/tgrep",
        "ash-resources/node/bin/node",
    ] {
        if !paths.contains(Path::new(required)) {
            return Err(RemoteRuntimeInstallError::artifact_integrity(format!(
                "runtime artifact is missing `{required}`"
            )));
        }
    }
    validate_package_metadata(
        metadata.as_deref().ok_or_else(|| {
            RemoteRuntimeInstallError::artifact_integrity(
                "runtime artifact is missing ash-package.json",
            )
        })?,
        artifact,
    )
}

fn validate_package_metadata(
    bytes: &[u8],
    artifact: &RemoteRuntimeArtifact,
) -> Result<(), RemoteRuntimeInstallError> {
    let metadata: Value = serde_json::from_slice(bytes).map_err(|error| {
        RemoteRuntimeInstallError::artifact_integrity(format!(
            "runtime package metadata is invalid JSON: {error}"
        ))
    })?;
    let expected = [
        ("layoutVersion", Value::from(2)),
        ("version", Value::from(artifact.version.as_str())),
        ("target", Value::from(artifact.platform.target_triple())),
        ("entrypoint", Value::from("bin/ash-app-server")),
        ("pathDir", Value::from("ash-path")),
        ("resourcesDir", Value::from("ash-resources")),
    ];
    for (key, value) in expected {
        if metadata.get(key) != Some(&value) {
            return Err(RemoteRuntimeInstallError::artifact_integrity(format!(
                "runtime package metadata `{key}` does not match the trusted artifact record"
            )));
        }
    }
    if metadata.pointer("/javascriptRuntime/kind") != Some(&Value::from("packagedNode")) {
        return Err(RemoteRuntimeInstallError::artifact_integrity(
            "Remote runtime package must include its own packaged Node runtime",
        ));
    }
    Ok(())
}

pub(super) fn is_canonical_absolute_posix_path(value: &str) -> bool {
    !value.is_empty()
        && value.starts_with('/')
        && !value.ends_with('/')
        && !value.contains('\0')
        && !value.contains('\n')
        && !value.contains('\r')
        && value
            .split('/')
            .skip(1)
            .all(|segment| !segment.is_empty() && !matches!(segment, "." | ".."))
}

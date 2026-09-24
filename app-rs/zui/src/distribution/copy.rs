use std::path::Path;

use super::BundleError;
use super::BundleManifest;

pub(super) fn create_root(path: &Path) -> Result<(), BundleError> {
    if path.exists() {
        return Err(BundleError::message("bundle output already exists"));
    }
    std::fs::create_dir_all(path).map_err(BundleError::source)
}

pub(super) fn copy_file(source: &Path, destination: &Path) -> Result<(), BundleError> {
    let metadata = std::fs::symlink_metadata(source).map_err(BundleError::source)?;
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(BundleError::message(
            "bundle file input must be a regular file",
        ));
    }
    if destination.exists() {
        return Err(BundleError::message(
            "bundle inputs resolve to the same destination",
        ));
    }
    if let Some(parent) = destination.parent() {
        std::fs::create_dir_all(parent).map_err(BundleError::source)?;
    }
    std::fs::copy(source, destination).map_err(BundleError::source)?;
    Ok(())
}

pub(super) fn copy_resources(
    manifest: &BundleManifest,
    resource_root: &Path,
) -> Result<(), BundleError> {
    for resource in &manifest.resources {
        let destination = resource_root.join(resource.destination.as_path());
        if destination.exists() {
            return Err(BundleError::message(
                "bundle resources overlap at one destination",
            ));
        }
        copy_entry(&resource.source, &destination)?;
    }
    Ok(())
}

fn copy_entry(source: &Path, destination: &Path) -> Result<(), BundleError> {
    let metadata = std::fs::symlink_metadata(source).map_err(BundleError::source)?;
    if metadata.file_type().is_symlink() {
        return Err(BundleError::message(
            "bundle resources cannot contain symbolic links",
        ));
    }
    if metadata.is_file() {
        return copy_file(source, destination);
    }
    if !metadata.is_dir() {
        return Err(BundleError::message(
            "bundle resource must be a file or directory",
        ));
    }
    std::fs::create_dir_all(destination).map_err(BundleError::source)?;
    for entry in std::fs::read_dir(source).map_err(BundleError::source)? {
        let entry = entry.map_err(BundleError::source)?;
        copy_entry(&entry.path(), &destination.join(entry.file_name()))?;
    }
    Ok(())
}

#[cfg(unix)]
pub(super) fn make_executable(path: &Path) -> Result<(), BundleError> {
    use std::os::unix::fs::PermissionsExt;

    let mut permissions = std::fs::metadata(path)
        .map_err(BundleError::source)?
        .permissions();
    permissions.set_mode(permissions.mode() | 0o755);
    std::fs::set_permissions(path, permissions).map_err(BundleError::source)
}

#[cfg(not(unix))]
pub(super) fn make_executable(_path: &Path) -> Result<(), BundleError> {
    Ok(())
}

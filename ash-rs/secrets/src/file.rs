use std::fmt::Write as _;
use std::fs;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

use ash_utils_path::CanonicalPathRoot;
use ash_utils_path::NoSymlinkPathError;
use ash_utils_path::NoSymlinkPathStatus;
use sha2::Digest;
use sha2::Sha256;
use zeroize::Zeroize;

use crate::DeleteSecretOutcome;
use crate::SecretKey;
use crate::SecretStore;
use crate::SecretStoreError;
use crate::SecretStoreErrorKind;
use crate::SecretValue;

#[cfg(windows)]
#[path = "file_windows.rs"]
mod windows;

const MAX_SECRET_BYTES: u64 = 1024 * 1024;
const KEY_DOMAIN: &[u8] = b"ash-file-secret-store-key-v1\0";

/// Profile-scoped durable secret backend rooted in a private product directory.
///
/// Keys are represented only by domain-separated SHA-256 filenames. Values are written through a
/// private, synced staging file and atomically promoted under a process-local operation lock. On
/// Unix, directories are mode 0700 and value files are mode 0600. Windows uses an owner-only
/// protected DACL and write-through atomic replacement. Other platforms fail closed.
pub struct FileSecretStore {
    values: PathBuf,
    boundary: CanonicalPathRoot,
    operations: Mutex<()>,
}

impl FileSecretStore {
    pub fn open(root: impl AsRef<Path>) -> Result<Self, SecretStoreError> {
        let (values, boundary) = prepare_values_directory(root.as_ref())?;
        Ok(Self {
            values,
            boundary,
            operations: Mutex::new(()),
        })
    }

    fn value_path(&self, key: &SecretKey) -> PathBuf {
        self.values.join(key_filename(key))
    }
}

#[cfg(any(unix, windows))]
fn prepare_values_directory(root: &Path) -> Result<(PathBuf, CanonicalPathRoot), SecretStoreError> {
    let root = std::path::absolute(root).map_err(store_io)?;
    fs::create_dir_all(&root).map_err(store_io)?;
    let boundary = CanonicalPathRoot::new(&root).map_err(store_io)?;
    require_existing_path(&boundary, &root)?;
    set_private_directory_permissions(&root)?;
    let values = root.join("values");
    ensure_directory_without_symlinks(&boundary, &values)?;
    set_private_directory_permissions(&values)?;
    cleanup_staging_files(&values)?;
    sync_directory(&values)?;
    Ok((values, boundary))
}

#[cfg(not(any(unix, windows)))]
fn prepare_values_directory(_: &Path) -> Result<(PathBuf, CanonicalPathRoot), SecretStoreError> {
    Err(SecretStoreError::new(
        SecretStoreErrorKind::BackendUnavailable,
        "private file secret storage is unavailable on this platform",
    ))
}

impl SecretStore for FileSecretStore {
    fn load(&self, key: &SecretKey) -> Result<Option<SecretValue>, SecretStoreError> {
        let _guard = self.operations.lock().map_err(lock_error)?;
        let path = self.value_path(key);
        let metadata = match inspect_path(&self.boundary, &path)? {
            NoSymlinkPathStatus::Existing => fs::symlink_metadata(&path).map_err(store_io)?,
            NoSymlinkPathStatus::Missing => return Ok(None),
        };
        if !metadata.file_type().is_file() || metadata.len() > MAX_SECRET_BYTES {
            return Err(backend_failure(
                "secret store value is not a bounded regular file",
            ));
        }
        let file = fs::File::open(path).map_err(store_io)?;
        let mut value = Vec::with_capacity(metadata.len() as usize);
        if let Err(error) = file.take(MAX_SECRET_BYTES + 1).read_to_end(&mut value) {
            value.zeroize();
            return Err(store_io(error));
        }
        if value.len() as u64 > MAX_SECRET_BYTES {
            value.zeroize();
            return Err(backend_failure("secret store value exceeds its size limit"));
        }
        Ok(Some(SecretValue::new(value)))
    }

    fn store(&self, key: &SecretKey, value: &SecretValue) -> Result<(), SecretStoreError> {
        if value.expose().len() as u64 > MAX_SECRET_BYTES {
            return Err(backend_failure("secret value exceeds its size limit"));
        }
        let _guard = self.operations.lock().map_err(lock_error)?;
        let destination = self.value_path(key);
        match inspect_path(&self.boundary, &destination)? {
            NoSymlinkPathStatus::Existing
                if !fs::symlink_metadata(&destination)
                    .map_err(store_io)?
                    .file_type()
                    .is_file() =>
            {
                return Err(backend_failure(
                    "secret store destination is not a regular file",
                ));
            }
            NoSymlinkPathStatus::Existing | NoSymlinkPathStatus::Missing => {}
        }
        let staging = self.values.join(staging_filename()?);
        let result = (|| {
            let mut options = fs::OpenOptions::new();
            options.create_new(true).write(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            let mut file = options.open(&staging).map_err(store_io)?;
            file.write_all(value.expose()).map_err(store_io)?;
            file.sync_all().map_err(store_io)?;
            promote_file(&staging, &destination)?;
            sync_directory(&self.values)
        })();
        if staging.exists() {
            let _ = fs::remove_file(staging);
        }
        result
    }

    fn delete(&self, key: &SecretKey) -> Result<DeleteSecretOutcome, SecretStoreError> {
        let _guard = self.operations.lock().map_err(lock_error)?;
        let path = self.value_path(key);
        if inspect_path(&self.boundary, &path)? == NoSymlinkPathStatus::Missing {
            return Ok(DeleteSecretOutcome::NotFound);
        }
        match fs::remove_file(path) {
            Ok(()) => {
                sync_directory(&self.values)?;
                Ok(DeleteSecretOutcome::Deleted)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                Ok(DeleteSecretOutcome::NotFound)
            }
            Err(error) => Err(store_io(error)),
        }
    }
}

fn key_filename(key: &SecretKey) -> String {
    let mut digest = Sha256::new();
    digest.update(KEY_DOMAIN);
    digest.update((key.as_str().len() as u64).to_be_bytes());
    digest.update(key.as_str().as_bytes());
    hex_digest(digest.finalize())
}

fn staging_filename() -> Result<String, SecretStoreError> {
    let mut random = [0_u8; 16];
    getrandom::getrandom(&mut random)
        .map_err(|_| backend_failure("secret staging identity could not be generated"))?;
    Ok(format!(".tmp-{}", hex_digest(random)))
}

fn hex_digest(bytes: impl IntoIterator<Item = u8>) -> String {
    let mut value = String::with_capacity(64);
    for byte in bytes {
        write!(value, "{byte:02x}").expect("writing to a String cannot fail");
    }
    value
}

fn cleanup_staging_files(values: &Path) -> Result<(), SecretStoreError> {
    for entry in fs::read_dir(values).map_err(store_io)? {
        let entry = entry.map_err(store_io)?;
        if entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(".tmp-"))
            && entry.file_type().map_err(store_io)?.is_file()
        {
            fs::remove_file(entry.path()).map_err(store_io)?;
        }
    }
    Ok(())
}

fn inspect_path(
    boundary: &CanonicalPathRoot,
    path: &Path,
) -> Result<NoSymlinkPathStatus, SecretStoreError> {
    boundary
        .inspect_without_symlinks(path)
        .map_err(no_symlink_path_error)
}

fn require_existing_path(
    boundary: &CanonicalPathRoot,
    path: &Path,
) -> Result<(), SecretStoreError> {
    if inspect_path(boundary, path)? != NoSymlinkPathStatus::Existing {
        return Err(backend_failure("secret store path is unavailable"));
    }
    Ok(())
}

fn ensure_directory_without_symlinks(
    boundary: &CanonicalPathRoot,
    path: &Path,
) -> Result<(), SecretStoreError> {
    if inspect_path(boundary, path)? == NoSymlinkPathStatus::Missing {
        fs::create_dir_all(path).map_err(store_io)?;
    }
    require_existing_path(boundary, path)?;
    if !fs::symlink_metadata(path)
        .map_err(store_io)?
        .file_type()
        .is_dir()
    {
        return Err(backend_failure(
            "secret store path is not a private directory",
        ));
    }
    Ok(())
}

fn no_symlink_path_error(error: NoSymlinkPathError) -> SecretStoreError {
    match error {
        NoSymlinkPathError::Unavailable { source, .. } => store_io(source),
        NoSymlinkPathError::OutsideRoot(_) | NoSymlinkPathError::Symlink(_) => {
            backend_failure("secret store path contains a symbolic link")
        }
    }
}

#[cfg(not(windows))]
fn promote_file(staging: &Path, destination: &Path) -> Result<(), SecretStoreError> {
    fs::rename(staging, destination).map_err(store_io)
}

#[cfg(windows)]
fn promote_file(staging: &Path, destination: &Path) -> Result<(), SecretStoreError> {
    windows::promote_file(staging, destination).map_err(store_io)
}

#[cfg(unix)]
fn set_private_directory_permissions(path: &Path) -> Result<(), SecretStoreError> {
    use std::os::unix::fs::PermissionsExt;

    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).map_err(store_io)
}

#[cfg(windows)]
fn set_private_directory_permissions(path: &Path) -> Result<(), SecretStoreError> {
    windows::set_private_directory_permissions(path).map_err(store_io)
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), SecretStoreError> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(store_io)
}

#[cfg(windows)]
fn sync_directory(_: &Path) -> Result<(), SecretStoreError> {
    Ok(())
}

fn lock_error<T>(_: std::sync::PoisonError<T>) -> SecretStoreError {
    backend_failure("secret store operation lock poisoned")
}

fn store_io(error: std::io::Error) -> SecretStoreError {
    let kind = if error.kind() == std::io::ErrorKind::PermissionDenied {
        SecretStoreErrorKind::AccessDenied
    } else {
        SecretStoreErrorKind::BackendFailure
    };
    SecretStoreError::new(kind, "secret store filesystem operation failed")
}

fn backend_failure(message: &'static str) -> SecretStoreError {
    SecretStoreError::new(SecretStoreErrorKind::BackendFailure, message)
}

#[cfg(test)]
#[path = "file_tests.rs"]
mod tests;

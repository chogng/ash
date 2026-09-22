//! Content-addressed attachment byte storage, independent of media processing and transport.

use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::io::Write;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;

use ash_protocol::ContentDigest;
use ash_utils_path::CanonicalPathRoot;
use ash_utils_path::NoSymlinkPathError;
use ash_utils_path::NoSymlinkPathStatus;

mod error;

pub use error::AttachmentStoreError;

/// Maximum encoded bytes accepted for one stored attachment.
pub const MAX_ATTACHMENT_BYTES: usize = 16 * 1024 * 1024;

/// Commits immutable attachment bytes before returning their digest.
/// Implementations verify content identity and size on every read; media validation belongs
/// to the attachment service. Untrusted metadata never selects arbitrary filesystem paths.
pub trait AttachmentStore: Send + Sync {
    fn put(&self, bytes: Arc<[u8]>) -> Result<ContentDigest, AttachmentStoreError>;
    fn read(
        &self,
        digest: &ContentDigest,
        encoded_bytes: u64,
    ) -> Result<Arc<[u8]>, AttachmentStoreError>;
}

/// Process-local store for explicitly ephemeral products and tests.
#[derive(Default)]
pub struct MemoryAttachmentStore {
    bytes: Mutex<BTreeMap<ContentDigest, Arc<[u8]>>>,
}

impl AttachmentStore for MemoryAttachmentStore {
    fn put(&self, bytes: Arc<[u8]>) -> Result<ContentDigest, AttachmentStoreError> {
        validate_size(bytes.len() as u64)?;
        let digest = ContentDigest::sha256(&bytes);
        self.bytes
            .lock()
            .map_err(|_| AttachmentStoreError::Corrupt)?
            .insert(digest.clone(), bytes);
        Ok(digest)
    }

    fn read(
        &self,
        digest: &ContentDigest,
        encoded_bytes: u64,
    ) -> Result<Arc<[u8]>, AttachmentStoreError> {
        validate_size(encoded_bytes)?;
        let bytes = self
            .bytes
            .lock()
            .map_err(|_| AttachmentStoreError::Corrupt)?
            .get(digest)
            .cloned()
            .ok_or(AttachmentStoreError::NotFound)?;
        verify_bytes(digest, encoded_bytes, &bytes)?;
        Ok(bytes)
    }
}

/// Content-addressed file store rooted under one application profile.
pub struct FileAttachmentStore {
    root: PathBuf,
    boundary: CanonicalPathRoot,
}

impl FileAttachmentStore {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, AttachmentStoreError> {
        let root = std::path::absolute(root.into())
            .map_err(|source| AttachmentStoreError::storage("attachments", source))?;
        create_private_directory(&root)?;
        let boundary = CanonicalPathRoot::new(&root)
            .map_err(|source| AttachmentStoreError::storage(&root, source))?;
        require_existing_path(&boundary, &root)?;
        Ok(Self { root, boundary })
    }

    fn path_for(&self, digest: &ContentDigest) -> PathBuf {
        let hex = digest
            .as_str()
            .strip_prefix("sha256:")
            .expect("ContentDigest validates its algorithm prefix");
        self.root.join("sha256").join(&hex[..2]).join(hex)
    }
}

impl AttachmentStore for FileAttachmentStore {
    fn put(&self, bytes: Arc<[u8]>) -> Result<ContentDigest, AttachmentStoreError> {
        validate_size(bytes.len() as u64)?;
        let digest = ContentDigest::sha256(&bytes);
        let path = self.path_for(&digest);
        if inspect_path(&self.boundary, &path)? == NoSymlinkPathStatus::Existing {
            self.read(&digest, bytes.len() as u64)?;
            return Ok(digest);
        }
        let parent = path.parent().expect("attachment paths have a parent");
        ensure_directory_without_symlinks(&self.boundary, parent)?;
        let mut temporary = tempfile::Builder::new()
            .prefix(".attachment-")
            .tempfile_in(parent)
            .map_err(|source| AttachmentStoreError::storage(parent, source))?;
        set_private_file_permissions(temporary.as_file(), temporary.path())?;
        temporary
            .write_all(&bytes)
            .map_err(|source| AttachmentStoreError::storage(temporary.path(), source))?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|source| AttachmentStoreError::storage(temporary.path(), source))?;
        match temporary.persist_noclobber(&path) {
            Ok(_) => {
                // Unix supports syncing a directory after publishing its entry. Windows file
                // handles cannot open directories this way; the file was synced before publish.
                #[cfg(unix)]
                sync_directory(parent)?;
            }
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                self.read(&digest, bytes.len() as u64)?;
            }
            Err(error) => return Err(AttachmentStoreError::storage(&path, error.error)),
        }
        Ok(digest)
    }

    fn read(
        &self,
        digest: &ContentDigest,
        encoded_bytes: u64,
    ) -> Result<Arc<[u8]>, AttachmentStoreError> {
        validate_size(encoded_bytes)?;
        let path = self.path_for(digest);
        if inspect_path(&self.boundary, &path)? == NoSymlinkPathStatus::Missing {
            return Err(AttachmentStoreError::NotFound);
        }
        let metadata = fs::symlink_metadata(&path)
            .map_err(|source| AttachmentStoreError::storage(&path, source))?;
        if !metadata.file_type().is_file() || metadata.len() != encoded_bytes {
            return Err(AttachmentStoreError::Corrupt);
        }
        let file =
            fs::File::open(&path).map_err(|source| AttachmentStoreError::storage(&path, source))?;
        let mut bytes = Vec::with_capacity(encoded_bytes as usize);
        file.take(encoded_bytes + 1)
            .read_to_end(&mut bytes)
            .map_err(|source| AttachmentStoreError::storage(&path, source))?;
        verify_bytes(digest, encoded_bytes, &bytes)?;
        Ok(bytes.into())
    }
}

fn validate_size(size: u64) -> Result<(), AttachmentStoreError> {
    if size == 0 || size > MAX_ATTACHMENT_BYTES as u64 {
        return Err(AttachmentStoreError::TooLarge);
    }
    Ok(())
}

fn verify_bytes(
    digest: &ContentDigest,
    encoded_bytes: u64,
    bytes: &[u8],
) -> Result<(), AttachmentStoreError> {
    if bytes.len() as u64 != encoded_bytes || ContentDigest::sha256(bytes) != *digest {
        return Err(AttachmentStoreError::Corrupt);
    }
    Ok(())
}

fn create_private_directory(path: &Path) -> Result<(), AttachmentStoreError> {
    fs::create_dir_all(path).map_err(|source| AttachmentStoreError::storage(path, source))?;
    let metadata =
        fs::symlink_metadata(path).map_err(|source| AttachmentStoreError::storage(path, source))?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(AttachmentStoreError::Corrupt);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|source| AttachmentStoreError::storage(path, source))?;
    }
    Ok(())
}

fn inspect_path(
    boundary: &CanonicalPathRoot,
    path: &Path,
) -> Result<NoSymlinkPathStatus, AttachmentStoreError> {
    boundary
        .inspect_without_symlinks(path)
        .map_err(|error| match error {
            NoSymlinkPathError::Unavailable { path, source } => {
                AttachmentStoreError::storage(path, source)
            }
            NoSymlinkPathError::OutsideRoot(_) | NoSymlinkPathError::Symlink(_) => {
                AttachmentStoreError::Corrupt
            }
        })
}

fn require_existing_path(
    boundary: &CanonicalPathRoot,
    path: &Path,
) -> Result<(), AttachmentStoreError> {
    if inspect_path(boundary, path)? != NoSymlinkPathStatus::Existing {
        return Err(AttachmentStoreError::Corrupt);
    }
    Ok(())
}

fn ensure_directory_without_symlinks(
    boundary: &CanonicalPathRoot,
    path: &Path,
) -> Result<(), AttachmentStoreError> {
    if inspect_path(boundary, path)? == NoSymlinkPathStatus::Missing {
        fs::create_dir_all(path).map_err(|source| AttachmentStoreError::storage(path, source))?;
    }
    require_existing_path(boundary, path)?;
    let metadata =
        fs::symlink_metadata(path).map_err(|source| AttachmentStoreError::storage(path, source))?;
    if !metadata.file_type().is_dir() {
        return Err(AttachmentStoreError::Corrupt);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|source| AttachmentStoreError::storage(path, source))?;
    }
    Ok(())
}

fn set_private_file_permissions(file: &fs::File, path: &Path) -> Result<(), AttachmentStoreError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|source| AttachmentStoreError::storage(path, source))?;
    }
    #[cfg(not(unix))]
    let _ = (file, path);
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<(), AttachmentStoreError> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|source| AttachmentStoreError::storage(path, source))
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;

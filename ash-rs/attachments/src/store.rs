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

use crate::AttachmentError;
use crate::MAX_ATTACHMENT_BYTES;

/// Commits immutable attachment bytes before returning their digest.
/// Implementations verify content identity and size on every read; media validation belongs
/// to the attachment service. Untrusted metadata never selects arbitrary filesystem paths.
pub trait AttachmentStore: Send + Sync {
    fn put(&self, bytes: Arc<[u8]>) -> Result<ContentDigest, AttachmentError>;
    fn read(
        &self,
        digest: &ContentDigest,
        encoded_bytes: u64,
    ) -> Result<Arc<[u8]>, AttachmentError>;
}

/// Process-local store for explicitly ephemeral products and tests.
#[derive(Default)]
pub struct MemoryAttachmentStore {
    bytes: Mutex<BTreeMap<ContentDigest, Arc<[u8]>>>,
}

impl AttachmentStore for MemoryAttachmentStore {
    fn put(&self, bytes: Arc<[u8]>) -> Result<ContentDigest, AttachmentError> {
        validate_size(bytes.len() as u64)?;
        let digest = ContentDigest::sha256(&bytes);
        self.bytes
            .lock()
            .map_err(|_| AttachmentError::Corrupt)?
            .insert(digest.clone(), bytes);
        Ok(digest)
    }

    fn read(
        &self,
        digest: &ContentDigest,
        encoded_bytes: u64,
    ) -> Result<Arc<[u8]>, AttachmentError> {
        validate_size(encoded_bytes)?;
        let bytes = self
            .bytes
            .lock()
            .map_err(|_| AttachmentError::Corrupt)?
            .get(digest)
            .cloned()
            .ok_or(AttachmentError::NotFound)?;
        verify_bytes(digest, encoded_bytes, &bytes)?;
        Ok(bytes)
    }
}

/// Crash-safe content-addressed store rooted under one application profile.
pub struct FileAttachmentStore {
    root: PathBuf,
    boundary: CanonicalPathRoot,
}

impl FileAttachmentStore {
    pub fn open(root: impl Into<PathBuf>) -> Result<Self, AttachmentError> {
        let root = std::path::absolute(root.into())
            .map_err(|source| AttachmentError::storage("attachments", source))?;
        create_private_directory(&root)?;
        let boundary = CanonicalPathRoot::new(&root)
            .map_err(|source| AttachmentError::storage(&root, source))?;
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
    fn put(&self, bytes: Arc<[u8]>) -> Result<ContentDigest, AttachmentError> {
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
            .map_err(|source| AttachmentError::storage(parent, source))?;
        set_private_file_permissions(temporary.as_file(), temporary.path())?;
        temporary
            .write_all(&bytes)
            .map_err(|source| AttachmentError::storage(temporary.path(), source))?;
        temporary
            .as_file()
            .sync_all()
            .map_err(|source| AttachmentError::storage(temporary.path(), source))?;
        match temporary.persist_noclobber(&path) {
            Ok(_) => sync_directory(parent)?,
            Err(error) if error.error.kind() == std::io::ErrorKind::AlreadyExists => {
                self.read(&digest, bytes.len() as u64)?;
            }
            Err(error) => return Err(AttachmentError::storage(&path, error.error)),
        }
        Ok(digest)
    }

    fn read(
        &self,
        digest: &ContentDigest,
        encoded_bytes: u64,
    ) -> Result<Arc<[u8]>, AttachmentError> {
        validate_size(encoded_bytes)?;
        let path = self.path_for(digest);
        if inspect_path(&self.boundary, &path)? == NoSymlinkPathStatus::Missing {
            return Err(AttachmentError::NotFound);
        }
        let metadata = fs::symlink_metadata(&path)
            .map_err(|source| AttachmentError::storage(&path, source))?;
        if !metadata.file_type().is_file() || metadata.len() != encoded_bytes {
            return Err(AttachmentError::Corrupt);
        }
        let file =
            fs::File::open(&path).map_err(|source| AttachmentError::storage(&path, source))?;
        let mut bytes = Vec::with_capacity(encoded_bytes as usize);
        file.take(encoded_bytes + 1)
            .read_to_end(&mut bytes)
            .map_err(|source| AttachmentError::storage(&path, source))?;
        verify_bytes(digest, encoded_bytes, &bytes)?;
        Ok(bytes.into())
    }
}

fn validate_size(size: u64) -> Result<(), AttachmentError> {
    if size == 0 || size > MAX_ATTACHMENT_BYTES as u64 {
        return Err(AttachmentError::TooLarge);
    }
    Ok(())
}

fn verify_bytes(
    digest: &ContentDigest,
    encoded_bytes: u64,
    bytes: &[u8],
) -> Result<(), AttachmentError> {
    if bytes.len() as u64 != encoded_bytes || ContentDigest::sha256(bytes) != *digest {
        return Err(AttachmentError::Corrupt);
    }
    Ok(())
}

fn create_private_directory(path: &Path) -> Result<(), AttachmentError> {
    fs::create_dir_all(path).map_err(|source| AttachmentError::storage(path, source))?;
    let metadata =
        fs::symlink_metadata(path).map_err(|source| AttachmentError::storage(path, source))?;
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return Err(AttachmentError::Corrupt);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|source| AttachmentError::storage(path, source))?;
    }
    Ok(())
}

fn inspect_path(
    boundary: &CanonicalPathRoot,
    path: &Path,
) -> Result<NoSymlinkPathStatus, AttachmentError> {
    boundary
        .inspect_without_symlinks(path)
        .map_err(|error| match error {
            NoSymlinkPathError::Unavailable { path, source } => {
                AttachmentError::storage(path, source)
            }
            NoSymlinkPathError::OutsideRoot(_) | NoSymlinkPathError::Symlink(_) => {
                AttachmentError::Corrupt
            }
        })
}

fn require_existing_path(boundary: &CanonicalPathRoot, path: &Path) -> Result<(), AttachmentError> {
    if inspect_path(boundary, path)? != NoSymlinkPathStatus::Existing {
        return Err(AttachmentError::Corrupt);
    }
    Ok(())
}

fn ensure_directory_without_symlinks(
    boundary: &CanonicalPathRoot,
    path: &Path,
) -> Result<(), AttachmentError> {
    if inspect_path(boundary, path)? == NoSymlinkPathStatus::Missing {
        fs::create_dir_all(path).map_err(|source| AttachmentError::storage(path, source))?;
    }
    require_existing_path(boundary, path)?;
    let metadata =
        fs::symlink_metadata(path).map_err(|source| AttachmentError::storage(path, source))?;
    if !metadata.file_type().is_dir() {
        return Err(AttachmentError::Corrupt);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|source| AttachmentError::storage(path, source))?;
    }
    Ok(())
}

fn set_private_file_permissions(file: &fs::File, path: &Path) -> Result<(), AttachmentError> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))
            .map_err(|source| AttachmentError::storage(path, source))?;
    }
    #[cfg(not(unix))]
    let _ = (file, path);
    Ok(())
}

fn sync_directory(path: &Path) -> Result<(), AttachmentError> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .map_err(|source| AttachmentError::storage(path, source))
}

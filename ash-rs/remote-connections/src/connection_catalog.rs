use std::fmt;
use std::fs;
use std::fs::File;
use std::fs::OpenOptions;
use std::io;
use std::path::Path;
use std::path::PathBuf;

use ash_remote::RemoteDirPath;
use ash_remote::SshHost;
use ash_remote::SshTarget;
use ash_utils_path::write_atomically;
use serde::Deserialize;
use serde::Serialize;

const CATALOG_FORMAT_VERSION: u32 = 1;
const DEFAULT_CATALOG_RESOURCE: &str = "remote/targets.json";
const MAX_CATALOG_BYTES: u64 = 1024 * 1024;
const MAX_CONNECTIONS: usize = 1024;
const MAX_CONNECTION_NAME_BYTES: usize = 64;

struct CatalogLease(File);

impl Drop for CatalogLease {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

/// Stable, command-line-safe identity for one saved Remote connection.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct RemoteConnectionName(String);

impl RemoteConnectionName {
    /// Parses a bounded ASCII name and canonicalizes it to lowercase.
    pub fn parse(value: impl AsRef<str>) -> Result<Self, RemoteConnectionNameError> {
        let value = value.as_ref().trim();
        if value.is_empty()
            || value.len() > MAX_CONNECTION_NAME_BYTES
            || !value
                .as_bytes()
                .first()
                .is_some_and(u8::is_ascii_alphanumeric)
            || !value
                .as_bytes()
                .last()
                .is_some_and(u8::is_ascii_alphanumeric)
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
        {
            return Err(RemoteConnectionNameError);
        }
        Ok(Self(value.to_ascii_lowercase()))
    }

    /// Returns the canonical connection name.
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Indicates that a saved Remote connection name is not safe or canonical.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RemoteConnectionNameError;

impl fmt::Display for RemoteConnectionNameError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(
            "Remote connection name must contain 1-64 ASCII letters, digits, dots, underscores, or hyphens and must start and end with a letter or digit",
        )
    }
}

impl std::error::Error for RemoteConnectionNameError {}

/// One credential-free, user-named SSH target.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteConnectionEntry {
    name: RemoteConnectionName,
    target: SshTarget,
}

impl RemoteConnectionEntry {
    /// Associates a user-facing connection name with one validated host and Directory.
    pub fn new(name: RemoteConnectionName, target: SshTarget) -> Self {
        Self { name, target }
    }

    /// Returns the canonical saved connection name.
    pub const fn name(&self) -> &RemoteConnectionName {
        &self.name
    }

    /// Returns the OpenSSH host alias and authoritative Remote Directory.
    pub const fn target(&self) -> &SshTarget {
        &self.target
    }
}

/// Controls whether saving may replace an existing connection with the same canonical name.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoteConnectionSaveMode {
    Create,
    Replace,
}

/// Atomic local directory of user-named, credential-free Remote targets.
///
/// The directory deliberately excludes passwords, private keys, SSH options, runtime paths, and
/// runtime activation history. Product hosts use the selected entry to start their own OpenSSH
/// transport and keep runtime generation state in [`crate::RemoteConnectionProfileStore`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteConnectionCatalog {
    path: PathBuf,
}

impl RemoteConnectionCatalog {
    /// Selects the shared named-target resource below a product's canonical local profile root.
    pub fn from_profile_root(profile_root: impl AsRef<Path>) -> Self {
        Self::new(profile_root.as_ref().join(DEFAULT_CATALOG_RESOURCE))
    }

    /// Selects an explicit JSON resource for named Remote targets.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// Returns the product-selected durable catalog path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Loads one named connection when it exists.
    pub fn connection(
        &self,
        name: &RemoteConnectionName,
    ) -> Result<Option<RemoteConnectionEntry>, RemoteConnectionCatalogError> {
        let _lease = self.acquire_lease()?;
        Ok(self
            .load_unlocked()?
            .into_iter()
            .find(|entry| entry.name == *name))
    }

    /// Lists all validated entries in stable canonical-name order.
    pub fn connections(&self) -> Result<Vec<RemoteConnectionEntry>, RemoteConnectionCatalogError> {
        let _lease = self.acquire_lease()?;
        self.load_unlocked()
    }

    /// Creates or explicitly replaces one named target while holding the cross-process lease.
    pub fn save(
        &self,
        entry: RemoteConnectionEntry,
        mode: RemoteConnectionSaveMode,
    ) -> Result<RemoteConnectionEntry, RemoteConnectionCatalogError> {
        let _lease = self.acquire_lease()?;
        let mut entries = self.load_unlocked()?;
        match entries
            .iter_mut()
            .find(|existing| existing.name == entry.name)
        {
            Some(_) if mode == RemoteConnectionSaveMode::Create => {
                return Err(RemoteConnectionCatalogError::new(
                    RemoteConnectionCatalogFailureKind::AlreadyExists,
                    format!("Remote connection `{}` already exists", entry.name.as_str()),
                ));
            }
            Some(existing) => *existing = entry.clone(),
            None => {
                if entries.len() >= MAX_CONNECTIONS {
                    return Err(RemoteConnectionCatalogError::invalid(
                        "Remote connection catalog reached its record limit",
                    ));
                }
                entries.push(entry.clone());
            }
        }
        sort_entries(&mut entries);
        self.write_unlocked(&entries)?;
        Ok(entry)
    }

    /// Atomically updates one existing target, including a canonical name change.
    ///
    /// The original name identifies the record observed by the caller. A rename refuses to
    /// overwrite another record and the complete mutation is written while holding one lease.
    pub fn update(
        &self,
        original_name: &RemoteConnectionName,
        entry: RemoteConnectionEntry,
    ) -> Result<RemoteConnectionEntry, RemoteConnectionCatalogError> {
        let _lease = self.acquire_lease()?;
        let mut entries = self.load_unlocked()?;
        let Some(index) = entries
            .iter()
            .position(|existing| existing.name == *original_name)
        else {
            return Err(RemoteConnectionCatalogError::new(
                RemoteConnectionCatalogFailureKind::Missing,
                format!(
                    "Remote connection `{}` no longer exists",
                    original_name.as_str()
                ),
            ));
        };
        if entry.name != *original_name
            && entries.iter().any(|existing| existing.name == entry.name)
        {
            return Err(RemoteConnectionCatalogError::new(
                RemoteConnectionCatalogFailureKind::AlreadyExists,
                format!("Remote connection `{}` already exists", entry.name.as_str()),
            ));
        }
        entries[index] = entry.clone();
        sort_entries(&mut entries);
        self.write_unlocked(&entries)?;
        Ok(entry)
    }

    /// Removes one named target and returns it when it existed.
    pub fn remove(
        &self,
        name: &RemoteConnectionName,
    ) -> Result<Option<RemoteConnectionEntry>, RemoteConnectionCatalogError> {
        let _lease = self.acquire_lease()?;
        let mut entries = self.load_unlocked()?;
        let Some(index) = entries.iter().position(|entry| entry.name == *name) else {
            return Ok(None);
        };
        let removed = entries.remove(index);
        self.write_unlocked(&entries)?;
        Ok(Some(removed))
    }

    fn acquire_lease(&self) -> Result<CatalogLease, RemoteConnectionCatalogError> {
        let parent = self.path.parent().ok_or_else(|| {
            RemoteConnectionCatalogError::unavailable(
                "Remote connection catalog path has no parent directory",
            )
        })?;
        fs::create_dir_all(parent).map_err(RemoteConnectionCatalogError::io)?;
        let path = self.lock_path()?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(RemoteConnectionCatalogError::io)?;
        file.try_lock().map_err(|error| match error {
            fs::TryLockError::WouldBlock => RemoteConnectionCatalogError::new(
                RemoteConnectionCatalogFailureKind::Busy,
                "Remote connections are being updated by another process",
            ),
            fs::TryLockError::Error(error) => RemoteConnectionCatalogError::io(error),
        })?;
        Ok(CatalogLease(file))
    }

    pub(crate) fn lock_path(&self) -> Result<PathBuf, RemoteConnectionCatalogError> {
        let name = self.path.file_name().ok_or_else(|| {
            RemoteConnectionCatalogError::unavailable(
                "Remote connection catalog path has no file name",
            )
        })?;
        let mut lock_name = name.to_os_string();
        lock_name.push(".lock");
        Ok(self.path.with_file_name(lock_name))
    }

    fn load_unlocked(&self) -> Result<Vec<RemoteConnectionEntry>, RemoteConnectionCatalogError> {
        let metadata = match fs::symlink_metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(RemoteConnectionCatalogError::io(error)),
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(RemoteConnectionCatalogError::invalid(
                "Remote connection catalog resource must be a regular file",
            ));
        }
        if metadata.len() == 0 || metadata.len() > MAX_CATALOG_BYTES {
            return Err(RemoteConnectionCatalogError::invalid(format!(
                "Remote connection catalog must contain between 1 and {MAX_CATALOG_BYTES} bytes"
            )));
        }
        let bytes = fs::read(&self.path).map_err(RemoteConnectionCatalogError::io)?;
        let document: CatalogDocument = serde_json::from_slice(&bytes).map_err(|error| {
            RemoteConnectionCatalogError::invalid(format!(
                "Remote connection catalog is invalid JSON: {error}"
            ))
        })?;
        if document.format_version != CATALOG_FORMAT_VERSION {
            return Err(RemoteConnectionCatalogError::invalid(format!(
                "unsupported Remote connection catalog format version {}",
                document.format_version
            )));
        }
        if document.connections.len() > MAX_CONNECTIONS {
            return Err(RemoteConnectionCatalogError::invalid(
                "Remote connection catalog exceeds its record limit",
            ));
        }
        let mut entries = Vec::with_capacity(document.connections.len());
        for value in document.connections {
            let name = RemoteConnectionName::parse(value.name).map_err(|error| {
                RemoteConnectionCatalogError::invalid(format!(
                    "Remote connection catalog has an invalid name: {error}"
                ))
            })?;
            let host = SshHost::parse(value.host).map_err(|error| {
                RemoteConnectionCatalogError::invalid(format!(
                    "Remote connection catalog has an invalid host: {error}"
                ))
            })?;
            let dir = RemoteDirPath::parse(value.dir).map_err(|error| {
                RemoteConnectionCatalogError::invalid(format!(
                    "Remote connection catalog has an invalid Directory: {error}"
                ))
            })?;
            let entry = RemoteConnectionEntry::new(name, SshTarget::new(host, dir));
            if entries
                .iter()
                .any(|existing: &RemoteConnectionEntry| existing.name == entry.name)
            {
                return Err(RemoteConnectionCatalogError::invalid(
                    "Remote connection catalog repeats a canonical name",
                ));
            }
            entries.push(entry);
        }
        sort_entries(&mut entries);
        Ok(entries)
    }

    fn write_unlocked(
        &self,
        entries: &[RemoteConnectionEntry],
    ) -> Result<(), RemoteConnectionCatalogError> {
        let document = CatalogDocument {
            format_version: CATALOG_FORMAT_VERSION,
            connections: entries.iter().map(CatalogRecord::from).collect(),
        };
        let mut bytes = serde_json::to_vec_pretty(&document).map_err(|error| {
            RemoteConnectionCatalogError::invalid(format!(
                "could not encode Remote connection catalog: {error}"
            ))
        })?;
        bytes.push(b'\n');
        if bytes.len() as u64 > MAX_CATALOG_BYTES {
            return Err(RemoteConnectionCatalogError::invalid(
                "encoded Remote connection catalog exceeds the size limit",
            ));
        }
        write_atomically(&self.path, &bytes).map_err(RemoteConnectionCatalogError::io)
    }
}

fn sort_entries(entries: &mut [RemoteConnectionEntry]) {
    entries.sort_by(|left, right| left.name.cmp(&right.name));
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogDocument {
    format_version: u32,
    connections: Vec<CatalogRecord>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogRecord {
    name: String,
    host: String,
    dir: String,
}

impl From<&RemoteConnectionEntry> for CatalogRecord {
    fn from(entry: &RemoteConnectionEntry) -> Self {
        Self {
            name: entry.name.as_str().into(),
            host: entry.target.host().as_str().into(),
            dir: entry.target.dir().as_str().into(),
        }
    }
}

/// Stable category for named Remote connection persistence failures.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoteConnectionCatalogFailureKind {
    Unavailable,
    Busy,
    Invalid,
    AlreadyExists,
    Missing,
}

/// A bounded named Remote connection catalog failure.
#[derive(Debug)]
pub struct RemoteConnectionCatalogError {
    kind: RemoteConnectionCatalogFailureKind,
    message: String,
}

impl RemoteConnectionCatalogError {
    fn new(kind: RemoteConnectionCatalogFailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    fn io(error: io::Error) -> Self {
        Self::new(
            RemoteConnectionCatalogFailureKind::Unavailable,
            format!("Remote connection catalog is unavailable: {error}"),
        )
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self::new(RemoteConnectionCatalogFailureKind::Unavailable, message)
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new(RemoteConnectionCatalogFailureKind::Invalid, message)
    }

    /// Returns the stable recovery category.
    pub const fn kind(&self) -> RemoteConnectionCatalogFailureKind {
        self.kind
    }
}

impl fmt::Display for RemoteConnectionCatalogError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for RemoteConnectionCatalogError {}

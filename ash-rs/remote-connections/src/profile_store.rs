use std::fmt;
use std::fs;
use std::fs::File;
use std::fs::OpenOptions;
use std::io;
use std::path::Path;
use std::path::PathBuf;

use ash_remote::RemoteDirPath;
use ash_remote::RemoteProfile;
use ash_remote::RemoteRuntime;
use ash_remote::SshHost;
use ash_remote::SshTarget;
use ash_utils_path::write_atomically;
use serde::Deserialize;
use serde::Serialize;

const PROFILE_FORMAT_VERSION: u32 = 1;
const MAX_PROFILE_BYTES: u64 = 1024 * 1024;
const MAX_CONNECTIONS: usize = 1024;
const DEFAULT_PROFILE_RESOURCE: &str = "remote/connections.json";

struct ProfileLease(File);

impl Drop for ProfileLease {
    fn drop(&mut self) {
        let _ = self.0.unlock();
    }
}

/// Durable, credential-free runtime history for one SSH host and Remote Directory.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteConnectionProfileRecord {
    target: SshTarget,
    active_runtime: RemoteRuntime,
    previous_runtime: Option<RemoteRuntime>,
}

impl RemoteConnectionProfileRecord {
    /// Returns the SSH host and Directory identity shared by both runtime generations.
    pub const fn target(&self) -> &SshTarget {
        &self.target
    }

    /// Returns the runtime selected after the last successful compatibility handshake.
    pub const fn active_runtime(&self) -> &RemoteRuntime {
        &self.active_runtime
    }

    /// Returns the immediately preceding compatible runtime retained for rollback.
    pub const fn previous_runtime(&self) -> Option<&RemoteRuntime> {
        self.previous_runtime.as_ref()
    }

    /// Builds the active Remote profile used for the next connection attempt.
    pub fn active_profile(&self) -> RemoteProfile {
        RemoteProfile::new(self.target.clone(), self.active_runtime.clone())
    }

    /// Builds the previous Remote profile when a rollback generation exists.
    pub fn previous_profile(&self) -> Option<RemoteProfile> {
        self.previous_runtime
            .clone()
            .map(|runtime| RemoteProfile::new(self.target.clone(), runtime))
    }
}

/// Atomic local store for credential-free Remote connection runtime history.
///
/// The caller supplies a host-profile path. Every operation takes an advisory lock shared by
/// product processes, validates the complete bounded document, and replaces it atomically. The
/// schema intentionally has no field for passwords, private keys, agent sockets, or SSH options.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteConnectionProfileStore {
    path: PathBuf,
}

impl RemoteConnectionProfileStore {
    /// Selects the shared Remote resource below a product's canonical local profile root.
    pub fn from_profile_root(profile_root: impl AsRef<Path>) -> Self {
        Self::new(profile_root.as_ref().join(DEFAULT_PROFILE_RESOURCE))
    }

    /// Selects the JSON resource owned by the native product's user-state directory.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }

    /// Returns the product-selected durable profile path.
    pub fn path(&self) -> &Path {
        &self.path
    }

    /// Loads the runtime history for exactly one SSH host and Directory.
    pub fn connection(
        &self,
        target: &SshTarget,
    ) -> Result<Option<RemoteConnectionProfileRecord>, RemoteConnectionProfileStoreError> {
        let _lease = self.acquire_lease()?;
        Ok(self
            .load_unlocked()?
            .into_iter()
            .find(|record| record.target == *target))
    }

    /// Lists all validated records in stable host/Directory order.
    pub fn connections(
        &self,
    ) -> Result<Vec<RemoteConnectionProfileRecord>, RemoteConnectionProfileStoreError> {
        let _lease = self.acquire_lease()?;
        self.load_unlocked()
    }

    /// Activates a runtime only after the caller has completed its compatibility handshake.
    ///
    /// A changed active runtime becomes the one retained previous generation. Re-activating the
    /// same runtime is idempotent and does not erase rollback history.
    pub fn activate(
        &self,
        profile: &RemoteProfile,
    ) -> Result<RemoteConnectionProfileRecord, RemoteConnectionProfileStoreError> {
        let _lease = self.acquire_lease()?;
        let mut records = self.load_unlocked()?;
        let record = match records
            .iter_mut()
            .find(|record| record.target == *profile.target())
        {
            Some(record) if record.active_runtime == *profile.runtime() => record.clone(),
            Some(record) => {
                record.previous_runtime = Some(record.active_runtime.clone());
                record.active_runtime = profile.runtime().clone();
                record.clone()
            }
            None => {
                if records.len() >= MAX_CONNECTIONS {
                    return Err(RemoteConnectionProfileStoreError::invalid(
                        "Remote connection profile store reached its record limit",
                    ));
                }
                let record = RemoteConnectionProfileRecord {
                    target: profile.target().clone(),
                    active_runtime: profile.runtime().clone(),
                    previous_runtime: None,
                };
                records.push(record.clone());
                record
            }
        };
        sort_records(&mut records);
        self.write_unlocked(&records)?;
        Ok(record)
    }

    /// Swaps active and previous runtime generations when the validated previous profile is still
    /// current.
    ///
    /// The expected profile makes a host-side compatibility check safe across concurrent product
    /// processes: a caller never rolls back to a generation that changed after it was checked.
    pub fn rollback_to_verified(
        &self,
        expected_previous: &RemoteProfile,
        verified_previous: &RemoteProfile,
    ) -> Result<Option<RemoteConnectionProfileRecord>, RemoteConnectionProfileStoreError> {
        if expected_previous.target() != verified_previous.target() {
            return Err(RemoteConnectionProfileStoreError::invalid(
                "expected and verified rollback profiles must select the same target",
            ));
        }
        let _lease = self.acquire_lease()?;
        let mut records = self.load_unlocked()?;
        let Some(record) = records
            .iter_mut()
            .find(|record| record.target == *expected_previous.target())
        else {
            return Ok(None);
        };
        if record.previous_runtime.as_ref() != Some(expected_previous.runtime()) {
            return Ok(None);
        }
        let replaced = std::mem::replace(
            &mut record.active_runtime,
            verified_previous.runtime().clone(),
        );
        record.previous_runtime = Some(replaced);
        let rolled_back = record.clone();
        self.write_unlocked(&records)?;
        Ok(Some(rolled_back))
    }

    fn acquire_lease(&self) -> Result<ProfileLease, RemoteConnectionProfileStoreError> {
        let parent = self.path.parent().ok_or_else(|| {
            RemoteConnectionProfileStoreError::unavailable(
                "Remote connection profile path has no parent directory",
            )
        })?;
        fs::create_dir_all(parent).map_err(RemoteConnectionProfileStoreError::io)?;
        let path = self.lock_path()?;
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(RemoteConnectionProfileStoreError::io)?;
        file.try_lock().map_err(|error| match error {
            fs::TryLockError::WouldBlock => RemoteConnectionProfileStoreError::new(
                RemoteConnectionProfileStoreFailureKind::Busy,
                "Remote connection profiles are being updated by another process",
            ),
            fs::TryLockError::Error(error) => RemoteConnectionProfileStoreError::io(error),
        })?;
        Ok(ProfileLease(file))
    }

    pub(crate) fn lock_path(&self) -> Result<PathBuf, RemoteConnectionProfileStoreError> {
        let name = self.path.file_name().ok_or_else(|| {
            RemoteConnectionProfileStoreError::unavailable(
                "Remote connection profile path has no file name",
            )
        })?;
        let mut lock_name = name.to_os_string();
        lock_name.push(".lock");
        Ok(self.path.with_file_name(lock_name))
    }

    fn load_unlocked(
        &self,
    ) -> Result<Vec<RemoteConnectionProfileRecord>, RemoteConnectionProfileStoreError> {
        let metadata = match fs::symlink_metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(error) => return Err(RemoteConnectionProfileStoreError::io(error)),
        };
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(RemoteConnectionProfileStoreError::invalid(
                "Remote connection profile resource must be a regular file",
            ));
        }
        if metadata.len() == 0 || metadata.len() > MAX_PROFILE_BYTES {
            return Err(RemoteConnectionProfileStoreError::invalid(format!(
                "Remote connection profile resource must contain between 1 and {MAX_PROFILE_BYTES} bytes"
            )));
        }
        let bytes = fs::read(&self.path).map_err(RemoteConnectionProfileStoreError::io)?;
        let document: ProfileDocument = serde_json::from_slice(&bytes).map_err(|error| {
            RemoteConnectionProfileStoreError::invalid(format!(
                "Remote connection profile resource is invalid JSON: {error}"
            ))
        })?;
        if document.format_version != PROFILE_FORMAT_VERSION {
            return Err(RemoteConnectionProfileStoreError::invalid(format!(
                "unsupported Remote connection profile format version {}",
                document.format_version
            )));
        }
        if document.connections.len() > MAX_CONNECTIONS {
            return Err(RemoteConnectionProfileStoreError::invalid(
                "Remote connection profile store exceeds its record limit",
            ));
        }
        let mut records = Vec::with_capacity(document.connections.len());
        for value in document.connections {
            let host = SshHost::parse(value.host).map_err(|error| {
                RemoteConnectionProfileStoreError::invalid(format!(
                    "Remote connection profile has an invalid host: {error}"
                ))
            })?;
            let dir = RemoteDirPath::parse(value.dir).map_err(|error| {
                RemoteConnectionProfileStoreError::invalid(format!(
                    "Remote connection profile has an invalid Directory: {error}"
                ))
            })?;
            let active_runtime = RemoteRuntime::new(value.active_runtime).map_err(|error| {
                RemoteConnectionProfileStoreError::invalid(format!(
                    "Remote connection profile has an invalid active runtime: {error}"
                ))
            })?;
            let previous_runtime = value
                .previous_runtime
                .map(RemoteRuntime::new)
                .transpose()
                .map_err(|error| {
                    RemoteConnectionProfileStoreError::invalid(format!(
                        "Remote connection profile has an invalid previous runtime: {error}"
                    ))
                })?;
            if previous_runtime.as_ref() == Some(&active_runtime) {
                return Err(RemoteConnectionProfileStoreError::invalid(
                    "Remote connection profile repeats its active runtime as previous",
                ));
            }
            let record = RemoteConnectionProfileRecord {
                target: SshTarget::new(host, dir),
                active_runtime,
                previous_runtime,
            };
            if records
                .iter()
                .any(|existing: &RemoteConnectionProfileRecord| existing.target == record.target)
            {
                return Err(RemoteConnectionProfileStoreError::invalid(
                    "Remote connection profile store repeats a host/Directory target",
                ));
            }
            records.push(record);
        }
        sort_records(&mut records);
        Ok(records)
    }

    fn write_unlocked(
        &self,
        records: &[RemoteConnectionProfileRecord],
    ) -> Result<(), RemoteConnectionProfileStoreError> {
        let document = ProfileDocument {
            format_version: PROFILE_FORMAT_VERSION,
            connections: records.iter().map(ProfileRecord::from).collect(),
        };
        let mut bytes = serde_json::to_vec_pretty(&document).map_err(|error| {
            RemoteConnectionProfileStoreError::invalid(format!(
                "could not encode Remote connection profiles: {error}"
            ))
        })?;
        bytes.push(b'\n');
        if bytes.len() as u64 > MAX_PROFILE_BYTES {
            return Err(RemoteConnectionProfileStoreError::invalid(
                "encoded Remote connection profiles exceed the size limit",
            ));
        }
        write_atomically(&self.path, &bytes).map_err(RemoteConnectionProfileStoreError::io)
    }
}

fn sort_records(records: &mut [RemoteConnectionProfileRecord]) {
    records.sort_by(|left, right| {
        left.target
            .host()
            .as_str()
            .cmp(right.target.host().as_str())
            .then_with(|| left.target.dir().as_str().cmp(right.target.dir().as_str()))
    });
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileDocument {
    format_version: u32,
    connections: Vec<ProfileRecord>,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProfileRecord {
    host: String,
    dir: String,
    active_runtime: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    previous_runtime: Option<String>,
}

impl From<&RemoteConnectionProfileRecord> for ProfileRecord {
    fn from(record: &RemoteConnectionProfileRecord) -> Self {
        Self {
            host: record.target.host().as_str().into(),
            dir: record.target.dir().as_str().into(),
            active_runtime: record.active_runtime.executable().into(),
            previous_runtime: record
                .previous_runtime
                .as_ref()
                .map(|runtime| runtime.executable().into()),
        }
    }
}

/// Stable category for local Remote profile persistence failures.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoteConnectionProfileStoreFailureKind {
    Unavailable,
    Busy,
    Invalid,
}

/// A bounded, credential-free Remote profile store failure.
#[derive(Debug)]
pub struct RemoteConnectionProfileStoreError {
    kind: RemoteConnectionProfileStoreFailureKind,
    message: String,
}

impl RemoteConnectionProfileStoreError {
    fn new(kind: RemoteConnectionProfileStoreFailureKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    fn io(error: io::Error) -> Self {
        Self::new(
            RemoteConnectionProfileStoreFailureKind::Unavailable,
            format!("Remote connection profiles are unavailable: {error}"),
        )
    }

    fn unavailable(message: impl Into<String>) -> Self {
        Self::new(
            RemoteConnectionProfileStoreFailureKind::Unavailable,
            message,
        )
    }

    fn invalid(message: impl Into<String>) -> Self {
        Self::new(RemoteConnectionProfileStoreFailureKind::Invalid, message)
    }

    /// Returns the stable recovery category.
    pub const fn kind(&self) -> RemoteConnectionProfileStoreFailureKind {
        self.kind
    }
}

impl fmt::Display for RemoteConnectionProfileStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for RemoteConnectionProfileStoreError {}

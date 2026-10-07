use std::collections::BTreeSet;
use std::fmt;
use std::fs;
use std::num::NonZeroU64;
use std::path::Path;
use std::path::PathBuf;

use ash_remote::RemotePlatform;
use serde::Deserialize;
use sha2::Digest;
use sha2::Sha256;

use crate::RemoteRuntimeArtifact;
use crate::RemoteRuntimeArtifactIntegrity;
use crate::RemoteRuntimeVersion;

const CATALOG_FORMAT_VERSION: u32 = 1;
pub(crate) const MAX_CATALOG_BYTES: u64 = 1024 * 1024;
pub(crate) const MAX_RUNTIME_ARCHIVE_BYTES: u64 = 1024 * 1024 * 1024;
const MAX_RUNTIME_UNPACKED_BYTES: u64 = 4 * MAX_RUNTIME_ARCHIVE_BYTES;

/// A release-authorized set of locally available Remote runtime artifacts.
///
/// Product packaging or update code must authenticate `expected_sha256` before calling
/// [`RemoteRuntimeCatalog::load_verified`]. The catalog then binds each supported Remote target to
/// one immutable local archive; it does not download content or decide product upgrade policy.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteRuntimeCatalog {
    artifacts: Vec<RemoteRuntimeArtifact>,
}

impl RemoteRuntimeCatalog {
    /// Loads a bounded catalog only when its bytes match the digest authenticated by the host.
    pub fn load_verified(
        path: impl AsRef<Path>,
        expected_sha256: impl AsRef<str>,
    ) -> Result<Self, RemoteRuntimeCatalogError> {
        let expected_sha256 = expected_sha256.as_ref();
        if !is_sha256(expected_sha256) {
            return Err(RemoteRuntimeCatalogError::InvalidExpectedDigest);
        }
        let path = path.as_ref();
        let metadata =
            fs::symlink_metadata(path).map_err(RemoteRuntimeCatalogError::unavailable)?;
        if metadata.file_type().is_symlink() || !metadata.is_file() {
            return Err(RemoteRuntimeCatalogError::Invalid(
                "Remote runtime catalog is not a regular file".into(),
            ));
        }
        if metadata.len() == 0 || metadata.len() > MAX_CATALOG_BYTES {
            return Err(RemoteRuntimeCatalogError::Invalid(format!(
                "Remote runtime catalog must contain between 1 and {MAX_CATALOG_BYTES} bytes"
            )));
        }
        let bytes = fs::read(path).map_err(RemoteRuntimeCatalogError::unavailable)?;
        let observed = format!("{:x}", Sha256::digest(&bytes));
        if observed != expected_sha256 {
            return Err(RemoteRuntimeCatalogError::Integrity {
                expected: expected_sha256.into(),
                observed,
            });
        }
        let document: CatalogDocument = serde_json::from_slice(&bytes).map_err(|error| {
            RemoteRuntimeCatalogError::Invalid(format!(
                "Remote runtime catalog is invalid JSON: {error}"
            ))
        })?;
        if document.format_version != CATALOG_FORMAT_VERSION {
            return Err(RemoteRuntimeCatalogError::Invalid(format!(
                "unsupported Remote runtime catalog format version {}",
                document.format_version
            )));
        }
        if document.artifacts.is_empty() {
            return Err(RemoteRuntimeCatalogError::Invalid(
                "Remote runtime catalog has no artifacts".into(),
            ));
        }
        let root = path.parent().ok_or_else(|| {
            RemoteRuntimeCatalogError::Invalid(
                "Remote runtime catalog has no containing directory".into(),
            )
        })?;
        let mut targets = BTreeSet::new();
        let mut artifacts = Vec::with_capacity(document.artifacts.len());
        for record in document.artifacts {
            let platform = RemotePlatform::from_target_triple(&record.target).ok_or_else(|| {
                RemoteRuntimeCatalogError::Invalid(format!(
                    "unsupported Remote runtime catalog target `{}`",
                    record.target
                ))
            })?;
            if !targets.insert(record.target.clone()) {
                return Err(RemoteRuntimeCatalogError::Invalid(format!(
                    "Remote runtime catalog repeats target `{}`",
                    record.target
                )));
            }
            let relative_archive = parse_relative_archive_path(&record.archive)?;
            let version = RemoteRuntimeVersion::parse(&record.version).map_err(|error| {
                RemoteRuntimeCatalogError::Invalid(format!(
                    "invalid Remote runtime version for `{}`: {error}",
                    record.target
                ))
            })?;
            let archive_size = NonZeroU64::new(record.archive_size).ok_or_else(|| {
                RemoteRuntimeCatalogError::Invalid(format!(
                    "Remote runtime archive size for `{}` must be positive",
                    record.target
                ))
            })?;
            if archive_size.get() > MAX_RUNTIME_ARCHIVE_BYTES {
                return Err(RemoteRuntimeCatalogError::Invalid(format!(
                    "Remote runtime archive size for `{}` exceeds {MAX_RUNTIME_ARCHIVE_BYTES} bytes",
                    record.target
                )));
            }
            let unpacked_size = NonZeroU64::new(record.unpacked_size).ok_or_else(|| {
                RemoteRuntimeCatalogError::Invalid(format!(
                    "Remote runtime unpacked size for `{}` must be positive",
                    record.target
                ))
            })?;
            if unpacked_size.get() > MAX_RUNTIME_UNPACKED_BYTES {
                return Err(RemoteRuntimeCatalogError::Invalid(format!(
                    "Remote runtime unpacked size for `{}` exceeds {MAX_RUNTIME_UNPACKED_BYTES} bytes",
                    record.target
                )));
            }
            let integrity =
                RemoteRuntimeArtifactIntegrity::new(archive_size, unpacked_size, &record.sha256)
                    .map_err(|error| {
                        RemoteRuntimeCatalogError::Invalid(format!(
                            "invalid Remote runtime integrity for `{}`: {error}",
                            record.target
                        ))
                    })?;
            artifacts.push(RemoteRuntimeArtifact::new(
                root.join(relative_archive),
                version,
                platform,
                integrity,
            ));
        }
        Ok(Self { artifacts })
    }

    /// Returns the one release artifact authorized for `platform`, if the catalog contains it.
    pub fn artifact_for(&self, platform: RemotePlatform) -> Option<&RemoteRuntimeArtifact> {
        self.artifacts
            .iter()
            .find(|artifact| artifact.platform() == platform)
    }

    /// Iterates over the exact artifact records after catalog authentication and validation.
    pub fn artifacts(&self) -> impl ExactSizeIterator<Item = &RemoteRuntimeArtifact> {
        self.artifacts.iter()
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogDocument {
    format_version: u32,
    artifacts: Vec<CatalogArtifactRecord>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogArtifactRecord {
    version: String,
    target: String,
    archive: String,
    archive_size: u64,
    unpacked_size: u64,
    sha256: String,
}

fn parse_relative_archive_path(value: &str) -> Result<PathBuf, RemoteRuntimeCatalogError> {
    if value.is_empty()
        || value.starts_with('/')
        || value.ends_with('/')
        || value.contains(['\\', '\0', '\n', '\r', ':'])
        || value
            .split('/')
            .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
    {
        return Err(RemoteRuntimeCatalogError::Invalid(format!(
            "Remote runtime archive path is not a canonical relative path: `{value}`"
        )));
    }
    Ok(value.split('/').collect())
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

/// A catalog failure before any SSH process or Remote install is started.
#[derive(Debug)]
pub enum RemoteRuntimeCatalogError {
    InvalidExpectedDigest,
    Unavailable(std::io::Error),
    Integrity { expected: String, observed: String },
    Invalid(String),
}

impl RemoteRuntimeCatalogError {
    fn unavailable(error: std::io::Error) -> Self {
        Self::Unavailable(error)
    }
}

impl fmt::Display for RemoteRuntimeCatalogError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidExpectedDigest => formatter.write_str(
                "authenticated Remote runtime catalog SHA-256 must be 64 lowercase hex characters",
            ),
            Self::Unavailable(error) => {
                write!(formatter, "Remote runtime catalog is unavailable: {error}")
            }
            Self::Integrity { expected, observed } => write!(
                formatter,
                "Remote runtime catalog SHA-256 mismatch: expected {expected}, observed {observed}"
            ),
            Self::Invalid(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for RemoteRuntimeCatalogError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Unavailable(error) => Some(error),
            _ => None,
        }
    }
}

use std::collections::BTreeMap;
use std::fs;
use std::path::Path;
use std::path::PathBuf;

use ash_utils_path::write_atomically;
use serde::Deserialize;
use serde::Serialize;

use super::ActivePlugin;
use super::InstalledKey;
use crate::InstalledPluginRef;
use crate::PluginError;
use crate::PluginErrorKind;

const AUTHORITY_SCHEMA_VERSION: u32 = 3;
const MAX_AUTHORITY_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PersistedCommandReceipt {
    pub expected_revision: u64,
    pub command_digest: String,
    pub result_revision: u64,
    pub activation_generation: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct ActivePluginRecord {
    pub package: InstalledPluginRef,
    pub activation_revision: u64,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(super) struct PersistedAuthority {
    schema_version: u32,
    pub revision: u64,
    pub activation_generation: u64,
    pub installed: Vec<InstalledPluginRef>,
    #[serde(default)]
    pub enabled: Vec<InstalledPluginRef>,
    #[serde(default)]
    pub granted: Vec<InstalledPluginRef>,
    #[serde(default)]
    pub revoked: Vec<InstalledPluginRef>,
    #[serde(default)]
    pub active: Vec<ActivePluginRecord>,
    pub receipts: BTreeMap<String, PersistedCommandReceipt>,
}

pub(super) struct AuthorityStateRef<'a> {
    pub revision: u64,
    pub activation_generation: u64,
    pub installed: &'a BTreeMap<InstalledKey, InstalledPluginRef>,
    pub enabled: &'a BTreeMap<crate::PluginPackageId, InstalledPluginRef>,
    pub granted: &'a BTreeMap<InstalledKey, InstalledPluginRef>,
    pub revoked: &'a BTreeMap<InstalledKey, InstalledPluginRef>,
    pub active: &'a BTreeMap<crate::PluginPackageId, ActivePlugin>,
    pub receipts: &'a BTreeMap<String, PersistedCommandReceipt>,
}

impl PersistedAuthority {
    pub fn empty() -> Self {
        Self {
            schema_version: AUTHORITY_SCHEMA_VERSION,
            revision: 0,
            activation_generation: 1,
            installed: Vec::new(),
            enabled: Vec::new(),
            granted: Vec::new(),
            revoked: Vec::new(),
            active: Vec::new(),
            receipts: BTreeMap::new(),
        }
    }

    pub fn from_state(state: AuthorityStateRef<'_>) -> Self {
        Self {
            schema_version: AUTHORITY_SCHEMA_VERSION,
            revision: state.revision,
            activation_generation: state.activation_generation,
            installed: state.installed.values().cloned().collect(),
            enabled: state.enabled.values().cloned().collect(),
            granted: state.granted.values().cloned().collect(),
            revoked: state.revoked.values().cloned().collect(),
            active: state
                .active
                .values()
                .map(|active| ActivePluginRecord {
                    package: active.package.clone(),
                    activation_revision: active.activation_revision,
                })
                .collect(),
            receipts: state.receipts.clone(),
        }
    }

    pub fn validate(&self) -> Result<(), PluginError> {
        if !matches!(self.schema_version, 1 | 2 | AUTHORITY_SCHEMA_VERSION)
            || self.activation_generation == 0
            || self.active.iter().any(|active| {
                active.activation_revision == 0
                    || active.activation_revision > self.activation_generation
            })
            || self.receipts.values().any(|receipt| {
                receipt.result_revision > self.revision
                    || receipt.activation_generation == 0
                    || receipt.activation_generation > self.activation_generation
                    || receipt.command_digest.len() != 64
            })
        {
            return Err(persistence_error("Plugin authority record is invalid"));
        }
        Ok(())
    }

    pub fn migrate(mut self) -> Self {
        if self.schema_version == 1 {
            self.enabled = self
                .active
                .iter()
                .map(|active| active.package.clone())
                .collect();
            self.granted = self.enabled.clone();
        }
        self.schema_version = AUTHORITY_SCHEMA_VERSION;
        self
    }
}

pub(super) struct FileAuthorityPersistence {
    path: PathBuf,
}

impl FileAuthorityPersistence {
    pub fn open(path: impl AsRef<Path>) -> Result<Self, PluginError> {
        let path = path.as_ref().to_path_buf();
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(io_error)?;
        }
        Ok(Self { path })
    }

    pub fn load(&self) -> Result<Option<PersistedAuthority>, PluginError> {
        let metadata = match fs::metadata(&self.path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_error(error)),
        };
        if !metadata.is_file() || metadata.len() > MAX_AUTHORITY_BYTES {
            return Err(persistence_error("Plugin authority record is invalid"));
        }
        let bytes = fs::read(&self.path).map_err(io_error)?;
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| persistence_error("Plugin authority record is invalid"))
    }

    pub fn persist(&self, authority: &PersistedAuthority) -> Result<(), PluginError> {
        let bytes = serde_json::to_vec(authority)
            .map_err(|_| persistence_error("Plugin authority record could not be encoded"))?;
        if bytes.len() as u64 > MAX_AUTHORITY_BYTES {
            return Err(persistence_error(
                "Plugin authority record exceeds its size limit",
            ));
        }
        write_atomically(&self.path, &bytes).map_err(io_error)
    }
}

fn io_error(_: impl std::fmt::Display) -> PluginError {
    persistence_error("Plugin authority persistence is unavailable")
}

fn persistence_error(message: impl Into<String>) -> PluginError {
    PluginError::new(PluginErrorKind::AuthorityUnavailable, message)
}

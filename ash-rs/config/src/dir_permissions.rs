use ash_file_access::DirId;
use ash_file_access::Permissions;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;

/// Durable user-owned permissions for explicitly selected directories.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(feature = "schema", derive(schemars::JsonSchema))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DirPermissionsConfig {
    #[serde(default)]
    pub entries: BTreeMap<DirId, Permissions>,
    /// Canonical paths retained only as display metadata.
    #[serde(default)]
    pub paths: BTreeMap<DirId, PathBuf>,
}

impl DirPermissionsConfig {
    pub fn explicit_permissions_for(&self, dir: &DirId) -> Option<&Permissions> {
        self.entries.get(dir)
    }

    pub fn permissions_for(&self, dir: &DirId) -> Permissions {
        self.explicit_permissions_for(dir)
            .cloned()
            .unwrap_or_default()
    }

    pub fn path_for(&self, dir: &DirId) -> Option<&Path> {
        self.explicit_permissions_for(dir)
            .and_then(|_| self.paths.get(dir).map(PathBuf::as_path))
    }
}

#[cfg(test)]
#[path = "dir_permissions_tests.rs"]
mod tests;

use crate::Dir;
use crate::DirId;
use crate::EnvId;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::path::Path;
use std::path::PathBuf;
use ts_rs::TS;

/// Durable Session binding to one canonical directory.
///
/// Product hosts use the path to reopen the directory and must recompute the ID before granting
/// permissions. The ID is never a substitute for containment or a current grant.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DirBinding {
    pub id: DirId,
    pub env: EnvId,
    pub path: PathBuf,
}

impl DirBinding {
    /// Freezes the canonical directory and its corresponding identity.
    pub fn from_dir(dir: &Dir) -> Self {
        Self {
            id: dir.id(),
            env: dir.env().clone(),
            path: dir.canonical_path().to_path_buf(),
        }
    }

    /// Returns true only when a currently opened directory has the same canonical identity.
    pub fn matches(&self, dir: &Dir) -> bool {
        dir.directory().ensure_current().is_ok()
            && self.id == dir.id()
            && self.env == *dir.env()
            && self.path == dir.canonical_path()
    }

    /// Returns the canonical directory path recorded with the Session.
    pub fn path(&self) -> &Path {
        &self.path
    }
}

#[cfg(test)]
#[path = "binding_tests.rs"]
mod tests;

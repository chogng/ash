use ash_environment::EnvId;
use ash_file_access::DirId;
use ash_protocol::ProjectId;
use ash_protocol::SessionId;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Component;
use std::path::PathBuf;

pub const PROJECT_SCHEMA_VERSION: u32 = 2;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectStatus {
    Active,
    Archived,
    Deleted,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectScope {
    Chat,
    Code,
}

/// One host-resolved directory reference in a Project catalog.
///
/// This is organizational metadata. It is never an executable directory authorization.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectRoot {
    pub environment_id: EnvId,
    pub dir_id: DirId,
    pub path: PathBuf,
    pub name: String,
    pub purpose: String,
}

/// Project-owned text or a reference that grants no access to its source.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ProjectMaterial {
    File {
        path: PathBuf,
        name: String,
        /// Size of the source when it was added to the project.
        #[serde(rename = "sizeBytes")]
        size_bytes: u64,
    },
    Folder {
        path: PathBuf,
        name: String,
    },
    Text {
        id: String,
        name: String,
        content: String,
    },
}

/// Long-lived weak associations for opening multi-root work.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub schema_version: u32,
    pub project_id: ProjectId,
    pub revision: u64,
    /// Unix epoch milliseconds, absent in older Project records and receipts.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub created_at_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub updated_at_ms: Option<u64>,
    pub status: ProjectStatus,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scope: Option<ProjectScope>,
    pub name: String,
    pub description: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub icon: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub color: Option<String>,
    pub roots: BTreeMap<DirId, ProjectRoot>,
    pub session_ids: BTreeSet<SessionId>,
    /// Opaque references to conversations owned by an external provider.
    #[serde(default, skip_serializing_if = "BTreeSet::is_empty")]
    pub external_conversation_ids: BTreeSet<String>,
    #[serde(default)]
    pub materials: Vec<ProjectMaterial>,
}

impl Project {
    pub fn scope(&self) -> ProjectScope {
        self.scope.unwrap_or_else(|| {
            let id = self.project_id.as_str();
            // The Desktop folder picker and the TUI workspace flow used deterministic IDs
            // before the scope was stored. Other legacy projects keep their Chat listing.
            let workspace_id = id
                .strip_prefix("folder-")
                .or_else(|| id.strip_prefix("project-"))
                .is_some_and(|hash| {
                    hash.len() == 64 && hash.bytes().all(|byte| byte.is_ascii_hexdigit())
                });
            if workspace_id {
                ProjectScope::Code
            } else {
                ProjectScope::Chat
            }
        })
    }

    pub fn validate(&self) -> Result<(), crate::ProjectError> {
        if self.schema_version != PROJECT_SCHEMA_VERSION {
            return Err(crate::ProjectError::InvalidInput(format!(
                "unsupported Project schema version {}",
                self.schema_version
            )));
        }
        if self.revision == 0 {
            return Err(crate::ProjectError::InvalidInput(
                "Project revision must be positive".into(),
            ));
        }
        if self.created_at_ms == Some(0)
            || self.updated_at_ms == Some(0)
            || self
                .created_at_ms
                .zip(self.updated_at_ms)
                .is_some_and(|(created, updated)| updated < created)
        {
            return Err(crate::ProjectError::InvalidInput(
                "invalid Project timestamps".into(),
            ));
        }
        validate_text("Project name", &self.name)?;
        for id in &self.external_conversation_ids {
            if id.is_empty()
                || id.len() > 512
                || !id.bytes().all(|byte| {
                    byte.is_ascii_alphanumeric() || matches!(byte, b':' | b'.' | b'-' | b'_')
                })
            {
                return Err(crate::ProjectError::InvalidInput(
                    "invalid external conversation reference".into(),
                ));
            }
        }
        for id in [&self.icon, &self.color].into_iter().flatten() {
            if id.len() > 128
                || !id.as_bytes().first().is_some_and(u8::is_ascii_alphanumeric)
                || !id
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
            {
                return Err(crate::ProjectError::InvalidInput(
                    "invalid Project appearance identifier".into(),
                ));
            }
        }
        for (dir_id, root) in &self.roots {
            if dir_id != &root.dir_id {
                return Err(crate::ProjectError::InvalidInput(
                    "Project root key does not match its Dir identity".into(),
                ));
            }
            root.validate()?;
        }
        if self.materials.len() > 1000 {
            return Err(crate::ProjectError::InvalidInput(
                "too many Project materials".into(),
            ));
        }
        let mut paths = BTreeSet::new();
        let mut text_ids = BTreeSet::new();
        let mut text_bytes = 0;
        for material in &self.materials {
            // Project sizes cross the JavaScript API as numbers.
            if let ProjectMaterial::File { size_bytes, .. } = material
                && *size_bytes > (1_u64 << 53) - 1
            {
                return Err(crate::ProjectError::InvalidInput(
                    "Project file size exceeds the safe integer range".into(),
                ));
            }
            let (name, valid) = match material {
                ProjectMaterial::File { path, name, .. }
                | ProjectMaterial::Folder { path, name } => (
                    name,
                    path.is_absolute()
                        && !path.components().any(|component| {
                            matches!(component, Component::ParentDir | Component::CurDir)
                        })
                        && paths.insert(path),
                ),
                ProjectMaterial::Text { id, name, content } => {
                    text_bytes += content.len();
                    (
                        name,
                        !id.is_empty()
                            && id.len() <= 128
                            && id
                                .bytes()
                                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                            && text_ids.insert(id)
                            && !content.trim().is_empty()
                            && content.len() <= 80_000
                            && text_bytes <= 1_000_000,
                    )
                }
            };
            validate_text("Project material name", name)?;
            if name.len() > 1024 || !valid {
                return Err(crate::ProjectError::InvalidInput(
                    "invalid or duplicate Project material".into(),
                ));
            }
        }
        Ok(())
    }

    pub fn is_active(&self) -> bool {
        self.status == ProjectStatus::Active
    }
}

impl ProjectRoot {
    pub fn validate(&self) -> Result<(), crate::ProjectError> {
        if !self.path.is_absolute()
            || self
                .path
                .components()
                .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
        {
            return Err(crate::ProjectError::InvalidInput(
                "Project root path must be absolute and normalized".into(),
            ));
        }
        validate_text("Project root name", &self.name)?;
        Ok(())
    }
}

pub(crate) fn validate_text(label: &str, value: &str) -> Result<(), crate::ProjectError> {
    if value.trim().is_empty() {
        Err(crate::ProjectError::InvalidInput(format!(
            "{label} must not be empty"
        )))
    } else {
        Ok(())
    }
}

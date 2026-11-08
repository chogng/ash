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

pub const PROJECT_SCHEMA_VERSION: u32 = 1;

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

/// A user-selected file or folder reference. It never grants file access or owns the source bytes.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectMaterial {
    pub path: PathBuf,
    pub name: String,
    pub kind: ProjectMaterialKind,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProjectMaterialKind {
    File,
    Folder,
}

/// Long-lived weak associations for opening multi-root work.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub schema_version: u32,
    pub project_id: ProjectId,
    pub revision: u64,
    /// Unix epoch milliseconds.
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
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
        if self.created_at_ms == 0 || self.updated_at_ms < self.created_at_ms {
            return Err(crate::ProjectError::InvalidInput(
                "invalid Project timestamps".into(),
            ));
        }
        validate_text("Project name", &self.name)?;
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
        for material in &self.materials {
            validate_text("Project material name", &material.name)?;
            if material.name.len() > 1024
                || !material.path.is_absolute()
                || material
                    .path
                    .components()
                    .any(|component| matches!(component, Component::ParentDir | Component::CurDir))
                || !paths.insert(&material.path)
            {
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

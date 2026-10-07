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

/// Long-lived weak associations for opening multi-root work.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Project {
    pub schema_version: u32,
    pub project_id: ProjectId,
    pub revision: u64,
    pub status: ProjectStatus,
    pub name: String,
    pub description: String,
    pub roots: BTreeMap<DirId, ProjectRoot>,
    pub session_ids: BTreeSet<SessionId>,
}

impl Project {
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
        validate_text("Project name", &self.name)?;
        for (dir_id, root) in &self.roots {
            if dir_id != &root.dir_id {
                return Err(crate::ProjectError::InvalidInput(
                    "Project root key does not match its Dir identity".into(),
                ));
            }
            root.validate()?;
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

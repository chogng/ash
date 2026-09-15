use crate::Project;
use crate::ProjectCommandRequest;
use ash_protocol::CommandId;
use ash_protocol::ProjectId;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProjectCommit {
    pub request: ProjectCommandRequest,
    pub result: Project,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectStoreOutcome {
    Applied,
    Replayed(Project),
}

pub trait ProjectStore: Send + Sync {
    fn list(&self) -> Result<Vec<Project>, ProjectStoreError>;

    fn load(&self, project_id: &ProjectId) -> Result<Project, ProjectStoreError>;

    fn load_command(
        &self,
        command_id: &CommandId,
    ) -> Result<Option<ProjectCommit>, ProjectStoreError>;

    fn commit(&self, commit: &ProjectCommit) -> Result<ProjectStoreOutcome, ProjectStoreError>;
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ProjectStoreError {
    #[error("Project was not found: {0}")]
    NotFound(String),
    #[error("Project already exists: {0}")]
    AlreadyExists(String),
    #[error("Project command ID was already used for different parameters")]
    CommandConflict,
    #[error("Project revision conflict: expected {expected}, actual {actual}")]
    RevisionConflict { expected: u64, actual: u64 },
    #[error("Project storage failed: {0}")]
    Storage(String),
}

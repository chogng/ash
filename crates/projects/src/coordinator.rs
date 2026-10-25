use crate::Project;
use crate::ProjectCommandRequest;
use crate::ProjectCommit;
use crate::ProjectError;
use crate::ProjectStatus;
use crate::ProjectStore;
use crate::ProjectStoreError;
use crate::ProjectStoreOutcome;
use ash_protocol::ProjectId;
use std::sync::Arc;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProjectCommandDisposition {
    Committed,
    Replayed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectCommandResult {
    pub project: Project,
    pub disposition: ProjectCommandDisposition,
}

pub struct ProjectCoordinator {
    store: Arc<dyn ProjectStore>,
}

impl ProjectCoordinator {
    pub fn new(store: Arc<dyn ProjectStore>) -> Self {
        Self { store }
    }

    pub fn list(&self) -> Result<Vec<Project>, ProjectError> {
        let projects = self.store.list().map_err(map_store_error)?;
        for project in &projects {
            project.validate()?;
        }
        Ok(projects
            .into_iter()
            .filter(|project| project.status != ProjectStatus::Deleted)
            .collect())
    }

    pub fn read(&self, project_id: &ProjectId) -> Result<Project, ProjectError> {
        let project = self.store.load(project_id).map_err(map_store_error)?;
        project.validate()?;
        if project.status == ProjectStatus::Deleted {
            return Err(ProjectError::NotFound(project_id.to_string()));
        }
        Ok(project)
    }

    pub fn apply(
        &self,
        request: ProjectCommandRequest,
    ) -> Result<ProjectCommandResult, ProjectError> {
        if let Some(receipt) = self
            .store
            .load_command(&request.command_id)
            .map_err(map_store_error)?
        {
            if receipt.request != request {
                return Err(ProjectError::CommandConflict);
            }
            receipt.result.validate()?;
            return Ok(ProjectCommandResult {
                project: receipt.result,
                disposition: ProjectCommandDisposition::Replayed,
            });
        }
        let current = match self.store.load(&request.project_id) {
            Ok(project) => {
                project.validate()?;
                Some(project)
            }
            Err(ProjectStoreError::NotFound(_)) => None,
            Err(error) => return Err(map_store_error(error)),
        };
        let now_ms = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| ProjectError::Storage(format!("Project clock failed: {error}")))?
            .as_millis()
            .try_into()
            .map_err(|_| ProjectError::Storage("Project clock overflow".into()))?;
        let result = crate::reducer::apply(current, &request, now_ms)?;
        let commit = ProjectCommit { request, result };
        match self.store.commit(&commit).map_err(map_store_error)? {
            ProjectStoreOutcome::Applied => Ok(ProjectCommandResult {
                project: commit.result,
                disposition: ProjectCommandDisposition::Committed,
            }),
            ProjectStoreOutcome::Replayed(project) => Ok(ProjectCommandResult {
                project,
                disposition: ProjectCommandDisposition::Replayed,
            }),
        }
    }
}

fn map_store_error(error: ProjectStoreError) -> ProjectError {
    match error {
        ProjectStoreError::NotFound(identity) => ProjectError::NotFound(identity),
        ProjectStoreError::AlreadyExists(identity) => ProjectError::AlreadyExists(identity),
        ProjectStoreError::CommandConflict => ProjectError::CommandConflict,
        ProjectStoreError::RevisionConflict { expected, actual } => {
            ProjectError::RevisionConflict { expected, actual }
        }
        ProjectStoreError::Storage(message) => ProjectError::Storage(message),
    }
}

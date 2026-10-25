use crate::Project;
use crate::ProjectCommand;
use crate::ProjectCommandRequest;
use crate::ProjectError;
use crate::ProjectStatus;
use crate::project::PROJECT_SCHEMA_VERSION;
use crate::project::validate_text;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

pub(crate) fn apply(
    current: Option<Project>,
    request: &ProjectCommandRequest,
    now_ms: u64,
) -> Result<Project, ProjectError> {
    let project = match (&current, &request.command) {
        (
            None,
            ProjectCommand::Create {
                name,
                description,
                materials,
            },
        ) => {
            if request.expected_revision != 0 {
                return Err(ProjectError::RevisionConflict {
                    expected: request.expected_revision,
                    actual: 0,
                });
            }
            validate_text("Project name", name)?;
            Project {
                schema_version: PROJECT_SCHEMA_VERSION,
                project_id: request.project_id.clone(),
                revision: 1,
                created_at_ms: Some(now_ms),
                updated_at_ms: Some(now_ms),
                status: ProjectStatus::Active,
                name: name.clone(),
                description: description.clone(),
                roots: BTreeMap::new(),
                session_ids: BTreeSet::new(),
                materials: materials.clone(),
            }
        }
        (None, _) => return Err(ProjectError::NotFound(request.project_id.to_string())),
        (Some(_), ProjectCommand::Create { .. }) => {
            return Err(ProjectError::AlreadyExists(request.project_id.to_string()));
        }
        (Some(project), _) => {
            if project.revision != request.expected_revision {
                return Err(ProjectError::RevisionConflict {
                    expected: request.expected_revision,
                    actual: project.revision,
                });
            }
            let mut project = project.clone();
            apply_existing(&mut project, &request.command)?;
            project.revision = project
                .revision
                .checked_add(1)
                .ok_or_else(|| ProjectError::InvalidTransition("revision overflow".into()))?;
            // A clock adjustment cannot make a saved update precede an earlier revision.
            project.updated_at_ms = Some(now_ms.max(project.updated_at_ms.unwrap_or(0)));
            project
        }
    };
    project.validate()?;
    if project.project_id != request.project_id {
        return Err(ProjectError::InvalidInput(
            "Project command changed the aggregate identity".into(),
        ));
    }
    Ok(project)
}

fn apply_existing(project: &mut Project, command: &ProjectCommand) -> Result<(), ProjectError> {
    if project.status == ProjectStatus::Deleted {
        return Err(ProjectError::NotFound(project.project_id.to_string()));
    }
    match command {
        ProjectCommand::Create { .. } => unreachable!("existing create rejected by caller"),
        ProjectCommand::Delete => {
            // Keep a revisioned tombstone for command replay; references never own their source data.
            project.status = ProjectStatus::Deleted;
            project.roots.clear();
            project.session_ids.clear();
            project.materials.clear();
            return Ok(());
        }
        ProjectCommand::Restore => {
            if project.status != ProjectStatus::Archived {
                return Err(ProjectError::InvalidTransition(
                    "only an archived Project can be restored".into(),
                ));
            }
            project.status = ProjectStatus::Active;
            return Ok(());
        }
        _ if !project.is_active() => {
            return Err(ProjectError::InvalidTransition(
                "an archived Project is read-only until restored".into(),
            ));
        }
        ProjectCommand::UpdateDetails {
            name,
            description,
            materials,
        } => {
            validate_text("Project name", name)?;
            project.name = name.clone();
            project.description = description.clone();
            if let Some(materials) = materials {
                project.materials = materials.clone();
            }
        }
        ProjectCommand::AddRoot { root } => {
            root.validate()?;
            if project
                .roots
                .insert(root.dir_id.clone(), root.clone())
                .is_some()
            {
                return Err(ProjectError::AlreadyExists(root.dir_id.to_string()));
            }
        }
        ProjectCommand::UpdateRootDetails {
            dir_id,
            name,
            purpose,
        } => {
            validate_text("Project root name", name)?;
            let root = project
                .roots
                .get_mut(dir_id)
                .ok_or_else(|| ProjectError::NotFound(dir_id.to_string()))?;
            root.name = name.clone();
            root.purpose = purpose.clone();
        }
        ProjectCommand::RemoveRoot { dir_id } => {
            project
                .roots
                .remove(dir_id)
                .ok_or_else(|| ProjectError::NotFound(dir_id.to_string()))?;
        }
        ProjectCommand::LinkSession { session_id } => {
            if !project.session_ids.insert(session_id.clone()) {
                return Err(ProjectError::AlreadyExists(session_id.to_string()));
            }
        }
        ProjectCommand::UnlinkSession { session_id } => {
            if !project.session_ids.remove(session_id) {
                return Err(ProjectError::NotFound(session_id.to_string()));
            }
        }
        ProjectCommand::Archive => project.status = ProjectStatus::Archived,
    }
    Ok(())
}

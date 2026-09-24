use ash_app_server_protocol::protocol::projects::ProjectDto;
use ash_app_server_protocol::protocol::projects::ProjectRootDto;
use ash_app_server_protocol::protocol::projects::ProjectStatusDto;
use ash_app_server_protocol::protocol::projects::ProjectSummaryDto;
use ash_projects::Project;
use ash_projects::ProjectStatus;
use ash_utils_absolute_path::AbsolutePathBuf;
use ash_utils_path_uri::PathUri;

pub(super) fn project(project: &Project) -> ProjectDto {
    ProjectDto {
        project_id: project.project_id.clone(),
        revision: project.revision,
        status: status(project.status),
        name: project.name.clone(),
        description: project.description.clone(),
        roots: project
            .roots
            .values()
            .map(|root| ProjectRootDto {
                environment_id: root.environment_id.clone(),
                dir_id: root.dir_id.clone(),
                path: PathUri::from_absolute_path(
                    &AbsolutePathBuf::from_absolute(&root.path)
                        .expect("validated Project root has an absolute path"),
                ),
                name: root.name.clone(),
                purpose: root.purpose.clone(),
            })
            .collect(),
        session_ids: project.session_ids.iter().cloned().collect(),
    }
}

pub(super) fn summary(project: &Project) -> ProjectSummaryDto {
    ProjectSummaryDto {
        project_id: project.project_id.clone(),
        revision: project.revision,
        status: status(project.status),
        name: project.name.clone(),
        root_count: project.roots.len() as u64,
        session_count: project.session_ids.len() as u64,
    }
}

fn status(status: ProjectStatus) -> ProjectStatusDto {
    match status {
        ProjectStatus::Active => ProjectStatusDto::Active,
        ProjectStatus::Archived => ProjectStatusDto::Archived,
    }
}

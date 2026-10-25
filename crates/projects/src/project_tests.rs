use super::ProjectCommand;
use super::ProjectCommandDisposition;
use super::ProjectCommandRequest;
use super::ProjectCommit;
use super::ProjectCoordinator;
use super::ProjectError;
use super::ProjectRoot;
use super::ProjectStore;
use super::ProjectStoreError;
use super::ProjectStoreOutcome;
use ash_environment::EnvId;
use ash_file_access::DirId;
use ash_protocol::CommandId;
use ash_protocol::ProjectId;
use ash_protocol::SessionId;
use pretty_assertions::assert_eq;
use std::collections::BTreeMap;
use std::str::FromStr;
use std::sync::Arc;
use std::sync::Mutex;

#[derive(Default)]
struct MemoryStore {
    projects: Mutex<BTreeMap<ProjectId, super::Project>>,
    commands: Mutex<BTreeMap<CommandId, ProjectCommit>>,
}

impl ProjectStore for MemoryStore {
    fn list(&self) -> Result<Vec<super::Project>, ProjectStoreError> {
        Ok(self.projects.lock().unwrap().values().cloned().collect())
    }

    fn load(&self, project_id: &ProjectId) -> Result<super::Project, ProjectStoreError> {
        self.projects
            .lock()
            .unwrap()
            .get(project_id)
            .cloned()
            .ok_or_else(|| ProjectStoreError::NotFound(project_id.to_string()))
    }

    fn load_command(
        &self,
        command_id: &CommandId,
    ) -> Result<Option<ProjectCommit>, ProjectStoreError> {
        Ok(self.commands.lock().unwrap().get(command_id).cloned())
    }

    fn commit(&self, commit: &ProjectCommit) -> Result<ProjectStoreOutcome, ProjectStoreError> {
        let mut commands = self.commands.lock().unwrap();
        if let Some(existing) = commands.get(&commit.request.command_id) {
            return if existing.request == commit.request {
                Ok(ProjectStoreOutcome::Replayed(existing.result.clone()))
            } else {
                Err(ProjectStoreError::CommandConflict)
            };
        }
        let mut projects = self.projects.lock().unwrap();
        let actual = projects
            .get(&commit.request.project_id)
            .map_or(0, |project| project.revision);
        if actual != commit.request.expected_revision {
            return Err(ProjectStoreError::RevisionConflict {
                expected: commit.request.expected_revision,
                actual,
            });
        }
        projects.insert(commit.result.project_id.clone(), commit.result.clone());
        commands.insert(commit.request.command_id.clone(), commit.clone());
        Ok(ProjectStoreOutcome::Applied)
    }
}

#[test]
fn project_times_preserve_creation_and_follow_committed_updates() {
    let create = request(
        "create-project-time",
        0,
        ProjectCommand::Create {
            name: "Ash".into(),
            description: String::new(),
            materials: Vec::new(),
        },
    );
    let created = crate::reducer::apply(None, &create, 100).unwrap();
    assert_eq!(created.created_at_ms, Some(100));
    assert_eq!(created.updated_at_ms, Some(100));
    let update = request(
        "update-project-time",
        1,
        ProjectCommand::UpdateDetails {
            name: "Renamed".into(),
            description: String::new(),
            materials: None,
        },
    );
    let updated = crate::reducer::apply(Some(created), &update, 300).unwrap();
    assert_eq!(updated.created_at_ms, Some(100));
    assert_eq!(updated.updated_at_ms, Some(300));
    let archive = request("archive-project-time", 2, ProjectCommand::Archive);
    let archived = crate::reducer::apply(Some(updated), &archive, 200).unwrap();
    assert_eq!(archived.created_at_ms, Some(100));
    assert_eq!(archived.updated_at_ms, Some(300));
}

#[test]
fn project_commands_are_revision_checked_and_retry_safe() {
    let coordinator = coordinator();
    let create = request(
        "create-project",
        0,
        ProjectCommand::Create {
            name: "Ash".into(),
            description: "multi-root work".into(),
            materials: Vec::new(),
        },
    );
    let created = coordinator.apply(create.clone()).unwrap();
    assert_eq!(created.project.revision, 1);
    assert!(created.project.created_at_ms.is_some());
    assert_eq!(created.project.created_at_ms, created.project.updated_at_ms);
    assert_eq!(created.disposition, ProjectCommandDisposition::Committed);
    assert_eq!(
        coordinator.apply(create).unwrap(),
        super::ProjectCommandResult {
            project: created.project,
            disposition: ProjectCommandDisposition::Replayed,
        }
    );
    assert!(matches!(
        coordinator.apply(request(
            "stale-project-update",
            0,
            ProjectCommand::UpdateDetails {
                name: "stale".into(),
                description: String::new(),
                materials: None,
            },
        )),
        Err(ProjectError::RevisionConflict {
            expected: 0,
            actual: 1
        })
    ));
}

#[test]
fn project_roots_and_associations_remain_organizational_facts() {
    let coordinator = coordinator();
    let mut project = coordinator
        .apply(request(
            "create-project-associations",
            0,
            ProjectCommand::Create {
                name: "Ash".into(),
                description: String::new(),
                materials: Vec::new(),
            },
        ))
        .unwrap()
        .project;
    project = coordinator
        .apply(request(
            "add-project-root",
            project.revision,
            ProjectCommand::AddRoot { root: root() },
        ))
        .unwrap()
        .project;
    project = coordinator
        .apply(request(
            "link-project-session",
            project.revision,
            ProjectCommand::LinkSession {
                session_id: SessionId::new("session-a").unwrap(),
            },
        ))
        .unwrap()
        .project;
    assert_eq!(project.roots.len(), 1);
    assert_eq!(project.session_ids.len(), 1);
    assert_eq!(project.revision, 3);
}

fn coordinator() -> ProjectCoordinator {
    ProjectCoordinator::new(Arc::new(MemoryStore::default()))
}

#[test]
fn deletion_is_retry_safe_hides_the_catalog_and_prevents_restoration() {
    let coordinator = coordinator();
    let created = coordinator
        .apply(request(
            "delete-create",
            0,
            ProjectCommand::Create {
                name: "Delete me".into(),
                description: String::new(),
                materials: Vec::new(),
            },
        ))
        .unwrap()
        .project;
    coordinator
        .apply(request(
            "delete-link",
            1,
            ProjectCommand::LinkSession {
                session_id: SessionId::new("retained-session").unwrap(),
            },
        ))
        .unwrap();
    coordinator
        .apply(request("delete-archive", 2, ProjectCommand::Archive))
        .unwrap();
    let deletion = request("delete-project", 3, ProjectCommand::Delete);
    let deleted = coordinator.apply(deletion.clone()).unwrap();
    assert_eq!(deleted.project.status, super::ProjectStatus::Deleted);
    assert!(deleted.project.session_ids.is_empty());
    assert!(coordinator.list().unwrap().is_empty());
    assert!(matches!(
        coordinator.read(&created.project_id),
        Err(ProjectError::NotFound(_))
    ));
    assert_eq!(
        coordinator.apply(deletion).unwrap().disposition,
        ProjectCommandDisposition::Replayed
    );
    assert!(matches!(
        coordinator.apply(request("delete-restore", 4, ProjectCommand::Restore)),
        Err(ProjectError::NotFound(_))
    ));
}

fn request(
    command_id: &str,
    expected_revision: u64,
    command: ProjectCommand,
) -> ProjectCommandRequest {
    ProjectCommandRequest {
        command_id: CommandId::new(command_id).unwrap(),
        project_id: ProjectId::new("project-a").unwrap(),
        expected_revision,
        command,
    }
}

fn root() -> ProjectRoot {
    ProjectRoot {
        environment_id: EnvId::local(),
        dir_id: DirId::from_str(&format!("sha256:{}", "a".repeat(64))).unwrap(),
        path: std::env::current_dir().unwrap(),
        name: "source".into(),
        purpose: "primary source root".into(),
    }
}

#[test]
fn materials_are_versioned_references_and_invalid_updates_are_atomic() {
    let coordinator = coordinator();
    let material = super::ProjectMaterial {
        path: std::env::temp_dir().join("project-paper.pdf"),
        name: "paper.pdf".into(),
        kind: super::ProjectMaterialKind::File,
    };
    let created = coordinator
        .apply(request(
            "create-material-project",
            0,
            ProjectCommand::Create {
                name: "Research".into(),
                description: "Read the evidence".into(),
                materials: vec![material.clone()],
            },
        ))
        .unwrap()
        .project;
    assert_eq!(created.materials, vec![material.clone()]);
    let duplicated = coordinator.apply(request(
        "duplicate-material",
        1,
        ProjectCommand::UpdateDetails {
            name: created.name.clone(),
            description: created.description.clone(),
            materials: Some(vec![material.clone(), material]),
        },
    ));
    assert!(matches!(duplicated, Err(ProjectError::InvalidInput(_))));
    assert_eq!(coordinator.read(&created.project_id).unwrap(), created);
    let renamed = coordinator
        .apply(request(
            "rename-material-project",
            1,
            ProjectCommand::UpdateDetails {
                name: "Research notes".into(),
                description: created.description,
                materials: None,
            },
        ))
        .unwrap()
        .project;
    assert_eq!(renamed.materials.len(), 1);
    let removed = coordinator
        .apply(request(
            "remove-material",
            2,
            ProjectCommand::UpdateDetails {
                name: renamed.name,
                description: renamed.description,
                materials: Some(Vec::new()),
            },
        ))
        .unwrap()
        .project;
    assert!(removed.materials.is_empty());
}

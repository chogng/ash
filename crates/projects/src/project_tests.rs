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
fn project_commands_are_revision_checked_and_retry_safe() {
    let coordinator = coordinator();
    let create = request(
        "create-project",
        0,
        ProjectCommand::Create {
            name: "Ash".into(),
            description: "multi-root work".into(),
        },
    );
    let created = coordinator.apply(create.clone()).unwrap();
    assert_eq!(created.project.revision, 1);
    assert_eq!(created.disposition, ProjectCommandDisposition::Committed);
    assert_eq!(
        coordinator.apply(create).unwrap().disposition,
        ProjectCommandDisposition::Replayed
    );
    assert!(matches!(
        coordinator.apply(request(
            "stale-project-update",
            0,
            ProjectCommand::UpdateDetails {
                name: "stale".into(),
                description: String::new(),
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

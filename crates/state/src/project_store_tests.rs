use super::SqliteProjectStore;
use ash_projects::ProjectCommand;
use ash_projects::ProjectCommandDisposition;
use ash_projects::ProjectCommandRequest;
use ash_projects::ProjectCoordinator;
use ash_projects::ProjectScope;
use ash_projects::ProjectStore;
use ash_protocol::CommandId;
use ash_protocol::ProjectId;
use rusqlite::Connection;
use std::sync::Arc;

#[test]
fn sqlite_projects_persist_records_and_original_command_results() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.sqlite3");
    let store: Arc<dyn ProjectStore> = Arc::new(SqliteProjectStore::open(&path).unwrap());
    let coordinator = ProjectCoordinator::new(store);
    let create = create_request();
    let created = coordinator.apply(create.clone()).unwrap();
    assert_eq!(created.project.revision, 1);
    let updated = coordinator
        .apply(ProjectCommandRequest {
            command_id: CommandId::new("rename-project").unwrap(),
            project_id: create.project_id.clone(),
            expected_revision: 1,
            command: ProjectCommand::UpdateDetails {
                name: "Renamed".into(),
                description: "still the same weak associations".into(),
                materials: None,
            },
        })
        .unwrap();
    drop(coordinator);

    let reopened = ProjectCoordinator::new(Arc::new(SqliteProjectStore::open(&path).unwrap()));
    let persisted = reopened.read(&create.project_id).unwrap();
    assert_eq!(persisted.scope(), ProjectScope::Code);
    assert_eq!(persisted, updated.project);
    let replay = reopened.apply(create).unwrap();
    assert_eq!(replay.disposition, ProjectCommandDisposition::Replayed);
    assert_eq!(replay.project.revision, 1);
    assert_eq!(replay.project, created.project);
}

#[test]
fn sqlite_projects_require_both_timestamps() {
    for field in ["createdAtMs", "updatedAtMs"] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.sqlite3");
        let coordinator =
            ProjectCoordinator::new(Arc::new(SqliteProjectStore::open(&path).unwrap()));
        let created = coordinator.apply(create_request()).unwrap().project;
        let mut record = serde_json::to_value(created).unwrap();
        record.as_object_mut().unwrap().remove(field);
        drop(coordinator);
        Connection::open(&path)
            .unwrap()
            .execute(
                "UPDATE projects SET record_json = ?1 WHERE project_id = ?2",
                rusqlite::params![record.to_string(), "project-a"],
            )
            .unwrap();
        assert!(SqliteProjectStore::open(&path).is_err());
    }
}

#[test]
fn sqlite_projects_reject_row_metadata_corruption() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.sqlite3");
    let coordinator = ProjectCoordinator::new(Arc::new(SqliteProjectStore::open(&path).unwrap()));
    let create = create_request();
    coordinator.apply(create.clone()).unwrap();
    drop(coordinator);
    Connection::open(&path)
        .unwrap()
        .execute(
            "UPDATE projects SET revision = 99 WHERE project_id = ?1",
            [create.project_id.as_str()],
        )
        .unwrap();
    assert!(SqliteProjectStore::open(&path).is_err());
}

fn create_request() -> ProjectCommandRequest {
    ProjectCommandRequest {
        command_id: CommandId::new("create-project").unwrap(),
        project_id: ProjectId::new("project-a").unwrap(),
        expected_revision: 0,
        command: ProjectCommand::Create {
            icon: None,
            color: None,
            scope: Some(ProjectScope::Code),
            name: "Ash".into(),
            description: "multi-root project".into(),
            materials: Vec::new(),
        },
    }
}

#[test]
fn sqlite_project_deletion_survives_reopen_and_replays_its_receipt() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.sqlite3");
    let coordinator = ProjectCoordinator::new(Arc::new(SqliteProjectStore::open(&path).unwrap()));
    let create = create_request();
    coordinator.apply(create.clone()).unwrap();
    let deletion = ProjectCommandRequest {
        command_id: CommandId::new("delete-project").unwrap(),
        project_id: create.project_id.clone(),
        expected_revision: 1,
        command: ProjectCommand::Delete,
    };
    coordinator.apply(deletion.clone()).unwrap();
    drop(coordinator);
    let reopened = ProjectCoordinator::new(Arc::new(SqliteProjectStore::open(&path).unwrap()));
    assert!(reopened.list().unwrap().is_empty());
    assert!(matches!(
        reopened.read(&create.project_id),
        Err(ash_projects::ProjectError::NotFound(_))
    ));
    assert_eq!(
        reopened.apply(deletion).unwrap().disposition,
        ProjectCommandDisposition::Replayed
    );
}

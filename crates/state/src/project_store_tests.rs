use super::SqliteProjectStore;
use ash_projects::ProjectCommand;
use ash_projects::ProjectCommandDisposition;
use ash_projects::ProjectCommandRequest;
use ash_projects::ProjectCoordinator;
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
    coordinator
        .apply(ProjectCommandRequest {
            command_id: CommandId::new("rename-project").unwrap(),
            project_id: create.project_id.clone(),
            expected_revision: 1,
            command: ProjectCommand::UpdateDetails {
                name: "Renamed".into(),
                description: "still the same weak associations".into(),
            },
        })
        .unwrap();
    drop(coordinator);

    let reopened = ProjectCoordinator::new(Arc::new(SqliteProjectStore::open(&path).unwrap()));
    assert_eq!(reopened.read(&create.project_id).unwrap().revision, 2);
    let replay = reopened.apply(create).unwrap();
    assert_eq!(replay.disposition, ProjectCommandDisposition::Replayed);
    assert_eq!(replay.project.revision, 1);
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
            name: "Ash".into(),
            description: "multi-root project".into(),
        },
    }
}

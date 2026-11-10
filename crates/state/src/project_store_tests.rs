use super::SqliteProjectStore;
use ash_projects::ProjectCommand;
use ash_projects::ProjectCommandDisposition;
use ash_projects::ProjectCommandRequest;
use ash_projects::ProjectCoordinator;
use ash_projects::ProjectMaterial;
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
fn sqlite_projects_reopen_and_replay_with_missing_legacy_timestamps() {
    for (missing_created, missing_updated) in [(true, true), (true, false), (false, true)] {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("state.sqlite3");
        let coordinator =
            ProjectCoordinator::new(Arc::new(SqliteProjectStore::open(&path).unwrap()));
        let create = create_request();
        let mut legacy = coordinator.apply(create.clone()).unwrap().project;
        if missing_created {
            legacy.created_at_ms = None;
        }
        if missing_updated {
            legacy.updated_at_ms = None;
        }
        let record = serde_json::to_string(&legacy).unwrap();
        drop(coordinator);
        let connection = Connection::open(&path).unwrap();
        connection
            .execute("UPDATE projects SET record_json = ?1", [&record])
            .unwrap();
        connection
            .execute("UPDATE project_commands SET result_json = ?1", [&record])
            .unwrap();
        drop(connection);

        let reopened = ProjectCoordinator::new(Arc::new(SqliteProjectStore::open(&path).unwrap()));
        assert_eq!(reopened.list().unwrap(), vec![legacy.clone()]);
        let updated = reopened
            .apply(ProjectCommandRequest {
                command_id: CommandId::new("archive-legacy-project").unwrap(),
                project_id: create.project_id.clone(),
                expected_revision: 1,
                command: ProjectCommand::Archive,
            })
            .unwrap();
        assert_eq!(updated.project.created_at_ms, legacy.created_at_ms);
        assert!(updated.project.updated_at_ms.is_some());
        assert_eq!(reopened.read(&create.project_id).unwrap(), updated.project);
        let replay = reopened.apply(create).unwrap();
        assert_eq!(replay.disposition, ProjectCommandDisposition::Replayed);
        assert_eq!(replay.project, legacy);
    }
}

#[test]
fn sqlite_projects_remove_unsized_file_references_from_records_and_receipts() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.sqlite3");
    let coordinator = ProjectCoordinator::new(Arc::new(SqliteProjectStore::open(&path).unwrap()));
    let mut create = create_request();
    let ProjectCommand::Create { materials, .. } = &mut create.command else {
        unreachable!()
    };
    materials.extend([
        ProjectMaterial::File {
            path: directory.path().join("empty.txt"),
            name: "empty.txt".into(),
            size_bytes: 0,
        },
        ProjectMaterial::Folder {
            path: directory.path().to_path_buf(),
            name: "Folder".into(),
        },
        ProjectMaterial::Text {
            id: "note".into(),
            name: "Note".into(),
            content: "Text".into(),
        },
    ]);
    let created = coordinator.apply(create.clone()).unwrap().project;
    drop(coordinator);

    let old_path = directory.path().join("legacy.pdf");
    std::fs::write(&old_path, "legacy source").unwrap();
    let old_material = serde_json::json!({"kind": "file", "name": "legacy.pdf", "path": old_path});
    let mut old_record = serde_json::to_value(&created).unwrap();
    old_record["schemaVersion"] = 1.into();
    old_record["materials"]
        .as_array_mut()
        .unwrap()
        .insert(0, old_material.clone());
    let mut old_request = serde_json::to_value(&create).unwrap();
    old_request["command"]["materials"]
        .as_array_mut()
        .unwrap()
        .push(old_material);
    let connection = Connection::open(&path).unwrap();
    connection
        .execute(
            "UPDATE projects SET record_json = ?1",
            [old_record.to_string()],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE project_commands SET result_json = ?1, request_json = ?2",
            [old_record.to_string(), old_request.to_string()],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE ash_schema_migrations SET version = 1 WHERE component = 'projects'",
            [],
        )
        .unwrap();
    drop(connection);

    let reopened = ProjectCoordinator::new(Arc::new(SqliteProjectStore::open(&path).unwrap()));
    assert_eq!(reopened.read(&create.project_id).unwrap(), created);
    let replay = reopened.apply(create).unwrap();
    assert_eq!(replay.disposition, ProjectCommandDisposition::Replayed);
    assert_eq!(replay.project, created);
    assert_eq!(std::fs::read_to_string(old_path).unwrap(), "legacy source");
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

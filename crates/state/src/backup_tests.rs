use super::*;

fn workspace() -> BackupWorkspace {
    BackupWorkspace {
        id: "workspace".into(),
        folders: vec!["file:///project".into()],
        configuration: None,
        remote_authority: None,
    }
}

fn content(text: &str) -> BackupContent {
    BackupContent {
        resource: "untitled:note".into(),
        format: "text.v1".into(),
        content: text.into(),
    }
}

#[test]
fn backup_content_and_workspace_survive_restart_and_discard_together() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.db");
    let first = SqliteBackupStore::open(&path).unwrap();
    let record = first
        .write("electron", &workspace(), &content("unsaved"), None)
        .unwrap();
    drop(first);
    let reopened = SqliteBackupStore::open(&path).unwrap();
    assert_eq!(reopened.workspaces("electron").unwrap(), vec![workspace()]);
    assert_eq!(
        reopened.list("electron", "workspace").unwrap(),
        vec![record.clone()]
    );
    reopened
        .discard("electron", "workspace", "untitled:note", &record.revision)
        .unwrap();
    assert!(reopened.workspaces("electron").unwrap().is_empty());
    assert!(reopened.list("electron", "workspace").unwrap().is_empty());
}

#[test]
fn concurrent_connections_reject_stale_writes_and_deletes() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.db");
    let first = SqliteBackupStore::open(&path).unwrap();
    let second = SqliteBackupStore::open(&path).unwrap();
    let initial = first
        .write("electron", &workspace(), &content("first"), None)
        .unwrap();
    let latest = second
        .write(
            "electron",
            &workspace(),
            &content("second"),
            Some(&initial.revision),
        )
        .unwrap();
    assert!(matches!(
        first.write(
            "electron",
            &workspace(),
            &content("stale"),
            Some(&initial.revision)
        ),
        Err(BackupError::Conflict)
    ));
    assert!(matches!(
        first.discard("electron", "workspace", "untitled:note", &initial.revision),
        Err(BackupError::Conflict)
    ));
    assert_eq!(first.list("electron", "workspace").unwrap(), vec![latest]);
}

#[test]
fn product_formats_and_workspaces_are_isolated_and_retries_are_idempotent() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqliteBackupStore::open(&directory.path().join("state.db")).unwrap();
    let electron = store
        .write("electron", &workspace(), &content("editor"), None)
        .unwrap();
    let mut draft = content("composer draft");
    draft.format = "composer.v1".into();
    let tui = store.write("tui", &workspace(), &draft, None).unwrap();
    assert_eq!(
        store
            .write("electron", &workspace(), &content("editor"), None)
            .unwrap(),
        electron
    );
    assert_eq!(store.list("tui", "workspace").unwrap(), vec![tui]);
    assert!(
        store
            .list("electron", "other-workspace")
            .unwrap()
            .is_empty()
    );
    store
        .discard("electron", "workspace", "untitled:note", &electron.revision)
        .unwrap();
    let recreated = store
        .write("electron", &workspace(), &content("new editor"), None)
        .unwrap();
    assert_ne!(recreated.revision, electron.revision);
    assert!(matches!(
        store.discard("electron", "workspace", "untitled:note", &electron.revision),
        Err(BackupError::Conflict)
    ));
}

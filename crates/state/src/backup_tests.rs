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
fn recovery_pages_bound_escaped_payloads_and_do_not_lose_any_records() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqliteBackupStore::open(&directory.path().join("state.db")).unwrap();
    // Eight individually valid records expand beyond the 320 MiB transport bound in one reply.
    let text = "\0".repeat(7 * 1024 * 1024);
    for index in 0..8 {
        let mut record = content("");
        record.resource = format!("untitled:note-{index}");
        record.content = text.clone();
        store.write("editor", &workspace(), &record, None).unwrap();
    }
    assert!(matches!(
        store.list("editor", "workspace"),
        Err(BackupError::Storage(_))
    ));
    let mut cursor = None;
    let mut resources = Vec::new();
    loop {
        let page = store
            .list_page("editor", "workspace", cursor.as_deref(), 8 * 1024 * 1024)
            .unwrap();
        assert_eq!(page.backups.len(), 1);
        let record = &page.backups[0];
        assert_eq!(record.content.content, text);
        resources.push(record.content.resource.clone());
        cursor = page.next_resource;
        if cursor.is_none() {
            break;
        }
    }
    assert_eq!(
        resources,
        (0..8)
            .map(|index| format!("untitled:note-{index}"))
            .collect::<Vec<_>>()
    );
    assert!(
        store
            .list_page("other-client", "workspace", None, 8 * 1024 * 1024)
            .unwrap()
            .backups
            .is_empty()
    );
    assert!(
        store
            .list_page("editor", "other-workspace", None, 8 * 1024 * 1024)
            .unwrap()
            .backups
            .is_empty()
    );
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

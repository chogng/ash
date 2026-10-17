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

#[test]
fn moving_recovery_is_atomic_and_keeps_unrelated_target_records() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.db");
    let store = SqliteBackupStore::open(&path).unwrap();
    let source = store
        .write("editor", &workspace(), &content("source draft"), None)
        .unwrap();
    let mut target = workspace();
    target.id = "saved".into();
    target.configuration = Some("file:///saved.ash-workspace".into());
    let mut unrelated = content("other recovery");
    unrelated.resource = "untitled:other".into();
    let other = store.write("editor", &target, &unrelated, None).unwrap();
    let moved = store
        .move_records(
            "editor",
            "workspace",
            &target,
            &[(source.content.resource.clone(), source.revision.clone())],
        )
        .unwrap();
    assert_eq!(
        moved,
        vec![(source.content.resource.clone(), source.revision.clone())]
    );
    drop(store);
    let reopened = SqliteBackupStore::open(&path).unwrap();
    assert!(reopened.list("editor", "workspace").unwrap().is_empty());
    let records = reopened.list("editor", "saved").unwrap();
    assert!(records.contains(&source));
    assert!(records.contains(&other));
    assert_eq!(reopened.workspaces("editor").unwrap(), vec![target]);
}

#[test]
fn a_late_destination_conflict_rolls_back_preceding_moves() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqliteBackupStore::open(&directory.path().join("state.db")).unwrap();
    let first = store
        .write("editor", &workspace(), &content("first"), None)
        .unwrap();
    let mut second_content = content("second");
    second_content.resource = "untitled:second".into();
    let second = store
        .write("editor", &workspace(), &second_content, None)
        .unwrap();
    let mut target = workspace();
    target.id = "saved".into();
    second_content.content = "different writer".into();
    let collision = store
        .write("editor", &target, &second_content, None)
        .unwrap();
    let expected = vec![
        (first.content.resource.clone(), first.revision.clone()),
        (second.content.resource.clone(), second.revision.clone()),
    ];
    assert!(matches!(
        store.move_records("editor", "workspace", &target, &expected),
        Err(BackupError::Conflict)
    ));
    let records = store.list("editor", "workspace").unwrap();
    assert!(records.contains(&first));
    assert!(records.contains(&second));
    assert_eq!(store.list("editor", "saved").unwrap(), vec![collision]);
}

#[test]
fn a_concurrent_source_writer_and_storage_failure_cannot_erase_recovery() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.db");
    let store = SqliteBackupStore::open(&path).unwrap();
    let old = store
        .write("editor", &workspace(), &content("old"), None)
        .unwrap();
    let peer = SqliteBackupStore::open(&path).unwrap();
    let latest = peer
        .write(
            "editor",
            &workspace(),
            &content("latest"),
            Some(&old.revision),
        )
        .unwrap();
    let mut target = workspace();
    target.id = "saved".into();
    assert!(matches!(
        store.move_records(
            "editor",
            "workspace",
            &target,
            &[(old.content.resource.clone(), old.revision)]
        ),
        Err(BackupError::Conflict)
    ));
    store.connection.lock().unwrap().execute_batch("CREATE TRIGGER fail_move BEFORE DELETE ON backup_contents WHEN OLD.workspace_id = 'workspace' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;").unwrap();
    assert!(matches!(
        store.move_records(
            "editor",
            "workspace",
            &target,
            &[(latest.content.resource.clone(), latest.revision.clone())]
        ),
        Err(BackupError::Storage(_))
    ));
    assert_eq!(store.list("editor", "workspace").unwrap(), vec![latest]);
    assert!(store.list("editor", "saved").unwrap().is_empty());
}

#[test]
fn recovery_accepts_the_workspace_folder_limit() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqliteBackupStore::open(&directory.path().join("state.db")).unwrap();
    let mut workspace = workspace();
    workspace.folders = (0..256)
        .map(|index| format!("file:///root-{index}"))
        .collect();
    assert!(
        store
            .write("editor", &workspace, &content("many roots"), None)
            .is_ok()
    );
}

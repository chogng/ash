use super::*;
#[test]
fn environment_commits_are_atomic_project_scoped_and_payload_bound() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite");
    let first = SqliteEnvironmentStore::open(&path).unwrap();
    let second = SqliteEnvironmentStore::open(&path).unwrap();
    let input = EnvironmentProfile::default();
    let result = first
        .save("project-one", "save", "request-one", 0, &input)
        .unwrap();
    assert_eq!(result.revision, 1);
    assert_eq!(
        second
            .save("project-one", "save", "request-one", 0, &input)
            .unwrap(),
        result
    );
    assert_eq!(second.read("project-two").unwrap().revision, 0);
    assert!(matches!(
        second.save("project-one", "other", "request-two", 0, &input),
        Err(EnvironmentError::Conflict)
    ));
    let changed = EnvironmentProfile {
        revision: 1,
        entries: vec![],
        observations: vec![],
    };
    assert!(matches!(
        second.save("project-one", "save", "changed", 1, &changed),
        Err(EnvironmentError::Conflict)
    ));
    assert_eq!(second.read("project-one").unwrap(), result);
    assert_eq!(
        second
            .receipt("project-one", "save", "request-one")
            .unwrap(),
        Some(result)
    );
    assert!(matches!(
        second.receipt("project-one", "save", "changed"),
        Err(EnvironmentError::Conflict)
    ));
}

#[test]
fn automatic_observations_survive_reopen_without_rewriting_user_acceptance_or_receipts() {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("state.sqlite");
    let store = SqliteEnvironmentStore::open(&path).unwrap();
    let observation = guardian_environment::EnvironmentEntry {
        id: "source".into(),
        kind: guardian_environment::EntryKind::Fact,
        title: "ASH.md".into(),
        content: "Use pnpm test".into(),
        accepted: false,
        current: true,
        source: guardian_environment::EnvironmentSource {
            id: "source".into(),
            kind: guardian_environment::SourceKind::ProjectFile,
            label: "ASH.md".into(),
            revision: "version".into(),
        },
    };
    assert_eq!(
        store
            .refresh("unprepared", 0, &[observation.clone()])
            .unwrap()
            .revision,
        0
    );
    let committed = store
        .save(
            "project",
            "prepare",
            "request",
            0,
            &EnvironmentProfile::default(),
        )
        .unwrap();
    let updated = store.refresh("project", 1, &[observation.clone()]).unwrap();
    assert_eq!(updated.revision, 2);
    assert_eq!(
        store.refresh("project", 2, &[observation.clone()]).unwrap(),
        updated
    );
    // A stale observer must not restore sources after another connection changes the selection.
    let other = SqliteEnvironmentStore::open(&path).unwrap();
    let removed = other
        .save(
            "project",
            "exclude",
            "exclude-request",
            2,
            &EnvironmentProfile::default(),
        )
        .unwrap();
    assert!(matches!(
        store.refresh("project", 2, &[observation]),
        Err(EnvironmentError::Conflict)
    ));
    assert_eq!(store.read("project").unwrap(), removed);
    assert!(updated.entries.is_empty());
    drop(store);
    let reopened = SqliteEnvironmentStore::open(&path).unwrap();
    assert_eq!(reopened.read("project").unwrap(), removed);
    assert_eq!(
        reopened.receipt("project", "prepare", "request").unwrap(),
        Some(committed)
    );
}

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

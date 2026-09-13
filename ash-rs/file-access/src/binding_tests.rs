use super::*;

#[test]
fn binding_freezes_canonical_directory_identity() {
    let directory = tempfile::tempdir().unwrap();
    let root = Dir::open_local(directory.path()).unwrap();

    let binding = DirBinding::from_dir(&root);

    assert_eq!(binding.path(), root.canonical_path());
    assert_eq!(binding.id, root.id());
    assert!(binding.matches(&root));
}

#[test]
fn binding_rejects_another_directory() {
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let first = Dir::open_local(first.path()).unwrap();
    let second = Dir::open_local(second.path()).unwrap();

    assert!(!DirBinding::from_dir(&first).matches(&second));
}

#[test]
fn replacing_a_directory_invalidates_its_binding_and_authorization() {
    let parent = tempfile::tempdir().unwrap();
    let path = parent.path().join("root");
    std::fs::create_dir(&path).unwrap();
    let dir = Dir::open_local(&path).unwrap();
    let binding = DirBinding::from_dir(&dir);
    let grant = crate::Grant::for_environment(
        dir.clone(),
        crate::GrantSource::ExplicitUser,
        crate::Permissions::new([crate::Permission::ReadFiles]),
    );
    let authorization = grant.authorize(crate::Permission::ReadFiles).unwrap();
    std::fs::rename(&path, parent.path().join("old")).unwrap();
    std::fs::create_dir(&path).unwrap();
    std::fs::write(path.join("new.txt"), "new").unwrap();
    let replacement = Dir::open_local(&path).unwrap();
    assert!(!binding.matches(&replacement));
    assert!(!binding.matches(&dir));
    assert!(authorization.ensure_active().is_err());
    assert!(dir.resolve_existing("new.txt").is_err());
}

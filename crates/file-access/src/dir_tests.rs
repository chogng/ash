use super::*;
use std::fs;

#[test]
fn opens_a_directory_with_absolute_namespaces() {
    let directory = tempfile::tempdir().unwrap();
    let root = Dir::open_local(directory.path()).unwrap();

    assert!(root.requested_path().is_absolute());
    assert!(root.canonical_path().is_absolute());
}

#[test]
fn normalizes_parent_segments_in_the_requested_namespace() {
    let directory = tempfile::tempdir().unwrap();
    let nested = directory.path().join("nested");
    fs::create_dir(&nested).unwrap();

    let root = Dir::open_local(nested.join("../nested")).unwrap();

    assert_eq!(root.requested_path(), nested);
    assert_eq!(
        root.project_observed_path(nested.join("created.txt")),
        Some(PathBuf::from("created.txt"))
    );
}

#[test]
#[cfg(unix)]
fn canonicalizes_the_original_spelling_rather_than_the_lexical_alias() {
    let linked = tempfile::tempdir().unwrap();
    let sibling = linked.path().join("sibling");
    let target = linked.path().join("target");
    fs::create_dir(&sibling).unwrap();
    fs::create_dir(&target).unwrap();
    let directory = tempfile::tempdir().unwrap();
    let link = directory.path().join("link");
    create_directory_symlink(&target, &link);

    let root = Dir::open_local(link.join("../sibling")).unwrap();

    assert_eq!(
        root.canonical_path(),
        dunce::canonicalize(&sibling).unwrap()
    );
}

#[test]
fn rejects_files_as_directory_roots() {
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("file.txt");
    fs::write(&file, "not a directory").unwrap();

    assert!(matches!(
        Dir::open_local(&file),
        Err(DirPathError::RootNotDirectory(path)) if path == dunce::canonicalize(&file).unwrap()
    ));
}

#[test]
fn rejects_parent_directory_before_resolving_a_write_target() {
    let directory = tempfile::tempdir().unwrap();
    let root = Dir::open_local(directory.path()).unwrap();

    assert_eq!(
        root.resolve_for_write("../outside.txt"),
        Err(DirPathError::InvalidRelativePath("../outside.txt".into()))
    );
}

#[test]
#[cfg(unix)]
fn rejects_existing_symlink_that_leaves_the_directory() {
    let directory = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    create_directory_symlink(outside.path(), &directory.path().join("escape"));
    let root = Dir::open_local(directory.path()).unwrap();

    assert!(matches!(
        root.resolve_existing("escape"),
        Err(DirPathError::OutsideDir(path)) if path == dunce::canonicalize(outside.path()).unwrap()
    ));
}

#[test]
#[cfg(unix)]
fn projects_requested_and_canonical_observer_namespaces() {
    let directory = tempfile::tempdir().unwrap();
    let alias_parent = tempfile::tempdir().unwrap();
    let alias = alias_parent.path().join("dir-alias");
    create_directory_symlink(directory.path(), &alias);
    let root = Dir::open_local(&alias).unwrap();

    assert_eq!(
        root.project_observed_path(alias.join("removed.txt")),
        Some(PathBuf::from("removed.txt"))
    );
    assert_eq!(
        root.project_observed_path(
            dunce::canonicalize(directory.path())
                .unwrap()
                .join("created.txt")
        ),
        Some(PathBuf::from("created.txt"))
    );
}

#[cfg(unix)]
fn create_directory_symlink(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}

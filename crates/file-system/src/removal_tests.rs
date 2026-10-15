use super::*;

#[test]
fn reviewed_removal_refuses_changed_content_and_escaping_paths() {
    let root = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(root.path()).unwrap();
    std::fs::write(root.path().join("kept.txt"), b"reviewed").unwrap();
    let entries = review_file_removals(&dir, &["kept.txt".into()]).unwrap();
    std::fs::write(root.path().join("kept.txt"), b"new user content").unwrap();
    assert!(remove_reviewed_files(&dir, &entries, FileRemovalMode::Permanent).is_err());
    assert_eq!(
        std::fs::read(root.path().join("kept.txt")).unwrap(),
        b"new user content"
    );
    assert!(review_file_removals(&dir, &["../outside".into()]).is_err());
    assert!(review_file_removals(&dir, &[root.path().to_owned()]).is_err());
    assert!(review_file_removals(&dir, &["kept.txt".into(), "kept.txt".into()]).is_err());
}

#[test]
fn a_failed_recycle_operation_restores_files_without_permanent_fallback() {
    let root = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(root.path()).unwrap();
    std::fs::create_dir(root.path().join("nested")).unwrap();
    std::fs::write(root.path().join("nested/file.txt"), b"recover me").unwrap();
    let entries = review_file_removals(&dir, &["nested/file.txt".into()]).unwrap();
    let result = remove_using(&dir, &entries, |staging| {
        assert_eq!(
            std::fs::read(staging.join("0/file.txt")).unwrap(),
            b"recover me"
        );
        Err(io::Error::other("recycle bin unavailable"))
    });
    assert!(result.is_err());
    assert_eq!(
        std::fs::read(root.path().join("nested/file.txt")).unwrap(),
        b"recover me"
    );
    remove_reviewed_files(&dir, &entries, FileRemovalMode::Permanent).unwrap();
    assert!(!root.path().join("nested/file.txt").exists());
}

#[test]
fn recovery_preserves_a_concurrent_replacement_in_the_original_location() {
    let root = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(root.path()).unwrap();
    std::fs::write(root.path().join("file.txt"), b"old").unwrap();
    let entries = review_file_removals(&dir, &["file.txt".into()]).unwrap();
    let result = remove_using(&dir, &entries, |_| {
        std::fs::write(root.path().join("file.txt"), b"new").unwrap();
        Err(io::Error::other("recycle failed"))
    });
    assert!(result.is_err());
    assert_eq!(std::fs::read(root.path().join("file.txt")).unwrap(), b"new");
    let staging = std::fs::read_dir(root.path())
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.is_dir())
        .unwrap();
    assert_eq!(std::fs::read(staging.join("0/file.txt")).unwrap(), b"old");
}

#[cfg(unix)]
#[test]
fn symlink_removal_does_not_follow_the_leaf_or_a_parent_outside_the_directory() {
    let root = tempfile::tempdir().unwrap();
    let outside = tempfile::tempdir().unwrap();
    let dir = Dir::open_local(root.path()).unwrap();
    std::fs::write(outside.path().join("target"), b"outside").unwrap();
    std::os::unix::fs::symlink(outside.path().join("target"), root.path().join("link")).unwrap();
    std::os::unix::fs::symlink(outside.path(), root.path().join("parent")).unwrap();
    assert!(review_file_removals(&dir, &["parent/target".into()]).is_err());
    let entries = review_file_removals(&dir, &["link".into()]).unwrap();
    remove_reviewed_files(&dir, &entries, FileRemovalMode::Permanent).unwrap();
    assert!(std::fs::symlink_metadata(root.path().join("link")).is_err());
    assert_eq!(
        std::fs::read(outside.path().join("target")).unwrap(),
        b"outside"
    );
}

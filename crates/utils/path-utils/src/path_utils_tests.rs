use super::*;
use pretty_assertions::assert_eq;
#[cfg(any(windows, target_os = "linux"))]
use std::path::PathBuf;

#[test]
fn canonical_path_root_accepts_existing_descendants() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let child = directory.path().join("nested").join("item");
    std::fs::create_dir_all(&child).expect("nested directory");
    let root = CanonicalPathRoot::new(directory.path()).expect("canonical root");

    assert_eq!(
        root.canonicalize_within(&child)
            .expect("contained canonical path"),
        child.canonicalize().expect("canonical child")
    );
}

#[test]
fn canonical_path_root_reports_unavailable_candidates() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let root = CanonicalPathRoot::new(directory.path()).expect("canonical root");

    assert!(matches!(
        root.canonicalize_within(directory.path().join("missing")),
        Err(CanonicalContainmentError::Unavailable(error))
            if error.kind() == std::io::ErrorKind::NotFound
    ));
}

#[test]
fn canonical_path_root_inspects_existing_and_missing_paths_without_symlinks() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let existing = directory.path().join("nested").join("item");
    std::fs::create_dir_all(&existing).expect("nested directory");
    let root = CanonicalPathRoot::new(directory.path()).expect("canonical root");

    assert_eq!(
        root.inspect_without_symlinks(&existing)
            .expect("existing path inspection"),
        NoSymlinkPathStatus::Existing
    );
    assert_eq!(
        root.inspect_without_symlinks(directory.path().join("missing/item"))
            .expect("missing path inspection"),
        NoSymlinkPathStatus::Missing
    );
}

#[test]
fn canonical_path_root_rejects_lexical_parent_escape_without_filesystem_access() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let root = CanonicalPathRoot::new(directory.path()).expect("canonical root");

    assert!(matches!(
        root.inspect_without_symlinks(directory.path().join("nested/../../outside")),
        Err(NoSymlinkPathError::OutsideRoot(_))
    ));
}

#[cfg(unix)]
#[test]
fn canonical_path_root_rejects_any_ancestor_symlink_without_following_it() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().expect("temporary directory");
    let target = directory.path().join("target");
    let target_item = target.join("item");
    std::fs::create_dir_all(&target_item).expect("target item");
    let alias = directory.path().join("alias");
    symlink(&target, &alias).expect("ancestor symlink");
    let root = CanonicalPathRoot::new(directory.path()).expect("canonical root");

    assert!(matches!(
        root.inspect_without_symlinks(alias.join("item")),
        Err(NoSymlinkPathError::Symlink(path)) if path == alias
    ));
}

#[cfg(unix)]
#[test]
fn canonical_path_root_rejects_ancestor_symlink_escape() {
    use std::os::unix::fs::symlink;

    let directory = tempfile::tempdir().expect("temporary directory");
    let outside = tempfile::tempdir().expect("outside directory");
    let outside_item = outside.path().join("item");
    std::fs::create_dir(&outside_item).expect("outside item");
    let alias = directory.path().join("alias");
    symlink(outside.path(), &alias).expect("ancestor symlink");
    let root = CanonicalPathRoot::new(directory.path()).expect("canonical root");

    assert!(matches!(
        root.canonicalize_within(alias.join("item")),
        Err(CanonicalContainmentError::OutsideRoot)
    ));
}

#[test]
fn atomic_write_replaces_existing_contents() {
    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory.path().join("nested").join("state.json");
    write_atomically(&path, b"first").expect("initial write");
    write_atomically(&path, b"second").expect("replacement write");

    assert_eq!(std::fs::read_to_string(path).unwrap(), "second");
}

#[cfg(windows)]
#[test]
fn atomic_write_creates_and_replaces_a_file_beyond_max_path() {
    use std::os::windows::ffi::OsStrExt;

    let directory = tempfile::tempdir().expect("temporary directory");
    let path = directory
        .path()
        .join("a".repeat(110))
        .join("b".repeat(110))
        .join("state.json");
    assert!(path.as_os_str().encode_wide().count() >= 260);

    write_atomically(&path, b"first").expect("initial long-path write");
    write_atomically(&path, b"second").expect("long-path replacement");

    let filesystem_path = persistence::filesystem_path(&path).unwrap();
    assert_eq!(std::fs::read_to_string(filesystem_path).unwrap(), "second");
    let directory_to_remove =
        persistence::filesystem_path(&directory.path().join("a".repeat(110))).unwrap();
    std::fs::remove_dir_all(directory_to_remove).unwrap();
}

#[cfg(windows)]
#[test]
fn filesystem_path_converts_unc_without_losing_components() {
    let path = std::path::Path::new(r"\\server\share\folder\file.txt");

    assert_eq!(
        persistence::filesystem_path(path).unwrap(),
        PathBuf::from(r"\\?\UNC\server\share\folder\file.txt")
    );
}

#[cfg(target_os = "linux")]
#[test]
fn wsl_drive_mounts_are_ascii_lowercased() {
    assert_eq!(
        canonical_root::normalize_for_wsl_on(PathBuf::from("/mnt/C/Users/Dev"), true),
        PathBuf::from("/mnt/c/users/dev")
    );
    assert_eq!(
        canonical_root::normalize_for_wsl_on(PathBuf::from("/home/Dev"), true),
        PathBuf::from("/home/Dev")
    );
}

#[cfg(unix)]
#[test]
fn atomic_replacement_preserves_existing_permissions() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("script");
    std::fs::write(&path, "old").unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o751)).unwrap();
    write_atomically(&path, b"new").unwrap();
    assert_eq!(std::fs::read_to_string(&path).unwrap(), "new");
    assert_eq!(
        std::fs::metadata(&path).unwrap().permissions().mode() & 0o777,
        0o751
    );
}

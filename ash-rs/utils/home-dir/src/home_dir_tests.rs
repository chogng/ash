use std::ffi::OsStr;
use std::fs;
use std::io::ErrorKind;
use std::path::Path;

use super::resolve_from;
use super::resolve_path;

#[test]
fn explicit_and_default_roots_share_one_directory_identity() {
    let user = tempfile::tempdir().unwrap();
    let root = user.path().join(".ash");
    fs::create_dir(&root).unwrap();
    let explicit = resolve_from(Some(root.as_os_str()), None, None).unwrap();
    assert_eq!(
        explicit,
        resolve_from(None, None, Some(user.path())).unwrap()
    );
    assert_eq!(explicit, dunce::canonicalize(root).unwrap());
}

#[test]
fn missing_directories_are_resolved_without_creating_them() {
    let user = tempfile::tempdir().unwrap();
    let root = user.path().join("new/data");
    let result = resolve_from(Some(root.as_os_str()), None, None).unwrap();
    assert_eq!(
        result,
        dunce::canonicalize(user.path()).unwrap().join("new/data")
    );
    assert!(!root.exists());
    assert_eq!(
        resolve_from(None, None, Some(user.path())).unwrap(),
        dunce::canonicalize(user.path()).unwrap().join(".ash")
    );
}

#[test]
fn invalid_overrides_do_not_select_a_different_root() {
    let user = tempfile::tempdir().unwrap();
    for invalid in ["", "relative"] {
        assert_eq!(
            resolve_from(Some(OsStr::new(invalid)), None, Some(user.path()))
                .unwrap_err()
                .kind(),
            ErrorKind::InvalidInput
        );
    }
    let file = user.path().join("file");
    fs::write(&file, b"keep").unwrap();
    assert_eq!(
        resolve_path(&file).unwrap_err().kind(),
        ErrorKind::NotADirectory
    );
    assert!(resolve_path(&file.join("data")).is_err());
    assert_eq!(fs::read(file).unwrap(), b"keep");
}

#[test]
fn missing_user_home_never_uses_the_working_directory() {
    assert_eq!(
        resolve_from(None, None, None).unwrap_err().kind(),
        ErrorKind::NotFound
    );
    assert!(resolve_from(None, None, Some(Path::new("relative"))).is_err());
}

#[cfg(windows)]
#[test]
fn root_relative_paths_cannot_select_the_current_drive() {
    for path in [r"\folder", "/folder", r"C:folder", r"\\server"] {
        assert_eq!(
            resolve_path(Path::new(path)).unwrap_err().kind(),
            ErrorKind::InvalidInput
        );
    }
}

#[test]
fn retired_override_requires_explicit_environment_migration() {
    let user = tempfile::tempdir().unwrap();
    for configured in [None, Some(user.path().as_os_str())] {
        let error =
            resolve_from(configured, Some(user.path().as_os_str()), Some(user.path())).unwrap_err();
        assert!(error.to_string().contains("remove ASH_PROFILE_ROOT"));
    }
}

#[cfg(unix)]
#[test]
fn links_resolve_before_missing_children_and_dangling_links_fail() {
    let user = tempfile::tempdir().unwrap();
    let real = user.path().join("real");
    fs::create_dir(&real).unwrap();
    let alias = user.path().join("alias");
    std::os::unix::fs::symlink(&real, &alias).unwrap();
    assert_eq!(
        resolve_path(&alias.join("new")).unwrap(),
        dunce::canonicalize(real).unwrap().join("new")
    );
    let dangling = user.path().join("dangling");
    std::os::unix::fs::symlink(user.path().join("absent"), &dangling).unwrap();
    assert!(resolve_path(&dangling).is_err());
    assert!(resolve_path(&dangling.join("new")).is_err());
}

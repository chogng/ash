use super::check_legacy_home;

#[test]
fn first_run_has_no_legacy_migration() {
    let user = tempfile::tempdir().unwrap();
    let root = user.path().join(".ash");
    check_legacy_home(&root, None).unwrap();
    check_legacy_home(&root, Some(&user.path().join("old"))).unwrap();
    assert!(!root.exists());
}

#[test]
fn legacy_data_requires_explicit_selection_even_when_new_home_exists() {
    let user = tempfile::tempdir().unwrap();
    let root = user.path().join(".ash");
    let legacy = user.path().join("old");
    std::fs::create_dir(&legacy).unwrap();
    std::fs::write(legacy.join("state"), b"remote history").unwrap();
    for has_root in [false, true] {
        if has_root {
            std::fs::create_dir(&root).unwrap();
        }
        let error = check_legacy_home(&root, Some(&legacy)).unwrap_err();
        assert!(
            error
                .to_string()
                .contains("Set ASH_HOME on the remote host")
        );
        assert_eq!(
            std::fs::read(legacy.join("state")).unwrap(),
            b"remote history"
        );
        assert!(!root.join("state").exists());
    }
}

#[cfg(unix)]
#[test]
fn already_migrated_directory_alias_is_the_same_home() {
    let user = tempfile::tempdir().unwrap();
    let root = ash_utils_home_dir::resolve_path(user.path()).unwrap();
    let legacy_parent = tempfile::tempdir().unwrap();
    let legacy = legacy_parent.path().join("old");
    std::os::unix::fs::symlink(&root, &legacy).unwrap();
    check_legacy_home(&root, Some(&legacy)).unwrap();
}

use super::available;
use super::environment;
use std::collections::BTreeSet;

#[test]
fn detects_only_catalog_names_without_executing_files() {
    let directory = tempfile::tempdir().unwrap();
    let name = if cfg!(windows) {
        "python.exe"
    } else {
        "python"
    };
    let path = directory.path().join(name);
    std::fs::write(&path, "this is deliberately not a runnable program").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
    }
    let path = std::env::join_paths([directory.path()]).unwrap();
    assert_eq!(
        available(&BTreeSet::from(["python".into(), "missing".into()]), &path),
        vec!["python"]
    );
}

#[cfg(unix)]
#[test]
fn ignores_non_executable_files_and_relative_path_entries() {
    use std::os::unix::fs::PermissionsExt;
    let directory = tempfile::tempdir().unwrap();
    let file = directory.path().join("python");
    std::fs::write(&file, "not executable").unwrap();
    std::fs::set_permissions(file, std::fs::Permissions::from_mode(0o600)).unwrap();
    let path = std::env::join_paths([directory.path(), std::path::Path::new(".")]).unwrap();
    assert!(available(&BTreeSet::from(["python".into()]), &path).is_empty());
}

#[test]
fn product_catalog_has_an_allowlisted_path_free_environment_projection() {
    let snapshot = environment();
    assert!(
        snapshot
            .executables
            .iter()
            .all(|name| !name.contains('/') && !name.contains('\\'))
    );
    assert!(snapshot.executables.len() <= 7);
}

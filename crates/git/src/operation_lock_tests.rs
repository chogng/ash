use super::*;
use std::process::Command;

#[test]
fn process_contender() {
    let Some(root) = std::env::var_os("ASH_TEST_REPOSITORY_LOCK") else {
        return;
    };
    let lock = RepositoryOperationLock {
        repository: PathBuf::from(&root),
        local: Mutex::new(()),
    };
    let result = match lock.try_lock() {
        Ok(_) => "acquired",
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => "blocked",
        Err(error) => panic!("lock failed: {error}"),
    };
    std::fs::write(PathBuf::from(root).join("result"), result).unwrap();
}

#[test]
fn operations_coordinate_across_processes_without_repository_metadata() {
    let root = tempfile::tempdir().unwrap();
    let path = dunce::canonicalize(root.path()).unwrap();
    let lock = RepositoryOperationLock {
        repository: path.clone(),
        local: Mutex::new(()),
    };
    let contender = || {
        let output = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "operation_lock::tests::process_contender"])
            .env("ASH_TEST_REPOSITORY_LOCK", &path)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
        std::fs::read_to_string(path.join("result")).unwrap()
    };
    let held = lock.lock().unwrap();
    assert_eq!(contender(), "blocked");
    drop(held);
    assert_eq!(contender(), "acquired");
    assert_eq!(std::fs::read_dir(&path).unwrap().count(), 1);
}

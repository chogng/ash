use super::*;
use std::process::Command;

#[test]
fn process_contender() {
    let Some(root) = std::env::var_os("ASH_TEST_REPOSITORY_LOCK") else {
        return;
    };
    let lock = RepositoryOperationLock {
        repository: PathBuf::from(&root),
        local: RwLock::new(()),
        writers: Mutex::new(VecDeque::new()),
    };
    let result = match if std::env::var_os("ASH_TEST_READ_LOCK").is_some() {
        lock.try_read().map(drop)
    } else {
        lock.try_lock().map(drop)
    } {
        Ok(_) => "acquired",
        Err(error) if error.kind() == io::ErrorKind::WouldBlock => "blocked",
        Err(error) => panic!("lock failed: {error}"),
    };
    std::fs::write(PathBuf::from(root).join("result"), result).unwrap();
}

#[test]
fn observations_overlap_but_exclude_writers_in_other_processes() {
    let root = tempfile::tempdir().unwrap();
    let path = dunce::canonicalize(root.path()).unwrap();
    let lock = RepositoryOperationLock {
        repository: path.clone(),
        local: RwLock::new(()),
        writers: Mutex::new(VecDeque::new()),
    };
    let contender = |read: bool| {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command.args(["--exact", "operation_lock::tests::process_contender"]);
        command.env("ASH_TEST_REPOSITORY_LOCK", &path);
        if read {
            command.env("ASH_TEST_READ_LOCK", "1");
        }
        assert!(command.status().unwrap().success());
        std::fs::read_to_string(path.join("result")).unwrap()
    };
    let first = lock.try_read().unwrap();
    let second = lock.try_read().unwrap();
    assert_eq!(
        lock.try_lock().err().unwrap().kind(),
        io::ErrorKind::WouldBlock
    );
    assert_eq!(contender(true), "acquired");
    assert_eq!(contender(false), "blocked");
    drop((first, second));
    let writer = lock.lock().unwrap();
    assert_eq!(contender(true), "blocked");
    drop(writer);
    assert_eq!(contender(false), "acquired");
}

#[test]
fn operations_coordinate_across_processes_without_repository_metadata() {
    let root = tempfile::tempdir().unwrap();
    let path = dunce::canonicalize(root.path()).unwrap();
    let lock = RepositoryOperationLock {
        repository: path.clone(),
        local: RwLock::new(()),
        writers: Mutex::new(VecDeque::new()),
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

#[test]
fn queued_writers_precede_later_readers_and_cancelled_waiters_release_admission() {
    let root = tempfile::tempdir().unwrap();
    let lock = RepositoryOperationLock {
        repository: dunce::canonicalize(root.path()).unwrap(),
        local: RwLock::new(()),
        writers: Mutex::new(VecDeque::new()),
    };
    let reader = lock.try_read().unwrap();
    let cancelled = lock.queue_write().unwrap();
    let first = lock.queue_write().unwrap();
    let second = lock.queue_write().unwrap();
    for _ in 0..1000 {
        assert_eq!(
            lock.try_read().err().unwrap().kind(),
            io::ErrorKind::WouldBlock
        );
        assert_eq!(
            first.try_lock().err().unwrap().kind(),
            io::ErrorKind::WouldBlock
        );
    }
    drop((reader, cancelled));
    assert_eq!(
        second.try_lock().err().unwrap().kind(),
        io::ErrorKind::WouldBlock
    );
    let writer = first.try_lock().unwrap();
    assert_eq!(
        lock.try_read().err().unwrap().kind(),
        io::ErrorKind::WouldBlock
    );
    drop((writer, first));
    let writer = second.try_lock().unwrap();
    drop((writer, second));
    assert!(lock.try_read().is_ok());
}

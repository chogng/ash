use std::fs;
use std::process::Command;
use std::str::FromStr;
use std::time::Duration;

use ash_file_access::DirId;
use tempfile::TempDir;

use super::{ClearOutcome, DirIndexKind, StateRuntime};

fn dir_id(byte: char) -> DirId {
    DirId::from_str(&format!("sha256:{}", byte.to_string().repeat(64))).unwrap()
}

#[test]
fn uses_one_cache_directory_per_dir() {
    let profile = TempDir::new().unwrap();
    let storage = StateRuntime::open(profile.path()).unwrap();
    let dir = dir_id('a');

    let lease = storage.acquire(&dir, DirIndexKind::Grep).unwrap();

    assert_eq!(
        lease.directory(),
        storage
            .profile_root()
            .join("cache/dirs")
            .join("a".repeat(64))
            .join("indexes/grep")
    );
    assert!(
        storage
            .profile_root()
            .join("cache/locks/indexes.lock")
            .is_file()
    );
    assert!(
        storage
            .profile_root()
            .join("cache/locks/dirs")
            .join("a".repeat(64))
            .join("grep.lock")
            .is_file()
    );
}

#[test]
fn clear_index_waits_for_users_and_is_idempotent() {
    let profile = TempDir::new().unwrap();
    let storage = StateRuntime::open(profile.path()).unwrap();
    let dir = dir_id('b');
    let lease = storage.acquire(&dir, DirIndexKind::Codebase).unwrap();
    fs::write(lease.directory().join("index.sqlite3"), b"index").unwrap();

    assert_eq!(
        storage.clear_index(&dir, DirIndexKind::Codebase).unwrap(),
        ClearOutcome::InUse
    );
    drop(lease);
    assert_eq!(
        storage.clear_index(&dir, DirIndexKind::Codebase).unwrap(),
        ClearOutcome::Cleared
    );
    assert_eq!(
        storage.clear_index(&dir, DirIndexKind::Codebase).unwrap(),
        ClearOutcome::AlreadyAbsent
    );
}

#[test]
fn clear_dir_is_atomic_across_index_kinds() {
    let profile = TempDir::new().unwrap();
    let storage = StateRuntime::open(profile.path()).unwrap();
    let dir = dir_id('c');
    let lexical = storage.acquire(&dir, DirIndexKind::Codebase).unwrap();
    let symbols = storage.acquire(&dir, DirIndexKind::Grep).unwrap();
    fs::write(lexical.directory().join("index.sqlite3"), b"lexical").unwrap();
    fs::write(symbols.directory().join("index.sqlite3"), b"symbols").unwrap();

    assert_eq!(storage.clear_dir(&dir).unwrap(), ClearOutcome::InUse);
    drop(lexical);
    drop(symbols);
    assert_eq!(storage.clear_dir(&dir).unwrap(), ClearOutcome::Cleared);
}

#[test]
fn clear_all_does_not_remove_an_open_dir() {
    let profile = TempDir::new().unwrap();
    let storage = StateRuntime::open(profile.path()).unwrap();
    let dir = dir_id('d');
    let lease = storage.acquire(&dir, DirIndexKind::Codebase).unwrap();

    assert_eq!(storage.clear_all().unwrap(), ClearOutcome::InUse);
    drop(lease);
    assert_eq!(storage.clear_all().unwrap(), ClearOutcome::Cleared);
    assert!(profile.path().join("cache/dirs").is_dir());
}

#[test]
fn a_cross_process_lease_blocks_explicit_deletion() {
    let profile = TempDir::new().unwrap();
    let coordination = TempDir::new().unwrap();
    let ready = coordination.path().join("ready");
    let release = coordination.path().join("release");
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            "dir_index::tests::cross_process_lease_child",
            "--nocapture",
        ])
        .env("ASH_INDEX_LOCK_TEST_ROOT", profile.path())
        .env("ASH_INDEX_LOCK_TEST_READY", &ready)
        .env("ASH_INDEX_LOCK_TEST_RELEASE", &release)
        .spawn()
        .unwrap();
    wait_for_path(&ready);

    let storage = StateRuntime::open(profile.path()).unwrap();
    assert_eq!(
        storage
            .clear_index(&dir_id('f'), DirIndexKind::Grep)
            .unwrap(),
        ClearOutcome::InUse
    );

    fs::write(&release, []).unwrap();
    assert!(child.wait().unwrap().success());
    assert_eq!(
        storage
            .clear_index(&dir_id('f'), DirIndexKind::Grep)
            .unwrap(),
        ClearOutcome::Cleared
    );
}

#[test]
fn cross_process_lease_child() {
    let Some(profile) = std::env::var_os("ASH_INDEX_LOCK_TEST_ROOT") else {
        return;
    };
    let storage = StateRuntime::open(profile).unwrap();
    let _lease = storage.acquire(&dir_id('f'), DirIndexKind::Grep).unwrap();
    fs::write(std::env::var_os("ASH_INDEX_LOCK_TEST_READY").unwrap(), []).unwrap();
    let release =
        std::path::PathBuf::from(std::env::var_os("ASH_INDEX_LOCK_TEST_RELEASE").unwrap());
    wait_for_path(&release);
}

fn wait_for_path(path: &std::path::Path) {
    for _ in 0..500 {
        if path.exists() {
            return;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    panic!("timed out waiting for {}", path.display());
}

#[cfg(unix)]
#[test]
fn refuses_to_follow_a_symlink_during_clear() {
    use std::os::unix::fs::symlink;

    let profile = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    let storage = StateRuntime::open(profile.path()).unwrap();
    let dir = dir_id('e');
    let index_directory = storage.index_directory(&dir, DirIndexKind::Grep);
    fs::create_dir_all(index_directory.parent().unwrap()).unwrap();
    symlink(outside.path(), &index_directory).unwrap();

    let error = storage.clear_index(&dir, DirIndexKind::Grep).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    assert!(outside.path().is_dir());
}

#[cfg(unix)]
#[test]
fn refuses_to_follow_an_ancestor_symlink_during_clear() {
    use std::os::unix::fs::symlink;

    let profile = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    let storage = StateRuntime::open(profile.path()).unwrap();
    let dir = dir_id('9');
    fs::remove_dir(&storage.dirs_root).unwrap();
    symlink(outside.path(), &storage.dirs_root).unwrap();
    let outside_index = outside.path().join("9".repeat(64)).join("indexes/grep");
    fs::create_dir_all(&outside_index).unwrap();
    fs::write(outside_index.join("sentinel"), b"outside").unwrap();

    let error = storage.clear_index(&dir, DirIndexKind::Grep).unwrap_err();

    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    assert_eq!(
        fs::read(outside_index.join("sentinel")).unwrap(),
        b"outside"
    );
}

#[cfg(unix)]
#[test]
fn refuses_to_follow_an_ancestor_symlink_during_acquire() {
    use std::os::unix::fs::symlink;

    let profile = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    let storage = StateRuntime::open(profile.path()).unwrap();
    fs::remove_dir(&storage.dirs_root).unwrap();
    symlink(outside.path(), &storage.dirs_root).unwrap();

    let error = storage
        .acquire(&dir_id('8'), DirIndexKind::Codebase)
        .unwrap_err();

    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    assert!(fs::read_dir(outside.path()).unwrap().next().is_none());
}

#[cfg(unix)]
#[test]
fn refuses_to_open_a_symlinked_lock_file() {
    use std::os::unix::fs::symlink;

    let profile = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    let storage = StateRuntime::open(profile.path()).unwrap();
    let outside_lock = outside.path().join("outside.lock");
    fs::write(&outside_lock, b"outside").unwrap();
    symlink(
        &outside_lock,
        storage.locks_root.join(super::GLOBAL_LOCK_FILE),
    )
    .unwrap();

    let error = storage.clear_all().unwrap_err();

    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    assert_eq!(fs::read(outside_lock).unwrap(), b"outside");
}

#[cfg(unix)]
#[test]
fn open_rejects_a_symlinked_cache_root_before_creating_state_directories() {
    use std::os::unix::fs::symlink;

    let profile = TempDir::new().unwrap();
    let outside = TempDir::new().unwrap();
    symlink(outside.path(), profile.path().join("cache")).unwrap();

    let error = StateRuntime::open(profile.path()).unwrap_err();

    assert_eq!(error.kind(), std::io::ErrorKind::InvalidData);
    assert!(!outside.path().join("locks").exists());
    assert!(!outside.path().join("dirs").exists());
}

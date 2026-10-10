use std::fs;
use std::fs::OpenOptions;

use super::select_runtime;

fn generation(root: &std::path::Path, digest: &str) -> std::path::PathBuf {
    let runtime = root.join("generations").join(digest);
    for name in ["bin", "ash-path", "ash-resources"] {
        fs::create_dir_all(runtime.join(name)).unwrap();
    }
    for name in [
        ".lease",
        "ash-development.json",
        if cfg!(windows) {
            "bin/ash-app-server.exe"
        } else {
            "bin/ash-app-server"
        },
        if cfg!(windows) {
            "bin/ash-app-server-daemon.exe"
        } else {
            "bin/ash-app-server-daemon"
        },
    ] {
        fs::write(runtime.join(name), b"").unwrap();
    }
    fs::write(root.join("publish.lock"), b"").unwrap();
    fs::write(
        root.join("current.json"),
        serde_json::to_vec(
            &serde_json::json!({ "version": 3, "runtime": format!("generations/{digest}") }),
        )
        .unwrap(),
    )
    .unwrap();
    runtime
}

#[test]
fn selection_keeps_a_runtime_leased_after_the_pointer_changes() {
    let root = tempfile::tempdir().unwrap();
    let first = generation(root.path(), &"a".repeat(64));
    let selected = select_runtime(&root.path().join("current.json")).unwrap();
    generation(root.path(), &"b".repeat(64));
    let lease = OpenOptions::new()
        .read(true)
        .write(true)
        .open(first.join(".lease"))
        .unwrap();
    assert_eq!(selected.root, first);
    assert!(matches!(
        lease.try_lock(),
        Err(std::fs::TryLockError::WouldBlock)
    ));
    // Selection releases publish.lock, so a publisher can commit another generation.
    let publication = OpenOptions::new()
        .read(true)
        .write(true)
        .open(root.path().join("publish.lock"))
        .unwrap();
    lock_after_inherited_handles_close(&publication);
    drop(selected);
    lock_after_inherited_handles_close(&lease);
}

fn lock_after_inherited_handles_close(file: &std::fs::File) {
    // Parallel process tests can fork while the lease is held. The child retains
    // both publication and runtime file descriptions until exec closes them.
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(1);
    loop {
        match file.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) if std::time::Instant::now() < deadline => {
                std::thread::sleep(std::time::Duration::from_millis(1));
            }
            Err(error) => panic!("released lock remained unavailable: {error}"),
        }
    }
}

#[test]
fn selection_rejects_invalid_pointers_and_incomplete_runtimes() {
    let root = tempfile::tempdir().unwrap();
    let runtime = generation(root.path(), &"a".repeat(64));
    let pointer = root.path().join("current.json");
    for contents in [
        serde_json::json!({ "version": 3, "runtime": "../outside" }).to_string(),
        serde_json::json!({ "version": 2, "runtime": format!("generations/{}", "a".repeat(64)) }).to_string(),
        serde_json::json!({ "version": 3, "runtime": format!("generations/{}", "a".repeat(64)), "extra": true }).to_string(),
        " ".repeat(4_097),
    ] {
        fs::write(&pointer, contents).unwrap();
        assert!(select_runtime(&pointer).is_err());
    }
    generation(root.path(), &"a".repeat(64));
    fs::remove_dir(runtime.join("ash-resources")).unwrap();
    assert!(select_runtime(&pointer).is_err());
    assert!(select_runtime(std::path::Path::new("current.json")).is_err());
}

use super::*;
use serde_json::json;
use std::fs;

fn installation() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    let mut checksums = serde_json::Map::new();
    for path in REQUIRED {
        let file = root.path().join(path);
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, b"published").unwrap();
        checksums.insert(path.into(), json!(checksum(&file).unwrap()));
    }
    fs::write(
        root.path().join("package.json"),
        json!({"checksums": checksums}).to_string(),
    )
    .unwrap();
    root
}

#[test]
fn compares_published_bytes_and_reports_modified_and_missing_files() {
    let root = installation();
    assert!(
        scan(root.path())
            .unwrap()
            .iter()
            .all(|proof| proof.actual.as_ref() == Some(&proof.expected))
    );
    fs::write(root.path().join(REQUIRED[0]), b"modified").unwrap();
    fs::remove_file(root.path().join(REQUIRED[1])).unwrap();
    let proof = scan(root.path()).unwrap();
    assert_eq!(
        proof
            .iter()
            .filter(|proof| proof.actual.as_ref() == Some(&proof.expected))
            .count(),
        1
    );
    assert_eq!(
        proof.iter().filter(|proof| proof.actual.is_none()).count(),
        1
    );
}

#[test]
fn rejects_invalid_manifest_before_accessing_entries() {
    let root = installation();
    let manifest = root.path().join("package.json");
    let original: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest).unwrap()).unwrap();
    for path in [
        "dist/../private",
        "resources//file",
        "dist/C:/file",
        "dist/./file",
        "dist/",
        "private/file",
        "dist/\\file",
    ] {
        let mut value = original.clone();
        value["checksums"][path] = json!("a".repeat(64));
        fs::write(&manifest, value.to_string()).unwrap();
        assert_eq!(
            scan(root.path()).err().unwrap().kind(),
            io::ErrorKind::InvalidData
        );
    }
    for value in [
        json!({}),
        json!({"checksums": {}}),
        json!({"checksums": []}),
    ] {
        fs::write(&manifest, value.to_string()).unwrap();
        assert!(scan(root.path()).is_err());
    }
    fs::write(&manifest, vec![b' '; MAX_MANIFEST as usize + 1]).unwrap();
    assert!(scan(root.path()).is_err());
}

#[test]
fn hashes_binary_data_and_rejects_directories() {
    let root = tempfile::tempdir().unwrap();
    let file = root.path().join("binary");
    fs::write(&file, [0, 255, 128, 1]).unwrap();
    assert_eq!(
        checksum(&file).unwrap(),
        format!("{:x}", Sha256::digest([0, 255, 128, 1]))
    );
    assert!(checksum(root.path()).is_err());
}

#[cfg(unix)]
#[test]
fn rejects_file_and_directory_links_outside_the_installation() {
    use std::os::unix::fs::symlink;

    for directory_link in [false, true] {
        let root = installation();
        let outside = tempfile::tempdir().unwrap();
        let entry = root.path().join(REQUIRED[0]);
        let target = outside.path().join("main.js");
        fs::write(&target, b"published").unwrap();
        if directory_link {
            fs::remove_dir_all(entry.parent().unwrap()).unwrap();
            symlink(outside.path(), entry.parent().unwrap()).unwrap();
        } else {
            fs::remove_file(&entry).unwrap();
            symlink(target, &entry).unwrap();
        }
        assert!(
            scan(root.path()).is_err(),
            "must not hash outside the installation"
        );
    }
}

#[cfg(unix)]
#[test]
fn rejects_a_manifest_link_outside_the_installation() {
    use std::os::unix::fs::symlink;

    let root = installation();
    let outside = tempfile::tempdir().unwrap();
    let manifest = root.path().join("package.json");
    let target = outside.path().join("package.json");
    fs::rename(&manifest, &target).unwrap();
    symlink(target, &manifest).unwrap();
    assert!(scan(root.path()).is_err());
}

#[cfg(unix)]
#[test]
fn rejects_pipes_without_waiting_for_a_writer() {
    use std::process::Command;
    use std::sync::mpsc;
    use std::time::Duration;

    let root = installation();
    let file = root.path().join(REQUIRED[0]);
    fs::remove_file(&file).unwrap();
    assert!(
        Command::new("mkfifo")
            .arg(&file)
            .status()
            .unwrap()
            .success()
    );
    let (sender, receiver) = mpsc::channel();
    let path = root.path().to_owned();
    std::thread::spawn(move || sender.send(scan(&path)).unwrap());
    assert!(
        receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("scan blocked on a pipe")
            .is_err()
    );

    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || sender.send(checksum(&file)).unwrap());
    assert!(
        receiver
            .recv_timeout(Duration::from_secs(2))
            .expect("checksum blocked on a pipe")
            .is_err()
    );
}

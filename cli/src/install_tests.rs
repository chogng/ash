use super::*;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeMap;
use tempfile::TempDir;

fn package(root: &Path, version: &str) -> PathBuf {
    let package = root.join(version);
    let relative = if cfg!(windows) {
        "bin/ash.exe"
    } else {
        "bin/ash"
    };
    let executable = package.join(relative);
    fs::create_dir_all(executable.parent().unwrap()).unwrap();
    fs::write(
        &executable,
        format!("#!/bin/sh\nprintf 'ash {version}\\n'\n"),
    )
    .unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o755)).unwrap();
    }
    let hash = format!("{:x}", Sha256::digest(fs::read(executable).unwrap()));
    let files = BTreeMap::from([(relative, hash.clone())]);
    let mut metadata = serde_json::json!({
        "layoutVersion": 2, "version": version, "target": update::current_target().unwrap(),
        "buildProfile": "release", "javascriptRuntime": {"kind": "packagedNode"},
        "protocol": {"major": 1, "schemaHash": format!("sha256:{}", "0".repeat(64))},
        "components": {"cli": {"binarySha256": hash, "updatePublicKey": "01".repeat(32)}}
    });
    metadata.sort_all_objects();
    let mut digest = Sha256::new();
    digest.update(b"ash-package-build-v2\0");
    digest.update(serde_json::to_vec(&metadata).unwrap());
    digest.update(b"\0");
    for (path, hash) in &files {
        digest.update(path.as_bytes());
        digest.update(b"\0");
        digest.update(hash.as_bytes());
        digest.update(b"\0");
    }
    metadata["buildId"] = format!("sha256:{:x}", digest.finalize()).into();
    metadata["files"] = serde_json::to_value(files).unwrap();
    fs::write(
        package.join("ash-package.json"),
        serde_json::to_vec(&metadata).unwrap(),
    )
    .unwrap();
    package
}

fn options(root: &Path, package: PathBuf) -> Options {
    Options {
        package,
        install_root: root.join("安装 %! with spaces"),
        bin_dir: root.join("命令 with spaces"),
    }
}

fn install(root: &Path, source: PathBuf, version: &str) -> Result<PathBuf, String> {
    install_package(
        options(root, source),
        &Version::parse(version).unwrap(),
        update::current_target().unwrap(),
    )
}

#[test]
fn reinstall_switches_the_launcher_and_preserves_immutable_packages() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    let source = package(root, "1.2.3");
    let first = install(root, source.clone(), "1.2.3").unwrap();
    assert_eq!(install(root, source.clone(), "1.2.3").unwrap(), first);
    assert!(
        source.is_dir(),
        "publication must not move a running bootstrap executable"
    );
    let second = install(root, package(root, "1.2.4"), "1.2.4").unwrap();
    assert_ne!(first, second);
    for (path, version) in [(&first, "1.2.3"), (&second, "1.2.4")] {
        update::validate_package(
            path,
            &Version::parse(version).unwrap(),
            update::current_target().unwrap(),
        )
        .unwrap();
    }
    let install_root = options(root, source).install_root;
    #[cfg(unix)]
    {
        assert_eq!(
            fs::canonicalize(install_root.join("current")).unwrap(),
            fs::canonicalize(second).unwrap()
        );
        let output = std::process::Command::new(root.join("命令 with spaces/ash"))
            .arg("--version")
            .output()
            .unwrap();
        assert!(output.status.success());
        assert_eq!(output.stdout, b"ash 1.2.4\n");
    }
    #[cfg(windows)]
    assert_eq!(
        fs::read_to_string(install_root.join("current")).unwrap(),
        second.file_name().unwrap().to_str().unwrap()
    );
}

#[test]
fn bootstrap_respects_the_updater_lock_and_can_retry_after_it_is_released() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    let source = package(root, "1.2.3");
    let install_root = options(root, source.clone()).install_root;
    fs::create_dir(&install_root).unwrap();
    let lock = update::UpdateLock::acquire(&install_root).unwrap();
    assert!(
        install(root, source.clone(), "1.2.3")
            .unwrap_err()
            .contains("another Ash update is active")
    );
    assert!(!install_root.join("versions").exists());
    drop(lock);
    install(root, source, "1.2.3").unwrap();
}

#[test]
fn simultaneous_installers_do_not_merge_packages() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    let source = package(root, "1.2.3");
    let barrier = std::sync::Barrier::new(4);
    std::thread::scope(|scope| {
        let workers: Vec<_> = (0..4)
            .map(|_| {
                let source = source.clone();
                let barrier = &barrier;
                scope.spawn(move || {
                    barrier.wait();
                    install(root, source, "1.2.3")
                })
            })
            .collect();
        let mut successes = 0;
        for worker in workers {
            match worker.join().unwrap() {
                Ok(_) => successes += 1,
                Err(error) => assert!(error.contains("another Ash update is active"), "{error}"),
            }
        }
        assert!(successes > 0);
    });
    let installed = install(root, source, "1.2.3").unwrap();
    assert!(!installed.join("package").exists());
    update::validate_package(
        &installed,
        &Version::parse("1.2.3").unwrap(),
        update::current_target().unwrap(),
    )
    .unwrap();
}

#[test]
fn invalid_packages_and_foreign_launchers_do_not_overwrite_an_installation() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    let first = install(root, package(root, "1.2.3"), "1.2.3").unwrap();
    let source = package(root, "1.2.4");
    fs::write(
        source.join(if cfg!(windows) {
            "bin/ash.exe"
        } else {
            "bin/ash"
        }),
        "tampered",
    )
    .unwrap();
    assert!(install(root, source, "1.2.4").is_err());
    assert!(first.exists());
    let bin = options(root, PathBuf::new()).bin_dir;
    let launcher = bin.join(if cfg!(windows) { "ash.cmd" } else { "ash" });
    fs::remove_file(&launcher).unwrap();
    fs::write(&launcher, b"foreign launcher").unwrap();
    install(root, package(root, "1.2.5"), "1.2.5").unwrap();
    assert_eq!(fs::read(launcher).unwrap(), b"foreign launcher");
}

#[cfg(unix)]
#[test]
fn failed_pointer_replacement_leaves_the_old_selection_intact() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    let old = install(root, package(root, "1.2.3"), "1.2.3").unwrap();
    let install_root = options(root, PathBuf::new()).install_root;
    // A leftover directory is not an owned staging link and must not be removed.
    fs::create_dir(install_root.join(".current-next")).unwrap();
    assert!(install(root, package(root, "1.2.4"), "1.2.4").is_err());
    assert_eq!(
        fs::canonicalize(install_root.join("current")).unwrap(),
        fs::canonicalize(old).unwrap()
    );
    assert!(install_root.join(".current-next").is_dir());
}

#[test]
fn installer_refuses_destinations_inside_the_downloaded_package() {
    let temp = TempDir::new().unwrap();
    let source = package(temp.path(), "1.2.3");
    let result = install_package(
        Options {
            package: source.clone(),
            install_root: source.join("install"),
            bin_dir: temp.path().join("bin"),
        },
        &Version::parse("1.2.3").unwrap(),
        update::current_target().unwrap(),
    );
    assert!(result.is_err());
    assert!(!source.join("install/versions").exists());
}

#[cfg(windows)]
#[test]
fn windows_launcher_uses_an_ascii_entry_and_preserves_its_unicode_binding() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    let source = package(root, "1.2.3");
    install(root, source.clone(), "1.2.3").unwrap();
    let options = options(root, source);
    let command = fs::read(options.bin_dir.join("ash.cmd")).unwrap();
    assert!(command.is_ascii());
    let binding: LauncherBinding =
        serde_json::from_slice(&fs::read(options.bin_dir.join("ash-launcher.json")).unwrap())
            .unwrap();
    assert_eq!(binding.install_root, options.install_root);
    assert!(options.bin_dir.join("ash-launcher.exe").is_file());
}

#[cfg(windows)]
#[test]
fn windows_reinstallation_migrates_only_its_owned_legacy_command() {
    let temp = TempDir::new().unwrap();
    let root = temp.path();
    let source = package(root, "1.2.3");
    let options = options(root, source.clone());
    fs::create_dir_all(&options.bin_dir).unwrap();
    let command = options.bin_dir.join("ash.cmd");
    for previous in [
        legacy_windows_launcher(&options.install_root).into_bytes(),
        WINDOWS_LAUNCHER_WITH_IMPLICIT_EXIT_CODE.as_bytes().to_vec(),
    ] {
        fs::write(&command, previous).unwrap();
        install(root, source.clone(), "1.2.3").unwrap();
        assert_eq!(fs::read(&command).unwrap(), WINDOWS_LAUNCHER.as_bytes());
    }
    let binding = options.bin_dir.join("ash-launcher.json");
    let original = fs::read(&binding).unwrap();
    fs::write(
        &binding,
        br#"{"schemaVersion":2,"installRoot":"C:\\other"}"#,
    )
    .unwrap();
    assert!(install(root, package(root, "1.2.4"), "1.2.4").is_err());
    fs::write(&binding, original).unwrap();
    assert!(read_launcher_binding(&binding).is_ok());
}

#[cfg(windows)]
#[test]
fn locked_windows_pointer_keeps_the_previous_selection() {
    use std::os::windows::fs::OpenOptionsExt;
    let temp = TempDir::new().unwrap();
    let current = temp.path().join("current");
    fs::write(&current, "old").unwrap();
    let held = fs::OpenOptions::new()
        .read(true)
        .share_mode(1 | 2)
        .open(&current)
        .unwrap();
    assert!(update::select_package(temp.path(), Path::new("versions/new")).is_err());
    assert_eq!(fs::read_to_string(&current).unwrap(), "old");
    drop(held);
    update::select_package(temp.path(), Path::new("versions/new")).unwrap();
    assert_eq!(fs::read_to_string(&current).unwrap(), "new");
}

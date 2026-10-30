use super::*;

#[test]
fn native_uninstall_must_remove_every_inventory_file_before_releasing_ownership() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("installed");
    fs::create_dir(&root).unwrap();
    let root = files::real_directory(&root).unwrap();
    let mut registry = Registry::open(&temporary.path().join("registry")).unwrap();
    registry
        .register(Product::Desktop, &root, None, None)
        .unwrap();
    let remaining = root.join("locked.dll");
    fs::write(&remaining, "locked image").unwrap();
    let prepared = serde_json::to_vec(
        &json!({"status":"prepared","report":{"failures":[]},"programFiles":[remaining]}),
    )
    .unwrap();
    let path = report_path(&registry.directory, &root);
    fs::write(&path, &prepared).unwrap();
    fs::write(registry.operation_path(&root), b"uninstall").unwrap();
    assert!(registry.require_launchable(&root).is_err());
    assert!(finish_uninstall(&mut registry, &root).is_err());
    assert_eq!(registry.receipts.installations.len(), 1);
    let failed: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    assert_eq!(failed["status"], "failed");
    assert!(
        failed["report"]["failures"][0]
            .as_str()
            .unwrap()
            .contains("locked.dll")
    );
    fs::remove_file(&remaining).unwrap();
    fs::write(&path, &prepared).unwrap();
    finish_uninstall(&mut registry, &root).unwrap();
    assert!(registry.receipts.installations.is_empty());
    assert!(registry.require_launchable(&root).is_ok());
}

#[cfg(windows)]
#[test]
fn launcher_removal_requires_matching_root_wrapper_and_binary_digest() {
    let temporary = tempfile::tempdir().unwrap();
    let root = temporary.path().join("installation");
    let bin = temporary.path().join("bin");
    fs::create_dir(&root).unwrap();
    fs::create_dir(&bin).unwrap();
    let command = bin.join("ash.cmd");
    let binding = bin.join("ash-launcher.json");
    let adapter = bin.join("ash-launcher.exe");
    let wrapper = b"@echo off\r\nsetlocal DisableDelayedExpansion\r\n\"%~dp0ash-launcher.exe\" %*\r\nexit /b %errorlevel%\r\n";
    fs::write(&command, wrapper).unwrap();
    fs::write(&adapter, "original adapter").unwrap();
    let digest = files::file_hash(&adapter).unwrap();
    fs::write(&binding, serde_json::to_vec(&json!({"schemaVersion":1,"installRoot":temporary.path().join("other-missing-installation")})).unwrap()).unwrap();
    let mut report = RemovalReport::default();
    remove_launcher(&root, &bin, Some(&digest), &mut report).unwrap();
    assert!(command.exists());
    fs::write(
        &binding,
        serde_json::to_vec(&json!({"schemaVersion":1,"installRoot":root})).unwrap(),
    )
    .unwrap();
    fs::write(&adapter, "user replaced this executable").unwrap();
    remove_launcher(&root, &bin, Some(&digest), &mut report).unwrap();
    assert_eq!(
        fs::read_to_string(&adapter).unwrap(),
        "user replaced this executable"
    );
    fs::write(&adapter, "original adapter").unwrap();
    fs::write(&command, "custom wrapper").unwrap();
    remove_launcher(&root, &bin, Some(&digest), &mut report).unwrap();
    assert_eq!(fs::read_to_string(&command).unwrap(), "custom wrapper");
    fs::write(&command, wrapper).unwrap();
    remove_launcher(&root, &bin, Some(&digest), &mut report).unwrap();
    assert!(!command.exists());
    assert!(!binding.exists());
    assert!(!adapter.exists());
}

#[cfg(unix)]
#[test]
fn launcher_removal_only_unlinks_this_installations_symlink() {
    let temporary = tempfile::tempdir().unwrap();
    let bin = temporary.path().join("bin");
    let root = temporary.path().join("installed");
    fs::create_dir(&bin).unwrap();
    fs::create_dir(&root).unwrap();
    let bin = files::real_directory(&bin).unwrap();
    let root = files::real_directory(&root).unwrap();
    fs::write(bin.join("ash"), "user command").unwrap();
    let mut report = RemovalReport::default();
    remove_launcher(&root, &bin, None, &mut report).unwrap();
    assert_eq!(fs::read_to_string(bin.join("ash")).unwrap(), "user command");
    fs::remove_file(bin.join("ash")).unwrap();
    std::os::unix::fs::symlink(root.join("current/bin/ash"), bin.join("ash")).unwrap();
    remove_launcher(&root, &bin, None, &mut report).unwrap();
    assert!(fs::symlink_metadata(bin.join("ash")).is_err());
}

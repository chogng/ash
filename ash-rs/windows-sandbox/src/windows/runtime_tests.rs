use super::*;

#[test]
fn installation_requires_approval_of_the_current_complete_plan() {
    let runner = std::env::current_exe().unwrap();
    let one = setup_plan(1, &runner).unwrap();
    let two = setup_plan(2, &runner).unwrap();
    assert_ne!(plan_digest(&one).unwrap(), plan_digest(&two).unwrap());
    assert!(
        setup(1, &runner, &plan_digest(&two).unwrap())
            .unwrap_err()
            .contains("approval does not match")
    );
    assert!(
        setup(1, &runner, "")
            .unwrap_err()
            .contains("approval does not match")
    );
    assert_eq!(one["accounts"]["total"], 3);
    assert_eq!(one["network"]["persistentFilters"], 13);
    assert!(one.get("deviceAclChanges").is_none());
}

#[test]
fn restored_acl_journal_directory_does_not_block_runner_update() {
    let temp = tempfile::tempdir().unwrap();
    let mut account = account::plan(NetworkMode::Allowed, 0).unwrap();
    account.sid = "S-1-5-21-101-102-103-104".into();
    let accounts = [account];
    let journal = temp.path().join("acl").join(&accounts[0].sid);
    let writable = temp.path().join("writable");
    std::fs::create_dir(&writable).unwrap();
    let mut manager = wxc_common::filesystem_dacl::DaclManager::in_directory(&journal).unwrap();
    manager
        .grant_appcontainer_access(&accounts[0].sid, &[writable], &[])
        .unwrap();
    assert!(ensure_idle_accounts(temp.path(), &accounts).is_err());
    manager.restore_strict().unwrap();
    assert!(journal.is_dir());
    ensure_idle_accounts(temp.path(), &accounts).unwrap();
    std::fs::create_dir_all(temp.path().join("runs").join(&accounts[0].sid)).unwrap();
    assert!(ensure_idle_accounts(temp.path(), &accounts).is_err());
}

fn layout() -> (tempfile::TempDir, String) {
    let temp = tempfile::tempdir().unwrap();
    std::fs::create_dir(temp.path().join("bin")).unwrap();
    std::fs::create_dir(temp.path().join("runs")).unwrap();
    std::fs::write(
        temp.path().join("bin/ash-windows-sandbox.exe"),
        b"owned runner",
    )
    .unwrap();
    for name in [
        "setup.lock",
        "state.dpapi",
        "state.pending",
        "lease-0",
        "lease-1",
    ] {
        std::fs::write(temp.path().join(name), b"test data").unwrap();
    }
    let digest = hash(&temp.path().join("bin/ash-windows-sandbox.exe")).unwrap();
    (temp, digest)
}

#[test]
fn cleanup_removes_owned_files_and_keeps_the_journal_until_final_verification() {
    let (temp, digest) = layout();
    clean_files(temp.path(), RunnerImages::Installed(&digest), 2).unwrap();
    let mut remaining = std::fs::read_dir(temp.path())
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect::<Vec<_>>();
    remaining.sort();
    assert_eq!(remaining, ["setup.lock", "state.dpapi"]);
    clean_files(temp.path(), RunnerImages::Installed(&digest), 2).unwrap();
}

#[test]
fn unknown_files_or_incomplete_execution_preserve_recovery_state() {
    for entry in ["unexpected", "runs/incomplete"] {
        let (temp, digest) = layout();
        std::fs::write(temp.path().join(entry), b"preserve me").unwrap();
        assert!(clean_files(temp.path(), RunnerImages::Installed(&digest), 2).is_err());
        assert_eq!(
            std::fs::read(temp.path().join(entry)).unwrap(),
            b"preserve me"
        );
        assert!(temp.path().join("state.dpapi").exists());
    }
}

#[test]
fn a_changed_runtime_is_not_silently_deleted() {
    let (temp, digest) = layout();
    std::fs::write(
        temp.path().join("bin/ash-windows-sandbox.exe"),
        b"different file",
    )
    .unwrap();
    assert!(clean_files(temp.path(), RunnerImages::Installed(&digest), 2).is_err());
    assert!(temp.path().join("bin/ash-windows-sandbox.exe").exists());
    assert!(temp.path().join("state.dpapi").exists());
}

#[test]
fn removal_can_finish_after_an_update_replaced_the_image_before_saving_ready() {
    let (temp, installed) = layout();
    let runner = temp.path().join("bin/ash-windows-sandbox.exe");
    std::fs::write(&runner, b"approved updated image").unwrap();
    let next = hash(&runner).unwrap();
    clean_files(
        temp.path(),
        RunnerImages::Updating {
            installed: &installed,
            next: &next,
        },
        2,
    )
    .unwrap();
    assert!(!runner.exists());
    assert!(temp.path().join("state.dpapi").exists());
}

#[test]
fn an_unrecorded_staged_image_is_preserved() {
    let (temp, installed) = layout();
    let staged = temp.path().join("bin/runner.pending");
    std::fs::write(&staged, b"unknown image").unwrap();
    assert!(clean_files(temp.path(), RunnerImages::Installed(&installed), 2).is_err());
    assert_eq!(std::fs::read(staged).unwrap(), b"unknown image");
    assert!(temp.path().join("state.dpapi").exists());
}

#[test]
fn initialization_cleanup_plan_contains_only_the_precommit_files() {
    let temp = tempfile::tempdir().unwrap();
    std::fs::write(
        temp.path().join("state.pending"),
        b"interrupted encrypted journal",
    )
    .unwrap();
    std::fs::write(temp.path().join("setup.lock"), []).unwrap();
    let plan = initial_removal_plan(temp.path()).unwrap();
    assert_eq!(plan["operation"], "remove-initialization");
    assert_eq!(plan["accounts"], serde_json::json!([]));
    assert_eq!(plan["files"][0]["name"], "setup.lock");
    assert_eq!(plan["files"][1]["name"], "state.pending");
    std::fs::create_dir(temp.path().join("unexpected")).unwrap();
    assert!(initial_removal_plan(temp.path()).is_err());
    assert!(temp.path().join("unexpected").exists());
}

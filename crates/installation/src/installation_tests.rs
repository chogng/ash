use super::*;
use std::fs;
use tempfile::TempDir;

fn setup() -> (TempDir, Registry, PathBuf, PathBuf, PathBuf) {
    let temporary = TempDir::new().unwrap();
    let desktop = temporary.path().join("desktop");
    let cli = temporary.path().join("cli");
    let profile = temporary.path().join("profile");
    fs::create_dir(&desktop).unwrap();
    fs::create_dir(&cli).unwrap();
    let registry = Registry::open(&temporary.path().join("registry")).unwrap();
    (temporary, registry, desktop, cli, profile)
}

fn populate(profile: &Path) {
    fs::create_dir_all(profile.join("worktrees/my-project/.git")).unwrap();
    fs::write(
        profile.join("worktrees/my-project/uncommitted.txt"),
        "user work",
    )
    .unwrap();
    fs::create_dir_all(profile.join("cache")).unwrap();
    fs::write(profile.join("cache/download"), "cached bytes").unwrap();
    fs::write(profile.join("settings.json"), "settings").unwrap();
    fs::create_dir_all(profile.join("state/cloud-codebase")).unwrap();
    fs::write(profile.join("state/cloud-codebase/record"), "cloud state").unwrap();
    fs::create_dir_all(profile.join("ash-code/themes")).unwrap();
    fs::write(profile.join("ash-code/themes/custom.json"), "custom theme").unwrap();
    fs::write(profile.join("notes.md"), "user notes").unwrap();
}

#[test]
fn both_modes_preserve_worktrees_and_unknown_files() {
    for mode in [RemovalMode::KeepData, RemovalMode::Purge] {
        let (_temporary, mut registry, desktop, _cli, profile) = setup();
        registry
            .register(Product::Desktop, &desktop, None, Some((&profile, None)))
            .unwrap();
        populate(&profile);
        for parent in ["state", "ash-code"] {
            fs::write(profile.join(parent).join("notes.md"), "user notes").unwrap();
        }
        for name in [
            "configuration.json",
            "keybindings.json",
            "keyboard-layout.json",
        ] {
            fs::write(profile.join(name), "custom configuration").unwrap();
        }
        let mut stopped = Vec::new();
        let report = registry
            .remove(Product::Desktop, &desktop, mode, |path| {
                stopped.push(path.to_owned());
                Ok(())
            })
            .unwrap();
        assert_eq!(stopped, vec![profile.clone()]);
        assert!(report.failures.is_empty());
        assert!(!profile.join("cache").exists());
        assert_eq!(
            profile.join("settings.json").exists(),
            mode == RemovalMode::KeepData
        );
        for (path, contents) in [
            ("state/cloud-codebase/record", "cloud state"),
            ("ash-code/themes/custom.json", "custom theme"),
        ] {
            if mode == RemovalMode::KeepData {
                assert_eq!(fs::read_to_string(profile.join(path)).unwrap(), contents);
            } else {
                assert!(!profile.join(path).exists());
            }
        }
        for name in [
            "configuration.json",
            "keybindings.json",
            "keyboard-layout.json",
        ] {
            if mode == RemovalMode::KeepData {
                assert_eq!(
                    fs::read_to_string(profile.join(name)).unwrap(),
                    "custom configuration"
                );
            } else {
                assert!(!profile.join(name).exists());
            }
        }
        assert_eq!(
            fs::read_to_string(profile.join("worktrees/my-project/uncommitted.txt")).unwrap(),
            "user work"
        );
        assert_eq!(
            fs::read_to_string(profile.join("notes.md")).unwrap(),
            "user notes"
        );
        for parent in ["state", "ash-code"] {
            assert_eq!(
                fs::read_to_string(profile.join(parent).join("notes.md")).unwrap(),
                "user notes"
            );
        }
    }
}

#[test]
fn profile_repository_protects_nested_domain_data() {
    for repository in [".git", ".hg", ".svn", "bare"] {
        let (_temporary, mut registry, desktop, _cli, profile) = setup();
        registry
            .register(Product::Desktop, &desktop, None, Some((&profile, None)))
            .unwrap();
        populate(&profile);
        if repository == "bare" {
            fs::write(profile.join("HEAD"), "ref: refs/heads/main").unwrap();
            fs::create_dir(profile.join("objects")).unwrap();
            fs::create_dir(profile.join("refs")).unwrap();
        } else {
            fs::create_dir(profile.join(repository)).unwrap();
        }
        let report = registry
            .remove(Product::Desktop, &desktop, RemovalMode::Purge, |_| Ok(()))
            .unwrap();
        assert_eq!(report.retained, vec![profile.clone()]);
        assert_eq!(
            fs::read_to_string(profile.join("state/cloud-codebase/record")).unwrap(),
            "cloud state"
        );
        assert_eq!(
            fs::read_to_string(profile.join("ash-code/themes/custom.json")).unwrap(),
            "custom theme"
        );
    }
}

#[test]
fn uninstalling_either_product_preserves_a_shared_profile() {
    for first in [Product::Desktop, Product::Cli] {
        let (_temporary, mut registry, desktop, cli, profile) = setup();
        registry
            .register(Product::Desktop, &desktop, None, Some((&profile, None)))
            .unwrap();
        registry
            .register(Product::Cli, &cli, None, Some((&profile, None)))
            .unwrap();
        populate(&profile);
        let root = if first == Product::Desktop {
            &desktop
        } else {
            &cli
        };
        let report = registry
            .remove(first, root, RemovalMode::Purge, |_| {
                panic!("shared backend must not stop")
            })
            .unwrap();
        registry.release(first, root).unwrap();
        assert_eq!(report.retained, vec![profile.clone()]);
        assert!(profile.join("settings.json").exists());
        assert!(profile.join("cache/download").exists());
        assert_eq!(
            fs::read_to_string(profile.join("state/cloud-codebase/record")).unwrap(),
            "cloud state"
        );
        assert_eq!(
            fs::read_to_string(profile.join("ash-code/themes/custom.json")).unwrap(),
            "custom theme"
        );
        drop(registry);
        let mut registry = Registry::open(&_temporary.path().join("registry")).unwrap();
        let (second, root) = if first == Product::Desktop {
            (Product::Cli, &cli)
        } else {
            (Product::Desktop, &desktop)
        };
        registry
            .remove(second, root, RemovalMode::Purge, |_| Ok(()))
            .unwrap();
        assert!(!profile.join("settings.json").exists());
        assert!(
            profile
                .join("worktrees/my-project/uncommitted.txt")
                .exists()
        );
    }
}

#[test]
fn legacy_profiles_and_repositories_in_cache_are_preserved() {
    let (_temporary, mut registry, desktop, _cli, profile) = setup();
    populate(&profile);
    registry
        .register(Product::Desktop, &desktop, None, Some((&profile, None)))
        .unwrap();
    let report = registry
        .remove(Product::Desktop, &desktop, RemovalMode::Purge, |_| {
            panic!("unknown ownership must not stop a backend")
        })
        .unwrap();
    assert_eq!(report.retained, vec![profile.clone()]);
    assert!(profile.join("settings.json").exists());
    fs::create_dir(profile.join("cache/.git")).unwrap();
    let mut report = RemovalReport::default();
    remove_owned_tree(&profile.join("cache"), &mut report).unwrap();
    assert_eq!(report.retained, vec![profile.join("cache")]);
    assert!(profile.join("cache/download").exists());
}

#[test]
fn new_profile_does_not_claim_an_existing_unrecorded_electron_directory() {
    let (temporary, mut registry, desktop, _cli, profile) = setup();
    let data = temporary.path().join("older-electron-data");
    fs::create_dir(&data).unwrap();
    fs::write(data.join("state.json"), "other consumer state").unwrap();
    registry
        .register(
            Product::Desktop,
            &desktop,
            None,
            Some((&profile, Some(&data))),
        )
        .unwrap();
    populate(&profile);
    // A subsequent launch must not turn an unrecorded directory into owned data.
    registry
        .register(
            Product::Desktop,
            &desktop,
            None,
            Some((&profile, Some(&data))),
        )
        .unwrap();
    let report = registry
        .remove(Product::Desktop, &desktop, RemovalMode::Purge, |_| Ok(()))
        .unwrap();
    assert!(!profile.join("settings.json").exists());
    assert_eq!(
        fs::read_to_string(data.join("state.json")).unwrap(),
        "other consumer state"
    );
    assert!(report.retained.contains(&data));
}

#[test]
fn stop_failure_keeps_receipt_and_data_for_retry() {
    let (_temporary, mut registry, desktop, _cli, profile) = setup();
    registry
        .register(Product::Desktop, &desktop, None, Some((&profile, None)))
        .unwrap();
    populate(&profile);
    let error = registry
        .remove(Product::Desktop, &desktop, RemovalMode::Purge, |_| {
            Err(io::Error::other("busy backend"))
        })
        .unwrap_err();
    assert_eq!(error.to_string(), "busy backend");
    assert_eq!(registry.receipts.installations.len(), 1);
    assert!(profile.join("settings.json").exists());
    assert!(profile.join("cache/download").exists());
}

#[test]
fn registration_rejects_traversal_and_unreadable_receipts() {
    let (temporary, mut registry, desktop, _cli, profile) = setup();
    assert!(
        registry
            .register(
                Product::Desktop,
                &desktop,
                None,
                Some((&profile.join("../other"), None))
            )
            .is_err()
    );
    drop(registry);
    fs::write(
        temporary.path().join("registry/installations.json"),
        "invalid",
    )
    .unwrap();
    assert!(Registry::open(&temporary.path().join("registry")).is_err());
}

#[test]
fn nested_profile_and_installation_roots_are_shared_not_exclusive() {
    let (_temporary, mut registry, desktop, cli, profile) = setup();
    registry
        .register(Product::Desktop, &desktop, None, Some((&profile, None)))
        .unwrap();
    let nested = profile.join("cache/other-profile");
    registry
        .register(Product::Cli, &cli, None, Some((&nested, None)))
        .unwrap();
    populate(&profile);
    fs::create_dir_all(&nested).unwrap();
    fs::write(nested.join("settings.json"), "other settings").unwrap();
    let report = registry
        .remove(Product::Desktop, &desktop, RemovalMode::Purge, |_| {
            panic!("nested shared profile must not stop")
        })
        .unwrap();
    assert!(report.retained.contains(&profile));
    assert_eq!(
        fs::read_to_string(nested.join("settings.json")).unwrap(),
        "other settings"
    );
}

#[test]
fn active_desktop_blocks_cleanup_and_retry_succeeds() {
    let (_temporary, mut registry, desktop, _cli, profile) = setup();
    registry
        .register(Product::Desktop, &desktop, None, Some((&profile, None)))
        .unwrap();
    populate(&profile);
    let lease = registry.use_lock(&desktop).unwrap();
    FileExt::lock_shared(&lease).unwrap();
    assert!(
        registry
            .remove(Product::Desktop, &desktop, RemovalMode::Purge, |_| panic!(
                "must check active clients first"
            ))
            .is_err()
    );
    assert!(profile.join("settings.json").exists());
    drop(lease);
    registry
        .remove(Product::Desktop, &desktop, RemovalMode::Purge, |_| Ok(()))
        .unwrap();
    assert!(!profile.join("settings.json").exists());
}

#[test]
fn retained_data_can_be_purged_after_reinstallation() {
    let (temporary, mut registry, desktop, _cli, profile) = setup();
    registry
        .register(Product::Desktop, &desktop, None, Some((&profile, None)))
        .unwrap();
    populate(&profile);
    registry
        .remove(
            Product::Desktop,
            &desktop,
            RemovalMode::KeepData,
            |_| Ok(()),
        )
        .unwrap();
    registry.release(Product::Desktop, &desktop).unwrap();
    drop(registry);
    let mut registry = Registry::open(&temporary.path().join("registry")).unwrap();
    registry
        .register(Product::Desktop, &desktop, None, Some((&profile, None)))
        .unwrap();
    registry
        .remove(Product::Desktop, &desktop, RemovalMode::Purge, |_| Ok(()))
        .unwrap();
    assert!(!profile.join("settings.json").exists());
    assert!(
        profile
            .join("worktrees/my-project/uncommitted.txt")
            .exists()
    );
}

#[test]
fn shared_electron_data_is_preserved_even_with_separate_profiles() {
    let (temporary, mut registry, desktop, cli, profile) = setup();
    let second = temporary.path().join("second-profile");
    let data = temporary.path().join("electron");
    registry
        .register(
            Product::Desktop,
            &desktop,
            None,
            Some((&profile, Some(&data))),
        )
        .unwrap();
    registry
        .register(Product::Cli, &cli, None, Some((&second, Some(&data))))
        .unwrap();
    populate(&profile);
    fs::create_dir_all(data.join("session-data")).unwrap();
    fs::write(data.join("session-data/cookies"), "keep").unwrap();
    registry
        .remove(Product::Desktop, &desktop, RemovalMode::Purge, |_| Ok(()))
        .unwrap();
    assert_eq!(
        fs::read_to_string(data.join("session-data/cookies")).unwrap(),
        "keep"
    );
}

#[test]
fn upgrade_reclaims_only_unchanged_obsolete_owned_files() {
    let (temporary, _registry, desktop, _cli, _profile) = setup();
    fs::create_dir_all(desktop.join("resources/old")).unwrap();
    for name in ["obsolete", "modified", "current"] {
        fs::write(desktop.join("resources/old").join(name), name).unwrap();
    }
    let hashes = ["obsolete", "modified", "current"]
        .into_iter()
        .map(|name| {
            (
                format!("resources/old/{name}"),
                format!("{:x}", Sha256::digest(name.as_bytes())),
            )
        })
        .collect::<std::collections::BTreeMap<_, _>>();
    fs::write(
        desktop.join("resources/installation-files.json"),
        serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"files":hashes})).unwrap(),
    )
    .unwrap();
    fs::write(desktop.join("resources/old/modified"), "user modification").unwrap();
    fs::write(desktop.join("user.txt"), "keep").unwrap();
    let incoming = temporary.path().join("incoming.json");
    fs::write(&incoming, serde_json::to_vec(&serde_json::json!({"schemaVersion":1,"files":{"resources/old/current":hashes["resources/old/current"]}})).unwrap()).unwrap();
    crate::upgrade::prepare(&desktop, &incoming).unwrap();
    assert!(!desktop.join("resources/old/obsolete").exists());
    assert_eq!(
        fs::read_to_string(desktop.join("resources/old/modified")).unwrap(),
        "user modification"
    );
    assert!(desktop.join("resources/old/current").exists());
    assert!(desktop.join("user.txt").exists());
    crate::upgrade::prepare(&desktop, &incoming).unwrap(); // Interrupted upgrades are retryable.
    fs::write(
        &incoming,
        serde_json::to_vec(
            &serde_json::json!({"schemaVersion":1,"files":{"../outside":"a".repeat(64)}}),
        )
        .unwrap(),
    )
    .unwrap();
    assert!(crate::upgrade::prepare(&desktop, &incoming).is_err());
    assert!(desktop.join("resources/old/current").exists());
}

#[cfg(windows)]
#[test]
fn junctions_and_bare_repositories_are_never_deleted() {
    let (temporary, mut registry, desktop, _cli, profile) = setup();
    registry
        .register(Product::Desktop, &desktop, None, Some((&profile, None)))
        .unwrap();
    populate(&profile);
    let outside = temporary.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("important"), "keep").unwrap();
    let status = crate::command::hidden_command(Path::new("powershell.exe"))
        .args(["-NoProfile", "-NonInteractive", "-Command", "New-Item -ItemType Junction -Path $env:ASH_TEST_LINK -Target $env:ASH_TEST_TARGET | Out-Null"])
        .env("ASH_TEST_LINK", profile.join("cache/link")).env("ASH_TEST_TARGET", &outside).status().unwrap();
    assert!(status.success());
    let report = registry
        .remove(Product::Desktop, &desktop, RemovalMode::Purge, |_| Ok(()))
        .unwrap();
    assert!(report.retained.contains(&profile.join("cache")));
    assert_eq!(
        fs::read_to_string(outside.join("important")).unwrap(),
        "keep"
    );
    fs::remove_dir(profile.join("cache/link")).unwrap();
    fs::create_dir_all(profile.join("cache/bare/objects")).unwrap();
    fs::create_dir_all(profile.join("cache/bare/refs")).unwrap();
    fs::write(profile.join("cache/bare/HEAD"), "ref: refs/heads/main").unwrap();
    let mut report = RemovalReport::default();
    remove_owned_tree(&profile.join("cache"), &mut report).unwrap();
    assert!(report.retained.contains(&profile.join("cache")));
}

#[cfg(unix)]
#[test]
fn symbolic_data_never_reaches_external_files() {
    use std::os::unix::fs::symlink;
    let (temporary, mut registry, desktop, _cli, profile) = setup();
    registry
        .register(Product::Desktop, &desktop, None, Some((&profile, None)))
        .unwrap();
    populate(&profile);
    let outside = temporary.path().join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("important"), "keep").unwrap();
    symlink(&outside, profile.join("cache/link")).unwrap();
    let report = registry
        .remove(Product::Desktop, &desktop, RemovalMode::Purge, |_| Ok(()))
        .unwrap();
    assert!(report.retained.contains(&profile.join("cache")));
    assert_eq!(
        fs::read_to_string(outside.join("important")).unwrap(),
        "keep"
    );
}

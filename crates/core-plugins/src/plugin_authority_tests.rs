use std::fs;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use tempfile::tempdir;

use crate::LocalPluginPackage;
use crate::PluginActivationAuthority;
use crate::PluginAuthorityCommand;
use crate::PluginAuthorityCommandId;
use crate::PluginAuthorityCommandRequest;
use crate::PluginAuthorityDisposition;
use crate::PluginErrorKind;
use crate::PluginPackageId;
use crate::PluginPackageStore;

fn package(root: &std::path::Path, id: &str, version: &str) -> LocalPluginPackage {
    fs::create_dir_all(root.join(".ash-plugin")).unwrap();
    fs::create_dir_all(root.join("mcp")).unwrap();
    fs::write(
        root.join(".ash-plugin/plugin.json"),
        format!(
            r#"{{
                "schemaVersion": 1,
                "id": "{id}",
                "version": "{version}",
                "displayName": "Test Plugin",
                "compatibility": {{"ash": ">=0.1.0"}},
                "contributions": {{
                    "mcpServers": [{{"id": "test", "definition": "mcp/test.json"}}]
                }}
            }}"#
        ),
    )
    .unwrap();
    fs::write(root.join("mcp/test.json"), "{}").unwrap();
    LocalPluginPackage::load(root).unwrap()
}

fn request(
    authority: &PluginActivationAuthority,
    command_id: &str,
    command: PluginAuthorityCommand,
) -> PluginAuthorityCommandRequest {
    PluginAuthorityCommandRequest {
        command_id: PluginAuthorityCommandId::new(command_id).unwrap(),
        expected_revision: authority.snapshot().revision(),
        command,
    }
}

#[test]
fn authority_persists_install_enable_disable_and_exact_replay() {
    let profile = tempdir().unwrap();
    let source = tempdir().unwrap();
    let local = package(source.path(), "acme/review", "1.0.0");
    let authority = PluginActivationAuthority::open(profile.path()).unwrap();
    let install = authority
        .install_local(
            PluginAuthorityCommandId::new("install-review").unwrap(),
            0,
            &local,
        )
        .unwrap();
    let installed = install.package;
    let replayed = authority
        .install_local(
            PluginAuthorityCommandId::new("install-review").unwrap(),
            0,
            &local,
        )
        .unwrap();
    assert_eq!(install.command.revision, 1);
    assert_eq!(install.command.activation_generation, 1);
    assert_eq!(
        replayed.command.disposition,
        PluginAuthorityDisposition::Replayed
    );

    authority
        .apply(request(
            &authority,
            "grant-review",
            PluginAuthorityCommand::Grant {
                package: installed.clone(),
            },
        ))
        .unwrap();
    authority
        .apply(request(
            &authority,
            "enable-review",
            PluginAuthorityCommand::Enable {
                package: installed.clone(),
            },
        ))
        .unwrap();
    assert_eq!(authority.snapshot().activation().generation(), 2);
    assert_eq!(authority.snapshot().activation().packages().len(), 1);
    drop(authority);

    let reopened = PluginActivationAuthority::open(profile.path()).unwrap();
    assert_eq!(reopened.snapshot().revision(), 3);
    assert_eq!(
        reopened.snapshot().installed(),
        std::slice::from_ref(&installed)
    );
    assert_eq!(reopened.snapshot().activation().packages().len(), 1);
    reopened
        .apply(request(
            &reopened,
            "disable-review",
            PluginAuthorityCommand::Disable { package: installed },
        ))
        .unwrap();
    assert!(reopened.snapshot().activation().packages().is_empty());
}

#[test]
fn formal_version_content_is_immutable_and_requires_a_version_bump() {
    let profile = tempdir().unwrap();
    let source = tempdir().unwrap();
    let authority = PluginActivationAuthority::open(profile.path()).unwrap();
    let first = package(source.path(), "acme/review", "1.0.0");
    let installed = authority
        .install_local(
            PluginAuthorityCommandId::new("install-first").unwrap(),
            0,
            &first,
        )
        .unwrap()
        .package;
    fs::write(source.path().join("mcp/test.json"), r#"{"changed":true}"#).unwrap();
    let changed = LocalPluginPackage::load(source.path()).unwrap();

    let error = authority
        .install_local(
            PluginAuthorityCommandId::new("install-changed").unwrap(),
            1,
            &changed,
        )
        .unwrap_err();

    assert_eq!(error.kind(), PluginErrorKind::PackageConflict);
    assert_eq!(
        authority.snapshot().installed(),
        std::slice::from_ref(&installed)
    );
    assert_eq!(
        fs::read_dir(profile.path().join("objects"))
            .unwrap()
            .count(),
        1
    );
}

#[test]
fn failed_enable_does_not_change_the_published_generation() {
    let root = tempdir().unwrap();
    let store = PluginPackageStore::open(root.path()).unwrap();
    let authority = PluginActivationAuthority::in_memory(store).unwrap();
    let missing = crate::InstalledPluginRef {
        id: PluginPackageId::new("acme/missing").unwrap(),
        version: crate::PluginVersion::new("1.0.0").unwrap(),
        digest: crate::PluginPackageDigest::new(format!("sha256:{}", "0".repeat(64))).unwrap(),
    };

    let error = authority
        .apply(request(
            &authority,
            "enable-missing",
            PluginAuthorityCommand::Enable { package: missing },
        ))
        .unwrap_err();
    assert_eq!(error.kind(), PluginErrorKind::SourceUnavailable);
    assert_eq!(authority.snapshot().revision(), 0);
    assert_eq!(authority.snapshot().activation().generation(), 1);
}

#[test]
fn disable_rejects_a_stale_exact_package_target() {
    let root = tempdir().unwrap();
    let source = tempdir().unwrap();
    let store = PluginPackageStore::open(root.path()).unwrap();
    let installed = store
        .install_local(&package(source.path(), "acme/review", "1.0.0"))
        .unwrap();
    let authority = PluginActivationAuthority::in_memory(store).unwrap();
    authority
        .apply(request(
            &authority,
            "install",
            PluginAuthorityCommand::Install {
                package: installed.clone(),
            },
        ))
        .unwrap();
    authority
        .apply(request(
            &authority,
            "enable",
            PluginAuthorityCommand::Enable {
                package: installed.clone(),
            },
        ))
        .unwrap();
    let mut stale = installed;
    stale.digest = crate::PluginPackageDigest::new(format!("sha256:{}", "0".repeat(64))).unwrap();

    let error = authority
        .apply(request(
            &authority,
            "disable-stale",
            PluginAuthorityCommand::Disable { package: stale },
        ))
        .unwrap_err();

    assert_eq!(error.kind(), PluginErrorKind::SourceUnavailable);
    assert_eq!(authority.snapshot().enabled().len(), 1);
}

#[test]
fn revoke_and_uninstall_reject_stale_exact_package_targets() {
    let root = tempdir().unwrap();
    let source = tempdir().unwrap();
    let store = PluginPackageStore::open(root.path()).unwrap();
    let installed = store
        .install_local(&package(source.path(), "acme/review", "1.0.0"))
        .unwrap();
    let authority = PluginActivationAuthority::in_memory(store).unwrap();
    authority
        .apply(request(
            &authority,
            "install",
            PluginAuthorityCommand::Install {
                package: installed.clone(),
            },
        ))
        .unwrap();
    authority
        .apply(request(
            &authority,
            "grant",
            PluginAuthorityCommand::Grant {
                package: installed.clone(),
            },
        ))
        .unwrap();
    let mut stale = installed;
    stale.digest = crate::PluginPackageDigest::new(format!("sha256:{}", "0".repeat(64))).unwrap();

    for command in [
        PluginAuthorityCommand::RevokeGrant {
            package: stale.clone(),
        },
        PluginAuthorityCommand::Uninstall { package: stale },
    ] {
        let error = authority
            .apply(request(&authority, "stale-exact-target", command))
            .unwrap_err();
        assert_eq!(error.kind(), PluginErrorKind::SourceUnavailable);
    }
    assert_eq!(authority.snapshot().installed().len(), 1);
    assert_eq!(authority.snapshot().granted().len(), 1);
}

#[test]
fn failed_install_authority_commit_removes_the_unreferenced_object() {
    let profile = tempdir().unwrap();
    let source = tempdir().unwrap();
    let local = package(source.path(), "acme/orphan", "1.0.0");
    let digest = local
        .package_digest()
        .as_str()
        .strip_prefix("sha256:")
        .unwrap()
        .to_owned();
    let authority = PluginActivationAuthority::open(profile.path()).unwrap();

    let error = authority
        .install_local(
            PluginAuthorityCommandId::new("install-conflict").unwrap(),
            99,
            &local,
        )
        .unwrap_err();

    assert_eq!(error.kind(), PluginErrorKind::GenerationConflict);
    assert!(!profile.path().join("objects").join(digest).exists());
}

#[test]
fn reopening_file_authority_clears_staging_without_removing_pending_objects() {
    let profile = tempdir().unwrap();
    let source = tempdir().unwrap();
    let local = package(source.path(), "acme/recovered", "1.0.0");
    let digest = local
        .package_digest()
        .as_str()
        .strip_prefix("sha256:")
        .unwrap()
        .to_owned();
    let store = PluginPackageStore::open(profile.path()).unwrap();
    store.install_local(&local).unwrap();
    std::fs::create_dir(profile.path().join("staging/orphaned")).unwrap();

    let _authority = PluginActivationAuthority::open(profile.path()).unwrap();

    assert!(profile.path().join("objects").join(digest).exists());
    assert!(
        std::fs::read_dir(profile.path().join("staging"))
            .unwrap()
            .next()
            .is_none()
    );
}

#[test]
fn enable_requires_an_exact_package_grant_before_activation() {
    let root = tempdir().unwrap();
    let source = tempdir().unwrap();
    let store = PluginPackageStore::open(root.path()).unwrap();
    let installed = store
        .install_local(&package(source.path(), "acme/review", "1.0.0"))
        .unwrap();
    let authority = PluginActivationAuthority::in_memory(store).unwrap();
    authority
        .apply(request(
            &authority,
            "install",
            PluginAuthorityCommand::Install {
                package: installed.clone(),
            },
        ))
        .unwrap();
    authority
        .apply(request(
            &authority,
            "enable",
            PluginAuthorityCommand::Enable {
                package: installed.clone(),
            },
        ))
        .unwrap();
    assert!(authority.snapshot().activation().packages().is_empty());

    authority
        .apply(request(
            &authority,
            "grant",
            PluginAuthorityCommand::Grant {
                package: installed.clone(),
            },
        ))
        .unwrap();
    assert_eq!(authority.snapshot().activation().packages().len(), 1);

    authority
        .apply(request(
            &authority,
            "revoke",
            PluginAuthorityCommand::RevokeGrant { package: installed },
        ))
        .unwrap();
    assert!(authority.snapshot().activation().packages().is_empty());
}

#[test]
fn distribution_revocation_is_a_durable_tombstone() {
    let profile = tempdir().unwrap();
    let source = tempdir().unwrap();
    let local = package(source.path(), "acme/review", "1.0.0");
    let authority = PluginActivationAuthority::open(profile.path()).unwrap();
    let installed = authority
        .install_local(
            PluginAuthorityCommandId::new("install-review").unwrap(),
            0,
            &local,
        )
        .unwrap()
        .package;
    for (command_id, command) in [
        (
            "grant-review",
            PluginAuthorityCommand::Grant {
                package: installed.clone(),
            },
        ),
        (
            "enable-review",
            PluginAuthorityCommand::Enable {
                package: installed.clone(),
            },
        ),
        (
            "revoke-package-review",
            PluginAuthorityCommand::RevokePackage {
                package: installed.clone(),
            },
        ),
    ] {
        authority
            .apply(request(&authority, command_id, command))
            .unwrap();
    }
    assert!(authority.snapshot().activation().packages().is_empty());
    assert_eq!(
        authority.snapshot().revoked(),
        std::slice::from_ref(&installed)
    );
    drop(authority);

    let reopened = PluginActivationAuthority::open(profile.path()).unwrap();
    assert_eq!(
        reopened.snapshot().revoked(),
        std::slice::from_ref(&installed)
    );
    let error = reopened
        .apply(request(
            &reopened,
            "reenable-revoked",
            PluginAuthorityCommand::Enable { package: installed },
        ))
        .unwrap_err();
    assert_eq!(error.kind(), PluginErrorKind::PackageRevoked);
}

#[test]
fn restoring_a_revoked_package_does_not_implicitly_reactivate_it() {
    let root = tempdir().unwrap();
    let source = tempdir().unwrap();
    let store = PluginPackageStore::open(root.path()).unwrap();
    let installed = store
        .install_local(&package(source.path(), "acme/review", "1.0.0"))
        .unwrap();
    let authority = PluginActivationAuthority::in_memory(store).unwrap();
    authority
        .apply(request(
            &authority,
            "revoke-package",
            PluginAuthorityCommand::RevokePackage {
                package: installed.clone(),
            },
        ))
        .unwrap();
    authority
        .apply(request(
            &authority,
            "restore-package",
            PluginAuthorityCommand::RestorePackage {
                package: installed.clone(),
            },
        ))
        .unwrap();

    assert!(authority.snapshot().revoked().is_empty());
    assert!(authority.snapshot().activation().packages().is_empty());
    assert!(authority.snapshot().installed().is_empty());
}

#[test]
fn disable_commits_then_waits_for_exact_invocation_drain() {
    let root = tempdir().unwrap();
    let source = tempdir().unwrap();
    let store = PluginPackageStore::open(root.path()).unwrap();
    let installed = store
        .install_local(&package(source.path(), "acme/review", "1.0.0"))
        .unwrap();
    let authority = PluginActivationAuthority::in_memory(store).unwrap();
    authority
        .apply(request(
            &authority,
            "install",
            PluginAuthorityCommand::Install {
                package: installed.clone(),
            },
        ))
        .unwrap();
    authority
        .apply(request(
            &authority,
            "grant",
            PluginAuthorityCommand::Grant {
                package: installed.clone(),
            },
        ))
        .unwrap();
    authority
        .apply(request(
            &authority,
            "enable",
            PluginAuthorityCommand::Enable {
                package: installed.clone(),
            },
        ))
        .unwrap();
    let active = authority.snapshot().activation().packages()[0].clone();
    let fence = authority.invocation_fence(&active).unwrap();
    let lease = fence.acquire().unwrap();
    let subscription = authority.subscribe();
    let expected_revision = authority.snapshot().revision();
    let disable_authority = authority.clone();
    let package = installed;
    let (completed_sender, completed_receiver) = mpsc::channel();
    let disable = thread::spawn(move || {
        let result = disable_authority.apply(PluginAuthorityCommandRequest {
            command_id: PluginAuthorityCommandId::new("disable").unwrap(),
            expected_revision,
            command: PluginAuthorityCommand::Disable { package },
        });
        completed_sender.send(()).unwrap();
        result
    });

    assert_eq!(
        subscription
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .activation_generation,
        3
    );
    assert!(!fence.authorizes());
    assert!(matches!(
        completed_receiver.recv_timeout(Duration::from_millis(50)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    drop(lease);
    disable.join().unwrap().unwrap();
    completed_receiver
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
}

#[test]
fn enabling_a_new_version_switches_generation_without_mutating_the_old_object() {
    let root = tempdir().unwrap();
    let first_source = tempdir().unwrap();
    let second_source = tempdir().unwrap();
    let store = PluginPackageStore::open(root.path()).unwrap();
    let first = store
        .install_local(&package(first_source.path(), "acme/review", "1.0.0"))
        .unwrap();
    let second = store
        .install_local(&package(second_source.path(), "acme/review", "2.0.0"))
        .unwrap();
    let authority = PluginActivationAuthority::in_memory(store.clone()).unwrap();
    for (command_id, command) in [
        (
            "install-first",
            PluginAuthorityCommand::Install {
                package: first.clone(),
            },
        ),
        (
            "install-second",
            PluginAuthorityCommand::Install {
                package: second.clone(),
            },
        ),
        (
            "grant-first",
            PluginAuthorityCommand::Grant {
                package: first.clone(),
            },
        ),
        (
            "grant-second",
            PluginAuthorityCommand::Grant {
                package: second.clone(),
            },
        ),
        (
            "enable-first",
            PluginAuthorityCommand::Enable {
                package: first.clone(),
            },
        ),
    ] {
        authority
            .apply(request(&authority, command_id, command))
            .unwrap();
    }
    let first_active = authority.snapshot().activation().packages()[0].clone();
    let first_fence = authority.invocation_fence(&first_active).unwrap();

    authority
        .apply(request(
            &authority,
            "enable-second",
            PluginAuthorityCommand::Enable {
                package: second.clone(),
            },
        ))
        .unwrap();

    let snapshot = authority.snapshot();
    assert_eq!(snapshot.activation().generation(), 3);
    assert_eq!(
        snapshot.activation().packages()[0]
            .manifest()
            .version
            .to_string(),
        "2.0.0"
    );
    assert!(!first_fence.authorizes());
    assert_eq!(
        store
            .activate(&first)
            .unwrap()
            .manifest()
            .version
            .to_string(),
        "1.0.0"
    );
}

#[test]
fn unrelated_activation_change_does_not_revoke_an_exact_package_fence() {
    let root = tempdir().unwrap();
    let first_source = tempdir().unwrap();
    let second_source = tempdir().unwrap();
    let store = PluginPackageStore::open(root.path()).unwrap();
    let first = store
        .install_local(&package(first_source.path(), "acme/first", "1.0.0"))
        .unwrap();
    let second = store
        .install_local(&package(second_source.path(), "acme/second", "1.0.0"))
        .unwrap();
    let authority = PluginActivationAuthority::in_memory(store).unwrap();
    for (id, package) in [("install-first", &first), ("install-second", &second)] {
        authority
            .apply(request(
                &authority,
                id,
                PluginAuthorityCommand::Install {
                    package: package.clone(),
                },
            ))
            .unwrap();
    }
    authority
        .apply(request(
            &authority,
            "grant-first",
            PluginAuthorityCommand::Grant {
                package: first.clone(),
            },
        ))
        .unwrap();
    authority
        .apply(request(
            &authority,
            "enable-first",
            PluginAuthorityCommand::Enable {
                package: first.clone(),
            },
        ))
        .unwrap();
    let active = authority.snapshot().activation().packages()[0].clone();
    let fence = authority.invocation_fence(&active).unwrap();

    authority
        .apply(request(
            &authority,
            "grant-second",
            PluginAuthorityCommand::Grant {
                package: second.clone(),
            },
        ))
        .unwrap();
    authority
        .apply(request(
            &authority,
            "enable-second",
            PluginAuthorityCommand::Enable { package: second },
        ))
        .unwrap();
    assert!(fence.authorizes());
    assert!(fence.acquire().is_some());
}

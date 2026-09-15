use std::fs;
use std::fs::OpenOptions;

use ash_remote::RemoteDirPath;
use ash_remote::SshHost;
use ash_remote::SshTarget;
use serde_json::json;
use tempfile::TempDir;

use crate::RemoteConnectionCatalog;
use crate::RemoteConnectionCatalogFailureKind;
use crate::RemoteConnectionEntry;
use crate::RemoteConnectionName;
use crate::RemoteConnectionSaveMode;

#[test]
fn names_are_canonical_bounded_and_command_line_safe() {
    assert_eq!(name("BUILD-01").as_str(), "build-01");
    for invalid in ["", "-build", "build-", "build server", "build/one"] {
        assert!(RemoteConnectionName::parse(invalid).is_err(), "{invalid}");
    }
    assert!(RemoteConnectionName::parse("a".repeat(65)).is_err());
}

#[test]
fn create_list_replace_and_remove_are_atomic_and_credential_free() {
    let directory = TempDir::new().unwrap();
    let catalog = catalog(&directory);
    let staging = entry("staging", "staging.example", "/srv/project");
    let production = entry("production", "prod.example", "/opt/project");
    catalog
        .save(staging.clone(), RemoteConnectionSaveMode::Create)
        .unwrap();
    catalog
        .save(production.clone(), RemoteConnectionSaveMode::Create)
        .unwrap();

    assert_eq!(
        catalog.connections().unwrap(),
        vec![production, staging.clone()]
    );
    assert_eq!(catalog.connection(&name("staging")).unwrap(), Some(staging));

    let replaced = entry("staging", "new.example", "/srv/new-project");
    catalog
        .save(replaced.clone(), RemoteConnectionSaveMode::Replace)
        .unwrap();
    assert_eq!(
        catalog.connection(&name("staging")).unwrap(),
        Some(replaced)
    );
    assert!(catalog.remove(&name("missing")).unwrap().is_none());
    assert!(catalog.remove(&name("production")).unwrap().is_some());

    let encoded = fs::read_to_string(catalog.path()).unwrap();
    assert!(!encoded.contains("password"));
    assert!(!encoded.contains("privateKey"));
    assert!(!encoded.contains("runtime"));
    assert_eq!(
        fs::read_dir(directory.path())
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().contains(".tmp"))
            .count(),
        0
    );
}

#[test]
fn create_refuses_to_silently_replace_an_existing_name() {
    let directory = TempDir::new().unwrap();
    let catalog = catalog(&directory);
    let original = entry("build", "first.example", "/srv/project");
    catalog
        .save(original.clone(), RemoteConnectionSaveMode::Create)
        .unwrap();

    let error = catalog
        .save(
            entry("BUILD", "second.example", "/srv/other"),
            RemoteConnectionSaveMode::Create,
        )
        .unwrap_err();

    assert_eq!(
        error.kind(),
        RemoteConnectionCatalogFailureKind::AlreadyExists
    );
    assert_eq!(catalog.connection(&name("build")).unwrap(), Some(original));
}

#[test]
fn update_atomically_renames_an_existing_connection_without_overwriting_another() {
    let directory = TempDir::new().unwrap();
    let catalog = catalog(&directory);
    let build = entry("build", "build.example", "/srv/project");
    let production = entry("production", "prod.example", "/opt/project");
    catalog
        .save(build, RemoteConnectionSaveMode::Create)
        .unwrap();
    catalog
        .save(production.clone(), RemoteConnectionSaveMode::Create)
        .unwrap();

    let renamed = entry("staging", "staging.example", "/srv/staging");
    assert_eq!(
        catalog.update(&name("build"), renamed.clone()).unwrap(),
        renamed
    );
    assert!(catalog.connection(&name("build")).unwrap().is_none());
    assert_eq!(
        catalog.connection(&name("staging")).unwrap(),
        Some(renamed.clone())
    );

    let error = catalog
        .update(
            &name("staging"),
            entry("production", "other.example", "/srv/other"),
        )
        .unwrap_err();
    assert_eq!(
        error.kind(),
        RemoteConnectionCatalogFailureKind::AlreadyExists
    );
    assert_eq!(catalog.connection(&name("staging")).unwrap(), Some(renamed));
    assert_eq!(
        catalog.connection(&name("production")).unwrap(),
        Some(production)
    );

    let error = catalog
        .update(
            &name("missing"),
            entry("replacement", "replacement.example", "/srv/replacement"),
        )
        .unwrap_err();
    assert_eq!(error.kind(), RemoteConnectionCatalogFailureKind::Missing);
}

#[test]
fn profile_root_constructor_keeps_targets_separate_from_runtime_history() {
    let directory = TempDir::new().unwrap();
    let catalog = RemoteConnectionCatalog::from_profile_root(directory.path());

    assert_eq!(catalog.path(), directory.path().join("remote/targets.json"));
}

#[test]
fn invalid_unknown_or_duplicate_records_reject_the_complete_document() {
    let directory = TempDir::new().unwrap();
    let catalog = catalog(&directory);
    fs::write(
        catalog.path(),
        serde_json::to_vec(&json!({
            "formatVersion": 1,
            "connections": [
                {"name": "BUILD", "host": "one", "dir": "/srv/one"},
                {"name": "build", "host": "two", "dir": "/srv/two"}
            ]
        }))
        .unwrap(),
    )
    .unwrap();

    let error = catalog.connections().unwrap_err();
    assert_eq!(error.kind(), RemoteConnectionCatalogFailureKind::Invalid);
    assert!(error.to_string().contains("repeats"));

    fs::write(
        catalog.path(),
        br#"{"formatVersion":1,"connections":[],"credential":"secret"}"#,
    )
    .unwrap();
    let error = catalog.connections().unwrap_err();
    assert_eq!(error.kind(), RemoteConnectionCatalogFailureKind::Invalid);
}

#[test]
fn advisory_lease_prevents_lost_updates() {
    let directory = TempDir::new().unwrap();
    let catalog = catalog(&directory);
    catalog
        .save(
            entry("build", "build.example", "/srv/project"),
            RemoteConnectionSaveMode::Create,
        )
        .unwrap();
    let lease = OpenOptions::new()
        .read(true)
        .write(true)
        .open(catalog.lock_path().unwrap())
        .unwrap();
    lease.try_lock().unwrap();

    let error = catalog
        .remove(&name("build"))
        .expect_err("the competing writer must hold the lease");
    assert_eq!(error.kind(), RemoteConnectionCatalogFailureKind::Busy);
    drop(lease);
    assert!(catalog.connection(&name("build")).unwrap().is_some());
}

#[cfg(unix)]
#[test]
fn catalog_resource_symlinks_are_rejected() {
    use std::os::unix::fs::symlink;

    let directory = TempDir::new().unwrap();
    let catalog = catalog(&directory);
    let outside = directory.path().join("outside.json");
    fs::write(&outside, r#"{"formatVersion":1,"connections":[]}"#).unwrap();
    symlink(outside, catalog.path()).unwrap();

    let error = catalog.connections().unwrap_err();
    assert_eq!(error.kind(), RemoteConnectionCatalogFailureKind::Invalid);
}

fn catalog(directory: &TempDir) -> RemoteConnectionCatalog {
    RemoteConnectionCatalog::new(directory.path().join("remote-targets.json"))
}

fn name(value: &str) -> RemoteConnectionName {
    RemoteConnectionName::parse(value).unwrap()
}

fn entry(name_value: &str, host: &str, dir: &str) -> RemoteConnectionEntry {
    RemoteConnectionEntry::new(
        name(name_value),
        SshTarget::new(
            SshHost::parse(host).unwrap(),
            RemoteDirPath::parse(dir).unwrap(),
        ),
    )
}

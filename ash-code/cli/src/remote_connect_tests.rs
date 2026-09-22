use std::path::Path;

use super::RemoteConnectEntry;
use super::RemoteConnectMode;
use super::RemoteConnectTarget;
use super::parse;
use super::runtime::RemoteConnectRuntimeSelection;
use super::runtime::RemoteRuntimeCatalogSelection;

#[test]
fn direct_connect_requires_a_credential_free_host_and_absolute_dir() {
    let options = parse(&strings([
        "--host",
        "build-linux",
        "--dir",
        "/srv/project",
        "--runtime",
        "ash-remote-server",
        "--ssh",
        "/usr/bin/ssh",
        "--check",
    ]))
    .unwrap();

    let RemoteConnectTarget::Direct(target) = options.target else {
        panic!("expected direct target");
    };
    assert_eq!(target.host().as_str(), "build-linux");
    assert_eq!(target.dir().as_str(), "/srv/project");
    let RemoteConnectRuntimeSelection::Explicit(runtime) = options.runtime else {
        panic!("expected explicit runtime");
    };
    assert_eq!(runtime.executable(), "ash-remote-server");
    assert_eq!(
        options.ssh_executable.as_deref(),
        Some(Path::new("/usr/bin/ssh"))
    );
    assert_eq!(options.mode, RemoteConnectMode::Check);
    assert_eq!(options.entry, RemoteConnectEntry::New);

    assert!(
        parse(&strings([
            "--host",
            "user@build-linux",
            "--dir",
            "/srv/project"
        ]))
        .is_err()
    );
    assert!(parse(&strings(["--host", "build-linux", "--dir", "relative"])).is_err());
}

#[test]
fn named_connect_is_exclusive_and_interactive_by_default() {
    let options = parse(&strings(["--name", "Production"])).unwrap();
    let RemoteConnectTarget::Named(name) = options.target else {
        panic!("expected named target");
    };
    assert_eq!(name.as_str(), "production");
    assert_eq!(
        options.runtime,
        RemoteConnectRuntimeSelection::Managed(RemoteRuntimeCatalogSelection::ProductPackage)
    );
    assert_eq!(options.mode, RemoteConnectMode::Interactive);
    assert_eq!(options.entry, RemoteConnectEntry::New);

    assert!(
        parse(&strings([
            "--name",
            "production",
            "--host",
            "build-linux",
            "--dir",
            "/srv/project"
        ]))
        .unwrap_err()
        .contains("cannot be combined")
    );
    assert!(parse(&strings(["--host", "build-linux"])).is_err());
    assert!(
        parse(&strings(["--name", "production", "--check", "--check"]))
            .unwrap_err()
            .contains("only once")
    );
}

#[test]
fn remote_resume_requires_durable_identity_and_interactive_mode() {
    let options = parse(&strings([
        "--host",
        "build-linux",
        "--dir",
        "/srv/project",
        "--resume",
        "session-1",
        "thread-1",
    ]))
    .unwrap();
    let RemoteConnectEntry::Resume(recovery) = options.entry else {
        panic!("expected resume entry");
    };
    assert_eq!(recovery.session_id().as_str(), "session-1");
    assert_eq!(recovery.thread_id().as_str(), "thread-1");

    assert!(
        parse(&strings([
            "--host",
            "build-linux",
            "--dir",
            "/srv/project",
            "--resume",
            "session-1",
            "thread-1",
            "--check",
        ]))
        .unwrap_err()
        .contains("cannot be combined")
    );
}

#[test]
fn runtime_catalog_options_are_authenticated_complete_and_mutually_exclusive() {
    let cache = std::env::temp_dir().join("ash-runtime-cache");
    let options = parse(&strings([
        "--host",
        "build-linux",
        "--dir",
        "/srv/project",
        "--runtime-catalog-url",
        "https://releases.example/ash/catalog.json",
        "--runtime-catalog-sha256",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "--runtime-cache",
        cache.to_str().unwrap(),
        "--check",
    ]))
    .unwrap();
    assert!(matches!(
        options.runtime,
        RemoteConnectRuntimeSelection::Managed(RemoteRuntimeCatalogSelection::Network { .. })
    ));

    assert!(
        parse(&strings([
            "--name",
            "production",
            "--runtime-catalog",
            "/opt/ash/catalog.json"
        ]))
        .unwrap_err()
        .contains("--runtime-catalog-sha256")
    );
    assert!(
        parse(&strings([
            "--name",
            "production",
            "--runtime",
            "ash",
            "--runtime-catalog",
            "/opt/ash/catalog.json",
            "--runtime-catalog-sha256",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        ]))
        .unwrap_err()
        .contains("cannot be combined")
    );
}

fn strings<const N: usize>(values: [&str; N]) -> Vec<String> {
    values.into_iter().map(str::to_owned).collect()
}

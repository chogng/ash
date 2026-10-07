use std::num::NonZeroU64;
use std::path::Path;

use super::RemoteCommand;
use super::RemoteFetchProgressFormat;
use super::RemoteInstallProgressFormat;
use super::RemoteProfileCommand;
use super::connections_command::RemoteConnectionsCommand;
use super::parse;
use crate::RemoteConnectionSaveMode;

#[test]
fn probe_accepts_only_a_credential_free_host_and_local_ssh_path() {
    let command = parse(strings([
        "probe",
        "--host",
        "build-linux",
        "--ssh",
        "/usr/bin/ssh",
    ]))
    .unwrap();
    let RemoteCommand::Probe(options) = command else {
        panic!("expected probe command");
    };

    assert_eq!(options.host.as_str(), "build-linux");
    assert_eq!(
        options.ssh_executable.as_deref(),
        Some(Path::new("/usr/bin/ssh"))
    );
    assert!(parse(strings(["probe", "--host", "user@build-linux"])).is_err());
}

#[test]
fn fetch_runtime_requires_a_release_digest_target_and_absolute_cache() {
    let digest = "a".repeat(64);
    let cache_root = std::env::temp_dir().join("ash-remote-runtime-cache-test");
    let cache_root_text = cache_root.to_string_lossy().into_owned();
    let command = parse(vec![
        "fetch-runtime".into(),
        "--catalog-url".into(),
        "https://releases.example/ash/catalog.json".into(),
        "--catalog-sha256".into(),
        digest.clone(),
        "--target".into(),
        "aarch64-unknown-linux-gnu".into(),
        "--cache-root".into(),
        cache_root_text.clone(),
        "--progress".into(),
        "json-lines".into(),
    ])
    .unwrap();
    let RemoteCommand::Fetch(options) = command else {
        panic!("expected fetch-runtime command");
    };

    assert_eq!(
        options.release.catalog_url(),
        "https://releases.example/ash/catalog.json"
    );
    assert_eq!(options.release.expected_sha256(), digest);
    assert_eq!(
        options.platform.target_triple(),
        "aarch64-unknown-linux-gnu"
    );
    assert_eq!(options.cache.root(), cache_root);
    assert_eq!(options.progress, RemoteFetchProgressFormat::JsonLines);

    assert!(
        parse(strings([
            "fetch-runtime",
            "--catalog-url",
            "https://user@releases.example/ash/catalog.json",
            "--catalog-sha256",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "--target",
            "x86_64-unknown-linux-gnu",
            "--cache-root",
            cache_root_text.as_str(),
        ]))
        .is_err()
    );
    assert!(
        parse(strings([
            "fetch-runtime",
            "--catalog-url",
            "https://releases.example/ash/catalog.json",
            "--catalog-sha256",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "--target",
            "x86_64-unknown-linux-gnu",
            "--cache-root",
            "relative",
        ]))
        .is_err()
    );
}

#[test]
fn install_requires_exact_catalog_integrity_and_package_target() {
    let digest = "a".repeat(64);
    let command = parse(vec![
        "install".into(),
        "--host".into(),
        "build-linux".into(),
        "--archive".into(),
        "/cache/ash-package.tar.gz".into(),
        "--version".into(),
        "0.1.0".into(),
        "--target".into(),
        "x86_64-unknown-linux-gnu".into(),
        "--archive-size".into(),
        "4096".into(),
        "--unpacked-size".into(),
        "16384".into(),
        "--sha256".into(),
        digest.clone(),
        "--install-root".into(),
        "/srv/ash/runtime".into(),
        "--progress".into(),
        "json-lines".into(),
    ])
    .unwrap();
    let RemoteCommand::Install(options) = command else {
        panic!("expected install command");
    };

    assert_eq!(options.host.as_str(), "build-linux");
    assert_eq!(
        options.artifact.archive(),
        Path::new("/cache/ash-package.tar.gz")
    );
    assert_eq!(options.artifact.version().as_str(), "0.1.0");
    assert_eq!(
        options.artifact.platform().target_triple(),
        "x86_64-unknown-linux-gnu"
    );
    assert_eq!(
        options.artifact.integrity().archive_size(),
        NonZeroU64::new(4096).unwrap()
    );
    assert_eq!(options.artifact.integrity().sha256(), digest);
    assert_eq!(options.install_root.unwrap().as_str(), "/srv/ash/runtime");
    assert_eq!(options.progress, RemoteInstallProgressFormat::JsonLines);
}

#[test]
fn install_rejects_windows_zero_sizes_and_incomplete_records() {
    let base = [
        "install",
        "--host",
        "build-linux",
        "--archive",
        "/cache/ash-package.tar.gz",
        "--version",
        "0.1.0",
        "--target",
        "x86_64-pc-windows-msvc",
        "--archive-size",
        "1",
        "--unpacked-size",
        "1",
        "--sha256",
        "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ];
    assert!(
        parse(strings(base))
            .unwrap_err()
            .contains("unsupported POSIX")
    );
    assert!(
        parse(strings([
            "install",
            "--host",
            "build-linux",
            "--archive-size",
            "0"
        ]))
        .unwrap_err()
        .contains("positive integer")
    );
    assert!(
        parse(strings(["install", "--host", "build-linux"]))
            .unwrap_err()
            .contains("--archive-size is required")
    );
}

#[test]
fn profile_commands_require_a_credential_free_target_and_verified_runtime() {
    let get = parse(strings([
        "profile",
        "get",
        "--host",
        "build-linux",
        "--dir",
        "/srv/project",
    ]))
    .unwrap();
    let RemoteCommand::Profile(RemoteProfileCommand::Get(options)) = get else {
        panic!("expected profile get command");
    };
    assert_eq!(options.target.host().as_str(), "build-linux");
    assert_eq!(options.target.dir().as_str(), "/srv/project");

    let activate = parse(strings([
        "profile",
        "activate",
        "--host",
        "build-linux",
        "--dir",
        "/srv/project",
        "--runtime",
        "/srv/ash/runtime/bin/ash",
    ]))
    .unwrap();
    let RemoteCommand::Profile(RemoteProfileCommand::Activate(options)) = activate else {
        panic!("expected profile activate command");
    };
    assert_eq!(
        options.profile.runtime().executable(),
        "/srv/ash/runtime/bin/ash"
    );

    assert!(parse(strings(["profile", "get", "--host", "user@host"])).is_err());
    assert!(
        parse(strings([
            "profile",
            "activate",
            "--host",
            "build-linux",
            "--dir",
            "relative",
            "--runtime",
            "ash",
        ]))
        .is_err()
    );

    let rollback = parse(strings([
        "profile",
        "rollback",
        "--host",
        "build-linux",
        "--dir",
        "/srv/project",
        "--ssh",
        "/usr/bin/ssh",
    ]))
    .unwrap();
    let RemoteCommand::Profile(RemoteProfileCommand::Rollback(options)) = rollback else {
        panic!("expected profile rollback command");
    };
    assert_eq!(options.target.dir().as_str(), "/srv/project");
    assert_eq!(
        options.ssh_executable.as_deref(),
        Some(Path::new("/usr/bin/ssh"))
    );
}

#[test]
fn connection_commands_parse_shared_credential_free_catalog_operations() {
    let save = parse(strings([
        "connections",
        "save",
        "--name",
        "Build",
        "--host",
        "build-linux",
        "--dir",
        "/srv/project",
        "--mode",
        "replace",
    ]))
    .unwrap();
    let RemoteCommand::Connections(RemoteConnectionsCommand::Save { entry, mode }) = save else {
        panic!("expected connections save command");
    };
    assert_eq!(entry.name().as_str(), "build");
    assert_eq!(entry.target().host().as_str(), "build-linux");
    assert_eq!(entry.target().dir().as_str(), "/srv/project");
    assert_eq!(mode, RemoteConnectionSaveMode::Replace);

    let update = parse(strings([
        "connections",
        "update",
        "--name",
        "Build",
        "--new-name",
        "Production",
        "--host",
        "production-linux",
        "--dir",
        "/srv/production",
    ]))
    .unwrap();
    let RemoteCommand::Connections(RemoteConnectionsCommand::Update {
        original_name,
        entry,
    }) = update
    else {
        panic!("expected connections update command");
    };
    assert_eq!(original_name.as_str(), "build");
    assert_eq!(entry.name().as_str(), "production");
    assert_eq!(entry.target().host().as_str(), "production-linux");
    assert_eq!(entry.target().dir().as_str(), "/srv/production");

    assert_eq!(
        parse(strings(["connections", "list"])).unwrap(),
        RemoteCommand::Connections(RemoteConnectionsCommand::List)
    );
    let get = parse(strings(["connections", "get", "--name", "BUILD"])).unwrap();
    let RemoteCommand::Connections(RemoteConnectionsCommand::Get(name)) = get else {
        panic!("expected connections get command");
    };
    assert_eq!(name.as_str(), "build");
    assert!(parse(strings(["connections", "list", "--extra"])).is_err());
    assert!(
        parse(strings([
            "connections",
            "save",
            "--name",
            "build",
            "--host",
            "user@host",
            "--dir",
            "/srv/project",
        ]))
        .is_err()
    );
    assert!(
        parse(strings([
            "connections",
            "update",
            "--name",
            "build",
            "--new-name",
            "production",
            "--host",
            "production-linux",
        ]))
        .is_err()
    );
}

fn strings<const N: usize>(values: [&str; N]) -> Vec<String> {
    values.into_iter().map(str::to_owned).collect()
}

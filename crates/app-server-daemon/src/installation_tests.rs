use std::collections::BTreeMap;
use std::fs;
use std::path::Path;

use serde_json::json;
use sha2::Digest;
use sha2::Sha256;
use tempfile::TempDir;

use super::ClientSelection;
use super::clear_pin;
use super::install_from_client;
use super::selected_backend;
use super::selected_is_pinned;
use crate::process::PackageDigest;

#[test]
#[ignore = "requires an explicit package, Electron executable and benchmark output path"]
fn benchmark_package_installation() {
    let backend = std::path::PathBuf::from(
        std::env::var_os("ASH_DAEMON_BENCH_BACKEND").expect("ASH_DAEMON_BENCH_BACKEND"),
    );
    let electron = std::path::PathBuf::from(
        std::env::var_os("ASH_DAEMON_BENCH_ELECTRON").expect("ASH_DAEMON_BENCH_ELECTRON"),
    );
    let output = std::path::PathBuf::from(
        std::env::var_os("ASH_DAEMON_BENCH_OUTPUT").expect("ASH_DAEMON_BENCH_OUTPUT"),
    );
    let mut samples = Vec::new();
    for index in 0..5 {
        let directory = TempDir::new().unwrap();
        let profile = directory.path().join("profile");
        let started = std::time::Instant::now();
        crate::run_command(
            [
                "prepare-desktop".into(),
                "--profile".into(),
                profile.to_str().unwrap().into(),
                "--electron".into(),
                electron.to_str().unwrap().into(),
            ],
            &backend,
        )
        .unwrap();
        let elapsed_ms = started.elapsed().as_secs_f64() * 1000.0;
        let store =
            ash_package_store::PackageStore::open(profile.join("app-server-packages")).unwrap();
        let selected = store.current().unwrap().expect("published package");
        let identity =
            ash_package_store::validate_package_identity(&selected.package_root).unwrap();
        samples
            .push(json!({ "index": index, "elapsedMs": elapsed_ms, "buildId": identity.build_id }));
        fs::write(&output, serde_json::to_vec_pretty(&samples).unwrap()).unwrap();
        println!("ASH_PACKAGE_BENCH {index} {elapsed_ms:.1}ms");
    }
}

#[test]
fn desktop_preparation_publishes_once_without_starting_the_backend() {
    let directory = TempDir::new().unwrap();
    let first = package(directory.path(), "first", "0.1.0");
    let second = package(directory.path(), "second", "0.2.0");
    let profile = directory.path().join("profile");
    let electron = directory.path().join("Ash.exe");
    let arguments = [
        "prepare-desktop".into(),
        "--profile".into(),
        profile.to_str().unwrap().into(),
        "--electron".into(),
        electron.to_str().unwrap().into(),
    ];

    // The fixture provides its own Node runtime and never executes either binary.
    crate::run_command(arguments.clone(), &first).unwrap();
    crate::run_command(arguments, &second).unwrap();
    let store = ash_package_store::PackageStore::open(profile.join("app-server-packages")).unwrap();
    let selected = store.current().unwrap().unwrap();
    assert_eq!(selected.sequence, 1);
    assert_eq!(
        fs::read(super::backend_in(&selected.package_root)).unwrap(),
        b"0.1.0"
    );
    assert!(!selected_is_pinned(&profile).unwrap());
    assert!(!profile.join("state.sqlite3").exists());
}

#[test]
fn installation_publishes_all_resources_as_independent_copies() {
    let directory = TempDir::new().unwrap();
    let resources = (0..64)
        .map(|index| {
            (
                format!("resources/group-{}/file-{index}", index % 4),
                format!("resource-{index}"),
            )
        })
        .collect::<Vec<_>>();
    let contents = resources
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_bytes()))
        .collect::<Vec<_>>();
    let source = package_with_files(directory.path(), "client", "0.1.0", &contents);
    let source_root = source.parent().unwrap().parent().unwrap();
    let profile = directory.path().join("profile");
    let selected = install_from_client(&profile, &source, ClientSelection::Initial).unwrap();
    let installed_root = selected.parent().unwrap().parent().unwrap();
    for (name, value) in &resources {
        assert_eq!(
            fs::read(installed_root.join(name)).unwrap(),
            value.as_bytes()
        );
        fs::write(source_root.join(name), b"caller changed after installation").unwrap();
        assert_eq!(
            fs::read(installed_root.join(name)).unwrap(),
            value.as_bytes()
        );
    }
}

#[test]
fn failed_resource_copy_joins_writers_and_preserves_the_selected_package() {
    let directory = TempDir::new().unwrap();
    let first = package(directory.path(), "first", "0.1.0");
    let profile = directory.path().join("profile");
    let selected = install_from_client(&profile, &first, ClientSelection::Explicit).unwrap();
    let resources = (0..64)
        .map(|index| {
            (
                format!("resources/file-{index}"),
                format!("resource-{index}"),
            )
        })
        .collect::<Vec<_>>();
    let contents = resources
        .iter()
        .map(|(name, value)| (name.as_str(), value.as_bytes()))
        .collect::<Vec<_>>();
    let second = package_with_files(directory.path(), "second", "0.2.0", &contents);
    fs::remove_file(
        second
            .parent()
            .unwrap()
            .parent()
            .unwrap()
            .join(&resources[32].0),
    )
    .unwrap();

    assert!(install_from_client(&profile, &second, ClientSelection::Explicit).is_err());
    assert!(selected_is_pinned(&profile).unwrap());
    assert_eq!(
        selected_backend(&profile, &first, PackageDigest::NotProvided).unwrap(),
        selected
    );
    assert_eq!(fs::read(selected).unwrap(), b"0.1.0");
    assert!(
        fs::read_dir(profile.join("app-server-packages"))
            .unwrap()
            .all(|entry| {
                !entry
                    .unwrap()
                    .file_name()
                    .to_string_lossy()
                    .starts_with(".install-")
            })
    );
}

#[test]
fn clients_with_different_versions_keep_the_profile_backend_selection() {
    let directory = TempDir::new().unwrap();
    let first = package(directory.path(), "client-one", "0.1.0");
    let second = package(directory.path(), "client-two", "0.2.0");
    let profile = directory.path().join("profile");
    fs::create_dir(&profile).unwrap();

    let selected = selected_backend(&profile, &first, PackageDigest::NotProvided).unwrap();
    let later = selected_backend(&profile, &second, PackageDigest::NotProvided).unwrap();

    assert_eq!(later, selected);
    assert!(selected.starts_with(profile.join("app-server-packages")));
    assert_eq!(fs::read(selected).unwrap(), b"0.1.0");
    assert!(!selected_is_pinned(&profile).unwrap());

    let updated = install_from_client(&profile, &second, ClientSelection::Explicit).unwrap();
    fs::remove_dir_all(second.parent().unwrap().parent().unwrap()).unwrap();
    let old_client = selected_backend(&profile, &first, PackageDigest::NotProvided).unwrap();
    assert_eq!(old_client, updated);
    assert_eq!(fs::read(updated).unwrap(), b"0.2.0");
    assert!(selected_is_pinned(&profile).unwrap());
    clear_pin(&profile).unwrap();
    assert!(!selected_is_pinned(&profile).unwrap());
    let version = crate::run_lifecycle(
        crate::LifecycleCommand::Version,
        crate::ConnectionOptions::new(&profile, None, crate::GrantSource::HostConfiguration, None),
        &first,
    )
    .unwrap();
    assert_eq!(version.installed_version.as_deref(), Some("0.2.0"));
}

#[test]
fn signed_source_is_verified_only_when_installing_the_initial_generation() {
    let directory = TempDir::new().unwrap();
    let source = package(directory.path(), "client", "0.1.0");
    let profile = directory.path().join("profile");
    let expected = format!("{:x}", Sha256::digest(b"0.1.0"));
    let digest = PackageDigest::parse(&expected).unwrap();
    fs::write(&source, b"changed").unwrap();
    let error = selected_backend(&profile, &source, digest).unwrap_err();
    assert!(error.contains("signed package digest"), "{error}");

    fs::write(&source, b"0.1.0").unwrap();
    let installed = selected_backend(&profile, &source, digest).unwrap();
    fs::remove_file(&source).unwrap();
    assert_eq!(
        selected_backend(&profile, &source, digest).unwrap(),
        installed
    );
    assert_eq!(fs::read(installed).unwrap(), b"0.1.0");
}

#[test]
fn failed_explicit_install_keeps_the_previous_pin() {
    let directory = TempDir::new().unwrap();
    let first = package(directory.path(), "client-one", "0.1.0");
    let second = package(directory.path(), "client-two", "0.2.0");
    let profile = directory.path().join("profile");
    install_from_client(&profile, &first, ClientSelection::Explicit).unwrap();
    assert!(selected_is_pinned(&profile).unwrap());

    fs::write(&second, b"changed after packaging").unwrap();
    assert!(install_from_client(&profile, &second, ClientSelection::Explicit).is_err());
    assert!(selected_is_pinned(&profile).unwrap());
    assert_eq!(
        fs::read(selected_backend(&profile, &first, PackageDigest::NotProvided).unwrap()).unwrap(),
        b"0.1.0"
    );
}

#[test]
fn repeated_selection_repins_verified_contents_and_rejects_tampering() {
    let directory = TempDir::new().unwrap();
    let source = package(directory.path(), "client", "0.1.0");
    let profile = directory.path().join("profile");
    let selected = install_from_client(&profile, &source, ClientSelection::Explicit).unwrap();
    clear_pin(&profile).unwrap();
    assert_eq!(
        install_from_client(&profile, &source, ClientSelection::Explicit).unwrap(),
        selected
    );
    assert!(selected_is_pinned(&profile).unwrap());

    // An unchanged manifest does not authorize changed caller or installed bytes.
    fs::write(&source, b"changed caller").unwrap();
    assert!(install_from_client(&profile, &source, ClientSelection::Explicit).is_err());
    fs::write(&source, b"0.1.0").unwrap();
    fs::write(&selected, b"changed installed package").unwrap();
    assert!(install_from_client(&profile, &source, ClientSelection::Explicit).is_err());

    let update = package(directory.path(), "updated-client", "0.2.0");
    let updated = install_from_client(&profile, &update, ClientSelection::Explicit).unwrap();
    assert_eq!(fs::read(updated).unwrap(), b"0.2.0");
}

#[test]
fn release_backend_must_have_its_own_javascript_runtime() {
    let directory = TempDir::new().unwrap();
    let executable = package(directory.path(), "client", "0.1.0");
    let manifest_path = executable
        .parent()
        .unwrap()
        .parent()
        .unwrap()
        .join("ash-package.json");
    let mut manifest: serde_json::Value =
        serde_json::from_slice(&fs::read(&manifest_path).unwrap()).unwrap();
    manifest["javascriptRuntime"]["kind"] = json!("hostProvidedNode");
    fs::write(manifest_path, serde_json::to_vec(&manifest).unwrap()).unwrap();

    let error =
        install_from_client(directory.path(), &executable, ClientSelection::Initial).unwrap_err();
    assert_eq!(
        error,
        "App Server installation requires a self-contained package"
    );
}

#[test]
fn packaged_backend_must_be_the_manifest_entrypoint() {
    let directory = TempDir::new().unwrap();
    let executable = package(directory.path(), "client", "0.1.0");
    let other = executable.parent().unwrap().join("other-server");
    fs::copy(&executable, &other).unwrap();

    let error =
        install_from_client(directory.path(), &other, ClientSelection::Initial).unwrap_err();
    assert_eq!(
        error,
        "App Server executable does not match its package entrypoint"
    );
}

fn package(root: &Path, name: &str, version: &str) -> std::path::PathBuf {
    package_with_files(root, name, version, &[])
}

fn package_with_files(
    root: &Path,
    name: &str,
    version: &str,
    resources: &[(&str, &[u8])],
) -> std::path::PathBuf {
    let package = root.join(name);
    let bin = package.join("bin");
    fs::create_dir(&package).unwrap();
    fs::create_dir(&bin).unwrap();
    let binary = bin.join(if cfg!(windows) {
        "ash-app-server.exe"
    } else {
        "ash-app-server"
    });
    fs::write(&binary, version).unwrap();
    let relative = format!("bin/{}", binary.file_name().unwrap().to_string_lossy());
    let file_digest = format!("{:x}", Sha256::digest(version.as_bytes()));
    let mut files = BTreeMap::from([(relative, file_digest)]);
    for (name, contents) in resources {
        let path = package.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, contents).unwrap();
        files.insert((*name).into(), format!("{:x}", Sha256::digest(contents)));
    }
    let identity = json!({
        "buildProfile": "release",
        "javascriptRuntime": { "kind": "packagedNode" },
        "protocol": { "major": 1, "schemaHash": format!("sha256:{}", "a".repeat(64)) },
        "target": "aarch64-apple-darwin",
        "version": version,
    });
    let mut digest = Sha256::new();
    digest.update(b"ash-package-build-v2\0");
    digest.update(serde_json::to_vec(&identity).unwrap());
    digest.update(b"\0");
    for (path, file_digest) in &files {
        digest.update(path.as_bytes());
        digest.update(b"\0");
        digest.update(file_digest.as_bytes());
        digest.update(b"\0");
    }
    fs::write(
        package.join("ash-package.json"),
        serde_json::to_vec(&json!({
            "buildId": format!("sha256:{:x}", digest.finalize()),
            "buildProfile": "release",
            "files": files,
            "javascriptRuntime": { "kind": "packagedNode" },
            "protocol": { "major": 1, "schemaHash": format!("sha256:{}", "a".repeat(64)) },
            "target": "aarch64-apple-darwin",
            "version": version,
        }))
        .unwrap(),
    )
    .unwrap();
    binary
}

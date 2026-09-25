use super::*;
use ed25519_dalek::SigningKey;
use std::sync::Mutex;
use tempfile::TempDir;

#[test]
fn signed_release_requires_the_installed_key_and_exact_identity() {
    let target = current_target().unwrap();
    let bytes = signed_update("0.2.0", target, 17, &"11".repeat(32));
    let release = ash_product_update::verify_release(
        &bytes,
        update_public_key(),
        &ash_product_update::ExpectedRelease {
            product: ash_product_update::UpdateProduct::AshCode,
            policy: ash_tui::UpdatePolicy::Latest,
            target: target.into(),
        },
    )
    .unwrap();
    assert_eq!(release.version, Version::parse("0.2.0").unwrap());
    let mut tampered = bytes;
    let index = tampered.iter().position(|byte| *byte == b'2').unwrap();
    tampered[index] = b'3';
    assert!(
        ash_product_update::verify_release(
            &tampered,
            update_public_key(),
            &ash_product_update::ExpectedRelease {
                product: ash_product_update::UpdateProduct::AshCode,
                policy: ash_tui::UpdatePolicy::Latest,
                target: target.into(),
            },
        )
        .is_err()
    );
    assert!(
        ash_product_update::verify_release(
            &signed_update("0.2.0", "wrong-target", 17, &"11".repeat(32)),
            update_public_key(),
            &ash_product_update::ExpectedRelease {
                product: ash_product_update::UpdateProduct::AshCode,
                policy: ash_tui::UpdatePolicy::Latest,
                target: target.into(),
            },
        )
        .is_err()
    );
}

#[test]
fn managed_install_requires_the_selected_versioned_package() {
    let directory = TempDir::new().unwrap();
    let root = directory.path();
    fs::write(
        root.join(INSTALL_MARKER),
        br#"{"schemaVersion":1,"repository":"chogng/ash"}"#,
    )
    .unwrap();
    let package = root.join("versions/0.1.0-test");
    let executable = package
        .join("bin")
        .join(if cfg!(windows) { "ash.exe" } else { "ash" });
    fs::create_dir_all(executable.parent().unwrap()).unwrap();
    fs::write(&executable, b"ash").unwrap();
    write_installed_metadata(&package);
    select_for_test(root, "0.1.0-test");

    let install = ManagedInstall::detect(&executable).unwrap();

    assert_eq!(install.root, fs::canonicalize(root).unwrap());
    assert_eq!(install.package, fs::canonicalize(&package).unwrap());
    assert!(selected_managed_executable(&executable).unwrap());

    let other =
        root.join("versions/0.2.0-test/bin")
            .join(if cfg!(windows) { "ash.exe" } else { "ash" });
    fs::create_dir_all(other.parent().unwrap()).unwrap();
    fs::write(&other, b"ash").unwrap();
    write_installed_metadata(other.parent().unwrap().parent().unwrap());
    assert!(ManagedInstall::detect(&other).is_err());
    assert!(!selected_managed_executable(&other).unwrap());
}

#[test]
fn package_validation_checks_identity_file_set_and_digests() {
    let directory = TempDir::new().unwrap();
    let package = directory.path();
    let relative = if cfg!(windows) {
        "bin/ash.exe"
    } else {
        "bin/ash"
    };
    let executable = package.join(relative);
    fs::create_dir_all(executable.parent().unwrap()).unwrap();
    fs::write(&executable, b"ash-cli").unwrap();
    make_executable(&executable);
    let digest = file_sha256(&executable).unwrap();
    let version = Version::parse(env!("CARGO_PKG_VERSION")).unwrap();
    let target = current_target().unwrap();
    write_metadata(
        package,
        &version,
        target,
        BTreeMap::from([(relative.to_owned(), digest)]),
    );

    assert!(validate_package(package, &version, target).is_ok());

    fs::write(&executable, b"tampered").unwrap();
    assert!(
        validate_package(package, &version, target)
            .unwrap_err()
            .contains("failed validation")
    );
}

#[test]
fn package_extraction_rejects_links() {
    let directory = TempDir::new().unwrap();
    let archive_path = directory.path().join("package.tar.gz");
    let output = directory.path().join("output");
    fs::create_dir(&output).unwrap();
    let file = File::create(&archive_path).unwrap();
    let encoder = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut archive = tar::Builder::new(encoder);
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(tar::EntryType::Symlink);
    header.set_size(0);
    header.set_mode(0o777);
    header.set_cksum();
    archive
        .append_link(&mut header, "bin/ash", "../../outside")
        .unwrap();
    archive.into_inner().unwrap().finish().unwrap();

    assert!(
        extract_package(
            &archive_path,
            ash_product_update::PackageFormat::TarGz,
            &output,
        )
        .unwrap_err()
        .contains("unsupported type")
    );
}

#[test]
fn zip_package_extraction_preserves_executables_and_rejects_links() {
    let directory = TempDir::new().unwrap();
    let archive_path = directory.path().join("package.zip");
    let file = File::create(&archive_path).unwrap();
    let mut archive = zip::ZipWriter::new(file);
    let options = zip::write::SimpleFileOptions::default().unix_permissions(0o755);
    archive.add_directory("bin/", options).unwrap();
    archive.start_file("bin/ash", options).unwrap();
    archive.write_all(b"ash").unwrap();
    archive.finish().unwrap();
    let output = directory.path().join("output");
    fs::create_dir(&output).unwrap();

    extract_package(
        &archive_path,
        ash_product_update::PackageFormat::Zip,
        &output,
    )
    .unwrap();

    assert_eq!(fs::read(output.join("bin/ash")).unwrap(), b"ash");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert!(
            output
                .join("bin/ash")
                .metadata()
                .unwrap()
                .permissions()
                .mode()
                & 0o111
                != 0
        );
    }

    let linked_archive = directory.path().join("linked.zip");
    let file = File::create(&linked_archive).unwrap();
    let mut archive = zip::ZipWriter::new(file);
    archive
        .add_symlink("bin/ash", "../../outside", options)
        .unwrap();
    archive.finish().unwrap();
    let linked_output = directory.path().join("linked-output");
    fs::create_dir(&linked_output).unwrap();
    assert!(
        extract_package(
            &linked_archive,
            ash_product_update::PackageFormat::Zip,
            &linked_output,
        )
        .unwrap_err()
        .contains("unsupported type")
    );
}

#[test]
fn update_installs_a_verified_package_and_switches_the_managed_pointer() {
    let directory = TempDir::new().unwrap();
    let root = directory.path();
    fs::write(
        root.join(INSTALL_MARKER),
        br#"{"schemaVersion":1,"repository":"chogng/ash"}"#,
    )
    .unwrap();
    let old_package = root.join("versions/0.1.0-old");
    let old_executable =
        old_package
            .join("bin")
            .join(if cfg!(windows) { "ash.exe" } else { "ash" });
    fs::create_dir_all(old_executable.parent().unwrap()).unwrap();
    fs::write(&old_executable, b"old").unwrap();
    write_installed_metadata(&old_package);
    select_for_test(root, "0.1.0-old");
    let install = ManagedInstall::detect(&old_executable).unwrap();
    let target = current_target().unwrap();
    let latest = Version::parse("0.2.0").unwrap();
    let archive_name = format!("ash-code-{target}.tar.gz");
    let archive = package_archive(&latest, target);
    let digest = format!("{:x}", Sha256::digest(&archive));
    let signed_name = format!("ash-code-{target}.update.json");
    let signed = signed_update("0.2.0", target, archive.len() as u64, &digest);
    let release_archive_url = archive_url("0.2.0", target);
    let release = serde_json::to_vec(&serde_json::json!({
        "tag_name": "v0.2.0",
        "assets": [
            { "name": archive_name, "browser_download_url": release_archive_url, "size": archive.len() },
            { "name": signed_name, "browser_download_url": "signed", "size": signed.len() }
        ]
    }))
    .unwrap();
    let transport = FakeTransport(Mutex::new(BTreeMap::from([
        (RELEASE_API.to_owned(), release),
        ("signed".to_owned(), signed),
        (archive_url("0.2.0", target), archive),
    ])));

    let outcome = run_for_install(
        &install,
        Version::parse("0.1.0").unwrap(),
        target,
        ash_tui::UpdatePolicy::Latest,
        UpdateMode::Manual,
        &transport,
    )
    .unwrap();

    assert_eq!(
        outcome,
        UpdateOutcome::Installed {
            previous: Version::parse("0.1.0").unwrap(),
            current: latest,
        }
    );
    let selected = selected_for_test(root);
    assert!(selected.starts_with("0.2.0-"));
    assert!(root.join("versions").join(selected).is_dir());
}

#[test]
fn stable_policy_uses_only_the_signed_promoted_release() {
    let target = current_target().unwrap();
    let descriptor_url = format!(
        "https://github.com/{REPOSITORY}/releases/download/ash-code-stable/ash-code-stable-{target}.update.json"
    );
    let signed = signed_update_with_policy(
        "0.2.0",
        target,
        17,
        &"11".repeat(32),
        ash_tui::UpdatePolicy::Stable,
    );
    let transport = FakeTransport(Mutex::new(BTreeMap::from([(descriptor_url, signed)])));

    let release = resolve_release(
        update_public_key(),
        target,
        ash_tui::UpdatePolicy::Stable,
        &transport,
    )
    .unwrap();

    assert_eq!(release.release.version, Version::parse("0.2.0").unwrap());
    assert_eq!(
        release.archive_url,
        format!(
            "https://github.com/{REPOSITORY}/releases/download/v0.2.0/ash-code-{target}.tar.gz"
        )
    );
}

#[test]
fn update_status_preserves_success_failure_and_readable_age() {
    let current = Version::parse("1.2.3").unwrap();
    let installed = UpdateStatus::from_result(
        current.clone(),
        ash_tui::UpdatePolicy::Stable,
        &Ok(UpdateOutcome::Installed {
            previous: current.clone(),
            current: Version::parse("1.3.0").unwrap(),
        }),
    )
    .unwrap();
    let encoded = serde_json::to_value(&installed).unwrap();
    assert_eq!(encoded["currentVersion"], "1.2.3");
    assert_eq!(encoded["policy"], "stable");
    assert_eq!(encoded["result"]["state"], "installed");
    assert_eq!(encoded["result"]["version"], "1.3.0");

    let failed = UpdateStatus::from_result(
        current,
        ash_tui::UpdatePolicy::Latest,
        &Err("signature rejected".into()),
    )
    .unwrap();
    let encoded = serde_json::to_value(&failed).unwrap();
    assert_eq!(encoded["result"]["state"], "failed");
    assert_eq!(encoded["result"]["message"], "signature rejected");
    assert_eq!(elapsed_label(59), "59s");
    assert_eq!(elapsed_label(60), "1m");
    assert_eq!(elapsed_label(60 * 60), "1h");
    assert_eq!(elapsed_label(24 * 60 * 60), "1d");
}

struct FakeTransport(Mutex<BTreeMap<String, Vec<u8>>>);

impl Transport for FakeTransport {
    fn fetch(&self, url: &str, maximum: usize) -> Result<Vec<u8>, String> {
        let bytes = self
            .0
            .lock()
            .unwrap()
            .get(url)
            .cloned()
            .ok_or_else(|| format!("missing fixture for {url}"))?;
        if bytes.len() > maximum {
            return Err("fixture exceeds the requested limit".into());
        }
        Ok(bytes)
    }
}

fn package_archive(version: &Version, target: &str) -> Vec<u8> {
    let directory = TempDir::new().unwrap();
    let package = directory.path();
    let relative = if cfg!(windows) {
        "bin/ash.exe"
    } else {
        "bin/ash"
    };
    let executable = package.join(relative);
    fs::create_dir_all(executable.parent().unwrap()).unwrap();
    fs::write(&executable, b"new-ash").unwrap();
    make_executable(&executable);
    write_metadata(
        package,
        version,
        target,
        BTreeMap::from([(relative.to_owned(), file_sha256(&executable).unwrap())]),
    );
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut archive = tar::Builder::new(encoder);
    archive.append_dir("bin", package.join("bin")).unwrap();
    archive
        .append_path_with_name(&executable, relative)
        .unwrap();
    archive
        .append_path_with_name(package.join("ash-package.json"), "ash-package.json")
        .unwrap();
    archive.into_inner().unwrap().finish().unwrap()
}

fn write_metadata(
    package: &Path,
    version: &Version,
    target: &str,
    files: BTreeMap<String, String>,
) {
    let cli_digest = files.values().next().unwrap().clone();
    fs::write(
        package.join("ash-package.json"),
        serde_json::to_vec(&serde_json::json!({
            "layoutVersion": 2,
            "version": version.to_string(),
            "target": target,
            "buildId": format!("sha256:{}", "a".repeat(64)),
            "files": files,
            "components": {
                "cli": {
                    "binarySha256": cli_digest,
                    "updatePublicKey": hex(&update_public_key().as_bytes())
                }
            }
        }))
        .unwrap(),
    )
    .unwrap();
}

fn write_installed_metadata(package: &Path) {
    fs::write(
        package.join("ash-package.json"),
        serde_json::to_vec(&serde_json::json!({
            "components": {
                "cli": { "updatePublicKey": hex(&update_public_key().as_bytes()) }
            }
        }))
        .unwrap(),
    )
    .unwrap();
}

fn signed_update(version: &str, target: &str, size: u64, sha256: &str) -> Vec<u8> {
    signed_update_with_policy(version, target, size, sha256, ash_tui::UpdatePolicy::Latest)
}

fn signed_update_with_policy(
    version: &str,
    target: &str,
    size: u64,
    sha256: &str,
    policy: ash_tui::UpdatePolicy,
) -> Vec<u8> {
    ash_product_update::sign_release(
        ash_product_update::ReleaseInput {
            product: ash_product_update::UpdateProduct::AshCode,
            policy,
            version: Version::parse(version).unwrap(),
            release_identity: format!("v{version}"),
            target: target.into(),
            package: ash_product_update::ReleasePackageInput {
                url: archive_url(version, target),
                file_name: format!("ash-code-{target}.tar.gz"),
                format: ash_product_update::PackageFormat::TarGz,
                size,
                sha256: sha256.into(),
            },
        },
        &SigningKey::from_bytes(&[7u8; 32]),
    )
    .unwrap()
}

fn update_public_key() -> ash_product_update::UpdatePublicKey {
    ash_product_update::UpdatePublicKey::from_bytes(
        SigningKey::from_bytes(&[7u8; 32])
            .verifying_key()
            .to_bytes(),
    )
}

fn archive_url(version: &str, target: &str) -> String {
    format!("https://github.com/{REPOSITORY}/releases/download/v{version}/ash-code-{target}.tar.gz")
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

#[cfg(unix)]
fn select_for_test(root: &Path, name: &str) {
    std::os::unix::fs::symlink(Path::new("versions").join(name), root.join("current")).unwrap();
}

#[cfg(unix)]
fn selected_for_test(root: &Path) -> String {
    fs::read_link(root.join("current"))
        .unwrap()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned()
}

#[cfg(unix)]
fn make_executable(path: &Path) {
    use std::os::unix::fs::PermissionsExt;
    let mut permissions = path.metadata().unwrap().permissions();
    permissions.set_mode(0o755);
    fs::set_permissions(path, permissions).unwrap();
}

#[cfg(windows)]
fn make_executable(_path: &Path) {}

#[cfg(windows)]
fn select_for_test(root: &Path, name: &str) {
    fs::write(root.join("current"), name).unwrap();
}

#[cfg(windows)]
fn selected_for_test(root: &Path) -> String {
    fs::read_to_string(root.join("current")).unwrap()
}

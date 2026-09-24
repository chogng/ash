use ed25519_dalek::SigningKey;
use futures::executor::block_on;

use super::AppVersion;
use super::DisabledUpdates;
use super::ExternalUrl;
use super::SignedHttpUpdater;
use super::SystemServiceError;
use super::UpdateConfig;
use super::UpdateHandle;
use super::UpdateInstaller;
use super::UpdatePublicKey;
use super::UpdateService;
use super::UpdateTransport;

#[test]
fn disabled_update_handle_reports_unsupported_asynchronously() {
    let error = block_on(UpdateHandle::new(DisabledUpdates).check()).unwrap_err();

    assert!(error.is_unsupported());
}

struct StaticTransport(Vec<u8>);

impl UpdateTransport for StaticTransport {
    fn get(&self, _url: &ExternalUrl) -> Result<Vec<u8>, SystemServiceError> {
        Ok(self.0.clone())
    }
}

struct NoopInstaller;

impl UpdateInstaller for NoopInstaller {
    fn launch(&self, _path: &std::path::Path) -> Result<(), SystemServiceError> {
        Ok(())
    }
}

fn signed_manifest(signing_key: &SigningKey, version: &str) -> Vec<u8> {
    ash_product_update::sign_release(
        ash_product_update::ReleaseInput {
            product: ash_product_update::UpdateProduct::RustDesktop,
            policy: ash_product_update::UpdatePolicy::Latest,
            version: semver::Version::parse(version).unwrap(),
            release_identity: format!("v{version}"),
            target: "aarch64-apple-darwin".into(),
            package: ash_product_update::ReleasePackageInput {
                url: "https://example.com/demo.pkg".into(),
                file_name: "demo.pkg".into(),
                format: ash_product_update::PackageFormat::MacOsPackage,
                size: 7,
                sha256: "00".repeat(32),
            },
        },
        signing_key,
    )
    .unwrap()
}

fn updater(bytes: Vec<u8>, signing_key: &SigningKey) -> SignedHttpUpdater {
    SignedHttpUpdater::with_backends(
        UpdateConfig::new(
            ExternalUrl::parse("https://example.com/updates.json").unwrap(),
            AppVersion::parse("1.2.3").unwrap(),
            "aarch64-apple-darwin",
            UpdatePublicKey::from_bytes(signing_key.verifying_key().to_bytes()),
            "/tmp/zui-update-tests",
            ash_product_update::UpdateProduct::RustDesktop,
            ash_product_update::UpdatePolicy::Latest,
            ash_product_update::PackageFormat::MacOsPackage,
        ),
        StaticTransport(bytes),
        NoopInstaller,
    )
}

#[test]
fn signed_manifest_selects_a_newer_target_artifact() {
    let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
    let release = updater(signed_manifest(&signing_key, "1.3.0"), &signing_key)
        .check()
        .unwrap()
        .unwrap();
    assert_eq!(release.version.to_string(), "1.3.0");
    assert_eq!(release.artifact.file_name, "demo.pkg");
}

#[test]
fn signed_manifest_ignores_current_or_older_versions() {
    let signing_key = SigningKey::from_bytes(&[8_u8; 32]);
    assert!(
        updater(signed_manifest(&signing_key, "1.2.3"), &signing_key)
            .check()
            .unwrap()
            .is_none()
    );
}

#[test]
fn modified_manifest_payload_fails_strict_signature_verification() {
    let signing_key = SigningKey::from_bytes(&[9_u8; 32]);
    let mut bytes = signed_manifest(&signing_key, "2.0.0");
    let position = bytes
        .windows("2.0.0".len())
        .position(|window| window == b"2.0.0")
        .unwrap();
    bytes[position] = b'3';
    assert!(updater(bytes, &signing_key).check().is_err());
}

#[test]
fn artifact_download_rejects_bytes_with_the_wrong_sha256() {
    let signing_key = SigningKey::from_bytes(&[10_u8; 32]);
    let backend = updater(signed_manifest(&signing_key, "2.0.0"), &signing_key);
    let release = backend.check().unwrap().unwrap();
    assert!(backend.download(release).is_err());
}

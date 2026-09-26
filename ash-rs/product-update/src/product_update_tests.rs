use super::*;
use ed25519_dalek::SigningKey;
use sha2::Digest;

#[test]
fn signed_release_round_trips_through_the_shared_contract() {
    let key = SigningKey::from_bytes(&[7u8; 32]);
    let bytes = sign_release(release(UpdatePolicy::Latest), &key).unwrap();

    let verified = verify_release(
        &bytes,
        UpdatePublicKey::from_bytes(key.verifying_key().to_bytes()),
        &ExpectedRelease {
            product: UpdateProduct::AshCode,
            policy: UpdatePolicy::Latest,
            target: "aarch64-apple-darwin".into(),
        },
    )
    .unwrap();

    assert_eq!(verified.version, Version::parse("1.2.3").unwrap());
    assert_eq!(verified.package.format, PackageFormat::TarGz);
    assert_eq!(verified.package.sha256, [0x11; 32]);
}

#[test]
fn signature_and_identity_mismatches_are_rejected() {
    let key = SigningKey::from_bytes(&[7u8; 32]);
    let mut bytes = sign_release(release(UpdatePolicy::Latest), &key).unwrap();
    let position = bytes
        .windows("1.2.3".len())
        .position(|window| window == b"1.2.3")
        .unwrap();
    bytes[position] = b'9';
    assert!(verify(&bytes, &key, UpdatePolicy::Latest).is_err());

    let bytes = sign_release(release(UpdatePolicy::Stable), &key).unwrap();
    assert!(verify(&bytes, &key, UpdatePolicy::Latest).is_err());
}

#[test]
fn signer_rejects_never_insecure_urls_paths_and_empty_packages() {
    let key = SigningKey::from_bytes(&[7u8; 32]);
    assert!(sign_release(release(UpdatePolicy::Never), &key).is_err());

    let mut insecure = release(UpdatePolicy::Latest);
    insecure.package.url = "http://example.test/ash.tar.gz".into();
    assert!(sign_release(insecure, &key).is_err());

    let mut path = release(UpdatePolicy::Latest);
    path.package.file_name = "../ash.tar.gz".into();
    assert!(sign_release(path, &key).is_err());

    let mut empty = release(UpdatePolicy::Latest);
    empty.package.size = 0;
    assert!(sign_release(empty, &key).is_err());
}

#[test]
fn staging_requires_the_signed_size_and_digest_before_publishing() {
    let staging = tempfile::tempdir().unwrap();
    let bytes = b"verified desktop package";
    let package = VerifiedPackage {
        url: "https://github.com/chogng/ash/releases/download/v1/AshSetup.exe".into(),
        file_name: "AshSetup.exe".into(),
        format: PackageFormat::WindowsExe,
        size: bytes.len() as u64,
        sha256: sha2::Sha256::digest(bytes).into(),
    };
    assert!(stage_package_reader(&package, staging.path(), &b"altered desktop package"[..]).is_err());
    assert!(!staging.path().join(&package.file_name).exists());
    assert!(!staging.path().join(format!(".{}.part", package.file_name)).exists());
    let staged = stage_package_reader(&package, staging.path(), &bytes[..]).unwrap();
    assert_eq!(std::fs::read(staged).unwrap(), bytes);
}

fn verify(
    bytes: &[u8],
    key: &SigningKey,
    policy: UpdatePolicy,
) -> Result<VerifiedRelease, UpdateError> {
    verify_release(
        bytes,
        UpdatePublicKey::from_bytes(key.verifying_key().to_bytes()),
        &ExpectedRelease {
            product: UpdateProduct::AshCode,
            policy,
            target: "aarch64-apple-darwin".into(),
        },
    )
}

fn release(policy: UpdatePolicy) -> ReleaseInput {
    ReleaseInput {
        product: UpdateProduct::AshCode,
        policy,
        version: Version::parse("1.2.3").unwrap(),
        release_identity: "v1.2.3".into(),
        target: "aarch64-apple-darwin".into(),
        package: ReleasePackageInput {
            url: "https://github.com/chogng/ash/releases/download/v1.2.3/ash-code-aarch64-apple-darwin.tar.gz".into(),
            file_name: "ash-code-aarch64-apple-darwin.tar.gz".into(),
            format: PackageFormat::TarGz,
            size: 17,
            sha256: "11".repeat(32),
        },
    }
}

use super::*;
use ed25519_dalek::Signature;
use ed25519_dalek::Verifier;
use serde::Deserialize;
use tempfile::TempDir;

#[test]
fn arguments_require_each_named_value() {
    let parsed = Arguments::parse(vec![
        "--repository".into(),
        "chogng/ash".into(),
        "--product".into(),
        "ash-code".into(),
        "--channel".into(),
        "latest".into(),
        "--version".into(),
        "1.2.3".into(),
        "--release-tag".into(),
        "v1.2.3".into(),
        "--target".into(),
        "aarch64-apple-darwin".into(),
        "--format".into(),
        "tar-gz".into(),
        "--archive".into(),
        "archive.tar.gz".into(),
        "--output".into(),
        "update.json".into(),
        "--public-key".into(),
        "11".repeat(32),
    ])
    .unwrap();
    assert_eq!(parsed.repository, "chogng/ash");
    assert_eq!(parsed.product, "ash-code");
    assert_eq!(parsed.channel, "latest");
    assert_eq!(parsed.version, "1.2.3");
    assert!(Arguments::parse(vec!["--version".into()]).is_err());
    assert!(Arguments::parse(vec!["--unknown".into(), "value".into()]).is_err());
}

#[test]
fn signing_key_accepts_hex_and_base64_seed() {
    let seed = [7u8; 32];
    let hex = seed
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let base64 = base64::engine::general_purpose::STANDARD.encode(seed);
    assert_eq!(decode_signing_key(&hex).unwrap().to_bytes(), seed);
    assert_eq!(decode_signing_key(&base64).unwrap().to_bytes(), seed);
    assert!(decode_signing_key("short").is_err());
    assert_eq!(public_key(&hex).unwrap().len(), 64);
}

#[test]
fn release_descriptor_signs_the_exact_archive_identity() {
    let directory = TempDir::new().unwrap();
    let archive = directory
        .path()
        .join("ash-code-aarch64-apple-darwin.tar.gz");
    fs::write(&archive, b"archive").unwrap();
    let output = directory.path().join("update.json");
    let signing_key = SigningKey::from_bytes(&[7u8; 32]);
    let public_key = signing_key
        .verifying_key()
        .to_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();

    sign_release(
        Arguments {
            repository: "chogng/ash".into(),
            product: "ash-code".into(),
            channel: "latest".into(),
            version: "1.2.3".into(),
            release_tag: "v1.2.3".into(),
            target: "aarch64-apple-darwin".into(),
            format: "tar-gz".into(),
            archive,
            output: output.clone(),
            public_key,
        },
        &"07".repeat(32),
    )
    .unwrap();

    #[derive(Deserialize)]
    struct Envelope {
        payload: String,
        signature: String,
    }
    let envelope: Envelope = serde_json::from_slice(&fs::read(output).unwrap()).unwrap();
    let signature = base64::engine::general_purpose::STANDARD
        .decode(envelope.signature)
        .unwrap();
    signing_key
        .verifying_key()
        .verify(
            envelope.payload.as_bytes(),
            &Signature::try_from(signature.as_slice()).unwrap(),
        )
        .unwrap();
    let payload: serde_json::Value = serde_json::from_str(&envelope.payload).unwrap();
    assert_eq!(
        payload,
        serde_json::json!({
            "schemaVersion": 1,
            "product": "ashCode",
            "channel": "latest",
            "version": "1.2.3",
            "releaseIdentity": "v1.2.3",
            "target": "aarch64-apple-darwin",
            "package": {
                "url": "https://github.com/chogng/ash/releases/download/v1.2.3/ash-code-aarch64-apple-darwin.tar.gz",
                "fileName": "ash-code-aarch64-apple-darwin.tar.gz",
                "format": "tarGz",
                "size": 7,
                "sha256": "0eb3e36bfb24dcd9bb1d1bece1531216b59539a8fde17ee80224af0653c92aa3"
            }
        })
    );
}

#[test]
fn release_descriptor_rejects_unversioned_tags_and_unknown_channels() {
    let directory = TempDir::new().unwrap();
    let archive = directory
        .path()
        .join("ash-code-aarch64-apple-darwin.tar.gz");
    fs::write(&archive, b"archive").unwrap();
    let signing_key = SigningKey::from_bytes(&[7u8; 32]);
    let public_key = signing_key
        .verifying_key()
        .to_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let arguments = |channel: &str, release_tag: &str, output: &str| Arguments {
        repository: "chogng/ash".into(),
        product: "ash-code".into(),
        channel: channel.into(),
        version: "1.2.3".into(),
        release_tag: release_tag.into(),
        target: "aarch64-apple-darwin".into(),
        format: "tar-gz".into(),
        archive: archive.clone(),
        output: directory.path().join(output),
        public_key: public_key.clone(),
    };

    assert!(
        sign_release(
            arguments("preview", "v1.2.3", "preview.json"),
            &"07".repeat(32)
        )
        .is_err()
    );
    assert!(
        sign_release(
            arguments("latest", "release-1.2.3", "tag.json"),
            &"07".repeat(32)
        )
        .is_err()
    );
}

use super::*;
use ash_product_update::ReleaseInput;
use ash_product_update::ReleasePackageInput;
use ash_product_update::sign_release;
use ed25519_dalek::SigningKey;
use serde_json::json;

#[test]
fn host_accepts_typed_check_and_download_requests() {
    let check: HostRequest = serde_json::from_value(json!({
        "command": "check", "currentVersion": "0.1.0", "publicKey": "a".repeat(64),
        "target": "x86_64-pc-windows-msvc"
    })).unwrap();
    assert!(matches!(check.command, HostCommand::Check));
    let download: HostRequest = serde_json::from_value(json!({
        "command": "download", "currentVersion": "0.1.0", "publicKey": "a".repeat(64),
        "target": "x86_64-pc-windows-msvc", "stagingDirectory": "C:/Ash/updates"
    })).unwrap();
    assert!(matches!(download.command, HostCommand::Download));
    assert_eq!(download.staging_directory, Some(PathBuf::from("C:/Ash/updates")));
}

fn signed_fixture(version: &str, target: &str) -> (CheckRequest, Vec<u8>, Vec<u8>) {
    let signing_key = SigningKey::from_bytes(&[7; 32]);
    let public_key: String = signing_key
        .verifying_key()
        .to_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect();
    let file_name = "AshSetup-0.2.0-win32-x64.exe";
    let tag = format!("v{version}");
    let package_url =
        format!("https://github.com/{REPOSITORY}/releases/download/{tag}/{file_name}");
    let descriptor_name = format!("ash-desktop-{target}.update.json");
    let descriptor_url =
        format!("https://github.com/{REPOSITORY}/releases/download/{tag}/{descriptor_name}");
    let manifest = sign_release(
        ReleaseInput {
            product: UpdateProduct::ElectronDesktop,
            policy: UpdatePolicy::Latest,
            version: Version::parse(version).unwrap(),
            release_identity: tag.clone(),
            target: target.into(),
            package: ReleasePackageInput {
                url: package_url.clone(),
                file_name: file_name.into(),
                format: package_format(),
                size: 42,
                sha256: "a".repeat(64),
            },
        },
        &signing_key,
    )
    .unwrap();
    let release = serde_json::to_vec(&json!([{
        "tag_name": tag,
        "draft": false,
        "prerelease": false,
        "assets": [
            { "name": descriptor_name, "size": manifest.len(), "browser_download_url": descriptor_url },
            { "name": file_name, "size": 42, "browser_download_url": package_url }
        ]
    }]))
    .unwrap();
    (
        CheckRequest {
            current_version: "0.1.0".into(),
            public_key,
            target: target.into(),
            policy: UpdatePolicy::Latest,
        },
        release,
        manifest,
    )
}

#[test]
fn signed_desktop_release_reports_a_new_version_and_current_version() {
    let target = "x86_64-pc-windows-msvc";
    let (mut request, release, manifest) = signed_fixture("0.2.0", target);
    let transport = |url: &str, _| {
        if url == RELEASE_API {
            Ok(release.clone())
        } else {
            Ok(manifest.clone())
        }
    };
    assert_eq!(
        check_release(&request, transport).unwrap(),
        CheckResult::Available {
            current_version: "0.1.0".into(),
            version: "0.2.0".into()
        }
    );
    request.current_version = "0.2.0".into();
    assert_eq!(
        check_release(&request, transport).unwrap(),
        CheckResult::Current {
            version: "0.2.0".into()
        }
    );
}

#[test]
fn altered_or_wrong_target_release_cannot_be_reported_as_available() {
    let target = "x86_64-pc-windows-msvc";
    let (request, release, manifest) = signed_fixture("0.2.0", target);
    let mut invalid = serde_json::from_slice::<serde_json::Value>(&manifest).unwrap();
    invalid["payload"] = json!("{}");
    let altered = serde_json::to_vec(&invalid).unwrap();
    assert!(
        check_release(&request, |url, _| {
            if url == RELEASE_API {
                Ok(release.clone())
            } else {
                Ok(altered.clone())
            }
        })
        .is_err()
    );

    let mut wrong_target = request;
    wrong_target.target = "aarch64-apple-darwin".into();
    assert!(
        check_release(&wrong_target, |url, _| {
            if url == RELEASE_API {
                Ok(release.clone())
            } else {
                Ok(manifest.clone())
            }
        })
        .is_err()
    );
}

#[test]
fn stable_check_uses_only_the_signed_promoted_pointer() {
    let target = "x86_64-pc-windows-msvc";
    let (mut request, _, _) = signed_fixture("0.2.0", target);
    request.policy = UpdatePolicy::Stable;
    let signing_key = SigningKey::from_bytes(&[7; 32]);
    let name = "AshSetup-0.2.0-win32-x64.exe";
    let manifest = sign_release(
        ReleaseInput {
            product: UpdateProduct::ElectronDesktop,
            policy: UpdatePolicy::Stable,
            version: Version::parse("0.2.0").unwrap(),
            release_identity: "v0.2.0".into(),
            target: target.into(),
            package: ReleasePackageInput {
                url: format!("https://github.com/{REPOSITORY}/releases/download/v0.2.0/{name}"),
                file_name: name.into(),
                format: package_format(),
                size: 42,
                sha256: "a".repeat(64),
            },
        },
        &signing_key,
    )
    .unwrap();
    let expected_url = format!(
        "https://github.com/{REPOSITORY}/releases/download/ash-desktop-stable/ash-desktop-stable-{target}.update.json"
    );
    assert_eq!(
        check_release(&request, |url, _| {
            assert_eq!(url, expected_url);
            Ok(manifest.clone())
        })
        .unwrap(),
        CheckResult::Available {
            current_version: "0.1.0".into(),
            version: "0.2.0".into(),
        }
    );
}

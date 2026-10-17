use super::*;

#[test]
fn plugin_versions_are_strict_semver() {
    assert_eq!(
        PluginVersion::new("1.2.3-alpha.1+build.4")
            .unwrap()
            .to_string(),
        "1.2.3-alpha.1+build.4"
    );
    assert_eq!(
        PluginVersion::new("1.2"),
        Err(InvalidPluginVersion::InvalidSemver)
    );
    assert_eq!(
        PluginVersion::new("v1.2.3"),
        Err(InvalidPluginVersion::InvalidSemver)
    );
}

#[test]
fn package_digests_are_self_describing_and_canonical() {
    let digest = PluginPackageDigest::sha256(b"package");
    assert_eq!(
        digest.as_str(),
        "sha256:bc4a71180870f7945155fbb02f4b0a2e3faa2a62d6d31b7039013055ed19869a"
    );
    assert_eq!(
        PluginPackageDigest::new(digest.to_string()).unwrap(),
        digest
    );
    assert!(PluginPackageDigest::new("abc").is_err());
    assert!(PluginPackageDigest::new(format!("sha256:{}", "A".repeat(64))).is_err());
}

#[test]
fn identity_types_validate_during_deserialization() {
    assert!(serde_json::from_str::<PluginVersion>("\"latest\"").is_err());
    assert!(
        serde_json::from_str::<PluginPackageDigest>(&format!("\"sha256:{}\"", "0".repeat(64)))
            .is_ok()
    );
}

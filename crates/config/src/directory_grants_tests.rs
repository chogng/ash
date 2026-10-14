use super::*;
use ash_file_access::Permission;

fn identity() -> DirId {
    format!("sha256:{}", "ab".repeat(32)).parse().unwrap()
}

#[test]
fn missing_directory_has_no_permissions() {
    assert_eq!(
        DirectoryGrantsConfig::default().permissions_for(&identity()),
        Permissions::default()
    );
}

#[test]
fn persisted_permissions_are_explicit() {
    let dir = identity();
    let permissions = Permissions::new([Permission::ReadFiles]);
    let config = DirectoryGrantsConfig {
        entries: BTreeMap::from([(dir.clone(), permissions.clone())]),
        ..DirectoryGrantsConfig::default()
    };

    assert_eq!(config.explicit_permissions_for(&dir), Some(&permissions));
}

#[test]
fn legacy_profile_key_preserves_fine_grained_and_empty_grants() {
    let dir = identity();
    let empty: DirId = format!("sha256:{}", "cd".repeat(32)).parse().unwrap();
    let source = format!(
        r#"schemaVersion = 10
[dirPermissions.entries]
"{dir}" = ["readFiles", "useLanguageServices"]
"{empty}" = []
[dirPermissions.paths]
"{dir}" = "/tmp/ash-directory-grants"
"#
    );
    let decoded = crate::document_migration::decode(&source).unwrap();
    assert!(!decoded.rewrite_required);
    let grants = &decoded.document.directory_grants;
    assert_eq!(
        grants.permissions_for(&dir),
        Permissions::new([Permission::ReadFiles, Permission::UseLanguageServices])
    );
    assert_eq!(
        grants.explicit_permissions_for(&empty),
        Some(&Permissions::default())
    );
    assert_eq!(
        grants.path_for(&dir),
        Some(Path::new("/tmp/ash-directory-grants"))
    );
    let encoded = crate::document_migration::encode(&decoded.document).unwrap();
    assert!(encoded.contains("[dirPermissions.entries]"));
    assert!(!encoded.contains("directoryGrants"));
    assert_eq!(
        crate::document_migration::decode(&encoded)
            .unwrap()
            .document
            .directory_grants,
        *grants
    );
    assert!(
        crate::document_migration::decode(
            &source.replace("useLanguageServices", "unknownCapability")
        )
        .is_err()
    );
}

#[test]
fn command_serialization_preserves_existing_receipt_identity() {
    for command in [
        serde_json::json!({"type":"setDirPermissions", "dir":identity(), "permissions":["readFiles"], "display_path":"/tmp/ash-directory-grants"}),
        serde_json::json!({"type":"forgetDirPermissions", "dir":identity()}),
    ] {
        let decoded: crate::UserConfigCommand = serde_json::from_value(command.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), command);
    }
}

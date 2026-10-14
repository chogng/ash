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
    assert!(decoded.rewrite_required);
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
    assert!(encoded.contains("[directoryGrants.entries]"));
    assert!(!encoded.contains("dirPermissions"));
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
fn commands_use_only_the_current_directory_grant_contract() {
    for command in [
        serde_json::json!({"type":"setDirectoryGrant", "dir":identity(), "permissions":["readFiles"], "display_path":"/tmp/ash-directory-grants"}),
        serde_json::json!({"type":"forgetDirectoryGrant", "dir":identity()}),
    ] {
        let decoded: crate::UserConfigCommand = serde_json::from_value(command.clone()).unwrap();
        assert_eq!(serde_json::to_value(decoded).unwrap(), command);
    }
}

#[test]
fn current_documents_and_commands_reject_retired_contracts() {
    let source = format!(
        "schemaVersion = {}\n[dirPermissions.entries]\n",
        crate::CONFIG_FILE_SCHEMA_VERSION
    );
    assert!(crate::document_migration::decode(&source).is_err());
    for tag in ["setDirPermissions", "forgetDirPermissions"] {
        assert!(
            serde_json::from_value::<crate::UserConfigCommand>(serde_json::json!({
                "type":tag, "dir":identity(), "permissions":["readFiles"]
            }))
            .is_err()
        );
    }
    assert!(
        crate::document_migration::decode(
            "schemaVersion = 10\n[dirPermissions]\n[directoryGrants]\n"
        )
        .is_err()
    );
}

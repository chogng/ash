use super::*;
use ash_file_access::Permission;

fn identity() -> DirId {
    format!("sha256:{}", "ab".repeat(32)).parse().unwrap()
}

#[test]
fn missing_directory_has_no_permissions() {
    assert_eq!(
        DirPermissionsConfig::default().permissions_for(&identity()),
        Permissions::default()
    );
}

#[test]
fn persisted_permissions_are_explicit() {
    let dir = identity();
    let permissions = Permissions::new([Permission::ReadFiles]);
    let config = DirPermissionsConfig {
        entries: BTreeMap::from([(dir.clone(), permissions.clone())]),
        ..DirPermissionsConfig::default()
    };

    assert_eq!(config.explicit_permissions_for(&dir), Some(&permissions));
}

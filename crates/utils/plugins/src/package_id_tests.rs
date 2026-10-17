use super::InvalidPluginPackageId;
use super::PluginPackageId;

#[test]
fn package_ids_have_one_canonical_shape() {
    assert_eq!(
        PluginPackageId::new("acme/code-review").unwrap().as_str(),
        "acme/code-review"
    );
    for invalid in [
        "code-review",
        "acme/",
        "/review",
        "Acme/review",
        "acme/code_review",
        "acme/-review",
        "acme/review-",
        "acme/code--review",
        "acme/review/extra",
    ] {
        assert_eq!(
            PluginPackageId::new(invalid),
            Err(InvalidPluginPackageId::InvalidShape),
            "{invalid}"
        );
    }
    assert_eq!(
        PluginPackageId::new(format!("a/{}", "b".repeat(127))),
        Err(InvalidPluginPackageId::TooLong)
    );
}

#[test]
fn package_identity_validates_during_deserialization() {
    assert!(serde_json::from_str::<PluginPackageId>("\"Acme/review\"").is_err());
}

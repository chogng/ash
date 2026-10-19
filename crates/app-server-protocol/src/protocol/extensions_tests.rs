use super::ExtensionDto;
use serde_json::json;

#[test]
fn catalog_runtime_binding_keeps_the_authority_and_resource_digests_distinct() {
    let mut value = json!({
        "id": "acme.terminal", "name": "terminal", "publisher": "acme", "version": "1.0.0",
        "displayName": "Terminal", "sourceKind": "plugin", "manifestJson": "{}",
        "manifestSha256": format!("sha256:{}", "a".repeat(64)),
        "packageSha256": format!("sha256:{}", "b".repeat(64))
    });
    let unbound: ExtensionDto = serde_json::from_value(value.clone()).unwrap();
    assert!(unbound.runtime_binding.is_none());
    assert!(
        serde_json::to_value(unbound)
            .unwrap()
            .get("runtimeBinding")
            .is_none()
    );

    value["runtimeBinding"] = json!({
        "runtimeId": "acme/terminal:provider", "packageDigest": format!("sha256:{}", "c".repeat(64))
    });
    let bound: ExtensionDto = serde_json::from_value(value.clone()).unwrap();
    let binding = bound.runtime_binding.as_ref().unwrap();
    assert_eq!(binding.runtime_id, "acme/terminal:provider");
    assert_ne!(bound.package_sha256, binding.package_digest);
    assert_eq!(serde_json::to_value(bound).unwrap(), value);

    value["runtimeBinding"]["granted"] = true.into();
    assert!(serde_json::from_value::<ExtensionDto>(value).is_err());
}

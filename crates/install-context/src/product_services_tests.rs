use super::*;

#[test]
fn explicit_product_services_override_precedes_the_bundled_product_config() {
    let explicit = PathBuf::from("explicit/product-services.json");
    let bundled = PathBuf::from("package/ash-resources/product-services/product-services.json");

    assert_eq!(
        select_product_services_path(Some(explicit.clone()), Some(bundled.clone())),
        Some(explicit)
    );
    assert_eq!(
        select_product_services_path(None, Some(bundled.clone())),
        Some(bundled)
    );
    assert_eq!(select_product_services_path(None, None), None);
}

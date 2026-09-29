use super::*;

#[test]
fn open_rejects_invalid_product_services_before_managed_endpoint_startup() {
    let root = tempfile::tempdir().unwrap();
    let product_services = root.path().join("product-services.json");
    fs::write(&product_services, "{}\n").unwrap();
    let host = ConnectionOptions::new(
        root.path().join("profile"),
        None,
        GrantSource::HostConfiguration,
        Some(product_services),
    );

    let Err(error) = ProfileAppServerRegistry::open(host) else {
        panic!("invalid product services were accepted");
    };

    assert!(error.contains("product services configuration is invalid"));
}

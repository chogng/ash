use std::fs;

use super::*;
use tempfile::TempDir;

#[test]
fn product_services_loads_public_oauth_and_pins_marketplace_root() {
    let root = TempDir::new().unwrap();
    fs::write(root.path().join("root.json"), br#"{"signed":{}}"#).unwrap();
    fs::write(
        root.path().join("product-services.json"),
        r#"{
          "schemaVersion": 2,
          "marketplaces": [{
            "name": "ash",
            "metadataBaseUrl": "https://marketplace.ash.example/metadata/",
            "targetsBaseUrl": "https://marketplace.ash.example/targets/",
            "trustedRoot": "root.json",
            "catalogRefreshIntervalSeconds": 900
          }],
          "githubAccount": {"clientId": "Ov23publicclient", "brokerBaseUrl": "https://broker.example/"},
          "connectorOauth": [{
            "type": "githubDevice",
            "connectorId": "openai/github:connector:account",
            "clientId": "public-client-id",
            "scopes": ["read:user", "repo"]
          }]
        }"#,
    )
    .unwrap();

    let config = LocalProductServicesConfig::load(
        root.path().join("product-services.json"),
        root.path().join("profile"),
    )
    .unwrap();

    assert_eq!(config.marketplaces().len(), 1);
    assert_eq!(
        config
            .github_account
            .as_ref()
            .map(|value| value.client_id.as_str()),
        Some("Ov23publicclient")
    );
    assert_eq!(
        config
            .marketplaces()
            .values()
            .next()
            .unwrap()
            .catalog_refresh_interval(),
        Duration::from_secs(900)
    );
    assert!(matches!(
        &config.connector_oauth[0],
        ProductConnectorOAuthConfig::GitHubDevice { connector_id, config }
            if connector_id.as_str() == "openai/github:connector:account"
                && config.client_id == "public-client-id"
    ));
}

#[test]
fn production_product_services_delegates_to_the_plugins_manager() {
    let product_services = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../resources/product-services/product-services.json");
    let profile = TempDir::new().unwrap();

    let config = LocalProductServicesConfig::load(product_services, profile.path()).unwrap();
    assert_eq!(
        config
            .github_account
            .as_ref()
            .map(|value| value.client_id.as_str()),
        Some("Iv23lieaFUjG1LamZy3K")
    );

    let registry = config.marketplaces().values().next().unwrap();
    assert_eq!(
        registry.metadata_base_url().as_str(),
        "https://chogng.github.io/ash-marketplace/metadata/"
    );
    assert_eq!(
        registry.targets_base_url().as_str(),
        "https://chogng.github.io/ash-marketplace/targets/"
    );
    assert_eq!(
        registry.catalog_refresh_interval(),
        Duration::from_secs(300)
    );
}

#[test]
fn product_services_rejects_invalid_github_account_client_id() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("product-services.json");
    for client_id in ["", "bad client", "client-secret:private"] {
        fs::write(
            &path,
            serde_json::json!({
                "schemaVersion": 2,
                "githubAccount": { "clientId": client_id, "brokerBaseUrl": "https://broker.example/" }
            })
            .to_string(),
        )
        .unwrap();
        assert!(LocalProductServicesConfig::load(&path, root.path()).is_err());
    }
}

#[test]
fn product_services_rejects_non_https_github_broker() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("product-services.json");
    for broker_base_url in [
        "http://broker.example/",
        "https://broker.example/path",
        "https://user@broker.example/",
    ] {
        fs::write(
            &path,
            serde_json::json!({
                "schemaVersion": 2,
                "githubAccount": { "clientId": "Iv23publicclient", "brokerBaseUrl": broker_base_url }
            }).to_string(),
        ).unwrap();
        assert!(LocalProductServicesConfig::load(&path, root.path()).is_err());
    }
}

#[test]
fn product_services_rejects_out_of_range_marketplace_refresh_intervals() {
    let root = TempDir::new().unwrap();
    fs::write(root.path().join("root.json"), br#"{"signed":{}}"#).unwrap();
    fs::write(
        root.path().join("product-services.json"),
        r#"{
          "schemaVersion": 2,
          "marketplaces": [{
            "name": "ash",
            "metadataBaseUrl": "https://marketplace.ash.example/metadata/",
            "targetsBaseUrl": "https://marketplace.ash.example/targets/",
            "trustedRoot": "root.json",
            "catalogRefreshIntervalSeconds": 30
          }]
        }"#,
    )
    .unwrap();

    assert!(
        LocalProductServicesConfig::load(
            root.path().join("product-services.json"),
            root.path().join("profile"),
        )
        .is_err()
    );
}

#[cfg(unix)]
#[test]
fn product_services_rejects_symlinked_trust_inputs() {
    use std::os::unix::fs::symlink;

    let root = TempDir::new().unwrap();
    fs::write(
        root.path().join("actual.json"),
        br#"{"schemaVersion":2,"marketplaces":[]}"#,
    )
    .unwrap();
    LocalProductServicesConfig::load(root.path().join("actual.json"), root.path().join("profile"))
        .unwrap();
    symlink(
        root.path().join("actual.json"),
        root.path().join("product-services.json"),
    )
    .unwrap();

    assert!(
        LocalProductServicesConfig::load(
            root.path().join("product-services.json"),
            root.path().join("profile"),
        )
        .is_err()
    );
}

#[test]
fn product_services_rejects_trust_roots_outside_its_directory() {
    let parent = TempDir::new().unwrap();
    let product = parent.path().join("product");
    fs::create_dir(&product).unwrap();
    fs::write(parent.path().join("root.json"), br#"{"signed":{}}"#).unwrap();
    fs::write(
        product.join("product-services.json"),
        r#"{
          "schemaVersion": 2,
          "marketplaces": [{
            "name": "ash",
            "metadataBaseUrl": "https://marketplace.ash.example/metadata/",
            "targetsBaseUrl": "https://marketplace.ash.example/targets/",
            "trustedRoot": "../root.json"
          }]
        }"#,
    )
    .unwrap();

    assert!(
        LocalProductServicesConfig::load(
            product.join("product-services.json"),
            product.join("profile"),
        )
        .is_err()
    );
}

#[test]
fn marketplace_sources_keep_independent_roots_and_reject_duplicate_or_unsafe_names() {
    let root = TempDir::new().unwrap();
    fs::write(root.path().join("team.json"), b"team trust root").unwrap();
    fs::write(root.path().join("vendor.json"), b"vendor trust root").unwrap();
    let path = root.path().join("product-services.json");
    let mut document = serde_json::json!({
        "schemaVersion": 2,
        "marketplaces": [
            {"name": "team", "metadataBaseUrl": "https://team.example/metadata/", "targetsBaseUrl": "https://team.example/targets/", "trustedRoot": "team.json"},
            {"name": "vendor", "metadataBaseUrl": "https://vendor.example/metadata/", "targetsBaseUrl": "https://vendor.example/targets/", "trustedRoot": "vendor.json", "allowedPublishers": ["vendor"]}
        ]
    });
    fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
    let config = LocalProductServicesConfig::load(&path, root.path().join("profile")).unwrap();
    assert_eq!(
        config
            .marketplaces()
            .keys()
            .map(MarketplaceName::as_str)
            .collect::<Vec<_>>(),
        ["team", "vendor"]
    );
    assert_eq!(
        config.marketplaces()[&MarketplaceName::new("vendor").unwrap()]
            .metadata_base_url()
            .as_str(),
        "https://vendor.example/metadata/"
    );
    fs::write(
        root.path().join("vendor.json"),
        b"changed vendor trust root",
    )
    .unwrap();
    let changed = LocalProductServicesConfig::load(&path, root.path().join("profile")).unwrap();
    assert_ne!(changed.authority_identity(), config.authority_identity());
    for name in ["team", "../vendor", "vendor.name", ""] {
        document["marketplaces"][1]["name"] = name.into();
        fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
        assert!(
            LocalProductServicesConfig::load(&path, root.path().join("profile")).is_err(),
            "{name}"
        );
    }
    document["marketplaces"][1] = document["marketplaces"][0].clone();
    document["marketplaces"][1]["name"] = "TEAM".into();
    fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
    let config = LocalProductServicesConfig::load(&path, root.path().join("profile")).unwrap();
    assert_ne!(
        config.marketplaces()[&MarketplaceName::new("team").unwrap()],
        config.marketplaces()[&MarketplaceName::new("TEAM").unwrap()],
        "separate source names must never share a cache, including on case-insensitive filesystems"
    );
}

#[test]
fn marketplace_publisher_policy_rejects_explicitly_empty_duplicate_or_invalid_lists() {
    let root = TempDir::new().unwrap();
    fs::write(root.path().join("root.json"), b"pinned trust root").unwrap();
    let path = root.path().join("product-services.json");
    let mut document = serde_json::json!({
        "schemaVersion": 2,
        "marketplaces": [{"name": "team", "metadataBaseUrl": "https://team.example/metadata/", "targetsBaseUrl": "https://team.example/targets/", "trustedRoot": "root.json"}]
    });
    fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
    LocalProductServicesConfig::load(&path, root.path().join("profile")).unwrap();
    for publishers in [vec![], vec!["team", "team"], vec!["../team"]] {
        document["marketplaces"][0]["allowedPublishers"] = serde_json::json!(publishers);
        fs::write(&path, serde_json::to_vec(&document).unwrap()).unwrap();
        assert!(LocalProductServicesConfig::load(&path, root.path().join("profile")).is_err());
    }
}

#[test]
fn product_services_binds_image_endpoint_and_git_policy_to_the_product_authority() {
    let root = TempDir::new().unwrap();
    let path = root.path().join("product.json");
    let mut document = serde_json::json!({"schemaVersion":2,"imageGeneration":{"serviceName":"images","endpoint":"https://images.example.test/generate","credentialReference":"images-key"},"gitAttribution":{"coAuthor":"Agent <agent@example.test>","pullRequestNotice":"Assisted by Agent"}});
    fs::write(&path, document.to_string()).unwrap();
    let first = LocalProductServicesConfig::load(&path, root.path()).unwrap();
    assert_eq!(
        first.image_generation.as_ref().unwrap().service_name,
        "images"
    );
    document["imageGeneration"]["endpoint"] =
        serde_json::json!("https://other.example.test/generate");
    fs::write(&path, document.to_string()).unwrap();
    let second = LocalProductServicesConfig::load(&path, root.path()).unwrap();
    assert_ne!(first.authority_identity(), second.authority_identity());
    document["imageGeneration"]["endpoint"] =
        serde_json::json!("https://user:secret@example.test/generate");
    fs::write(&path, document.to_string()).unwrap();
    assert!(LocalProductServicesConfig::load(&path, root.path()).is_err());
}

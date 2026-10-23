use std::time::Duration;
use tempfile::TempDir;
use url::Url;

use super::RemoteExtensionsConfig;

#[test]
fn production_registry_requires_https_and_a_trusted_root() {
    let cache = TempDir::new().unwrap();
    let metadata = Url::parse("http://marketplace.example/metadata/").unwrap();
    let targets = Url::parse("https://marketplace.example/targets/").unwrap();

    assert!(
        RemoteExtensionsConfig::new(metadata, targets.clone(), b"root".to_vec(), cache.path())
            .is_err()
    );
    assert!(
        RemoteExtensionsConfig::new(
            Url::parse("https://marketplace.example/metadata/").unwrap(),
            targets,
            Vec::new(),
            cache.path(),
        )
        .is_err()
    );
}

#[test]
fn production_registry_exposes_only_pinned_remote_endpoints() {
    let cache = TempDir::new().unwrap();
    let metadata = Url::parse("https://marketplace.example/metadata/").unwrap();
    let targets = Url::parse("https://marketplace.example/targets/").unwrap();
    let config = RemoteExtensionsConfig::new(
        metadata.clone(),
        targets.clone(),
        b"root".to_vec(),
        cache.path(),
    )
    .unwrap()
    .with_allowed_publishers(["example".to_owned()])
    .unwrap();

    assert_eq!(config.metadata_base_url(), &metadata);
    assert_eq!(config.targets_base_url(), &targets);
    assert_eq!(config.catalog_refresh_interval(), Duration::from_secs(300));
    assert!(
        config
            .clone()
            .with_allowed_publishers(["example".to_owned(), "example".to_owned()])
            .is_err()
    );
    assert!(
        config
            .clone()
            .with_catalog_refresh_interval(Duration::from_secs(30))
            .is_err()
    );
    assert!(
        config
            .with_catalog_refresh_interval(Duration::from_secs(900))
            .is_ok()
    );
}

#[test]
fn product_runtime_trust_requires_explicit_publisher_and_pinned_root() {
    let root = TempDir::new().unwrap();
    let config = RemoteExtensionsConfig::new(
        Url::parse("https://example.com/metadata/").unwrap(),
        Url::parse("https://example.com/targets/").unwrap(),
        b"root-a".to_vec(),
        root.path(),
    )
    .unwrap();
    assert!(config.product_runtime_authority("ash.academy").is_none());
    let trusted = config
        .clone()
        .with_product_runtime_publishers(["ash".into()])
        .unwrap();
    assert!(trusted.product_runtime_authority("ash.academy").is_some());
    assert!(trusted.product_runtime_authority("other.academy").is_none());
    assert!(
        trusted
            .product_runtime_authority("ash-impostor.academy")
            .is_none()
    );
    assert!(
        config
            .clone()
            .with_product_runtime_publishers(["ash".into(), "ash".into()])
            .is_err()
    );
    assert!(
        config
            .with_product_runtime_publishers(["ash/other".into()])
            .is_err()
    );
    let other_root = RemoteExtensionsConfig::new(
        Url::parse("https://example.com/metadata/").unwrap(),
        Url::parse("https://example.com/targets/").unwrap(),
        b"root-b".to_vec(),
        root.path(),
    )
    .unwrap()
    .with_product_runtime_publishers(["ash".into()])
    .unwrap();
    assert_ne!(
        trusted.product_runtime_authority("ash.academy"),
        other_root.product_runtime_authority("ash.academy")
    );
}

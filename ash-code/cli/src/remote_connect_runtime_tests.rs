use std::fs;
use std::path::Path;
use std::path::PathBuf;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

use ash_remote::RemoteRuntime;

use super::PACKAGED_REMOTE_RUNTIME_CATALOG;
use super::RemoteConnectRuntimeInput;
use super::RemoteConnectRuntimeSelection;
use super::RemoteRuntimeCacheSelection;
use super::RemoteRuntimeCatalogSelection;
use super::RemoteRuntimeCatalogSource;
use super::load_product_package_catalog_source;

#[test]
fn runtime_selection_keeps_explicit_and_managed_sources_unambiguous() {
    let default = RemoteConnectRuntimeSelection::parse(input()).unwrap();
    assert_eq!(
        default,
        RemoteConnectRuntimeSelection::Managed(RemoteRuntimeCatalogSelection::ProductPackage)
    );

    let explicit = RemoteConnectRuntimeSelection::parse(RemoteConnectRuntimeInput {
        runtime: Some(RemoteRuntime::new("/opt/ash/bin/ash-remote-server").unwrap()),
        ..input()
    })
    .unwrap();
    assert!(matches!(
        explicit,
        RemoteConnectRuntimeSelection::Explicit(_)
    ));

    let local = RemoteConnectRuntimeSelection::parse(RemoteConnectRuntimeInput {
        local_catalog: Some(std::env::temp_dir().join("ash/catalog.json")),
        catalog_sha256: Some("a".repeat(64)),
        ..input()
    })
    .unwrap();
    assert!(matches!(
        local,
        RemoteConnectRuntimeSelection::Managed(RemoteRuntimeCatalogSelection::Local { .. })
    ));

    let network = RemoteConnectRuntimeSelection::parse(RemoteConnectRuntimeInput {
        catalog_url: Some("https://releases.example/ash/catalog.json".into()),
        catalog_sha256: Some("b".repeat(64)),
        runtime_cache: Some(std::env::temp_dir().join("ash-runtime-cache")),
        ..input()
    })
    .unwrap();
    let RemoteConnectRuntimeSelection::Managed(RemoteRuntimeCatalogSelection::Network {
        cache,
        ..
    }) = network
    else {
        panic!("expected managed network catalog");
    };
    assert!(matches!(cache, RemoteRuntimeCacheSelection::Explicit(_)));

    assert!(
        RemoteConnectRuntimeSelection::parse(RemoteConnectRuntimeInput {
            runtime: Some(RemoteRuntime::new("ash").unwrap()),
            local_catalog: Some(PathBuf::from("/opt/ash/catalog.json")),
            catalog_sha256: Some("a".repeat(64)),
            ..input()
        })
        .unwrap_err()
        .contains("cannot be combined")
    );
    assert!(
        RemoteConnectRuntimeSelection::parse(RemoteConnectRuntimeInput {
            local_catalog: Some(PathBuf::from("relative/catalog.json")),
            catalog_sha256: Some("a".repeat(64)),
            ..input()
        })
        .unwrap_err()
        .contains("absolute")
    );
}

#[test]
fn product_package_binding_selects_only_the_exact_local_or_https_source() {
    let root = test_root("package-binding");
    let metadata = root.join("ash-package.json");
    let profile = root.join("profile");
    fs::create_dir_all(&root).unwrap();
    fs::write(
        &metadata,
        format!(
            r#"{{"layoutVersion":2,"remoteRuntimeCatalog":{{"path":"{PACKAGED_REMOTE_RUNTIME_CATALOG}","sha256":"{}","trustBinding":"signedProductPackage"}}}}"#,
            "a".repeat(64)
        ),
    )
    .unwrap();
    let source = load_product_package_catalog_source(&metadata, &root, &profile).unwrap();
    assert_eq!(
        source,
        RemoteRuntimeCatalogSource::Local {
            path: root.join(PACKAGED_REMOTE_RUNTIME_CATALOG),
            expected_sha256: "a".repeat(64),
        }
    );

    fs::write(
        &metadata,
        format!(
            r#"{{"remoteRuntimeCatalog":{{"url":"https://releases.example/ash/catalog.json","sha256":"{}","trustBinding":"signedProductPackage"}}}}"#,
            "b".repeat(64)
        ),
    )
    .unwrap();
    let source = load_product_package_catalog_source(&metadata, &root, &profile).unwrap();
    let RemoteRuntimeCatalogSource::Network { release, cache } = source else {
        panic!("expected packaged network catalog");
    };
    assert_eq!(
        release.catalog_url(),
        "https://releases.example/ash/catalog.json"
    );
    assert_eq!(cache.root(), profile.join("remote-runtime-downloads"));

    fs::write(
        &metadata,
        format!(
            r#"{{"remoteRuntimeCatalog":{{"path":"{PACKAGED_REMOTE_RUNTIME_CATALOG}","url":"https://releases.example/ash/catalog.json","sha256":"{}","trustBinding":"signedProductPackage"}}}}"#,
            "c".repeat(64)
        ),
    )
    .unwrap();
    assert!(
        load_product_package_catalog_source(&metadata, &root, &profile)
            .unwrap_err()
            .contains("ambiguous")
    );
    fs::remove_dir_all(root).unwrap();
}

fn input() -> RemoteConnectRuntimeInput {
    RemoteConnectRuntimeInput {
        runtime: None,
        local_catalog: None,
        catalog_url: None,
        catalog_sha256: None,
        runtime_cache: None,
    }
}

fn test_root(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "ash-cli-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos(),
    ))
}

#[test]
fn package_metadata_must_be_a_real_bounded_file() {
    let root = test_root("package-metadata");
    fs::create_dir_all(&root).unwrap();
    let missing = root.join("missing.json");
    assert!(
        load_product_package_catalog_source(&missing, &root, Path::new("/profile"))
            .unwrap_err()
            .contains("could not read")
    );
    fs::remove_dir_all(root).unwrap();
}

use tempfile::TempDir;
use url::Url;

use super::ExtensionsRemoteClient;
use crate::ExtensionSource;
use crate::RemoteExtensionsConfig;

#[test]
fn opening_the_remote_client_never_requires_network_access() {
    let cache = TempDir::new().unwrap();
    let config = RemoteExtensionsConfig::new(
        Url::parse("https://unreachable.invalid/metadata/").unwrap(),
        Url::parse("https://unreachable.invalid/targets/").unwrap(),
        b"not-yet-parsed-because-access-is-lazy".to_vec(),
        cache.path(),
    )
    .unwrap();

    let client = ExtensionsRemoteClient::new(config);
    let result = client
        .search(crate::SearchPackagesRequest {
            package_type: Some("editorExtension".into()),
            ..Default::default()
        })
        .unwrap();
    assert!(
        result.packages.is_empty(),
        "VSIX discovery belongs to its own provider, not the signed catalog"
    );
}

#[test]
fn provider_names_preserve_the_signed_registry_identity() {
    for id in ["acme/review", "third-party/code-review-2"] {
        let name = super::plugin_name(id);
        assert_eq!(super::package_id(&name).unwrap(), id);
    }
    for invalid in ["review", "acme/review", "a.b.c", "a.b@other", "../review"] {
        assert!(super::package_id(invalid).is_err(), "{invalid}");
    }
}

#[test]
fn verified_catalog_pages_continue_beyond_the_legacy_search_cap_and_bind_the_query() {
    let packages = (0..257)
        .map(|index| crate::PackageSummary {
            id: format!("example.item-{index:03}"),
            version: "1.0.0".into(),
            package_type: "skill".into(),
            display_name: format!("Item {index}"),
            description: String::new(),
        })
        .collect::<Vec<_>>();
    let mut request = crate::SearchPackagesPageRequest {
        source_id: "ash".into(),
        cursor: None,
        search: crate::SearchPackagesRequest {
            limit: Some(100),
            ..Default::default()
        },
    };
    let identities = [crate::PackageRef {
        id: "example.item-000".into(),
        version: "1.0.0".into(),
        digest: "sha256:original-archive".into(),
    }];
    let first = super::catalog_page(&request, packages.clone(), &identities).unwrap();
    assert_eq!(first.total, 257);
    assert_eq!(first.packages, packages[..100]);
    request.cursor = first.next_cursor;
    let changed_archive = crate::PackageRef {
        id: "example.item-000".into(),
        version: "1.0.0".into(),
        digest: "sha256:new-permissions-with-the-same-summary".into(),
    };
    assert!(super::catalog_page(&request, packages.clone(), &[changed_archive]).is_err());
    let second = super::catalog_page(&request, packages.clone(), &identities).unwrap();
    assert_eq!(second.packages, packages[100..200]);
    let mut changed = request.clone();
    changed.source_id = "other".into();
    assert!(super::catalog_page(&changed, packages.clone(), &identities).is_err());
    changed = request.clone();
    changed.search.query = "changed".into();
    assert!(super::catalog_page(&changed, packages.clone(), &identities).is_err());
    changed = request.clone();
    changed.search.limit = Some(30);
    assert!(super::catalog_page(&changed, packages.clone(), &identities).is_err());
    assert!(super::catalog_page(&request, packages[..256].to_vec(), &identities).is_err());
    let prefix = request.cursor.as_ref().unwrap().split(':').next().unwrap();
    changed = request.clone();
    changed.cursor = Some(format!("{prefix}:100:0"));
    assert!(super::catalog_page(&changed, packages.clone(), &identities).is_err());
    request.cursor = second.next_cursor;
    let third = super::catalog_page(&request, packages.clone(), &identities).unwrap();
    assert_eq!(third.packages, packages[200..]);
    assert!(third.next_cursor.is_none());
}

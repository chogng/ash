use tempfile::TempDir;
use url::Url;

use super::MarketplaceRemoteClient;
use crate::PluginProvider;
use crate::RemoteMarketplaceConfig;

#[test]
fn opening_the_remote_client_never_requires_network_access() {
    let cache = TempDir::new().unwrap();
    let config = RemoteMarketplaceConfig::new(
        Url::parse("https://unreachable.invalid/metadata/").unwrap(),
        Url::parse("https://unreachable.invalid/targets/").unwrap(),
        b"not-yet-parsed-because-access-is-lazy".to_vec(),
        cache.path(),
    )
    .unwrap();

    let client = MarketplaceRemoteClient::new(config);
    let result = client
        .search(crate::SearchPackagesRequest {
            capability_kind: Some(crate::CapabilityKind::EditorExtension),
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

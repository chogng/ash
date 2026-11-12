use super::*;
use ash_async_utils::CancellationSource;
use ash_http_client::NetworkAccess;

#[test]
fn anonymous_favicons_refuse_private_and_reserved_targets() {
    let favicons = BrowserFavicons::new(OutboundNetworkPolicy::default()).unwrap();
    let cancellation = CancellationSource::new().token();
    for url in [
        "http://127.0.0.1/favicon.ico",
        "http://169.254.169.254/favicon.ico",
        "http://[::ffff:127.0.0.1]/favicon.ico",
        "https://198.18.0.1/favicon.ico",
        "https://[2001:2::1]/favicon.ico",
    ] {
        assert_eq!(favicons.read(url, &cancellation), None, "{url}");
    }
}

#[test]
fn cached_icons_observe_outbound_policy_changes() {
    let policy = OutboundNetworkPolicy::default();
    let favicons = BrowserFavicons::new(policy.clone()).unwrap();
    let cancellation = CancellationSource::new().token();
    let url = "https://example.test/favicon.ico";
    let image = favicon_data_url(b"\0\0\x01\0").unwrap();
    assert_eq!(image, "data:image/x-icon;base64,AAABAA==");
    favicons.cache.insert(
        url.to_owned(),
        CachedFavicon {
            data_url: Some(Arc::from(image.as_str())),
            expires: Instant::now() + Duration::from_secs(3600),
            policy_revision: policy.revision(),
        },
    );
    assert_eq!(
        favicons.read(url, &cancellation).as_deref(),
        Some(image.as_str())
    );
    policy.update(NetworkAccess::Hosts(Default::default()));
    assert_eq!(favicons.read(url, &cancellation), None);
}

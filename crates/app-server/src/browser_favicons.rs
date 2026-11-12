use ash_async_utils::CancellationToken;
use ash_attachments::AttachmentError;
use ash_attachments::SafeRemoteImageFetcher;
use ash_http_client::OutboundNetworkPolicy;
use ash_http_client::Timeout;
use ash_http_client::TransportTimeouts;
use ash_utils_cache::BlockingLruCache;
use ash_utils_image::data_url_from_bytes;
use ash_utils_image::detect_image_format;
use std::num::NonZeroUsize;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;
use tokio::sync::Semaphore;

/// The local App Server shares anonymous favicon results across Desktop connections.
pub(crate) struct BrowserFavicons {
    fetcher: SafeRemoteImageFetcher,
    policy: OutboundNetworkPolicy,
    cache: BlockingLruCache<String, CachedFavicon>,
    downloads: Semaphore,
}

#[derive(Clone)]
struct CachedFavicon {
    data_url: Option<Arc<str>>,
    expires: Instant,
    policy_revision: u64,
}

impl BrowserFavicons {
    pub(crate) fn new(policy: OutboundNetworkPolicy) -> Result<Self, AttachmentError> {
        let timeout = Timeout::After(Duration::from_secs(4));
        let fetcher = SafeRemoteImageFetcher::with_limits(
            policy.clone(),
            NonZeroUsize::new(64 * 1024).unwrap(),
            TransportTimeouts::new(timeout, timeout, Timeout::Disabled, timeout),
        )?;
        Ok(Self {
            fetcher,
            policy,
            cache: BlockingLruCache::new(NonZeroUsize::new(256).unwrap()),
            downloads: Semaphore::new(12),
        })
    }

    pub(crate) fn read(&self, url: &str, cancellation: &CancellationToken) -> Option<Arc<str>> {
        cancellation.check().ok()?;
        let revision = self.policy.revision();
        if let Some(cached) = self.cache.get(url)
            && cached.expires > Instant::now()
            && cached.policy_revision == revision
        {
            return cached.data_url;
        }
        let _permit = self.downloads.try_acquire().ok()?;
        let data_url = self
            .fetcher
            .fetch_with_cancellation(url, "image/*", cancellation)
            .ok()
            .and_then(|bytes| favicon_data_url(&bytes))
            .map(Arc::from);
        cancellation.check().ok()?;
        if self.policy.revision() != revision {
            return None;
        }
        let ttl = if data_url.is_some() { 3600 } else { 300 };
        self.cache.insert(
            url.to_owned(),
            CachedFavicon {
                data_url: data_url.clone(),
                expires: Instant::now() + Duration::from_secs(ttl),
                policy_revision: revision,
            },
        );
        data_url
    }
}

fn favicon_data_url(bytes: &[u8]) -> Option<String> {
    let mime = if bytes.starts_with(b"\0\0\x01\0") {
        "image/x-icon"
    } else {
        detect_image_format(bytes)?.mime_type()
    };
    Some(data_url_from_bytes(mime, bytes))
}

#[cfg(test)]
#[path = "browser_favicons_tests.rs"]
mod tests;

use std::num::NonZeroUsize;
use std::sync::Arc;

use ash_http_client::HttpClient;
use ash_http_client::HttpClientConfig;
use ash_http_client::HttpHeader;
use ash_http_client::HttpMethod;
use ash_http_client::HttpRequest;
use ash_http_client::NetworkTargetPolicy;
use ash_http_client::ProxyPolicy;
use ash_http_client::RedirectPolicy;
use ash_http_client::ResponseBodyLimit;
use ash_http_client::UreqHttpClient;
use url::Url;

use crate::AttachmentError;
use crate::MAX_IMAGE_ATTACHMENT_BYTES;

const MAX_REMOTE_REDIRECTS: usize = 5;
const MAX_REMOTE_URL_BYTES: usize = 8 * 1024;

/// Fetches one bounded image representation from a caller-supplied remote location.
///
/// Implementations must prevent access to local/private network targets, revalidate every
/// redirect, avoid ambient credentials, and return bounded bytes without decoding them.
pub trait RemoteImageFetcher: Send + Sync {
    fn fetch(&self, url: &str) -> Result<Vec<u8>, AttachmentError>;
}

/// Production remote image fetcher with DNS-time public-address enforcement.
pub struct SafeRemoteImageFetcher {
    client: Arc<dyn HttpClient>,
}

impl SafeRemoteImageFetcher {
    pub fn production() -> Result<Self, AttachmentError> {
        let body_limit = ResponseBodyLimit::new(
            NonZeroUsize::new(MAX_IMAGE_ATTACHMENT_BYTES)
                .expect("attachment byte limit is non-zero"),
        )
        .map_err(|_| AttachmentError::RemoteFetch)?;
        let client = UreqHttpClient::with_config(
            HttpClientConfig::new()
                .with_proxy_policy(ProxyPolicy::Direct)
                .with_redirect_policy(RedirectPolicy::Reject)
                .with_network_target_policy(NetworkTargetPolicy::PublicInternetOnly)
                .with_response_body_limit(body_limit),
        )
        .map_err(|_| AttachmentError::RemoteFetch)?;
        Ok(Self {
            client: Arc::new(client),
        })
    }

    #[cfg(test)]
    pub(crate) fn with_client(client: Arc<dyn HttpClient>) -> Self {
        Self { client }
    }
}

impl RemoteImageFetcher for SafeRemoteImageFetcher {
    fn fetch(&self, url: &str) -> Result<Vec<u8>, AttachmentError> {
        let mut current = validate_remote_url(url)?;
        let initial_scheme = current.scheme().to_owned();
        for hop in 0..=MAX_REMOTE_REDIRECTS {
            let request = HttpRequest::new(
                HttpMethod::Get,
                current.as_str(),
                vec![
                    HttpHeader::new("accept", "image/png,image/jpeg,image/webp,image/gif"),
                    HttpHeader::new("accept-encoding", "identity"),
                ],
                Vec::new(),
            )
            .map_err(|_| AttachmentError::RemoteFetch)?;
            let response = self
                .client
                .execute(&request)
                .map_err(|_| AttachmentError::RemoteFetch)?;
            if response.is_success() {
                return Ok(response.body().to_vec());
            }
            if !is_redirect(response.status()) || hop == MAX_REMOTE_REDIRECTS {
                return Err(AttachmentError::RemoteFetch);
            }
            let location = response
                .headers()
                .iter()
                .find(|header| header.name().eq_ignore_ascii_case("location"))
                .map(|header| header.value())
                .ok_or(AttachmentError::RemoteFetch)?;
            let next = current
                .join(location)
                .map_err(|_| AttachmentError::RemoteFetch)?;
            current = validate_remote_url(next.as_str())?;
            if initial_scheme == "https" && current.scheme() != "https" {
                return Err(AttachmentError::RemoteFetch);
            }
        }
        Err(AttachmentError::RemoteFetch)
    }
}

fn validate_remote_url(raw: &str) -> Result<Url, AttachmentError> {
    if raw.len() > MAX_REMOTE_URL_BYTES || raw.chars().any(char::is_whitespace) {
        return Err(AttachmentError::RemoteFetch);
    }
    let url = Url::parse(raw).map_err(|_| AttachmentError::RemoteFetch)?;
    let has_standard_port = matches!(
        (url.scheme(), url.port_or_known_default()),
        ("http", Some(80)) | ("https", Some(443))
    );
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
        || !has_standard_port
    {
        return Err(AttachmentError::RemoteFetch);
    }
    Ok(url)
}

fn is_redirect(status: u16) -> bool {
    matches!(status, 301 | 302 | 303 | 307 | 308)
}

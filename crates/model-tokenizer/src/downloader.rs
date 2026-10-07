use crate::LocalTokenizerError;
use crate::RemoteTokenizerAsset;
use ash_http_client::HttpClient;
use ash_http_client::HttpClientConfig;
use ash_http_client::HttpMethod;
use ash_http_client::HttpRequest;
use ash_http_client::OutboundNetworkPolicy;
use ash_http_client::OutboundNetworkSnapshot;
use ash_http_client::RedirectPolicy;
use ash_http_client::ReqwestHttpClient;
use ash_http_client::ResponseBodyLimit;
use ash_http_client::UreqHttpClient;
use std::sync::Arc;
use std::sync::OnceLock;

/// Downloads one immutable asset without owning cache paths, retries, or publication.
pub trait TokenizerAssetDownloader: Send + Sync {
    fn fetch(&self, url: &str) -> Result<Vec<u8>, LocalTokenizerError>;

    fn download(&self, asset: &RemoteTokenizerAsset) -> Result<Vec<u8>, LocalTokenizerError> {
        if let Some(bytes) = asset.inline_bytes() {
            Ok(bytes.to_vec())
        } else {
            self.fetch(asset.url())
        }
    }
}

/// Production downloader backed by Ash's shared bounded HTTP transport contract.
pub struct HttpTokenizerAssetDownloader {
    client: OnceLock<Result<Arc<dyn HttpClient>, String>>,
    factory: Arc<dyn Fn() -> Result<Arc<dyn HttpClient>, String> + Send + Sync>,
}

impl HttpTokenizerAssetDownloader {
    pub fn new(client: Arc<dyn HttpClient>) -> Self {
        let initialized = OnceLock::new();
        let _ = initialized.set(Ok(client));
        Self {
            client: initialized,
            factory: Arc::new(|| Err("fixed tokenizer HTTP client was not initialized".into())),
        }
    }

    pub fn production() -> Self {
        Self {
            client: OnceLock::new(),
            factory: Arc::new(production_http_client),
        }
    }

    pub fn with_policy(policy: OutboundNetworkPolicy) -> Self {
        Self {
            client: OnceLock::new(),
            factory: Arc::new(move || production_http_client_with_policy(policy.clone())),
        }
    }

    fn client(&self) -> Result<&Arc<dyn HttpClient>, LocalTokenizerError> {
        self.client
            .get_or_init(|| (self.factory)())
            .as_ref()
            .map_err(|message| LocalTokenizerError::Download(message.clone()))
    }
}

impl TokenizerAssetDownloader for HttpTokenizerAssetDownloader {
    fn fetch(&self, url: &str) -> Result<Vec<u8>, LocalTokenizerError> {
        let request = HttpRequest::new(HttpMethod::Get, url, Vec::new(), Vec::new())
            .map_err(|error| LocalTokenizerError::Download(error.to_string()))?;
        let response = self
            .client()?
            .execute(&request)
            .map_err(|error| LocalTokenizerError::Download(error.to_string()))?;
        if !response.is_success() {
            return Err(LocalTokenizerError::DownloadStatus {
                url: url.into(),
                status: response.status(),
            });
        }
        Ok(response.body().to_vec())
    }
}

fn production_http_client() -> Result<Arc<dyn HttpClient>, String> {
    UreqHttpClient::with_config(production_http_config()?)
        .map(|client| Arc::new(client) as Arc<dyn HttpClient>)
        .map_err(|error| error.to_string())
}

fn production_http_client_with_policy(
    policy: OutboundNetworkPolicy,
) -> Result<Arc<dyn HttpClient>, String> {
    let network = OutboundNetworkSnapshot::with_policy(production_http_config()?, policy.clone())
        .map_err(|error| error.to_string())?;
    let client: Arc<dyn HttpClient> =
        Arc::new(ReqwestHttpClient::with_network(network).map_err(|error| error.to_string())?);
    Ok(client)
}

fn production_http_config() -> Result<HttpClientConfig, String> {
    let redirects = std::num::NonZeroU8::new(5).expect("five is non-zero");
    let response_limit =
        std::num::NonZeroUsize::new(128 * 1024 * 1024).expect("128 MiB is non-zero");
    let config = HttpClientConfig::new()
        .with_redirect_policy(RedirectPolicy::Follow {
            max_hops: redirects,
        })
        .with_response_body_limit(
            ResponseBodyLimit::new(response_limit).map_err(|error| error.to_string())?,
        );
    Ok(config)
}

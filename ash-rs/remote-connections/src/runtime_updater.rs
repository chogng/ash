use std::fmt;
use std::fs;
use std::fs::File;
use std::io;
use std::io::Write;
use std::num::NonZeroUsize;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use ash_http_client::HttpBodySink;
use ash_http_client::HttpClient;
use ash_http_client::HttpClientConfig;
use ash_http_client::HttpClientError;
use ash_http_client::HttpHeader;
use ash_http_client::HttpMethod;
use ash_http_client::HttpRequest;
use ash_http_client::NetworkTargetPolicy;
use ash_http_client::ProxyPolicy;
use ash_http_client::RedirectPolicy;
use ash_http_client::ResponseBodyLimit;
use ash_http_client::Timeout;
use ash_http_client::TransportTimeouts;
use ash_http_client::UreqHttpClient;
use ash_remote::RemotePlatform;
use ash_utils_path::write_atomically;
use sha2::Digest;
use sha2::Sha256;
use tempfile::NamedTempFile;
use url::Url;

use crate::RemoteRuntimeArtifact;
use crate::RemoteRuntimeArtifactIntegrity;
use crate::RemoteRuntimeCatalog;
use crate::RemoteRuntimeCatalogError;
use crate::RemoteRuntimeInstallError;
use crate::RemoteRuntimeVersion;
use crate::catalog::MAX_CATALOG_BYTES;
use crate::catalog::MAX_RUNTIME_ARCHIVE_BYTES;
use crate::install::open_and_validate_artifact;

const CACHE_DIRECTORY: &str = "remote-runtime-catalogs";
const CATALOG_FILE: &str = "catalog.json";
const DOWNLOAD_PROGRESS_INTERVAL_BYTES: u64 = 256 * 1024;
const MAX_ERROR_RESPONSE_BYTES: usize = 1024 * 1024;

/// One network catalog whose exact bytes were authenticated by a signed product release.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteRuntimeCatalogRelease {
    catalog_url: Url,
    expected_sha256: String,
}

impl RemoteRuntimeCatalogRelease {
    /// Creates a release binding without accepting credentials, redirects, query, or fragments.
    pub fn new(
        catalog_url: impl AsRef<str>,
        expected_sha256: impl AsRef<str>,
    ) -> Result<Self, RemoteRuntimeUpdateError> {
        let catalog_url = Url::parse(catalog_url.as_ref()).map_err(|_| {
            RemoteRuntimeUpdateError::InvalidRelease("Remote runtime catalog URL is invalid".into())
        })?;
        if catalog_url.scheme() != "https"
            || catalog_url.host_str().is_none()
            || !catalog_url.username().is_empty()
            || catalog_url.password().is_some()
            || catalog_url.query().is_some()
            || catalog_url.fragment().is_some()
            || !catalog_url.path().ends_with("/catalog.json")
        {
            return Err(RemoteRuntimeUpdateError::InvalidRelease(
                "Remote runtime catalog URL must be a credential-free HTTPS catalog.json URL without query or fragment"
                    .into(),
            ));
        }
        let expected_sha256 = expected_sha256.as_ref();
        if !is_sha256(expected_sha256) {
            return Err(RemoteRuntimeUpdateError::InvalidRelease(
                "Remote runtime catalog SHA-256 must be 64 lowercase hex characters".into(),
            ));
        }
        Ok(Self {
            catalog_url,
            expected_sha256: expected_sha256.into(),
        })
    }

    /// Returns the release-authenticated catalog endpoint.
    pub fn catalog_url(&self) -> &str {
        self.catalog_url.as_str()
    }

    /// Returns the release-authenticated digest of the catalog bytes.
    pub fn expected_sha256(&self) -> &str {
        &self.expected_sha256
    }
}

/// Product-selected local root for immutable, content-addressed runtime downloads.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteRuntimeDownloadCache {
    root: PathBuf,
}

impl RemoteRuntimeDownloadCache {
    /// Accepts only a non-root absolute path without lexical traversal components.
    pub fn new(root: impl Into<PathBuf>) -> Result<Self, RemoteRuntimeUpdateError> {
        let root = root.into();
        if !root.is_absolute()
            || root.parent().is_none()
            || root
                .components()
                .any(|component| matches!(component, Component::CurDir | Component::ParentDir))
        {
            return Err(RemoteRuntimeUpdateError::InvalidRelease(
                "Remote runtime download cache must be a non-root absolute path without traversal"
                    .into(),
            ));
        }
        Ok(Self { root })
    }

    /// Returns the product-owned cache root.
    pub fn root(&self) -> &Path {
        &self.root
    }
}

/// Whether the selected immutable runtime archive was fetched or already verified locally.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoteRuntimeDownloadDisposition {
    Downloaded,
    Reused,
}

/// Bounded, credential-free progress emitted while materializing one runtime artifact.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RemoteRuntimeDownloadProgress {
    DownloadingCatalog,
    DownloadingArtifact {
        transferred_bytes: u64,
        total_bytes: u64,
    },
    ValidatingArtifact,
    Complete {
        disposition: RemoteRuntimeDownloadDisposition,
    },
}

/// Materializes release-authenticated catalogs and artifacts into an immutable local cache.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteRuntimeCatalogUpdater {
    release: RemoteRuntimeCatalogRelease,
    cache: RemoteRuntimeDownloadCache,
}

impl RemoteRuntimeCatalogUpdater {
    pub fn new(release: RemoteRuntimeCatalogRelease, cache: RemoteRuntimeDownloadCache) -> Self {
        Self { release, cache }
    }

    /// Downloads through the shared HTTP transport with public-Internet-only DNS policy.
    pub fn fetch_for(
        &self,
        platform: RemotePlatform,
        report_progress: impl FnMut(RemoteRuntimeDownloadProgress),
    ) -> Result<RemoteRuntimeArtifact, RemoteRuntimeUpdateError> {
        let client = UreqHttpClient::with_config(public_download_config()?)?;
        self.fetch_for_with_client(platform, &client, report_progress)
    }

    /// Uses a caller-owned transport generation while preserving digest and cache validation.
    pub fn fetch_for_with_client(
        &self,
        platform: RemotePlatform,
        client: &dyn HttpClient,
        mut report_progress: impl FnMut(RemoteRuntimeDownloadProgress),
    ) -> Result<RemoteRuntimeArtifact, RemoteRuntimeUpdateError> {
        let generation_root = self.prepare_generation_root()?;
        let catalog_path = generation_root.join(CATALOG_FILE);
        let catalog =
            match RemoteRuntimeCatalog::load_verified(&catalog_path, &self.release.expected_sha256)
            {
                Ok(catalog) => catalog,
                Err(_) => {
                    report_progress(RemoteRuntimeDownloadProgress::DownloadingCatalog);
                    self.download_catalog(client, &catalog_path)?;
                    RemoteRuntimeCatalog::load_verified(
                        &catalog_path,
                        &self.release.expected_sha256,
                    )?
                }
            };
        let artifact = catalog.artifact_for(platform).ok_or_else(|| {
            RemoteRuntimeUpdateError::InvalidRelease(format!(
                "authenticated Remote runtime catalog has no artifact for `{platform}`"
            ))
        })?;
        if artifact.archive().exists() {
            report_progress(RemoteRuntimeDownloadProgress::ValidatingArtifact);
            if open_and_validate_artifact(artifact).is_ok() {
                report_progress(RemoteRuntimeDownloadProgress::Complete {
                    disposition: RemoteRuntimeDownloadDisposition::Reused,
                });
                return Ok(artifact.clone());
            }
        }

        let relative_archive = artifact
            .archive()
            .strip_prefix(&generation_root)
            .map_err(|_| {
                RemoteRuntimeUpdateError::InvalidRelease(
                    "Remote runtime artifact escaped its catalog generation".into(),
                )
            })?;
        let archive_url = self.artifact_url(relative_archive)?;
        let parent = artifact.archive().parent().ok_or_else(|| {
            RemoteRuntimeUpdateError::InvalidRelease(
                "Remote runtime artifact has no cache parent".into(),
            )
        })?;
        ensure_generation_directory(&generation_root, parent)?;
        let mut temporary =
            NamedTempFile::new_in(parent).map_err(RemoteRuntimeUpdateError::cache)?;
        let total_bytes = artifact.integrity().archive_size().get();
        report_progress(RemoteRuntimeDownloadProgress::DownloadingArtifact {
            transferred_bytes: 0,
            total_bytes,
        });
        let mut sink = ArtifactDownloadSink::new(
            temporary.as_file_mut(),
            total_bytes,
            artifact.integrity().sha256(),
            &mut report_progress,
        );
        let request = get_request(archive_url.as_str(), "application/gzip")?;
        let response = client.execute_streaming(&request, &mut sink)?;
        if response.status() != 200 {
            return Err(RemoteRuntimeUpdateError::HttpStatus {
                resource: "artifact",
                status: response.status(),
            });
        }
        sink.finish()?;
        temporary
            .as_file()
            .sync_all()
            .map_err(RemoteRuntimeUpdateError::cache)?;
        report_progress(RemoteRuntimeDownloadProgress::ValidatingArtifact);
        let temporary_artifact = artifact_at(temporary.path(), artifact);
        open_and_validate_artifact(&temporary_artifact)?;
        temporary
            .persist(artifact.archive())
            .map_err(|error| RemoteRuntimeUpdateError::cache(error.error))?;
        report_progress(RemoteRuntimeDownloadProgress::Complete {
            disposition: RemoteRuntimeDownloadDisposition::Downloaded,
        });
        Ok(artifact.clone())
    }

    fn download_catalog(
        &self,
        client: &dyn HttpClient,
        catalog_path: &Path,
    ) -> Result<(), RemoteRuntimeUpdateError> {
        let request = get_request(self.release.catalog_url.as_str(), "application/json")?;
        let response = client.execute(&request)?;
        if response.status() != 200 {
            return Err(RemoteRuntimeUpdateError::HttpStatus {
                resource: "catalog",
                status: response.status(),
            });
        }
        if response.body().is_empty() || response.body().len() as u64 > MAX_CATALOG_BYTES {
            return Err(RemoteRuntimeUpdateError::Integrity(
                "Remote runtime catalog response has an invalid size".into(),
            ));
        }
        let observed = sha256(response.body());
        if observed != self.release.expected_sha256 {
            return Err(RemoteRuntimeUpdateError::Integrity(format!(
                "Remote runtime catalog SHA-256 mismatch: expected {}, observed {observed}",
                self.release.expected_sha256
            )));
        }
        write_atomically(catalog_path, response.body()).map_err(RemoteRuntimeUpdateError::cache)
    }

    fn artifact_url(&self, relative_archive: &Path) -> Result<Url, RemoteRuntimeUpdateError> {
        let relative_archive = relative_url_path(relative_archive)?;
        self.release
            .catalog_url
            .join(&relative_archive)
            .map_err(|_| {
                RemoteRuntimeUpdateError::InvalidRelease(
                    "Remote runtime artifact URL could not be derived from its catalog".into(),
                )
            })
    }

    fn generation_root(&self) -> PathBuf {
        self.cache
            .root
            .join(CACHE_DIRECTORY)
            .join(&self.release.expected_sha256)
    }

    fn prepare_generation_root(&self) -> Result<PathBuf, RemoteRuntimeUpdateError> {
        ensure_cache_root(&self.cache.root)?;
        let catalogs = self.cache.root.join(CACHE_DIRECTORY);
        ensure_real_child_directory(&catalogs)?;
        let generation = self.generation_root();
        ensure_real_child_directory(&generation)?;
        Ok(generation)
    }
}

fn ensure_cache_root(root: &Path) -> Result<(), RemoteRuntimeUpdateError> {
    fs::create_dir_all(root).map_err(RemoteRuntimeUpdateError::cache)?;
    require_real_directory(root)
}

fn ensure_generation_directory(
    generation_root: &Path,
    directory: &Path,
) -> Result<(), RemoteRuntimeUpdateError> {
    let relative = directory.strip_prefix(generation_root).map_err(|_| {
        RemoteRuntimeUpdateError::InvalidRelease(
            "Remote runtime artifact parent escaped its cache generation".into(),
        )
    })?;
    let mut current = generation_root.to_path_buf();
    for component in relative.components() {
        let Component::Normal(segment) = component else {
            return Err(RemoteRuntimeUpdateError::InvalidRelease(
                "Remote runtime artifact parent is not canonical".into(),
            ));
        };
        current.push(segment);
        ensure_real_child_directory(&current)?;
    }
    Ok(())
}

fn ensure_real_child_directory(path: &Path) -> Result<(), RemoteRuntimeUpdateError> {
    match fs::create_dir(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(RemoteRuntimeUpdateError::cache(error)),
    }
    require_real_directory(path)
}

fn require_real_directory(path: &Path) -> Result<(), RemoteRuntimeUpdateError> {
    let metadata = fs::symlink_metadata(path).map_err(RemoteRuntimeUpdateError::cache)?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err(RemoteRuntimeUpdateError::InvalidRelease(format!(
            "Remote runtime download cache contains a linked or non-directory path: {}",
            path.display()
        )));
    }
    Ok(())
}

fn public_download_config() -> Result<HttpClientConfig, RemoteRuntimeUpdateError> {
    let error_limit = ResponseBodyLimit::new(NonZeroUsize::new(MAX_ERROR_RESPONSE_BYTES).unwrap())?;
    let artifact_limit = usize::try_from(MAX_RUNTIME_ARCHIVE_BYTES).map_err(|_| {
        RemoteRuntimeUpdateError::InvalidRelease(
            "Remote runtime archive limit does not fit this host architecture".into(),
        )
    })?;
    let artifact_limit = ResponseBodyLimit::new(NonZeroUsize::new(artifact_limit).unwrap())?;
    Ok(HttpClientConfig::new()
        .with_proxy_policy(ProxyPolicy::Direct)
        .with_redirect_policy(RedirectPolicy::Reject)
        .with_network_target_policy(NetworkTargetPolicy::PublicInternetOnly)
        .with_response_body_limit(error_limit)
        .with_streaming_response_body_limit(artifact_limit)
        .with_timeouts(TransportTimeouts::new(
            Timeout::After(Duration::from_secs(30)),
            Timeout::After(Duration::from_secs(60)),
            Timeout::After(Duration::from_secs(60)),
            Timeout::After(Duration::from_secs(10 * 60)),
        )))
}

fn get_request(url: &str, accept: &str) -> Result<HttpRequest, RemoteRuntimeUpdateError> {
    Ok(HttpRequest::new(
        HttpMethod::Get,
        url,
        vec![HttpHeader::new("Accept", accept)],
        Vec::new(),
    )?)
}

fn artifact_at(path: &Path, artifact: &RemoteRuntimeArtifact) -> RemoteRuntimeArtifact {
    RemoteRuntimeArtifact::new(
        path,
        RemoteRuntimeVersion::parse(artifact.version().as_str())
            .expect("a catalog artifact already contains a validated version"),
        artifact.platform(),
        RemoteRuntimeArtifactIntegrity::new(
            artifact.integrity().archive_size(),
            artifact.integrity().unpacked_size(),
            artifact.integrity().sha256(),
        )
        .expect("a catalog artifact already contains validated integrity"),
    )
}

fn relative_url_path(path: &Path) -> Result<String, RemoteRuntimeUpdateError> {
    let mut segments = Vec::new();
    for component in path.components() {
        let Component::Normal(segment) = component else {
            return Err(RemoteRuntimeUpdateError::InvalidRelease(
                "Remote runtime artifact path is not canonical and relative".into(),
            ));
        };
        segments.push(segment.to_str().ok_or_else(|| {
            RemoteRuntimeUpdateError::InvalidRelease(
                "Remote runtime artifact path is not UTF-8".into(),
            )
        })?);
    }
    if segments.is_empty() {
        return Err(RemoteRuntimeUpdateError::InvalidRelease(
            "Remote runtime artifact path is empty".into(),
        ));
    }
    Ok(segments.join("/"))
}

fn is_sha256(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn sha256(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

struct ArtifactDownloadSink<'a, F> {
    file: &'a mut File,
    expected_bytes: u64,
    expected_sha256: &'a str,
    hasher: Sha256,
    transferred_bytes: u64,
    last_reported_bytes: u64,
    report_progress: &'a mut F,
}

impl<'a, F> ArtifactDownloadSink<'a, F>
where
    F: FnMut(RemoteRuntimeDownloadProgress),
{
    fn new(
        file: &'a mut File,
        expected_bytes: u64,
        expected_sha256: &'a str,
        report_progress: &'a mut F,
    ) -> Self {
        Self {
            file,
            expected_bytes,
            expected_sha256,
            hasher: Sha256::new(),
            transferred_bytes: 0,
            last_reported_bytes: 0,
            report_progress,
        }
    }

    fn finish(self) -> Result<(), RemoteRuntimeUpdateError> {
        if self.transferred_bytes != self.expected_bytes {
            return Err(RemoteRuntimeUpdateError::Integrity(format!(
                "Remote runtime archive size mismatch: expected {}, observed {}",
                self.expected_bytes, self.transferred_bytes
            )));
        }
        let observed = format!("{:x}", self.hasher.finalize());
        if observed != self.expected_sha256 {
            return Err(RemoteRuntimeUpdateError::Integrity(format!(
                "Remote runtime archive SHA-256 mismatch: expected {}, observed {observed}",
                self.expected_sha256
            )));
        }
        Ok(())
    }
}

impl<F> HttpBodySink for ArtifactDownloadSink<'_, F>
where
    F: FnMut(RemoteRuntimeDownloadProgress),
{
    fn emit(&mut self, chunk: &[u8]) -> Result<(), HttpClientError> {
        let chunk_bytes = u64::try_from(chunk.len())
            .map_err(|_| HttpClientError::Transport("download chunk is too large".into()))?;
        self.transferred_bytes = self
            .transferred_bytes
            .checked_add(chunk_bytes)
            .ok_or_else(|| HttpClientError::Transport("download size overflowed".into()))?;
        if self.transferred_bytes > self.expected_bytes {
            return Err(HttpClientError::Transport(
                "download exceeded its release-authorized size".into(),
            ));
        }
        self.file
            .write_all(chunk)
            .map_err(|_| HttpClientError::Transport("failed to write runtime download".into()))?;
        self.hasher.update(chunk);
        if self.transferred_bytes == self.expected_bytes
            || self.transferred_bytes - self.last_reported_bytes >= DOWNLOAD_PROGRESS_INTERVAL_BYTES
        {
            self.last_reported_bytes = self.transferred_bytes;
            (self.report_progress)(RemoteRuntimeDownloadProgress::DownloadingArtifact {
                transferred_bytes: self.transferred_bytes,
                total_bytes: self.expected_bytes,
            });
        }
        Ok(())
    }
}

/// Failure before any downloaded bytes become an installable runtime generation.
#[derive(Debug)]
pub enum RemoteRuntimeUpdateError {
    InvalidRelease(String),
    Http(HttpClientError),
    HttpStatus { resource: &'static str, status: u16 },
    Catalog(RemoteRuntimeCatalogError),
    Cache(io::Error),
    Integrity(String),
    Artifact(RemoteRuntimeInstallError),
}

impl RemoteRuntimeUpdateError {
    fn cache(error: io::Error) -> Self {
        Self::Cache(error)
    }
}

impl fmt::Display for RemoteRuntimeUpdateError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRelease(message) | Self::Integrity(message) => {
                formatter.write_str(message)
            }
            Self::Http(error) => write!(formatter, "Remote runtime download failed: {error}"),
            Self::HttpStatus { resource, status } => write!(
                formatter,
                "Remote runtime {resource} request returned HTTP status {status}"
            ),
            Self::Catalog(error) => write!(formatter, "Remote runtime catalog is invalid: {error}"),
            Self::Cache(error) => {
                write!(formatter, "Remote runtime download cache failed: {error}")
            }
            Self::Artifact(error) => {
                write!(formatter, "downloaded Remote runtime is invalid: {error}")
            }
        }
    }
}

impl std::error::Error for RemoteRuntimeUpdateError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Http(error) => Some(error),
            Self::Catalog(error) => Some(error),
            Self::Cache(error) => Some(error),
            Self::Artifact(error) => Some(error),
            Self::InvalidRelease(_) | Self::HttpStatus { .. } | Self::Integrity(_) => None,
        }
    }
}

impl From<HttpClientError> for RemoteRuntimeUpdateError {
    fn from(error: HttpClientError) -> Self {
        Self::Http(error)
    }
}

impl From<RemoteRuntimeCatalogError> for RemoteRuntimeUpdateError {
    fn from(error: RemoteRuntimeCatalogError) -> Self {
        Self::Catalog(error)
    }
}

impl From<RemoteRuntimeInstallError> for RemoteRuntimeUpdateError {
    fn from(error: RemoteRuntimeInstallError) -> Self {
        Self::Artifact(error)
    }
}

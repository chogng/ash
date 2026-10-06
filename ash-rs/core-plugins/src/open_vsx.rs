use std::collections::BTreeSet;
use std::num::NonZeroUsize;
use std::path::Path;
use std::sync::Arc;
use std::sync::Mutex;

use ash_http_client::HttpClient;
use ash_http_client::HttpClientConfig;
use ash_http_client::HttpMethod;
use ash_http_client::HttpRequest;
use ash_http_client::ResponseBodyLimit;
use ash_http_client::UreqHttpClient;
use serde::Deserialize;
use sha2::Digest;
use sha2::Sha256;
use tempfile::TempDir;
use url::Url;

use crate::AvailableCapability;
use crate::CapabilityKind;
use crate::DownloadPackageRequest;
use crate::GetPackageRequest;
use crate::MarketplaceClientError;
use crate::PackageDetails;
use crate::PackageRef;
use crate::PackageSource;
use crate::PackageSummary;
use crate::PluginPackageCapability;
use crate::PluginPackagePayload;
use crate::PluginProvider;
use crate::SearchPackagesRequest;
use crate::SearchPackagesResult;
use crate::marketplace_store::inspect_tree;
use crate::registry::archive;
use crate::registry::catalog::copy_tree;

const MAX_METADATA_BYTES: usize = 4 * 1024 * 1024;
const MAX_MANIFEST_BYTES: u64 = 4 * 1024 * 1024;
const MAX_REDIRECTS: usize = 5;
const PACKAGE_TYPE: &str = "editorExtension";

/// Distribution endpoints for one independently named Open VSX provider.
///
/// The host supplies the API and permitted CDN origins. Registry metadata cannot widen this list.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenVsxConfig {
    api_url: Url,
    download_origins: BTreeSet<String>,
}

impl OpenVsxConfig {
    pub fn new(api_url: Url, download_origins: Vec<Url>) -> Result<Self, MarketplaceClientError> {
        validate_https(&api_url)?;
        if !api_url.path().ends_with('/') || api_url.query().is_some() {
            return Err(MarketplaceClientError::invalid_request(
                "invalid Open VSX API URL",
            ));
        }
        let mut origins = BTreeSet::from([api_url.origin().ascii_serialization()]);
        for url in download_origins {
            validate_https(&url)?;
            if url.path() != "/" || url.query().is_some() {
                return Err(MarketplaceClientError::invalid_request(
                    "invalid Open VSX download origin",
                ));
            }
            origins.insert(url.origin().ascii_serialization());
        }
        Ok(Self {
            api_url,
            download_origins: origins,
        })
    }
}

/// Open VSX discovery and checksum-verified VSIX ingestion, without extension execution.
///
/// The manager continues to own the durable installation and capability lifecycle. A single
/// resolved payload is retained so opening details and installing the same version share bytes.
pub struct OpenVsxClient {
    config: OpenVsxConfig,
    http: Arc<dyn HttpClient>,
    resolved: Mutex<Option<Arc<VsixPayload>>>,
}

impl OpenVsxClient {
    pub fn new(config: OpenVsxConfig) -> Result<Self, MarketplaceClientError> {
        let limit = ResponseBodyLimit::new(
            NonZeroUsize::new(archive::MAX_ARCHIVE_BYTES as usize)
                .expect("archive limit is nonzero"),
        )
        .map_err(|_| MarketplaceClientError::unavailable())?;
        let http = UreqHttpClient::with_config(
            // Endpoints come from the trusted product configuration. Use the product transport's
            // proxy/DNS policy while enforcing the origin list on every request and redirect.
            HttpClientConfig::default().with_response_body_limit(limit),
        )
        .map_err(|_| MarketplaceClientError::unavailable())?;
        Ok(Self {
            config,
            http: Arc::new(http),
            resolved: Mutex::new(None),
        })
    }

    fn fetch(&self, mut url: Url, limit: usize) -> Result<Vec<u8>, MarketplaceClientError> {
        for _ in 0..=MAX_REDIRECTS {
            validate_https(&url)?;
            if !self
                .config
                .download_origins
                .contains(&url.origin().ascii_serialization())
            {
                return Err(MarketplaceClientError::package_untrusted());
            }
            let request = HttpRequest::new(HttpMethod::Get, url.as_str(), Vec::new(), Vec::new())
                .map_err(|_| MarketplaceClientError::package_untrusted())?
                .without_redirects();
            let response = self
                .http
                .execute(&request)
                .map_err(|_| MarketplaceClientError::unavailable())?;
            if matches!(response.status(), 301 | 302 | 303 | 307 | 308) {
                let location = response
                    .headers()
                    .iter()
                    .find(|header| header.name().eq_ignore_ascii_case("location"))
                    .ok_or_else(MarketplaceClientError::package_untrusted)?;
                url = url
                    .join(location.value())
                    .map_err(|_| MarketplaceClientError::package_untrusted())?;
                continue;
            }
            if response.status() == 404 {
                return Err(MarketplaceClientError::package_not_found());
            }
            if !response.is_success() {
                return Err(MarketplaceClientError::unavailable());
            }
            if response.body().len() > limit {
                return Err(MarketplaceClientError::package_untrusted());
            }
            return Ok(response.body().to_vec());
        }
        Err(MarketplaceClientError::package_untrusted())
    }

    fn resolve(
        &self,
        request: GetPackageRequest,
    ) -> Result<Arc<VsixPayload>, MarketplaceClientError> {
        let (namespace, name) = extension_name(&request.package_id)?;
        let version = request.version.as_deref().unwrap_or("latest");
        if request
            .version
            .as_ref()
            .is_some_and(|version| semver::Version::parse(version).is_err())
        {
            return Err(MarketplaceClientError::invalid_request(
                "invalid Open VSX version",
            ));
        }
        // Only universal artifacts can enter the browser editor catalog. Platform binaries are
        // not selected implicitly, and a package's main/browser entrypoint is never launched here.
        let url = self
            .config
            .api_url
            .join(&format!("{namespace}/{name}/universal/{version}"))
            .map_err(|_| MarketplaceClientError::invalid_request("invalid Open VSX package ID"))?;
        let bytes = self.fetch(url.clone(), MAX_METADATA_BYTES)?;
        let metadata: ExtensionMetadata = serde_json::from_slice(&bytes)
            .map_err(|_| MarketplaceClientError::package_untrusted())?;
        if metadata.namespace != namespace
            || metadata.name != name
            || metadata.target_platform != "universal"
            || metadata.pre_release
            || !metadata.downloadable
            || semver::Version::parse(&metadata.version).is_err()
            || request
                .version
                .as_ref()
                .is_some_and(|version| version != &metadata.version)
        {
            return Err(MarketplaceClientError::package_untrusted());
        }
        let hash_url = Url::parse(&metadata.files.sha256)
            .map_err(|_| MarketplaceClientError::package_untrusted())?;
        let expected = self.fetch(hash_url, 1024)?;
        let expected = std::str::from_utf8(&expected)
            .map_err(|_| MarketplaceClientError::package_untrusted())?
            .trim();
        if expected.len() != 64 || !expected.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err(MarketplaceClientError::package_untrusted());
        }
        let mut resolved = self
            .resolved
            .lock()
            .map_err(|_| MarketplaceClientError::unavailable())?;
        if let Some(payload) = resolved.as_ref()
            && payload.package.id == request.package_id
            && payload.package.version == metadata.version
            && payload.archive_sha256.eq_ignore_ascii_case(expected)
        {
            return Ok(Arc::clone(payload));
        }
        let download = Url::parse(&metadata.files.download)
            .map_err(|_| MarketplaceClientError::package_untrusted())?;
        let bytes = self.fetch(download, archive::MAX_ARCHIVE_BYTES as usize)?;
        if !format!("{:x}", Sha256::digest(&bytes)).eq_ignore_ascii_case(expected) {
            return Err(MarketplaceClientError::package_untrusted());
        }
        let record_url = self
            .config
            .api_url
            .join(&format!(
                "{namespace}/{name}/universal/{}",
                metadata.version
            ))
            .map_err(|_| MarketplaceClientError::package_untrusted())?;
        let payload = Arc::new(VsixPayload::read(
            metadata,
            expected.to_ascii_lowercase(),
            &bytes,
            record_url,
        )?);
        *resolved = Some(Arc::clone(&payload));
        Ok(payload)
    }
}

impl PluginProvider for OpenVsxClient {
    fn search(
        &self,
        request: SearchPackagesRequest,
    ) -> Result<SearchPackagesResult, MarketplaceClientError> {
        if request
            .package_type
            .as_ref()
            .is_some_and(|kind| kind != PACKAGE_TYPE)
            || request
                .capability_kind
                .is_some_and(|kind| kind != CapabilityKind::EditorExtension)
            || request.language_id.is_some()
        {
            return Ok(SearchPackagesResult {
                packages: Vec::new(),
            });
        }
        let limit = request.limit.unwrap_or(50).clamp(1, 200);
        let mut url = self
            .config
            .api_url
            .join("-/search")
            .map_err(|_| MarketplaceClientError::unavailable())?;
        url.query_pairs_mut()
            .append_pair("query", &request.query)
            .append_pair("size", &limit.to_string())
            .append_pair("targetPlatform", "universal");
        let bytes = self.fetch(url, MAX_METADATA_BYTES)?;
        let result: SearchResult = serde_json::from_slice(&bytes)
            .map_err(|_| MarketplaceClientError::package_untrusted())?;
        let mut packages = Vec::new();
        for entry in result.extensions.into_iter().take(limit) {
            let id = format!("{}.{}", entry.namespace, entry.name);
            extension_name(&id)?;
            if semver::Version::parse(&entry.version).is_err() {
                return Err(MarketplaceClientError::package_untrusted());
            }
            packages.push(PackageSummary {
                id,
                version: entry.version,
                package_type: PACKAGE_TYPE.into(),
                display_name: entry.display_name.unwrap_or(entry.name),
                description: entry.description.unwrap_or_default(),
            });
        }
        Ok(SearchPackagesResult { packages })
    }

    fn get(&self, request: GetPackageRequest) -> Result<PackageDetails, MarketplaceClientError> {
        let payload = self.resolve(request)?;
        Ok(PackageDetails {
            package: payload.package.clone(),
            package_type: PACKAGE_TYPE.into(),
            display_name: payload
                .metadata
                .display_name
                .clone()
                .unwrap_or_else(|| payload.metadata.name.clone()),
            description: payload.metadata.description.clone().unwrap_or_default(),
            license: payload.metadata.license.clone().unwrap_or_default(),
            source: PackageSource::ThirdParty,
            upstream: None,
            capabilities: vec![AvailableCapability {
                kind: CapabilityKind::EditorExtension,
                id: payload.package.id.clone(),
                contract_version: "1".into(),
                permissions: Vec::new(),
                authentication_provider: None,
            }],
        })
    }

    fn download(
        &self,
        request: DownloadPackageRequest,
    ) -> Result<Box<dyn PluginPackagePayload>, MarketplaceClientError> {
        Ok(Box::new(self.resolve(GetPackageRequest {
            package_id: request.package_id,
            version: request.version,
        })?))
    }
}

struct VsixPayload {
    metadata: ExtensionMetadata,
    archive_sha256: String,
    package: PackageRef,
    contents: TempDir,
    capabilities: Vec<PluginPackageCapability>,
    file_count: u64,
    size_bytes: u64,
}

impl VsixPayload {
    fn read(
        metadata: ExtensionMetadata,
        archive_sha256: String,
        bytes: &[u8],
        record_url: Url,
    ) -> Result<Self, MarketplaceClientError> {
        let contents = tempfile::tempdir().map_err(|_| MarketplaceClientError::storage())?;
        archive::extract(bytes, contents.path())?;
        let manifest_path = contents.path().join("extension/package.json");
        let file = std::fs::symlink_metadata(&manifest_path)
            .map_err(|_| MarketplaceClientError::package_untrusted())?;
        if !file.is_file() || file.len() > MAX_MANIFEST_BYTES {
            return Err(MarketplaceClientError::package_untrusted());
        }
        let manifest: serde_json::Value = serde_json::from_slice(
            &std::fs::read(manifest_path).map_err(|_| MarketplaceClientError::storage())?,
        )
        .map_err(|_| MarketplaceClientError::package_untrusted())?;
        if manifest["publisher"].as_str() != Some(&metadata.namespace)
            || manifest["name"].as_str() != Some(&metadata.name)
            || manifest["version"].as_str() != Some(&metadata.version)
        {
            return Err(MarketplaceClientError::package_untrusted());
        }
        // Only immutable artifact facts enter the content digest. Publisher verification can
        // change independently of a release; neither it nor a checksum grants execution permission.
        let provenance = serde_json::to_vec(&serde_json::json!({
            "registryRecord": record_url.as_str(), "archiveSha256": archive_sha256,
            "targetPlatform": metadata.target_platform,
        }))
        .map_err(|_| MarketplaceClientError::package_untrusted())?;
        let mut provenance_file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(contents.path().join("ash-open-vsx.json"))
            .map_err(|_| MarketplaceClientError::package_untrusted())?;
        std::io::Write::write_all(&mut provenance_file, &provenance)
            .map_err(|_| MarketplaceClientError::storage())?;
        let inspection = inspect_tree(contents.path())?;
        let id = format!("{}.{}", metadata.namespace, metadata.name);
        Ok(Self {
            package: PackageRef {
                id: id.clone(),
                version: metadata.version.clone(),
                digest: inspection.digest,
            },
            metadata,
            archive_sha256,
            contents,
            capabilities: vec![PluginPackageCapability {
                kind: CapabilityKind::EditorExtension,
                id,
                path: "extension".into(),
                runtime: None,
                language_ids: Vec::new(),
            }],
            file_count: inspection.file_count,
            size_bytes: inspection.total_bytes,
        })
    }
}

impl PluginPackagePayload for Arc<VsixPayload> {
    fn package(&self) -> &PackageRef {
        &self.package
    }
    fn capabilities(&self) -> &[PluginPackageCapability] {
        &self.capabilities
    }
    fn expected_file_count(&self) -> u64 {
        self.file_count
    }
    fn expected_size_bytes(&self) -> u64 {
        self.size_bytes
    }
    fn copy_to(&self, destination: &Path) -> Result<(), MarketplaceClientError> {
        copy_tree(self.contents.path(), destination)
    }
}

fn validate_https(url: &Url) -> Result<(), MarketplaceClientError> {
    if url.scheme() != "https"
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.fragment().is_some()
    {
        return Err(MarketplaceClientError::invalid_request(
            "Open VSX requires an HTTPS endpoint without credentials",
        ));
    }
    Ok(())
}

fn extension_name(value: &str) -> Result<(&str, &str), MarketplaceClientError> {
    let (namespace, name) = value.split_once('.').ok_or_else(|| {
        MarketplaceClientError::invalid_request("Open VSX requires publisher.name")
    })?;
    if [namespace, name].into_iter().any(|value| {
        value.is_empty()
            || value.len() > 128
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
    }) {
        return Err(MarketplaceClientError::invalid_request(
            "invalid Open VSX extension ID",
        ));
    }
    Ok((namespace, name))
}

#[derive(Deserialize)]
struct SearchResult {
    extensions: Vec<SearchEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchEntry {
    namespace: String,
    name: String,
    version: String,
    display_name: Option<String>,
    description: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExtensionMetadata {
    namespace: String,
    name: String,
    version: String,
    target_platform: String,
    pre_release: bool,
    downloadable: bool,
    display_name: Option<String>,
    description: Option<String>,
    license: Option<String>,
    files: ExtensionFiles,
}

#[derive(Deserialize)]
struct ExtensionFiles {
    download: String,
    sha256: String,
}

#[cfg(test)]
#[path = "open_vsx_tests.rs"]
mod tests;

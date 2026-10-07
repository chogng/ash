use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use crate::PackageRef;
use semver::Version;
use serde::Deserialize;
use tempfile::TempDir;
use tough::DefaultTransport;
use tough::ExpirationEnforcement;
use tough::IntoVec;
use tough::Limits;
use tough::Repository;
use tough::RepositoryLoader;
use tough::TargetName;
use tough::schema::Targets;
use url::Url;

use crate::MarketplaceClientError;
use crate::registry::archive;
use crate::registry::catalog::CatalogManifest;
use crate::registry::catalog::Release;

mod cache;

use cache::cache_repository;
use cache::open_cached_repository;
use cache::prepare_cache_root;
use cache::replace_directory;
use cache::stage_datastore;

const MAX_TRUSTED_ROOT_BYTES: usize = 1024 * 1024;
const MAX_REVOCATIONS_BYTES: usize = 4 * 1024 * 1024;
const DEFAULT_CATALOG_REFRESH_INTERVAL: Duration = Duration::from_secs(300);
const MIN_CATALOG_REFRESH_INTERVAL: Duration = Duration::from_secs(60);
const MAX_CATALOG_REFRESH_INTERVAL: Duration = Duration::from_secs(86_400);

/// Product-pinned deployment configuration for one remote Marketplace source.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RemoteMarketplaceConfig {
    metadata_base_url: Url,
    targets_base_url: Url,
    trusted_root: Vec<u8>,
    cache_root: PathBuf,
    allowed_publishers: BTreeSet<String>,
    catalog_refresh_interval: Duration,
}

impl RemoteMarketplaceConfig {
    /// Creates a production HTTPS Marketplace source with an out-of-band trusted root.
    pub fn new(
        metadata_base_url: Url,
        targets_base_url: Url,
        trusted_root: Vec<u8>,
        cache_root: impl Into<PathBuf>,
    ) -> Result<Self, MarketplaceClientError> {
        if metadata_base_url.scheme() != "https"
            || targets_base_url.scheme() != "https"
            || !valid_base_url(&metadata_base_url)
            || !valid_base_url(&targets_base_url)
            || trusted_root.is_empty()
            || trusted_root.len() > MAX_TRUSTED_ROOT_BYTES
        {
            return Err(MarketplaceClientError::invalid_request(
                "Marketplace remote source configuration is invalid",
            ));
        }
        Ok(Self {
            metadata_base_url,
            targets_base_url,
            trusted_root,
            cache_root: cache_root.into(),
            allowed_publishers: BTreeSet::new(),
            catalog_refresh_interval: DEFAULT_CATALOG_REFRESH_INTERVAL,
        })
    }

    /// Opens a signed filesystem distribution for development and deterministic tests.
    pub fn from_directory(
        distribution_root: impl AsRef<Path>,
        trusted_root: Vec<u8>,
        cache_root: impl Into<PathBuf>,
    ) -> Result<Self, MarketplaceClientError> {
        let distribution_root = distribution_root
            .as_ref()
            .canonicalize()
            .map_err(|_| MarketplaceClientError::storage())?;
        if trusted_root.is_empty() || trusted_root.len() > MAX_TRUSTED_ROOT_BYTES {
            return Err(MarketplaceClientError::invalid_request(
                "Marketplace trusted root is invalid",
            ));
        }
        Ok(Self {
            metadata_base_url: directory_url(&distribution_root.join("metadata"))?,
            targets_base_url: directory_url(&distribution_root.join("targets"))?,
            trusted_root,
            cache_root: cache_root.into(),
            allowed_publishers: BTreeSet::new(),
            catalog_refresh_interval: DEFAULT_CATALOG_REFRESH_INTERVAL,
        })
    }

    /// Restricts a host-approved source to exact publisher namespaces.
    pub fn with_allowed_publishers(
        mut self,
        publishers: impl IntoIterator<Item = String>,
    ) -> Result<Self, MarketplaceClientError> {
        let publishers = publishers.into_iter().collect::<Vec<_>>();
        let unique = publishers.iter().cloned().collect::<BTreeSet<_>>();
        if unique.is_empty()
            || unique.len() != publishers.len()
            || unique
                .iter()
                .any(|publisher| !valid_identifier_segment(publisher))
        {
            return Err(MarketplaceClientError::invalid_request(
                "Marketplace publisher policy is invalid",
            ));
        }
        self.allowed_publishers = unique;
        Ok(self)
    }

    /// Sets how long an in-process verified catalog snapshot may be reused before refreshing.
    ///
    /// TUF expiry and rollback checks remain mandatory and are not weakened by this interval.
    pub fn with_catalog_refresh_interval(
        mut self,
        interval: Duration,
    ) -> Result<Self, MarketplaceClientError> {
        if !(MIN_CATALOG_REFRESH_INTERVAL..=MAX_CATALOG_REFRESH_INTERVAL).contains(&interval) {
            return Err(MarketplaceClientError::invalid_request(
                "Marketplace catalog refresh interval is invalid",
            ));
        }
        self.catalog_refresh_interval = interval;
        Ok(self)
    }

    /// Returns the pinned TUF metadata endpoint used by this registry.
    pub fn metadata_base_url(&self) -> &Url {
        &self.metadata_base_url
    }

    /// Returns the pinned TUF target endpoint used by this registry.
    pub fn targets_base_url(&self) -> &Url {
        &self.targets_base_url
    }

    /// Returns the product-selected in-process catalog refresh interval.
    pub fn catalog_refresh_interval(&self) -> Duration {
        self.catalog_refresh_interval
    }
}

#[derive(Clone)]
pub(crate) struct RemotePackageTarget {
    name: TargetName,
    package: PackageRef,
    signed_length: u64,
    package_file_count: u64,
    package_size_bytes: u64,
}

impl RemotePackageTarget {
    pub(crate) fn package(&self) -> &PackageRef {
        &self.package
    }

    pub(crate) fn package_file_count(&self) -> u64 {
        self.package_file_count
    }

    pub(crate) fn package_size_bytes(&self) -> u64 {
        self.package_size_bytes
    }
}

pub(crate) struct RemoteSource {
    config: RemoteMarketplaceConfig,
}

impl RemoteSource {
    pub(crate) fn new(config: RemoteMarketplaceConfig) -> Result<Self, MarketplaceClientError> {
        prepare_cache_root(&config.cache_root)?;
        Ok(Self { config })
    }

    pub(crate) fn releases(&self) -> Result<Vec<Release>, MarketplaceClientError> {
        let runtime = runtime()?;
        runtime.block_on(self.releases_async())
    }

    pub(crate) fn materialize(
        &self,
        expected: &RemotePackageTarget,
    ) -> Result<TempDir, MarketplaceClientError> {
        let runtime = runtime()?;
        runtime.block_on(self.materialize_async(expected))
    }

    async fn releases_async(&self) -> Result<Vec<Release>, MarketplaceClientError> {
        let loaded = self.load().await?;
        let releases =
            collect_releases(&loaded.repository, &self.config.allowed_publishers).await?;
        if let Some(datastore) = loaded.datastore {
            cache_repository(&self.config, &loaded.repository, &[]).await?;
            replace_directory(datastore, &self.config.cache_root.join("tuf"))?;
        }
        Ok(releases)
    }

    async fn materialize_async(
        &self,
        expected: &RemotePackageTarget,
    ) -> Result<TempDir, MarketplaceClientError> {
        let loaded = self.load().await?;
        let releases =
            collect_releases(&loaded.repository, &self.config.allowed_publishers).await?;
        let exact = releases
            .iter()
            .map(|release| &release.target)
            .find(|target| target.package == expected.package);
        let exact = exact.ok_or_else(MarketplaceClientError::package_untrusted)?;
        if exact.name != expected.name
            || exact.signed_length != expected.signed_length
            || exact.package_file_count != expected.package_file_count
            || exact.package_size_bytes != expected.package_size_bytes
        {
            return Err(MarketplaceClientError::package_untrusted());
        }
        let bytes = read_target(
            &loaded.repository,
            &exact.name,
            exact.signed_length,
            archive::MAX_ARCHIVE_BYTES as usize,
        )
        .await?;
        let staging = tempfile::Builder::new()
            .prefix(".remote-package-")
            .tempdir_in(&self.config.cache_root)
            .map_err(|_| MarketplaceClientError::storage())?;
        archive::extract(&bytes, staging.path())?;
        if let Some(datastore) = loaded.datastore {
            cache_repository(
                &self.config,
                &loaded.repository,
                std::slice::from_ref(&exact.name),
            )
            .await?;
            replace_directory(datastore, &self.config.cache_root.join("tuf"))?;
        }
        Ok(staging)
    }

    async fn load(&self) -> Result<LoadedRepository, MarketplaceClientError> {
        let datastore_root = self.config.cache_root.join("tuf");
        let datastore = stage_datastore(&self.config.cache_root, &datastore_root)?;
        let online = RepositoryLoader::new(
            &self.config.trusted_root,
            self.config.metadata_base_url.clone(),
            self.config.targets_base_url.clone(),
        )
        .transport(DefaultTransport::default())
        .datastore(datastore.path())
        .limits(Limits::default())
        .expiration_enforcement(ExpirationEnforcement::Safe)
        .load()
        .await;
        match online {
            Ok(repository) => Ok(LoadedRepository {
                repository,
                datastore: Some(datastore),
            }),
            Err(tough::error::Error::Transport { .. }) => Ok(LoadedRepository {
                repository: open_cached_repository(&self.config).await?,
                datastore: None,
            }),
            Err(_) => Err(MarketplaceClientError::package_untrusted()),
        }
    }
}

struct LoadedRepository {
    repository: Repository,
    datastore: Option<TempDir>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PackageTargetMetadata {
    schema_version: u32,
    id: String,
    version: Version,
    package_digest: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CatalogTargetMetadata {
    schema_version: u32,
    manifest: CatalogManifest,
    #[serde(default)]
    consumer_metadata: BTreeMap<String, serde_json::Value>,
    package_file_count: u64,
    package_size_bytes: u64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RevocationDocument {
    schema_version: u32,
    #[serde(default)]
    revoked: Vec<RevokedPackage>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RevokedPackage {
    id: String,
    version: Version,
    digest: String,
}

async fn collect_releases(
    repository: &Repository,
    allowed_publishers: &BTreeSet<String>,
) -> Result<Vec<Release>, MarketplaceClientError> {
    let revoked = read_revocations(repository).await?;
    let mut releases = BTreeMap::new();
    let mut publishers = BTreeSet::new();
    collect_delegated_targets(
        &repository.targets().signed,
        &mut releases,
        &mut publishers,
        &revoked,
    )?;
    if !allowed_publishers.is_empty()
        && publishers
            .iter()
            .any(|publisher| !allowed_publishers.contains(publisher))
    {
        return Err(MarketplaceClientError::package_untrusted());
    }
    Ok(releases.into_values().collect())
}

fn collect_delegated_targets(
    targets: &Targets,
    releases: &mut BTreeMap<(String, Version), Release>,
    publishers: &mut BTreeSet<String>,
    revoked: &BTreeSet<(String, Version, String)>,
) -> Result<(), MarketplaceClientError> {
    let Some(delegations) = &targets.delegations else {
        return Ok(());
    };
    for role in &delegations.roles {
        let Some(signed) = role.targets.as_ref() else {
            continue;
        };
        for (name, target) in &signed.signed.targets {
            let Some(package_value) = target.custom.get("marketplacePackage").cloned() else {
                continue;
            };
            let catalog_value = target
                .custom
                .get("marketplaceCatalog")
                .cloned()
                .ok_or_else(MarketplaceClientError::package_untrusted)?;
            let package: PackageTargetMetadata = serde_json::from_value(package_value)
                .map_err(|_| MarketplaceClientError::package_untrusted())?;
            let catalog: CatalogTargetMetadata = serde_json::from_value(catalog_value)
                .map_err(|_| MarketplaceClientError::package_untrusted())?;
            let publisher = package_publisher(&package.id)?;
            if package.schema_version != 1
                || catalog.schema_version != 1
                || role.name != format!("publishers/{publisher}")
                || name.raw() != format!("packages/{}/{}.zip", package.id, package.version)
                || catalog.manifest.id != package.id
                || catalog.manifest.version != package.version
                || !valid_digest(&package.package_digest)
                || target.length > archive::MAX_ARCHIVE_BYTES
                || catalog.package_file_count == 0
                || catalog.package_file_count > archive::MAX_ARCHIVE_ENTRIES as u64
                || catalog.package_size_bytes == 0
                || catalog.package_size_bytes > archive::MAX_EXPANDED_BYTES
            {
                return Err(MarketplaceClientError::package_untrusted());
            }
            crate::registry::catalog::validate_manifest(&catalog.manifest)
                .map_err(|_| MarketplaceClientError::package_untrusted())?;
            let _ = catalog.consumer_metadata;
            publishers.insert(publisher.to_owned());
            if revoked.contains(&(
                package.id.clone(),
                package.version.clone(),
                package.package_digest.clone(),
            )) {
                continue;
            }
            let package_ref = PackageRef {
                id: package.id.clone(),
                version: package.version.to_string(),
                digest: package.package_digest,
            };
            let release = Release {
                manifest: catalog.manifest,
                target: RemotePackageTarget {
                    name: name.clone(),
                    package: package_ref,
                    signed_length: target.length,
                    package_file_count: catalog.package_file_count,
                    package_size_bytes: catalog.package_size_bytes,
                },
            };
            if releases
                .insert((package.id, package.version), release)
                .is_some()
            {
                return Err(MarketplaceClientError::package_untrusted());
            }
        }
        collect_delegated_targets(&signed.signed, releases, publishers, revoked)?;
    }
    Ok(())
}

async fn read_revocations(
    repository: &Repository,
) -> Result<BTreeSet<(String, Version, String)>, MarketplaceClientError> {
    let name = TargetName::new("marketplace/revocations.json")
        .map_err(|_| MarketplaceClientError::package_untrusted())?;
    let target = repository
        .targets()
        .signed
        .targets
        .get(&name)
        .ok_or_else(MarketplaceClientError::package_untrusted)?;
    let bytes = read_target(repository, &name, target.length, MAX_REVOCATIONS_BYTES).await?;
    let document: RevocationDocument =
        serde_json::from_slice(&bytes).map_err(|_| MarketplaceClientError::package_untrusted())?;
    if document.schema_version != 1 {
        return Err(MarketplaceClientError::package_untrusted());
    }
    let mut revoked = BTreeSet::new();
    let mut identities = BTreeMap::new();
    for package in document.revoked {
        if package_publisher(&package.id).is_err() || !valid_digest(&package.digest) {
            return Err(MarketplaceClientError::package_untrusted());
        }
        let identity = (package.id.clone(), package.version.clone());
        if let Some(existing) = identities.insert(identity, package.digest.clone())
            && existing != package.digest
        {
            return Err(MarketplaceClientError::package_untrusted());
        }
        revoked.insert((package.id, package.version, package.digest));
    }
    Ok(revoked)
}

async fn read_target(
    repository: &Repository,
    name: &TargetName,
    signed_length: u64,
    limit: usize,
) -> Result<Vec<u8>, MarketplaceClientError> {
    if signed_length > limit as u64 {
        return Err(MarketplaceClientError::package_untrusted());
    }
    let stream = repository
        .read_target(name)
        .await
        .map_err(|_| MarketplaceClientError::unavailable())?
        .ok_or_else(MarketplaceClientError::unavailable)?;
    let bytes = stream
        .into_vec()
        .await
        .map_err(|_| MarketplaceClientError::unavailable())?;
    if bytes.len() > limit || bytes.len() as u64 != signed_length {
        return Err(MarketplaceClientError::package_untrusted());
    }
    Ok(bytes)
}

fn valid_base_url(url: &Url) -> bool {
    !url.cannot_be_a_base()
        && url.username().is_empty()
        && url.password().is_none()
        && url.query().is_none()
        && url.fragment().is_none()
        && url.path().ends_with('/')
}

fn package_publisher(id: &str) -> Result<&str, MarketplaceClientError> {
    let Some((publisher, name)) = id.split_once('/') else {
        return Err(MarketplaceClientError::package_untrusted());
    };
    if id.matches('/').count() != 1
        || !valid_identifier_segment(publisher)
        || !valid_identifier_segment(name)
    {
        return Err(MarketplaceClientError::package_untrusted());
    }
    Ok(publisher)
}

fn valid_identifier_segment(value: &str) -> bool {
    !value.is_empty()
        && !value.starts_with('-')
        && !value.ends_with('-')
        && !value.contains("--")
        && value
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
}

fn valid_digest(value: &str) -> bool {
    value.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    })
}

pub(super) fn directory_url(path: &Path) -> Result<Url, MarketplaceClientError> {
    Url::from_directory_path(path).map_err(|_| MarketplaceClientError::storage())
}

fn runtime() -> Result<tokio::runtime::Runtime, MarketplaceClientError> {
    tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .map_err(|_| MarketplaceClientError::unavailable())
}

#[cfg(test)]
#[path = "remote_tests.rs"]
mod tests;

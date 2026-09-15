use ash_plugin::MarketplaceName;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::fs;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::time::Duration;

use connectors::ConnectorId;
use connectors::GitHubBrokeredOAuthConfig;
use connectors::GitHubDeviceOAuthConfig;
use serde::Deserialize;
use sha2::Digest;
use sha2::Sha256;
use url::Url;

use crate::OpenAppServerError;

const PRODUCT_SERVICES_SCHEMA_VERSION: u32 = 2;
const MAX_PRODUCT_SERVICES_BYTES: u64 = 1024 * 1024;

/// Product-distribution trust and public OAuth configuration loaded by a host.
///
/// This document contains no confidential client secret. Marketplace root metadata remains pinned
/// by the product file, while broker URLs and public client IDs are explicit host inputs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalProductServicesConfig {
    pub(crate) marketplaces: BTreeMap<MarketplaceName, ash_core_plugins::RemoteMarketplaceConfig>,
    pub(crate) connector_oauth: Vec<ProductConnectorOAuthConfig>,
    pub(crate) image_generation: Option<ProductImageGenerationConfig>,
    pub(crate) git_attribution: Option<ProductGitAttributionConfig>,
    authority_identity: [u8; 32],
}

impl LocalProductServicesConfig {
    pub fn load(
        path: impl AsRef<Path>,
        profile_root: impl AsRef<Path>,
    ) -> Result<Self, OpenAppServerError> {
        let path = path.as_ref();
        let metadata = fs::symlink_metadata(path).map_err(product_config_error)?;
        if metadata.file_type().is_symlink()
            || !metadata.is_file()
            || metadata.len() > MAX_PRODUCT_SERVICES_BYTES
        {
            return Err(product_config_error(()));
        }
        let bytes = fs::read(path).map_err(product_config_error)?;
        let document: ProductServicesDocument =
            serde_json::from_slice(&bytes).map_err(product_config_error)?;
        if document.schema_version != PRODUCT_SERVICES_SCHEMA_VERSION {
            return Err(product_config_error(()));
        }
        let source_root = path.parent().ok_or_else(|| product_config_error(()))?;
        let mut authority_identity = Sha256::new();
        authority_identity.update(&bytes);
        let mut marketplaces = BTreeMap::new();
        for marketplace in document.marketplaces {
            let name = marketplace.name;
            let trusted_root = read_trusted_root(source_root, &marketplace.trusted_root)?;
            authority_identity.update((trusted_root.len() as u64).to_le_bytes());
            authority_identity.update(&trusted_root);
            let mut config = ash_core_plugins::RemoteMarketplaceConfig::new(
                Url::parse(&marketplace.metadata_base_url).map_err(product_config_error)?,
                Url::parse(&marketplace.targets_base_url).map_err(product_config_error)?,
                trusted_root,
                profile_root
                    .as_ref()
                    .join("cache/marketplace")
                    .join(format!("{:x}", Sha256::digest(name.as_str()))),
            )
            .map_err(product_config_error)?;
            if let Some(seconds) = marketplace.catalog_refresh_interval_seconds {
                config = config
                    .with_catalog_refresh_interval(Duration::from_secs(seconds))
                    .map_err(product_config_error)?;
            }
            if let Some(publishers) = marketplace.allowed_publishers {
                config = config
                    .with_allowed_publishers(publishers)
                    .map_err(product_config_error)?;
            }
            if marketplaces.insert(name, config).is_some() {
                return Err(product_config_error(()));
            }
        }
        let connector_oauth = document
            .connector_oauth
            .into_iter()
            .map(ProductConnectorOAuthConfig::try_from)
            .collect::<Result<Vec<_>, _>>()?;
        validate_unique_configuration(&connector_oauth)?;
        if let Some(image) = &document.image_generation {
            let endpoint = Url::parse(&image.endpoint).map_err(product_config_error)?;
            if endpoint.scheme() != "https"
                || !endpoint.username().is_empty()
                || endpoint.password().is_some()
                || endpoint.fragment().is_some()
                || endpoint.host_str().is_none()
                || image.service_name.trim().is_empty()
                || image.service_name.len() > 256
            {
                return Err(product_config_error(()));
            }
            if let Some(reference) = &image.credential_reference {
                ash_secrets::SecretKey::new(reference).map_err(product_config_error)?;
            }
        }
        if let Some(policy) = &document.git_attribution {
            policy.policy().validate().map_err(product_config_error)?;
        }
        Ok(Self {
            image_generation: document.image_generation,
            git_attribution: document.git_attribution,
            marketplaces,
            connector_oauth,
            authority_identity: authority_identity.finalize().into(),
        })
    }

    /// Returns named, independently pinned Marketplace provider configurations.
    pub fn marketplaces(
        &self,
    ) -> &BTreeMap<MarketplaceName, ash_core_plugins::RemoteMarketplaceConfig> {
        &self.marketplaces
    }

    /// Returns the distribution inputs that must match before products share a local authority.
    ///
    /// The identity covers the manifest and referenced trust-root bytes, but not their installation
    /// paths. Identical signed product configuration can therefore be packaged by multiple product
    /// hosts without splitting their profile authority.
    pub fn authority_identity(&self) -> &[u8; 32] {
        &self.authority_identity
    }
}

fn validate_unique_configuration(
    connector_oauth: &[ProductConnectorOAuthConfig],
) -> Result<(), OpenAppServerError> {
    let connector_ids = connector_oauth
        .iter()
        .map(|configuration| match configuration {
            ProductConnectorOAuthConfig::GitHubBrokered { connector_id, .. }
            | ProductConnectorOAuthConfig::GitHubDevice { connector_id, .. } => connector_id,
        })
        .collect::<BTreeSet<_>>();
    if connector_ids.len() != connector_oauth.len() {
        return Err(product_config_error(()));
    }
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ProductConnectorOAuthConfig {
    GitHubBrokered {
        connector_id: ConnectorId,
        config: GitHubBrokeredOAuthConfig,
    },
    GitHubDevice {
        connector_id: ConnectorId,
        config: GitHubDeviceOAuthConfig,
    },
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProductServicesDocument {
    schema_version: u32,
    #[serde(default)]
    marketplaces: Vec<ProductMarketplaceDocument>,
    #[serde(default)]
    connector_oauth: Vec<ProductConnectorOAuthDocument>,
    #[serde(default)]
    image_generation: Option<ProductImageGenerationConfig>,
    #[serde(default)]
    git_attribution: Option<ProductGitAttributionConfig>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProductMarketplaceDocument {
    name: MarketplaceName,
    metadata_base_url: String,
    targets_base_url: String,
    trusted_root: PathBuf,
    #[serde(default)]
    catalog_refresh_interval_seconds: Option<u64>,
    #[serde(default)]
    allowed_publishers: Option<Vec<String>>,
}

#[derive(Deserialize)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
enum ProductConnectorOAuthDocument {
    #[serde(rename = "githubBrokered")]
    GitHubBrokered {
        connector_id: String,
        broker_base_url: String,
        client_id: String,
        #[serde(default)]
        scopes: Vec<String>,
    },
    #[serde(rename = "githubDevice")]
    GitHubDevice {
        connector_id: String,
        client_id: String,
        #[serde(default)]
        scopes: Vec<String>,
    },
}

impl TryFrom<ProductConnectorOAuthDocument> for ProductConnectorOAuthConfig {
    type Error = OpenAppServerError;

    fn try_from(document: ProductConnectorOAuthDocument) -> Result<Self, Self::Error> {
        match document {
            ProductConnectorOAuthDocument::GitHubBrokered {
                connector_id,
                broker_base_url,
                client_id,
                scopes,
            } => Ok(Self::GitHubBrokered {
                connector_id: ConnectorId::new(connector_id).map_err(product_config_error)?,
                config: GitHubBrokeredOAuthConfig {
                    broker_base_url: Url::parse(&broker_base_url).map_err(product_config_error)?,
                    client_id,
                    scopes,
                },
            }),
            ProductConnectorOAuthDocument::GitHubDevice {
                connector_id,
                client_id,
                scopes,
            } => Ok(Self::GitHubDevice {
                connector_id: ConnectorId::new(connector_id).map_err(product_config_error)?,
                config: GitHubDeviceOAuthConfig { client_id, scopes },
            }),
        }
    }
}

fn read_trusted_root(root: &Path, relative_path: &Path) -> Result<Vec<u8>, OpenAppServerError> {
    let path = resolve_relative_regular_file(root, relative_path)?;
    fs::read(path).map_err(product_config_error)
}

fn resolve_relative_regular_file(
    root: &Path,
    relative_path: &Path,
) -> Result<PathBuf, OpenAppServerError> {
    if relative_path.as_os_str().is_empty()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
    {
        return Err(product_config_error(()));
    }
    let canonical_root = fs::canonicalize(root).map_err(product_config_error)?;
    let path = root.join(relative_path);
    let metadata = fs::symlink_metadata(&path).map_err(product_config_error)?;
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > MAX_PRODUCT_SERVICES_BYTES
    {
        return Err(product_config_error(()));
    }
    let canonical_path = fs::canonicalize(&path).map_err(product_config_error)?;
    if !canonical_path.starts_with(&canonical_root) {
        return Err(product_config_error(()));
    }
    Ok(canonical_path)
}

fn product_config_error(_: impl Sized) -> OpenAppServerError {
    OpenAppServerError("product services configuration is invalid".into())
}

#[cfg(test)]
#[path = "product_services_tests.rs"]
mod tests;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProductImageGenerationConfig {
    pub service_name: String,
    pub endpoint: String,
    pub credential_reference: Option<String>,
}
#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ProductGitAttributionConfig {
    pub co_author: String,
    pub pull_request_notice: String,
}
impl ProductGitAttributionConfig {
    pub fn policy(&self) -> git_attribution::GitAttributionPolicy {
        git_attribution::GitAttributionPolicy::Enabled {
            co_author: self.co_author.clone(),
            pull_request_notice: self.pull_request_notice.clone(),
        }
    }
}

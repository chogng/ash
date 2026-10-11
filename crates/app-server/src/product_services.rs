use ash_plugin::ExtensionSourceId;
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

const PRODUCT_SERVICES_SCHEMA_VERSION: u32 = 3;
const MAX_PRODUCT_SERVICES_BYTES: u64 = 1024 * 1024;

/// Product-distribution trust and public OAuth configuration loaded by a host.
///
/// This document contains no confidential client secret. Extensions root metadata remains pinned
/// by the product file, while broker URLs and public client IDs are explicit host inputs.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalProductServicesConfig {
    pub(crate) extension_sources:
        BTreeMap<ExtensionSourceId, ash_core_plugins::RemoteExtensionsConfig>,
    pub(crate) open_vsx: Option<(ExtensionSourceId, ash_core_plugins::OpenVsxConfig)>,
    pub(crate) connector_oauth: Vec<ProductConnectorOAuthConfig>,
    pub(crate) github_account: Option<GitHubAccountConfig>,
    pub(crate) github_enterprise_accounts: Vec<github::GitHubBrowserConfig>,
    pub(crate) report_issue_url: Option<String>,
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
        let mut extension_sources = BTreeMap::new();
        for extension_packages in document.extension_sources {
            let name = extension_packages.name;
            let trusted_root = read_trusted_root(source_root, &extension_packages.trusted_root)?;
            authority_identity.update((trusted_root.len() as u64).to_le_bytes());
            authority_identity.update(&trusted_root);
            let mut config = ash_core_plugins::RemoteExtensionsConfig::new(
                Url::parse(&extension_packages.metadata_base_url).map_err(product_config_error)?,
                Url::parse(&extension_packages.targets_base_url).map_err(product_config_error)?,
                trusted_root,
                profile_root
                    .as_ref()
                    .join("cache/extensions")
                    .join(format!("{:x}", Sha256::digest(name.as_str()))),
            )
            .map_err(product_config_error)?;
            if let Some(paths) = extension_packages.tls_root_certificates {
                if paths.is_empty() || paths.len() > 32 {
                    return Err(product_config_error(()));
                }
                let certificates = paths
                    .iter()
                    .map(|path| read_trusted_root(source_root, path))
                    .collect::<Result<Vec<_>, _>>()?;
                for certificate in &certificates {
                    authority_identity.update((certificate.len() as u64).to_le_bytes());
                    authority_identity.update(certificate);
                }
                config = config
                    .with_tls_root_certificates(certificates)
                    .map_err(product_config_error)?;
            }
            if let Some(seconds) = extension_packages.catalog_refresh_interval_seconds {
                config = config
                    .with_catalog_refresh_interval(Duration::from_secs(seconds))
                    .map_err(product_config_error)?;
            }
            if let Some(publishers) = extension_packages.allowed_publishers {
                config = config
                    .with_allowed_publishers(publishers)
                    .map_err(product_config_error)?;
            }
            if extension_sources.insert(name, config).is_some() {
                return Err(product_config_error(()));
            }
        }
        let open_vsx = document
            .open_vsx
            .map(|source| {
                if extension_sources.contains_key(&source.name) {
                    return Err(product_config_error(()));
                }
                let config = ash_core_plugins::OpenVsxConfig::new(
                    Url::parse(&source.api_url).map_err(product_config_error)?,
                    source
                        .download_origins
                        .into_iter()
                        .map(|url| Url::parse(&url).map_err(product_config_error))
                        .collect::<Result<Vec<_>, _>>()?,
                )
                .map_err(product_config_error)?;
                Ok((source.name, config))
            })
            .transpose()?;
        let connector_oauth = document
            .connector_oauth
            .into_iter()
            .map(ProductConnectorOAuthConfig::try_from)
            .collect::<Result<Vec<_>, _>>()?;
        validate_unique_configuration(&connector_oauth)?;
        let github_account = document
            .github_account
            .map(GitHubAccountConfig::try_from)
            .transpose()?;
        let mut hosts = BTreeSet::new();
        let github_enterprise_accounts = document
            .github_enterprise_accounts
            .into_iter()
            .map(|value| {
                let host = value.host.to_ascii_lowercase();
                github::Repository::new(host.clone(), "account".into(), "identity".into())
                    .map_err(product_config_error)?;
                if host == "github.com" || !hosts.insert(host.clone()) {
                    return Err(product_config_error(()));
                }
                let config = GitHubAccountConfig::try_from(GitHubAccountDocument {
                    client_id: value.client_id,
                    broker_base_url: value.broker_base_url,
                })?;
                Ok(github::GitHubBrowserConfig {
                    host,
                    client_id: config.client_id,
                    broker_base_url: config.broker_base_url,
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        if let Some(target) = &document.report_issue_url {
            github::report_repository(target).map_err(product_config_error)?;
        }
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
            extension_sources,
            open_vsx,
            connector_oauth,
            github_account,
            github_enterprise_accounts,
            report_issue_url: document.report_issue_url,
            authority_identity: authority_identity.finalize().into(),
        })
    }

    /// Returns named, independently pinned Extensions provider configurations.
    pub fn extension_sources(
        &self,
    ) -> &BTreeMap<ExtensionSourceId, ash_core_plugins::RemoteExtensionsConfig> {
        &self.extension_sources
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
    extension_sources: Vec<ProductExtensionsDocument>,
    #[serde(default)]
    open_vsx: Option<ProductOpenVsxDocument>,
    #[serde(default)]
    connector_oauth: Vec<ProductConnectorOAuthDocument>,
    #[serde(default)]
    github_account: Option<GitHubAccountDocument>,
    #[serde(default)]
    github_enterprise_accounts: Vec<GitHubEnterpriseAccountDocument>,
    #[serde(default)]
    report_issue_url: Option<String>,
    #[serde(default)]
    image_generation: Option<ProductImageGenerationConfig>,
    #[serde(default)]
    git_attribution: Option<ProductGitAttributionConfig>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitHubAccountDocument {
    client_id: String,
    broker_base_url: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct GitHubEnterpriseAccountDocument {
    host: String,
    client_id: String,
    broker_base_url: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct GitHubAccountConfig {
    pub client_id: String,
    pub broker_base_url: Url,
}

impl TryFrom<GitHubAccountDocument> for GitHubAccountConfig {
    type Error = OpenAppServerError;

    fn try_from(value: GitHubAccountDocument) -> Result<Self, Self::Error> {
        if value.client_id.is_empty()
            || !value
                .client_id
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric())
        {
            return Err(product_config_error(()));
        }
        let broker_base_url = Url::parse(&value.broker_base_url).map_err(product_config_error)?;
        if broker_base_url.scheme() != "https"
            || broker_base_url.cannot_be_a_base()
            || broker_base_url.host_str().is_none()
            || !broker_base_url.username().is_empty()
            || broker_base_url.password().is_some()
            || broker_base_url.query().is_some()
            || broker_base_url.fragment().is_some()
            || !broker_base_url.path().ends_with('/')
        {
            return Err(product_config_error(()));
        }
        Ok(Self {
            client_id: value.client_id,
            broker_base_url,
        })
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProductOpenVsxDocument {
    name: ExtensionSourceId,
    api_url: String,
    download_origins: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ProductExtensionsDocument {
    name: ExtensionSourceId,
    metadata_base_url: String,
    targets_base_url: String,
    trusted_root: PathBuf,
    #[serde(default)]
    tls_root_certificates: Option<Vec<PathBuf>>,
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

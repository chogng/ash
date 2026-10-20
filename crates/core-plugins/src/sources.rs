use std::collections::BTreeMap;
use std::sync::Arc;

use ash_utils_plugins::ExtensionSourceId;
use serde::Deserialize;
use serde::Serialize;
use url::Url;

use crate::ExtensionSource;
use crate::ExtensionsClientError;
use crate::ExtensionsRemoteClient;
use crate::RemoteExtensionsConfig;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ExtensionRegistryKind {
    Ash,
}

/// Profile-owned configuration for one independently trusted Ash registry.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AshExtensionSourceConfig {
    pub id: ExtensionSourceId,
    pub metadata_base_url: String,
    pub targets_base_url: String,
    pub trusted_root_json: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionSourceDescription {
    pub id: ExtensionSourceId,
    pub kind: ExtensionRegistryKind,
    pub enabled: bool,
    pub product_owned: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExtensionSourcesSnapshot {
    pub revision: u64,
    pub sources: Vec<ExtensionSourceDescription>,
}

pub(crate) fn source_provider(
    config: &AshExtensionSourceConfig,
    cache_root: &std::path::Path,
) -> Result<Arc<dyn ExtensionSource>, ExtensionsClientError> {
    if config.trusted_root_json.len() > 1024 * 1024 {
        return Err(ExtensionsClientError::invalid_request(
            "extension trust root is too large",
        ));
    }
    serde_json::from_str::<tough::schema::Signed<tough::schema::Root>>(&config.trusted_root_json)
        .map_err(|_| ExtensionsClientError::invalid_request("invalid extension trust root"))?;
    let remote = RemoteExtensionsConfig::new(
        Url::parse(&config.metadata_base_url).map_err(|_| {
            ExtensionsClientError::invalid_request("invalid extension metadata URL")
        })?,
        Url::parse(&config.targets_base_url)
            .map_err(|_| ExtensionsClientError::invalid_request("invalid extension targets URL"))?,
        config.trusted_root_json.as_bytes().to_vec(),
        cache_root,
    )?;
    Ok(Arc::new(ExtensionsRemoteClient::new(remote)))
}

pub(crate) fn restore_sources(
    providers: &mut crate::ExtensionSources,
    sources: &BTreeMap<ExtensionSourceId, AshExtensionSourceConfig>,
    store: &crate::extension_packages_store::Store,
) -> Result<(), ExtensionsClientError> {
    for (id, config) in sources {
        if id != &config.id
            || providers.providers.contains_key(id)
            || providers.providers.len() >= 32
        {
            return Err(ExtensionsClientError::storage());
        }
        providers.providers.insert(
            id.clone(),
            source_provider(config, &store.source_cache_root(id))?,
        );
        if !config.enabled {
            providers.disabled.insert(id.clone());
        }
    }
    Ok(())
}

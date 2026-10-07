use semver::Version;
use serde::Deserialize;

use crate::MarketplaceClientError;
use crate::UpstreamReference;
use crate::UpstreamRegistry;

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct CatalogUpstreamReference {
    pub registry: UpstreamRegistry,
    pub name: String,
    pub version: Version,
    pub record_url: String,
    #[serde(default)]
    pub repository_url: Option<String>,
}

impl CatalogUpstreamReference {
    pub(crate) fn validate(
        &self,
        schema_version: u32,
        is_mcp: bool,
    ) -> Result<(), MarketplaceClientError> {
        if schema_version != 2
            || !is_mcp
            || self.name.trim().is_empty()
            || self.name.len() > 256
            || !valid_upstream_url(&self.record_url, true)
            || self
                .repository_url
                .as_deref()
                .is_some_and(|url| !valid_upstream_url(url, false))
        {
            return Err(MarketplaceClientError::package_untrusted());
        }
        Ok(())
    }

    pub(crate) fn public_reference(&self) -> UpstreamReference {
        UpstreamReference {
            registry: self.registry,
            name: self.name.clone(),
            version: self.version.to_string(),
            record_url: self.record_url.clone(),
            repository_url: self.repository_url.clone(),
        }
    }
}

fn valid_upstream_url(value: &str, require_registry_host: bool) -> bool {
    url::Url::parse(value).is_ok_and(|url| {
        value.len() <= 4096
            && url.scheme() == "https"
            && url.host_str().is_some()
            && (!require_registry_host
                || url.host_str() == Some("registry.modelcontextprotocol.io"))
            && url.username().is_empty()
            && url.password().is_none()
            && url.fragment().is_none()
    })
}

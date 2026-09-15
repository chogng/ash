use ash_protocol::ProviderId;
use std::fmt;

const STATIC_SOURCE_SCOPE: &str = "ash:provider-seed";

/// Opaque, non-secret identity for one endpoint, account, tenant, and config revision scope.
///
/// Hosts should pass a one-way fingerprint rather than raw endpoint or credential material. A
/// changed provider configuration must produce a new value so a late response cannot overwrite the
/// new scope.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct CatalogSourceScopeId(String);

impl CatalogSourceScopeId {
    pub fn new(value: impl Into<String>) -> Result<Self, InvalidCatalogScope> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(InvalidCatalogScope(
                "catalog source scope must not be empty".into(),
            ));
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }

    pub(crate) fn provider_seed() -> Self {
        Self(STATIC_SOURCE_SCOPE.into())
    }

    pub(crate) fn is_provider_seed(&self) -> bool {
        self.0 == STATIC_SOURCE_SCOPE
    }
}

impl fmt::Display for CatalogSourceScopeId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

/// Stable cache identity for one provider catalog authority.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct CatalogScopeKey {
    provider: ProviderId,
    source_scope: CatalogSourceScopeId,
}

impl CatalogScopeKey {
    pub fn new(provider: ProviderId, source_scope: CatalogSourceScopeId) -> Self {
        Self {
            provider,
            source_scope,
        }
    }

    pub fn provider_seed(provider: ProviderId) -> Self {
        Self::new(provider, CatalogSourceScopeId::provider_seed())
    }

    pub fn provider(&self) -> &ProviderId {
        &self.provider
    }

    pub fn source_scope(&self) -> &CatalogSourceScopeId {
        &self.source_scope
    }

    pub(crate) fn is_provider_seed(&self) -> bool {
        self.source_scope.is_provider_seed()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvalidCatalogScope(pub String);

impl fmt::Display for InvalidCatalogScope {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for InvalidCatalogScope {}

use crate::CatalogScopeKey;
use std::fmt;
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;
use std::time::SystemTime;
use ash_protocol::CapabilitySupport;
use ash_protocol::ContextWindow;
use ash_protocol::ModelId;
use ash_protocol::ModelLifecycle;
use ash_protocol::Personality;
use ash_protocol::ReasoningEffort;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ModelCapabilitiesPatch {
    pub tools: Option<CapabilitySupport>,
    pub reasoning: Option<CapabilitySupport>,
    pub parallel_tool_calls: Option<CapabilitySupport>,
    pub personality: Option<CapabilitySupport>,
    pub image_detail_original: Option<CapabilitySupport>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ModelMetadataPatch {
    pub display_name: Option<String>,
    pub context_window: Option<ContextWindow>,
    pub auto_compact_token_limit: Option<u32>,
    pub capabilities: ModelCapabilitiesPatch,
    pub supported_reasoning_efforts: Option<Vec<ReasoningEffort>>,
    pub model_reasoning_effort: Option<ReasoningEffort>,
    pub default_personality: Option<Personality>,
    pub lifecycle: Option<ModelLifecycle>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiscoveredModel {
    pub id: ModelId,
    pub metadata: ModelMetadataPatch,
}

impl DiscoveredModel {
    pub fn new(id: ModelId) -> Self {
        Self {
            id,
            metadata: ModelMetadataPatch::default(),
        }
    }

    pub fn with_metadata(mut self, metadata: ModelMetadataPatch) -> Self {
        self.metadata = metadata;
        self
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiscoveryCoverage {
    CompleteAgentCatalog,
    Partial,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CatalogValidator {
    Etag(String),
    LastModified(String),
    SourceRevision(String),
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CatalogCacheHint {
    fresh_for: Option<Duration>,
    stale_usable_for: Option<Duration>,
}

impl CatalogCacheHint {
    pub fn unspecified() -> Self {
        Self::default()
    }

    pub fn with_fresh_for(mut self, duration: Duration) -> Self {
        self.fresh_for = Some(duration);
        self
    }

    pub fn with_stale_usable_for(mut self, duration: Duration) -> Self {
        self.stale_usable_for = Some(duration);
        self
    }

    pub fn fresh_for(self) -> Option<Duration> {
        self.fresh_for
    }

    pub fn stale_usable_for(self) -> Option<Duration> {
        self.stale_usable_for
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiscoveredCatalog {
    pub scope: CatalogScopeKey,
    pub coverage: DiscoveryCoverage,
    pub models: Vec<DiscoveredModel>,
    pub validator: Option<CatalogValidator>,
    pub cache_hint: CatalogCacheHint,
    pub observed_at: SystemTime,
}

impl DiscoveredCatalog {
    pub fn new(
        scope: CatalogScopeKey,
        coverage: DiscoveryCoverage,
        observed_at: SystemTime,
    ) -> Self {
        Self {
            scope,
            coverage,
            models: Vec::new(),
            validator: None,
            cache_hint: CatalogCacheHint::unspecified(),
            observed_at,
        }
    }

    pub fn with_models(mut self, models: impl IntoIterator<Item = DiscoveredModel>) -> Self {
        self.models.extend(models);
        self
    }

    pub fn with_validator(mut self, validator: CatalogValidator) -> Self {
        self.validator = Some(validator);
        self
    }

    pub fn with_cache_hint(mut self, cache_hint: CatalogCacheHint) -> Self {
        self.cache_hint = cache_hint;
        self
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CatalogNotModified {
    pub scope: CatalogScopeKey,
    pub validator: Option<CatalogValidator>,
    pub cache_hint: CatalogCacheHint,
    pub observed_at: SystemTime,
}

impl CatalogNotModified {
    pub fn new(scope: CatalogScopeKey, observed_at: SystemTime) -> Self {
        Self {
            scope,
            validator: None,
            cache_hint: CatalogCacheHint::unspecified(),
            observed_at,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CatalogDiscoveryOutcome {
    Modified(DiscoveredCatalog),
    NotModified(CatalogNotModified),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CatalogDiscoveryRequest {
    scope: CatalogScopeKey,
    validator: Option<CatalogValidator>,
}

impl CatalogDiscoveryRequest {
    pub(crate) fn new(scope: CatalogScopeKey, validator: Option<CatalogValidator>) -> Self {
        Self { scope, validator }
    }

    pub fn scope(&self) -> &CatalogScopeKey {
        &self.scope
    }

    pub fn validator(&self) -> Option<&CatalogValidator> {
        self.validator.as_ref()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CatalogSourceErrorKind {
    Authentication,
    Permission,
    Unsupported,
    RateLimited,
    Unreachable,
    ProviderUnavailable,
    InvalidRequest,
    Transient,
    InvalidPayload,
    Cancelled,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CatalogSourceError {
    kind: CatalogSourceErrorKind,
    message: String,
}

impl CatalogSourceError {
    pub fn new(kind: CatalogSourceErrorKind, message: impl Into<String>) -> Self {
        Self {
            kind,
            message: message.into(),
        }
    }

    pub fn kind(&self) -> CatalogSourceErrorKind {
        self.kind
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for CatalogSourceError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for CatalogSourceError {}

pub type CatalogSourceFuture<'a> =
    Pin<Box<dyn Future<Output = Result<CatalogDiscoveryOutcome, CatalogSourceError>> + Send + 'a>>;

/// Supplies one provider catalog observation without owning cache or merge policy.
///
/// Implementations live beside provider wire adapters. They must honor the exact requested scope,
/// complete pagination before claiming complete coverage, avoid inference probing, and return only
/// sanitized errors. Dropping the returned future is the cancellation signal; implementations must
/// not commit partial pagination after cancellation.
pub trait ModelCatalogSource: Send + Sync {
    /// Discovers one atomic observation for the exact requested scope.
    ///
    /// Implementations should use the optional validator when supported and must classify partial
    /// pagination as `Partial` instead of claiming a complete Agent catalog.
    fn discover<'a>(&'a self, request: CatalogDiscoveryRequest) -> CatalogSourceFuture<'a>;
}

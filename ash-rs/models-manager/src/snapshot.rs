use crate::CatalogScopeKey;
use ash_protocol::ModelAvailability;
use ash_protocol::ModelCatalogFreshness;
use ash_protocol::ModelInfo;
use ash_protocol::ModelLifecycle;
use ash_protocol::ModelMetadataQuality;
use ash_protocol::ModelRef;
use std::fmt;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct CatalogGeneration(u64);

impl CatalogGeneration {
    pub const INITIAL: Self = Self(1);

    pub fn get(self) -> u64 {
        self.0
    }

    pub(crate) fn next(self) -> Self {
        Self(self.0.saturating_add(1))
    }
}

impl fmt::Display for CatalogGeneration {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MetadataSource {
    ProviderLive,
    UserConfigured,
    BuiltinCurated,
    ProviderSeed,
    PersistedObservation,
}

impl MetadataSource {
    pub(crate) fn quality(self) -> ModelMetadataQuality {
        match self {
            Self::ProviderLive => ModelMetadataQuality::ProviderLive,
            Self::UserConfigured => ModelMetadataQuality::UserConfigured,
            Self::BuiltinCurated => ModelMetadataQuality::BuiltinCurated,
            Self::ProviderSeed => ModelMetadataQuality::ProviderSeed,
            Self::PersistedObservation => ModelMetadataQuality::PersistedObservation,
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ModelCapabilitiesProvenance {
    pub tools: Option<MetadataSource>,
    pub reasoning: Option<MetadataSource>,
    pub parallel_tool_calls: Option<MetadataSource>,
    pub personality: Option<MetadataSource>,
    pub image_detail_original: Option<MetadataSource>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ModelMetadataProvenance {
    pub display_name: Option<MetadataSource>,
    pub context_window: Option<MetadataSource>,
    pub auto_compact_token_limit: Option<MetadataSource>,
    pub capabilities: ModelCapabilitiesProvenance,
    pub supported_reasoning_efforts: Option<MetadataSource>,
    pub model_reasoning_effort: Option<MetadataSource>,
    pub default_personality: Option<MetadataSource>,
    pub lifecycle: Option<MetadataSource>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CatalogWarningCode {
    RefreshFailed,
    DiscoveryUnsupported,
    AuthenticationRequired,
    StaleCatalog,
    UnknownCapability,
    UnlistedModel,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CatalogWarning {
    code: CatalogWarningCode,
    message: String,
}

impl CatalogWarning {
    pub fn new(code: CatalogWarningCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn code(&self) -> CatalogWarningCode {
        self.code
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelCatalogEntry {
    model: ModelRef,
    info: ModelInfo,
    availability: ModelAvailability,
    lifecycle: ModelLifecycle,
    metadata_quality: ModelMetadataQuality,
    provenance: ModelMetadataProvenance,
    warnings: Vec<CatalogWarning>,
}

impl ModelCatalogEntry {
    pub(crate) fn new(
        model: ModelRef,
        info: ModelInfo,
        availability: ModelAvailability,
        lifecycle: ModelLifecycle,
        metadata_quality: ModelMetadataQuality,
        provenance: ModelMetadataProvenance,
        warnings: Vec<CatalogWarning>,
    ) -> Self {
        Self {
            model,
            info,
            availability,
            lifecycle,
            metadata_quality,
            provenance,
            warnings,
        }
    }

    pub fn model(&self) -> &ModelRef {
        &self.model
    }

    pub fn info(&self) -> &ModelInfo {
        &self.info
    }

    pub fn availability(&self) -> ModelAvailability {
        self.availability
    }

    pub fn lifecycle(&self) -> ModelLifecycle {
        self.lifecycle
    }

    pub fn metadata_quality(&self) -> ModelMetadataQuality {
        self.metadata_quality
    }

    pub fn provenance(&self) -> &ModelMetadataProvenance {
        &self.provenance
    }

    pub fn warnings(&self) -> &[CatalogWarning] {
        &self.warnings
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelCatalogSnapshot {
    scope: CatalogScopeKey,
    generation: CatalogGeneration,
    freshness: ModelCatalogFreshness,
    entries: Arc<[ModelCatalogEntry]>,
    warnings: Arc<[CatalogWarning]>,
}

impl ModelCatalogSnapshot {
    pub(crate) fn new(
        scope: CatalogScopeKey,
        generation: CatalogGeneration,
        freshness: ModelCatalogFreshness,
        entries: Vec<ModelCatalogEntry>,
        warnings: Vec<CatalogWarning>,
    ) -> Self {
        Self {
            scope,
            generation,
            freshness,
            entries: entries.into(),
            warnings: warnings.into(),
        }
    }

    pub fn scope(&self) -> &CatalogScopeKey {
        &self.scope
    }

    pub fn generation(&self) -> CatalogGeneration {
        self.generation
    }

    pub fn freshness(&self) -> ModelCatalogFreshness {
        self.freshness
    }

    pub fn entries(&self) -> &[ModelCatalogEntry] {
        &self.entries
    }

    pub fn warnings(&self) -> &[CatalogWarning] {
        &self.warnings
    }

    pub(crate) fn has_same_contents(&self, other: &Self) -> bool {
        self.scope == other.scope
            && self.freshness == other.freshness
            && self.entries == other.entries
            && self.warnings == other.warnings
    }
}

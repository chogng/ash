use crate::DiscoveredCatalog;
use crate::DiscoveryCoverage;
use crate::MetadataSource;
use crate::ModelCapabilitiesProvenance;
use crate::ModelCatalogEntry;
use crate::ModelMetadataPatch;
use crate::ModelMetadataProvenance;
use ash_model_provider_config::ProviderDefinition;
use ash_protocol::CapabilitySupport;
use ash_protocol::ContextWindow;
use ash_protocol::ModelAvailability;
use ash_protocol::ModelId;
use ash_protocol::ModelInfo;
use ash_protocol::ModelLifecycle;
use ash_protocol::ModelMetadataQuality;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CatalogRecord {
    info: ModelInfo,
    availability: ModelAvailability,
    lifecycle: ModelLifecycle,
    provenance: ModelMetadataProvenance,
    observed_live: bool,
}

impl CatalogRecord {
    fn from_seed(info: ModelInfo) -> Self {
        let capabilities = ModelCapabilitiesProvenance {
            tools: known_capability_source(info.capabilities.tools),
            reasoning: known_capability_source(info.capabilities.reasoning),
            parallel_tool_calls: known_capability_source(info.capabilities.parallel_tool_calls),
            personality: known_capability_source(info.capabilities.personality),
            image_detail_original: known_capability_source(info.capabilities.image_detail_original),
        };
        let provenance = ModelMetadataProvenance {
            display_name: Some(MetadataSource::ProviderSeed),
            context_window: match info.context_window {
                ContextWindow::Known(_) => Some(MetadataSource::ProviderSeed),
                ContextWindow::Unknown => None,
            },
            auto_compact_token_limit: info
                .auto_compact_token_limit
                .map(|_| MetadataSource::ProviderSeed),
            capabilities,
            supported_reasoning_efforts: (!info.supported_reasoning_efforts.is_empty())
                .then_some(MetadataSource::ProviderSeed),
            model_reasoning_effort: info
                .model_reasoning_effort
                .map(|_| MetadataSource::ProviderSeed),
            default_personality: info
                .default_personality
                .map(|_| MetadataSource::ProviderSeed),
            lifecycle: None,
        };
        Self {
            info,
            availability: ModelAvailability::Unverified,
            lifecycle: ModelLifecycle::Unknown,
            provenance,
            observed_live: false,
        }
    }

    fn discovered(id: ModelId) -> Self {
        Self {
            info: ModelInfo::new(id.clone(), id.as_str()),
            availability: ModelAvailability::Available,
            lifecycle: ModelLifecycle::Unknown,
            provenance: ModelMetadataProvenance::default(),
            observed_live: true,
        }
    }

    pub(crate) fn entry(&self, provider: &ProviderId) -> ModelCatalogEntry {
        let quality = if self.observed_live {
            ModelMetadataQuality::ProviderLive
        } else {
            highest_metadata_source(&self.provenance)
                .map(MetadataSource::quality)
                .unwrap_or(ModelMetadataQuality::Unknown)
        };
        ModelCatalogEntry::new(
            ModelRef::new(provider.clone(), self.info.id.clone()),
            self.info.clone(),
            self.availability,
            self.lifecycle,
            quality,
            self.provenance.clone(),
            Vec::new(),
        )
    }
}

pub(crate) fn seed_records(definition: &ProviderDefinition) -> BTreeMap<ModelId, CatalogRecord> {
    definition
        .models
        .iter()
        .cloned()
        .map(|model| (model.id.clone(), CatalogRecord::from_seed(model)))
        .collect()
}

pub(crate) fn apply_discovery(
    records: &mut BTreeMap<ModelId, CatalogRecord>,
    catalog: &DiscoveredCatalog,
) {
    if catalog.coverage == DiscoveryCoverage::CompleteAgentCatalog {
        for record in records.values_mut() {
            record.availability = ModelAvailability::Unavailable;
        }
    }
    for discovered in &catalog.models {
        let record = records
            .entry(discovered.id.clone())
            .or_insert_with(|| CatalogRecord::discovered(discovered.id.clone()));
        record.observed_live = true;
        record.availability = ModelAvailability::Available;
        apply_live_patch(record, &discovered.metadata);
    }
}

pub(crate) fn mark_unverified(records: &mut BTreeMap<ModelId, CatalogRecord>) {
    for record in records.values_mut() {
        if record.availability == ModelAvailability::Available {
            record.availability = ModelAvailability::Unverified;
        }
    }
}

fn apply_live_patch(record: &mut CatalogRecord, patch: &ModelMetadataPatch) {
    if let Some(access) = patch.access {
        record.info.access = access;
    }
    let source = MetadataSource::ProviderLive;
    if let Some(display_name) = patch
        .display_name
        .as_ref()
        .filter(|display_name| !display_name.trim().is_empty())
    {
        record.info.display_name = display_name.clone();
        record.provenance.display_name = Some(source);
    }
    if let Some(context_window @ ContextWindow::Known(_)) = patch.context_window {
        record.info.context_window = context_window;
        record.provenance.context_window = Some(source);
    }
    if let Some(limit) = patch.auto_compact_token_limit.filter(|limit| *limit > 0) {
        record.info.auto_compact_token_limit = Some(limit);
        record.provenance.auto_compact_token_limit = Some(source);
    }
    apply_capability(
        &mut record.info.capabilities.tools,
        &mut record.provenance.capabilities.tools,
        patch.capabilities.tools,
        source,
    );
    apply_capability(
        &mut record.info.capabilities.reasoning,
        &mut record.provenance.capabilities.reasoning,
        patch.capabilities.reasoning,
        source,
    );
    apply_capability(
        &mut record.info.capabilities.parallel_tool_calls,
        &mut record.provenance.capabilities.parallel_tool_calls,
        patch.capabilities.parallel_tool_calls,
        source,
    );
    apply_capability(
        &mut record.info.capabilities.personality,
        &mut record.provenance.capabilities.personality,
        patch.capabilities.personality,
        source,
    );
    apply_capability(
        &mut record.info.capabilities.image_detail_original,
        &mut record.provenance.capabilities.image_detail_original,
        patch.capabilities.image_detail_original,
        source,
    );
    if let Some(efforts) = &patch.supported_reasoning_efforts {
        record.info.supported_reasoning_efforts = efforts.clone();
        record.provenance.supported_reasoning_efforts = Some(source);
    }
    if let Some(effort) = patch.model_reasoning_effort {
        record.info.model_reasoning_effort = Some(effort);
        record.provenance.model_reasoning_effort = Some(source);
    }
    if let Some(personality) = patch.default_personality {
        record.info.default_personality = Some(personality);
        record.provenance.default_personality = Some(source);
    }
    if let Some(lifecycle) = patch
        .lifecycle
        .filter(|lifecycle| *lifecycle != ModelLifecycle::Unknown)
    {
        record.lifecycle = lifecycle;
        record.provenance.lifecycle = Some(source);
    }
}

fn apply_capability(
    current: &mut CapabilitySupport,
    provenance: &mut Option<MetadataSource>,
    incoming: Option<CapabilitySupport>,
    source: MetadataSource,
) {
    if let Some(incoming) = incoming.filter(|value| *value != CapabilitySupport::Unknown) {
        *current = incoming;
        *provenance = Some(source);
    }
}

fn known_capability_source(value: CapabilitySupport) -> Option<MetadataSource> {
    (value != CapabilitySupport::Unknown).then_some(MetadataSource::ProviderSeed)
}

fn highest_metadata_source(provenance: &ModelMetadataProvenance) -> Option<MetadataSource> {
    let sources = [
        provenance.display_name,
        provenance.context_window,
        provenance.auto_compact_token_limit,
        provenance.capabilities.tools,
        provenance.capabilities.reasoning,
        provenance.capabilities.parallel_tool_calls,
        provenance.capabilities.personality,
        provenance.capabilities.image_detail_original,
        provenance.supported_reasoning_efforts,
        provenance.model_reasoning_effort,
        provenance.default_personality,
        provenance.lifecycle,
    ];
    sources
        .into_iter()
        .flatten()
        .max_by_key(|source| match source {
            MetadataSource::PersistedObservation => 1,
            MetadataSource::ProviderSeed => 2,
            MetadataSource::BuiltinCurated => 3,
            MetadataSource::ProviderLive => 4,
            MetadataSource::UserConfigured => 5,
        })
}

use crate::CatalogWarning;
use crate::CatalogWarningCode;
use crate::ModelCatalogEntry;
use crate::ModelsManagerError;
use ash_protocol::CapabilitySupport;
use ash_protocol::ModelAvailability;
use ash_protocol::ModelCapabilities;
use ash_protocol::ModelInputModality;
use ash_protocol::ModelLifecycle;
use ash_protocol::ModelRef;
use std::collections::BTreeSet;
use std::fmt;

#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum ModelCapability {
    Tools,
    Reasoning,
    ParallelToolCalls,
    Personality,
    OriginalImageDetail,
}

impl fmt::Display for ModelCapability {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(match self {
            Self::Tools => "tools",
            Self::Reasoning => "reasoning",
            Self::ParallelToolCalls => "parallel tool calls",
            Self::Personality => "personality",
            Self::OriginalImageDetail => "original image detail",
        })
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UnknownCapabilityPolicy {
    IncludeWithWarning,
    Exclude,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AvailabilityFilter {
    Selectable,
    IncludeUnavailable,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CatalogQuery {
    required_capabilities: BTreeSet<ModelCapability>,
    unknown_capability: UnknownCapabilityPolicy,
    availability: AvailabilityFilter,
}

impl CatalogQuery {
    pub fn selectable() -> Self {
        Self {
            required_capabilities: BTreeSet::new(),
            unknown_capability: UnknownCapabilityPolicy::IncludeWithWarning,
            availability: AvailabilityFilter::Selectable,
        }
    }

    pub fn all() -> Self {
        Self {
            availability: AvailabilityFilter::IncludeUnavailable,
            ..Self::selectable()
        }
    }

    pub fn require_capability(mut self, capability: ModelCapability) -> Self {
        self.required_capabilities.insert(capability);
        self
    }

    pub fn with_unknown_capability_policy(mut self, policy: UnknownCapabilityPolicy) -> Self {
        self.unknown_capability = policy;
        self
    }

    pub fn with_availability_filter(mut self, filter: AvailabilityFilter) -> Self {
        self.availability = filter;
        self
    }
}

impl Default for CatalogQuery {
    fn default() -> Self {
        Self::selectable()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelRequirements {
    required_capabilities: BTreeSet<ModelCapability>,
    unknown_capability: UnknownCapabilityPolicy,
}

impl ModelRequirements {
    pub fn agent() -> Self {
        Self {
            required_capabilities: BTreeSet::new(),
            unknown_capability: UnknownCapabilityPolicy::IncludeWithWarning,
        }
    }

    pub fn require_capability(mut self, capability: ModelCapability) -> Self {
        self.required_capabilities.insert(capability);
        self
    }

    pub fn with_unknown_capability_policy(mut self, policy: UnknownCapabilityPolicy) -> Self {
        self.unknown_capability = policy;
        self
    }
}

impl Default for ModelRequirements {
    fn default() -> Self {
        Self::agent()
    }
}

pub(crate) fn matches_query(entry: &ModelCatalogEntry, query: &CatalogQuery) -> bool {
    if query.availability == AvailabilityFilter::Selectable
        && entry.availability() == ModelAvailability::Unavailable
    {
        return false;
    }
    if entry.lifecycle() == ModelLifecycle::Retired
        && query.availability == AvailabilityFilter::Selectable
    {
        return false;
    }
    query.required_capabilities.iter().all(|capability| {
        match capability_support(entry.info().capabilities, *capability) {
            CapabilitySupport::Supported => true,
            CapabilitySupport::Unsupported => false,
            CapabilitySupport::Unknown => {
                query.unknown_capability == UnknownCapabilityPolicy::IncludeWithWarning
            }
        }
    })
}

pub(crate) fn validate_requirements(
    entry: &ModelCatalogEntry,
    requirements: &ModelRequirements,
) -> Result<Vec<CatalogWarning>, ModelsManagerError> {
    let provider = &entry.model().provider;
    let model = &entry.model().model;
    if entry.availability() == ModelAvailability::Unavailable {
        return Err(ModelsManagerError::ModelUnavailable {
            provider: provider.clone(),
            model: model.clone(),
        });
    }
    if entry.lifecycle() == ModelLifecycle::Retired {
        return Err(ModelsManagerError::ModelRetired {
            provider: provider.clone(),
            model: model.clone(),
        });
    }
    let mut warnings = Vec::new();
    for capability in &requirements.required_capabilities {
        match capability_support(entry.info().capabilities, *capability) {
            CapabilitySupport::Supported => {}
            CapabilitySupport::Unsupported => {
                return Err(ModelsManagerError::CapabilityUnsupported {
                    provider: provider.clone(),
                    model: model.clone(),
                    capability: *capability,
                });
            }
            CapabilitySupport::Unknown
                if requirements.unknown_capability == UnknownCapabilityPolicy::Exclude =>
            {
                return Err(ModelsManagerError::CapabilityUnknown {
                    provider: provider.clone(),
                    model: model.clone(),
                    capability: *capability,
                });
            }
            CapabilitySupport::Unknown => warnings.push(CatalogWarning::new(
                CatalogWarningCode::UnknownCapability,
                format!("support for {capability} is unknown"),
            )),
        }
    }
    Ok(warnings)
}

/// Selects the first eligible candidate from the host's ordered, ready connections.
/// The host supplies effective input budgets after provider configuration is applied.
pub fn select_automatic_model(
    candidates: impl IntoIterator<Item = (ModelCatalogEntry, u32)>,
    input_tokens: u32,
    input_modalities: &[ModelInputModality],
) -> Option<ModelRef> {
    let requirements = ModelRequirements::agent()
        .require_capability(ModelCapability::Tools)
        .with_unknown_capability_policy(UnknownCapabilityPolicy::Exclude);
    candidates
        .into_iter()
        .find(|(entry, usable_input)| {
            *usable_input >= input_tokens
                && entry.info().capabilities.agent_mode != CapabilitySupport::Unsupported
                && input_modalities.iter().all(|modality| {
                    entry
                        .info()
                        .settings
                        .input_modalities
                        .as_ref()
                        .is_some_and(|supported| supported.contains(modality))
                })
                && validate_requirements(entry, &requirements).is_ok()
        })
        .map(|(entry, _)| entry.model().clone())
}

fn capability_support(
    capabilities: ModelCapabilities,
    capability: ModelCapability,
) -> CapabilitySupport {
    match capability {
        ModelCapability::Tools => capabilities.tools,
        ModelCapability::Reasoning => capabilities.reasoning,
        ModelCapability::ParallelToolCalls => capabilities.parallel_tool_calls,
        ModelCapability::Personality => capabilities.personality,
        ModelCapability::OriginalImageDetail => capabilities.image_detail_original,
    }
}

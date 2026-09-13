use crate::CatalogGeneration;
use crate::CatalogWarning;
use crate::ModelCatalogEntry;
use crate::ModelMetadataProvenance;
use ash_model_provider_config::ModelContextConfig;
use ash_model_provider_config::ModelProviderConfig;
use ash_model_provider_config::ProviderConfigError;
use ash_protocol::ContextWindow;
use ash_protocol::ModelAvailability;
use ash_protocol::ModelId;
use ash_protocol::ModelInfo;
use ash_protocol::ModelLifecycle;
use ash_protocol::ModelMetadataQuality;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedModel {
    entry: ModelCatalogEntry,
    generation: CatalogGeneration,
    warnings: Vec<CatalogWarning>,
}

impl ResolvedModel {
    pub(crate) fn new(
        entry: ModelCatalogEntry,
        generation: CatalogGeneration,
        warnings: Vec<CatalogWarning>,
    ) -> Self {
        Self {
            entry,
            generation,
            warnings,
        }
    }

    pub fn entry(&self) -> &ModelCatalogEntry {
        &self.entry
    }

    pub fn generation(&self) -> CatalogGeneration {
        self.generation
    }

    pub fn warnings(&self) -> &[CatalogWarning] {
        &self.warnings
    }
}

impl ModelCatalogEntry {
    /// Builds effective metadata for this catalog entry using provider-scoped configuration.
    ///
    /// The catalog entry, provenance, generation, and warnings remain the original evidence.
    /// Configuration only changes the returned copy. A known catalog window caps the configured
    /// window; unknown metadata remains unknown unless the configuration supplies it explicitly.
    pub fn model_info(
        &self,
        config: &ModelProviderConfig,
    ) -> Result<ModelInfo, ProviderConfigError> {
        if config.provider != self.model().provider {
            return Err(ProviderConfigError::ProviderMismatch {
                configured: config.provider.clone(),
                selected: self.model().provider.clone(),
            });
        }
        config.validate_static()?;
        let mut info = self.info().clone();
        let context = config
            .custom
            .as_ref()
            .map(|custom| ModelContextConfig {
                context_window: custom.context_window,
                auto_compact_token_limit: None,
            })
            .or_else(|| config.model_context.get(&info.id).copied());
        if let Some(context) = context {
            info.context_window = ContextWindow::Known(match info.context_window {
                ContextWindow::Known(limit) => context.context_window.min(limit),
                ContextWindow::Unknown => context.context_window,
            });
            info.auto_compact_token_limit = context.auto_compact_token_limit;
        }
        if let ContextWindow::Known(window) = info.context_window {
            // Ash's automatic compaction recommendation reserves ten percent of the context.
            // Widen before multiplying so every u32 context window keeps the same ratio.
            let limit = (u64::from(window) * 9 / 10) as u32;
            info.auto_compact_token_limit = Some(
                info.auto_compact_token_limit
                    .map_or(limit, |configured| configured.min(limit)),
            );
        }
        Ok(info)
    }
}

pub(crate) fn unlisted_entry(provider: &ProviderId, model: &ModelId) -> ModelCatalogEntry {
    ModelCatalogEntry::new(
        ModelRef::new(provider.clone(), model.clone()),
        ModelInfo::new(model.clone(), model.as_str()),
        ModelAvailability::Unverified,
        ModelLifecycle::Unknown,
        ModelMetadataQuality::Unknown,
        ModelMetadataProvenance {
            display_name: None,
            context_window: None,
            auto_compact_token_limit: None,
            capabilities: Default::default(),
            supported_reasoning_efforts: None,
            model_reasoning_effort: None,
            default_personality: None,
            lifecycle: None,
        },
        Vec::new(),
    )
}

#[cfg(test)]
#[path = "model_info_tests.rs"]
mod tests;

use crate::CatalogGeneration;
use crate::CatalogWarning;
use crate::ModelCatalogEntry;
use crate::ModelMetadataProvenance;
use ash_protocol::ContextWindow;
use ash_protocol::ModelAvailability;
use ash_protocol::ModelId;
use ash_protocol::ModelInfo;
use ash_protocol::ModelLifecycle;
use ash_protocol::ModelMetadataQuality;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use model_provider_info::ModelContextConfig;
use model_provider_info::ModelProviderConfig;
use model_provider_info::ProviderConfigError;

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
    /// Selectable declared budgets, constrained by the current capacity observation.
    /// A custom connection specifies its own fixed budget; unknown capacity has no choices.
    pub fn context_window_options(&self, config: &ModelProviderConfig) -> Vec<u32> {
        let ContextWindow::Known(default) = self.default_context_window(config) else {
            return Vec::new();
        };
        let mut options = vec![default];
        if config.custom.is_none() {
            options.extend(
                self.declared_context_window_options
                    .iter()
                    .copied()
                    .filter(|tokens| match self.info().context_window {
                        ContextWindow::Known(limit) => *tokens <= limit,
                        ContextWindow::Unknown => true,
                    }),
            );
        }
        options.sort_unstable();
        options.dedup();
        options
    }

    /// Validates the complete update before changing the selected model's preferences.
    /// Other models, connection details and compaction settings retain their values.
    pub fn apply_preferences(
        &self,
        config: &mut ModelProviderConfig,
        update: &ModelPreferencesUpdate,
    ) -> Result<(), ProviderConfigError> {
        let info = self.model_info(config)?;
        let invalid = |message: &str| ProviderConfigError::InvalidProvider {
            provider: config.provider.clone(),
            message: message.to_owned(),
        };
        if update.fast.is_none() && update.context_window.is_none() {
            return Err(invalid("model preference update must contain a change"));
        }
        if update.fast == Some(true)
            && info.capabilities.fast_mode != ash_protocol::CapabilitySupport::Supported
        {
            return Err(invalid("Fast is unavailable for this model connection"));
        }
        if let Some(window) = update.context_window
            && !self.context_window_options(config).contains(&window)
        {
            return Err(invalid("context window is not a selectable budget"));
        }
        if let Some(fast) = update.fast {
            if fast {
                config.fast_models.insert(info.id.clone());
            } else {
                config.fast_models.remove(&info.id);
            }
        }
        if let Some(window) = update.context_window {
            config
                .model_context
                .entry(info.id)
                .or_insert(ModelContextConfig {
                    context_window: window,
                    auto_compact_token_limit: None,
                })
                .context_window = window;
        }
        Ok(())
    }

    /// Context budget before a per-model preference, capped by known catalog capacity.
    pub fn default_context_window(&self, config: &ModelProviderConfig) -> ContextWindow {
        let window = if let Some(custom) = &config.custom {
            Some(custom.context_window)
        } else {
            self.declared_context_window_options.first().copied()
        };
        match (self.info().context_window, window) {
            (ContextWindow::Known(limit), Some(window)) => ContextWindow::Known(limit.min(window)),
            (ContextWindow::Unknown, Some(window)) => ContextWindow::Known(window),
            (catalog, _) => catalog,
        }
    }

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
        if info.capabilities.fast_mode == ash_protocol::CapabilitySupport::Supported {
            info.capabilities.fast_mode = config.fast_mode_support(&info.id);
        }
        let context = config.model_context.get(&info.id).copied().or_else(|| {
            config.custom.as_ref().map(|custom| ModelContextConfig {
                context_window: custom.context_window,
                auto_compact_token_limit: None,
            })
        });
        if let Some(context) = context {
            info.context_window = ContextWindow::Known(match info.context_window {
                ContextWindow::Known(limit) => context.context_window.min(limit),
                ContextWindow::Unknown => context.context_window,
            });
            info.auto_compact_token_limit = context.auto_compact_token_limit;
        } else {
            info.context_window = self.default_context_window(config);
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelPreferencesUpdate {
    pub fast: Option<bool>,
    pub context_window: Option<u32>,
}

pub(crate) fn unlisted_entry(provider: &ProviderId, model: &ModelId) -> ModelCatalogEntry {
    ModelCatalogEntry::new(
        ModelRef::new(provider.clone(), model.clone()),
        ModelInfo::new(model.clone(), model.as_str()),
        None,
        ModelAvailability::Unverified,
        ModelLifecycle::Unknown,
        ModelMetadataQuality::Unknown,
        ModelMetadataProvenance {
            settings: None,
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

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
    /// None means this connection has no larger context budget; false is the product default.
    pub fn long_context(&self, config: &ModelProviderConfig) -> Option<bool> {
        if config.custom.is_some() {
            return None;
        }
        match (
            self.default_context_window(config),
            self.info().context_window,
        ) {
            (ContextWindow::Known(default), ContextWindow::Known(maximum)) if maximum > default => {
                Some(
                    config
                        .model_context
                        .get(&self.info().id)
                        .and_then(|context| context.long_context)
                        .unwrap_or(false),
                )
            }
            _ => None,
        }
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
        if update.acceleration.is_missing() && update.long_context.is_none() {
            return Err(invalid("model preference update must contain a change"));
        }
        if let ash_protocol::Patch::Value(option) = &update.acceleration
            && !config
                .acceleration_options(&info)
                .iter()
                .any(|entry| &entry.id == option)
        {
            return Err(invalid(
                "acceleration option is unavailable for this model connection",
            ));
        }
        if update.long_context.is_some() && self.long_context(config).is_none() {
            return Err(invalid(
                "long context is unavailable for this model connection",
            ));
        }
        match &update.acceleration {
            ash_protocol::Patch::Missing => {}
            ash_protocol::Patch::Null => {
                config.model_acceleration.remove(&info.id);
            }
            ash_protocol::Patch::Value(option) => {
                config
                    .model_acceleration
                    .insert(info.id.clone(), option.clone());
            }
        }
        if let Some(enabled) = update.long_context {
            let context = config
                .model_context
                .entry(info.id)
                .or_insert(ModelContextConfig {
                    context_window: None,
                    long_context: None,
                    auto_compact_token_limit: None,
                });
            context.context_window = None;
            context.long_context = Some(enabled);
        }
        Ok(())
    }

    /// Product default constrained by the current connection's observed capacity.
    pub fn default_context_window(&self, config: &ModelProviderConfig) -> ContextWindow {
        let default = config
            .custom
            .as_ref()
            .map(|custom| custom.context_window)
            .or_else(|| match self.declared_default_context_window {
                ContextWindow::Known(window) => Some(window),
                ContextWindow::Unknown => None,
            });
        match (self.info().context_window, default) {
            (ContextWindow::Known(limit), Some(window)) => ContextWindow::Known(window.min(limit)),
            (ContextWindow::Unknown, Some(window)) => ContextWindow::Known(window),
            (catalog, _) => catalog,
        }
    }

    /// Effective execution metadata; observations and saved compaction thresholds stay intact.
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
        if info.capabilities.fast_mode == ash_protocol::CapabilitySupport::Supported
            && config.acceleration_options(&info).is_empty()
        {
            info.capabilities.fast_mode = ash_protocol::CapabilitySupport::Unsupported;
        }
        let context = config.model_context.get(&info.id);
        info.context_window = match context.and_then(|context| context.long_context) {
            // The selected budget follows capacity changes on this connection; no size is saved.
            Some(true) => self.info().context_window,
            Some(false) => self.default_context_window(config),
            None => {
                let manual = context
                    .and_then(|context| context.context_window)
                    .or_else(|| config.custom.as_ref().map(|custom| custom.context_window));
                match (self.info().context_window, manual) {
                    (ContextWindow::Known(limit), Some(window)) => {
                        ContextWindow::Known(window.min(limit))
                    }
                    (ContextWindow::Unknown, Some(window)) => ContextWindow::Known(window),
                    _ => self.default_context_window(config),
                }
            }
        };
        if let Some(context) = context {
            info.auto_compact_token_limit = context.auto_compact_token_limit;
        }
        if let ContextWindow::Known(window) = info.context_window {
            // Reserve ten percent; widening keeps the same ratio for every u32 window.
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
    pub acceleration: ash_protocol::Patch<String>,
    pub long_context: Option<bool>,
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
            description: None,
            context_window: None,
            auto_compact_token_limit: None,
            capabilities: Default::default(),
            supported_reasoning_efforts: None,
            default_reasoning_effort: None,
            default_personality: None,
            lifecycle: None,
        },
        Vec::new(),
    )
}

#[cfg(test)]
#[path = "model_info_tests.rs"]
mod tests;

use crate::LiveApiProfile;
use crate::ModelId;
use crate::ProviderConfigError;
use crate::ProviderDefinition;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeSet;

/// Voice selection is stored independently of the tool-capable text model selection.
#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VoiceModelConfig {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub model: Option<ModelId>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub voice: Option<String>,
}

impl VoiceModelConfig {
    /// Explicit request fields override saved voice settings; omitted fields retain them.
    pub fn with_overrides(&self, request: &Self) -> Self {
        Self {
            model: request.model.clone().or_else(|| self.model.clone()),
            voice: request.voice.clone().or_else(|| self.voice.clone()),
        }
    }
}

/// Provider-declared speech model and its supported built-in voices; no text/tool capabilities.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceModelDefinition {
    pub id: ModelId,
    pub default_voice: String,
    pub voices: Vec<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VoiceModelCatalog {
    pub default_model: ModelId,
    pub models: Vec<VoiceModelDefinition>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResolvedVoiceModel {
    pub model: ModelId,
    pub voice: String,
}

impl ProviderDefinition {
    pub fn with_voice_models(mut self, catalog: VoiceModelCatalog) -> Self {
        self.voice_models = Some(catalog);
        self
    }

    pub fn resolve_voice(
        &self,
        config: &VoiceModelConfig,
    ) -> Result<ResolvedVoiceModel, ProviderConfigError> {
        self.validate_voice()?;
        let catalog = self
            .voice_models
            .as_ref()
            .ok_or_else(|| self.voice_error("provider has no voice model catalog"))?;
        let model = config.model.as_ref().unwrap_or(&catalog.default_model);
        let definition = catalog
            .models
            .iter()
            .find(|entry| &entry.id == model)
            .ok_or_else(|| ProviderConfigError::ModelNotRegistered {
                provider: self.id.clone(),
                model: model.clone(),
            })?;
        let voice = config.voice.as_ref().unwrap_or(&definition.default_voice);
        if !definition.voices.contains(voice) {
            return Err(self.voice_error("voice is not declared for the selected speech model"));
        }
        Ok(ResolvedVoiceModel {
            model: model.clone(),
            voice: voice.clone(),
        })
    }

    pub(crate) fn validate_voice(&self) -> Result<(), ProviderConfigError> {
        let Some(catalog) = &self.voice_models else {
            return Ok(());
        };
        if self.live_api_profile == LiveApiProfile::Unavailable {
            return Err(self.voice_error("voice models require an explicit Live protocol"));
        }
        let mut models = BTreeSet::new();
        for model in &catalog.models {
            let voices: BTreeSet<_> = model.voices.iter().collect();
            if !models.insert(&model.id)
                || voices.len() != model.voices.len()
                || voices.iter().any(|voice| voice.trim().is_empty())
                || !model.voices.contains(&model.default_voice)
            {
                return Err(self.voice_error("voice catalog contains duplicate models, invalid voices or an undeclared default voice"));
            }
        }
        if !models.contains(&catalog.default_model) {
            return Err(self.voice_error("default voice model is not in the voice catalog"));
        }
        Ok(())
    }

    fn voice_error(&self, message: &str) -> ProviderConfigError {
        ProviderConfigError::InvalidProvider {
            provider: self.id.clone(),
            message: message.into(),
        }
    }
}

#[cfg(test)]
#[path = "voice_tests.rs"]
mod tests;

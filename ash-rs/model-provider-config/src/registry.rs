use crate::config::{is_http_url, normalize_base_url};
use crate::{
    ApprovalReviewModelDefault, BaseUrlNormalization, EndpointPolicy, InputTokenCountTarget,
    ModelCatalogPolicy, ModelProviderConfig, NormalizedInputTokenCountConfig,
    NormalizedModelProviderConfig, ProviderAccessMode, ProviderConfigError, ProviderDefinition,
    ProviderId, model_catalog, providers,
};
use ash_protocol::ModelRef;
use std::collections::BTreeMap;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RegistryMergePolicy {
    RejectConflicts,
    ReplaceExisting,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ProviderConfigRegistry {
    providers: BTreeMap<ProviderId, ProviderDefinition>,
}

impl ProviderConfigRegistry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn builtin() -> Self {
        let mut definitions = providers::builtin();
        model_catalog::attach_static_models(&mut definitions);
        Self::from_definitions(definitions)
            .expect("built-in provider definitions must be valid and unique")
    }

    pub fn from_definitions(
        definitions: impl IntoIterator<Item = ProviderDefinition>,
    ) -> Result<Self, ProviderConfigError> {
        let mut registry = Self::new();
        for definition in definitions {
            registry.register(definition)?;
        }
        Ok(registry)
    }

    pub fn register(&mut self, definition: ProviderDefinition) -> Result<(), ProviderConfigError> {
        definition.validate()?;
        if self.providers.contains_key(&definition.id) {
            return Err(ProviderConfigError::DuplicateProvider(
                definition.id.clone(),
            ));
        }
        self.providers.insert(definition.id.clone(), definition);
        Ok(())
    }

    pub fn merge(
        &mut self,
        incoming: Self,
        policy: RegistryMergePolicy,
    ) -> Result<(), ProviderConfigError> {
        for definition in incoming.providers.values() {
            definition.validate()?;
            if policy == RegistryMergePolicy::RejectConflicts
                && self.providers.contains_key(&definition.id)
            {
                return Err(ProviderConfigError::DuplicateProvider(
                    definition.id.clone(),
                ));
            }
        }
        self.providers.extend(incoming.providers);
        Ok(())
    }

    pub fn get(&self, provider: &ProviderId) -> Option<&ProviderDefinition> {
        self.providers.get(provider)
    }

    /// Resolves user-defined connections into one immutable registry snapshot.
    pub fn with_configs<'a>(
        &self,
        configs: impl IntoIterator<Item = &'a ModelProviderConfig>,
    ) -> Result<Self, ProviderConfigError> {
        let mut registry = self.clone();
        let mut names = std::collections::BTreeSet::new();
        for config in configs {
            if config.access_mode == ProviderAccessMode::Subscription {
                config.validate_static()?;
                let mut definition = providers::subscription_definition(config.provider.as_str())
                    .ok_or_else(|| ProviderConfigError::InvalidProvider {
                    provider: config.provider.clone(),
                    message: "subscription access is unavailable for this provider".into(),
                })?;
                model_catalog::attach_subscription_models(&mut definition);
                registry
                    .providers
                    .insert(config.provider.clone(), definition);
            } else if let Some(custom) = &config.custom {
                config.validate_static()?;
                if !names.insert(custom.name.trim().to_lowercase()) {
                    return Err(ProviderConfigError::DuplicateProvider(
                        config.provider.clone(),
                    ));
                }
                registry
                    .providers
                    .insert(config.provider.clone(), custom.definition(config)?);
            }
        }
        Ok(registry)
    }

    pub fn providers(&self) -> impl Iterator<Item = &ProviderDefinition> {
        self.providers.values()
    }

    /// Selects the provider-owned automatic approval-review model for an active Agent model.
    ///
    /// Providers may name a dedicated review default. Providers without one reuse the active
    /// model, which keeps custom and local providers usable without inventing a model identifier.
    pub fn automatic_approval_review_model(
        &self,
        active_model: &ModelRef,
    ) -> Result<ModelRef, ProviderConfigError> {
        let definition = self
            .get(&active_model.provider)
            .ok_or_else(|| ProviderConfigError::UnknownProvider(active_model.provider.clone()))?;
        let model = match &definition.defaults.approval_review_model {
            ApprovalReviewModelDefault::ActiveModel => active_model.model.clone(),
            ApprovalReviewModelDefault::Model { model } => model.clone(),
        };
        Ok(ModelRef::new(active_model.provider.clone(), model))
    }

    /// Validates the part of model availability represented by the provider's static catalog.
    ///
    /// Providers that allow unlisted model IDs still require runtime validation because account
    /// entitlement and remote availability cannot be proven from local configuration.
    pub fn validate_model_selection(&self, model: &ModelRef) -> Result<(), ProviderConfigError> {
        let definition = self
            .get(&model.provider)
            .ok_or_else(|| ProviderConfigError::UnknownProvider(model.provider.clone()))?;
        if definition.model_catalog_policy == ModelCatalogPolicy::ListedOnly
            && !definition
                .models
                .iter()
                .any(|candidate| candidate.id == model.model)
        {
            return Err(ProviderConfigError::ModelNotRegistered {
                provider: model.provider.clone(),
                model: model.model.clone(),
            });
        }
        Ok(())
    }

    pub fn normalize(
        &self,
        config: &ModelProviderConfig,
    ) -> Result<NormalizedModelProviderConfig, ProviderConfigError> {
        config.validate_static()?;
        let definition = self
            .get(&config.provider)
            .ok_or_else(|| ProviderConfigError::UnknownProvider(config.provider.clone()))?;
        let configured_base_url = config
            .base_url
            .as_deref()
            .map(str::trim)
            .filter(|base_url| !base_url.is_empty());
        let base_url = match (configured_base_url, &definition.endpoint) {
            (Some(base_url), _) => base_url,
            (None, EndpointPolicy::ProviderDefault { base_url }) => base_url,
            (None, EndpointPolicy::ConfiguredOnly) => {
                return Err(ProviderConfigError::MissingBaseUrl(config.provider.clone()));
            }
        };
        let base_url = normalize_base_url(base_url, definition.base_url_normalization);
        if !is_http_url(&base_url) {
            return Err(ProviderConfigError::InvalidBaseUrl {
                provider: config.provider.clone(),
                base_url,
            });
        }
        let input_token_count = definition.input_token_count.as_ref().and_then(|count| {
            let count_base_url = match &count.target {
                InputTokenCountTarget::InvocationBase => base_url.clone(),
                InputTokenCountTarget::ProviderDefault { base_url }
                    if configured_base_url.is_none() =>
                {
                    normalize_base_url(base_url, BaseUrlNormalization::TrimAndRemoveTrailingSlash)
                }
                InputTokenCountTarget::ProviderDefault { .. } => return None,
            };
            Some(NormalizedInputTokenCountConfig {
                profile: count.profile,
                base_url: count_base_url,
                models: count.models.clone(),
            })
        });
        Ok(NormalizedModelProviderConfig {
            provider: config.provider.clone(),
            access_mode: config.access_mode,
            api_profile: definition.api_profile,
            base_url,
            input_token_count,
            max_output_tokens: config
                .max_output_tokens
                .or(definition.defaults.max_output_tokens),
        })
    }

    pub fn normalize_for(
        &self,
        config: &ModelProviderConfig,
        selected_provider: &ProviderId,
    ) -> Result<NormalizedModelProviderConfig, ProviderConfigError> {
        if &config.provider != selected_provider {
            return Err(ProviderConfigError::ProviderMismatch {
                configured: config.provider.clone(),
                selected: selected_provider.clone(),
            });
        }
        self.normalize(config)
    }
}

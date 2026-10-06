use ash_config::ResolvedConfig;
use ash_core::ContextBudget;
use ash_core::ContextCompactionLimit;
use ash_core::ContextTokenCount;
use ash_core::ResolvedContextBudget;
use ash_model_provider::ModelProviderError;
use ash_model_provider::ModelProviderRuntime;
use ash_models_manager::CatalogQuery;
use ash_models_manager::ModelCatalogEntry;
use ash_models_manager::ModelRequirements;
use ash_models_manager::ModelsManager;
use ash_protocol::ContextWindow;
use ash_protocol::ModelInfo;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use core_api::CoreError;
use model_provider_info::ModelProviderConfig;
use model_provider_info::ProviderConfigRegistry;
use std::collections::BTreeMap;
use std::collections::HashMap;

const DEFAULT_OUTPUT_TOKENS: u32 = 4_096;
const CONTEXT_SAFETY_MARGIN_TOKENS: u32 = 1_024;

/// Freezes cached model evidence alongside the configuration used by one Turn.
/// Capturing a catalog never fetches an endpoint. Account-scoped observations override seeds
/// in both the picker and execution; later refreshes cannot change a running Turn's capacity.
#[derive(Clone)]
pub(super) struct ModelContextCatalog {
    manager: ModelsManager,
    registry: ProviderConfigRegistry,
    entries: HashMap<ModelRef, ModelCatalogEntry>,
    discovered: BTreeMap<ProviderId, Vec<ModelCatalogEntry>>,
}

impl ModelContextCatalog {
    pub(super) fn registry(&self) -> &ProviderConfigRegistry {
        &self.registry
    }

    pub(super) fn capture(
        config: &ResolvedConfig,
        registry: &ProviderConfigRegistry,
        manager: &ModelsManager,
        runtime: &ModelProviderRuntime,
    ) -> Result<Self, CoreError> {
        let registry = registry
            .with_configs(config.providers.values())
            .map_err(|error| CoreError::Model(error.to_string()))?;
        let manager = manager.with_registry(registry.clone());
        let mut entries = HashMap::new();
        let mut discovered = BTreeMap::new();
        for provider in config.providers.values() {
            let seed = manager
                .static_snapshot(&provider.provider)
                .map_err(|error| CoreError::Model(error.to_string()))?;
            entries.extend(
                seed.entries()
                    .iter()
                    .map(|entry| (entry.model().clone(), entry.clone())),
            );
            let binding = match runtime.catalog_binding(provider) {
                Ok(binding) => binding,
                // Credentials are checked by invocation. Missing credentials do not erase
                // the product catalog or supply fabricated capacity for an unknown model.
                Err(ModelProviderError::Credential(_)) => None,
                Err(error) => return Err(CoreError::Model(error.to_string())),
            };
            if let Some(binding) = binding {
                let observed = manager
                    .list_discovered(&[binding.scope().clone()], &CatalogQuery::all())
                    .map_err(|error| CoreError::Model(error.to_string()))?;
                entries.extend(
                    observed
                        .iter()
                        .map(|entry| (entry.model().clone(), entry.clone())),
                );
                discovered.insert(provider.provider.clone(), observed);
            }
        }
        Ok(Self {
            manager,
            registry,
            entries,
            discovered,
        })
    }

    pub(super) fn discovered(&self, provider: &ProviderId) -> &[ModelCatalogEntry] {
        self.discovered.get(provider).map_or(&[], Vec::as_slice)
    }

    pub(super) fn entry(&self, model: &ModelRef) -> Result<ModelCatalogEntry, CoreError> {
        if let Some(entry) = self.entries.get(model) {
            return Ok(entry.clone());
        }
        // AllowUnlisted enrollment is a catalog policy, not a capacity declaration. Exact
        // per-model configuration may complete its metadata before requiring a budget.
        self.manager
            .resolve_static(model, &ModelRequirements::agent())
            .map(|resolved| resolved.entry().clone())
            .map_err(|error| CoreError::Model(error.to_string()))
    }

    pub(super) fn budget(&self, config: &ResolvedConfig) -> Result<ContextBudget, CoreError> {
        let model = config.model.as_ref().ok_or_else(configuration_missing)?;
        let provider = config
            .providers
            .get(&model.provider)
            .ok_or_else(configuration_missing)?;
        ModelContext::resolve(&self.entry(model)?, provider, &self.registry)?.require_budget()
    }

    pub(super) fn info(&self, config: &ResolvedConfig) -> Result<ModelInfo, CoreError> {
        let model = config.model.as_ref().ok_or_else(configuration_missing)?;
        let provider = config
            .providers
            .get(&model.provider)
            .ok_or_else(configuration_missing)?;
        self.entry(model)?
            .model_info(provider)
            .map_err(|error| CoreError::Model(error.to_string()))
    }
}

fn configuration_missing() -> CoreError {
    CoreError::ModelFailure(ash_protocol::StableTurnError::model_configuration())
}

/// One interpretation of effective metadata, shared by catalog serialization and execution.
pub(super) struct ModelContext {
    pub(super) info: ModelInfo,
    pub(super) maximum_window: Option<u32>,
    budget: ModelContextBudget,
}

enum ModelContextBudget {
    MissingWindow,
    InvalidAllocations,
    Ready {
        budget: ContextBudget,
        available_input: u32,
    },
}

impl ModelContext {
    pub(super) fn resolve(
        entry: &ModelCatalogEntry,
        config: &ModelProviderConfig,
        registry: &ProviderConfigRegistry,
    ) -> Result<Self, CoreError> {
        let info = entry
            .model_info(config)
            .map_err(|error| CoreError::Model(error.to_string()))?;
        let maximum_window = match entry.info().context_window {
            ContextWindow::Known(tokens) => Some(tokens),
            ContextWindow::Unknown => None,
        };
        let ContextWindow::Known(window) = info.context_window else {
            return Ok(Self {
                info,
                maximum_window,
                budget: ModelContextBudget::MissingWindow,
            });
        };
        // Capacity is model metadata, independent of endpoint and credential readiness.
        // The picker can therefore show every registered model before a connection is set up.
        let definition = registry
            .get(&config.provider)
            .ok_or_else(|| CoreError::Model(format!("unknown provider '{}'", config.provider)))?;
        let output = config
            .max_output_tokens
            .or(definition.defaults.max_output_tokens)
            .unwrap_or(DEFAULT_OUTPUT_TOKENS);
        let compaction = info
            .auto_compact_token_limit
            .map_or(ContextCompactionLimit::ContextWindow, |tokens| {
                ContextCompactionLimit::Tokens(ContextTokenCount::new(tokens))
            });
        let budget = ContextBudget::core_managed(
            ContextTokenCount::new(window),
            ContextTokenCount::new(output),
            ContextTokenCount::new(CONTEXT_SAFETY_MARGIN_TOKENS),
            compaction,
        );
        let budget = match budget.resolve() {
            Ok(ResolvedContextBudget::CoreManaged(limits)) => ModelContextBudget::Ready {
                budget,
                available_input: limits.maximum_input().get(),
            },
            Ok(ResolvedContextBudget::ProviderManaged) => {
                unreachable!("explicit allocations are Core-managed")
            }
            Err(_) => ModelContextBudget::InvalidAllocations,
        };
        Ok(Self {
            info,
            maximum_window,
            budget,
        })
    }

    pub(super) fn available_input(&self) -> Option<u32> {
        match self.budget {
            ModelContextBudget::Ready {
                available_input, ..
            } => Some(available_input),
            ModelContextBudget::MissingWindow | ModelContextBudget::InvalidAllocations => None,
        }
    }

    pub(super) fn require_budget(&self) -> Result<ContextBudget, CoreError> {
        match self.budget {
            ModelContextBudget::Ready { budget, .. } => Ok(budget),
            ModelContextBudget::MissingWindow => Err(context_configuration_error(
                "Configure the model context window in /config before sending a message.",
            )),
            ModelContextBudget::InvalidAllocations => Err(context_configuration_error(
                "Adjust the context window, output limit, or compaction threshold in /config to leave room for input.",
            )),
        }
    }
}

fn context_configuration_error(message: &str) -> CoreError {
    let mut error = ash_protocol::StableTurnError::model_configuration();
    error.message = message.into();
    CoreError::ModelFailure(error)
}

/// Direct consultations also receive the reserved output limit. Requests already assembled by
/// Core retain their per-invocation allocation, including auxiliary-model and review limits.
pub(super) fn request_with_output_limit(
    request: &ash_protocol::ModelRequest,
    budget: ContextBudget,
) -> ash_protocol::ModelRequest {
    let ContextBudget::CoreManaged {
        reserved_output, ..
    } = budget
    else {
        unreachable!("configured models require explicit context allocations")
    };
    let mut request = request.clone();
    request.max_output_tokens = request.max_output_tokens.or(Some(reserved_output.get()));
    request
}

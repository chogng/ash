use std::collections::BTreeMap;
use std::sync::Arc;

use ash_config::ToolSearchConfig;
use ash_config::ToolSearchModeConfig;
use ash_model_provider::EmbeddingRuntimeRequest;
use ash_model_provider::SemanticModelProvider;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use model_provider_info::ModelProviderConfig;

use crate::tool_composition::ToolSearchOptions;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ToolSearchEmbeddingStatus {
    Disabled,
    Ready {
        model: ModelRef,
    },
    Unavailable {
        model: Option<ModelRef>,
        reason: String,
    },
}

pub(crate) struct ToolSearchResolution {
    pub(crate) options: ToolSearchOptions,
    pub(crate) status: ToolSearchEmbeddingStatus,
}

pub(crate) fn resolve_tool_search(
    config: &ToolSearchConfig,
    providers: &BTreeMap<ProviderId, ModelProviderConfig>,
    model_provider: Option<&Arc<dyn SemanticModelProvider>>,
) -> ToolSearchResolution {
    if config.mode == ToolSearchModeConfig::Lexical {
        return ToolSearchResolution {
            options: ToolSearchOptions::new(),
            status: ToolSearchEmbeddingStatus::Disabled,
        };
    }

    let result = resolve_hybrid(config, providers, model_provider);
    match result {
        Ok((options, model)) => ToolSearchResolution {
            options,
            status: ToolSearchEmbeddingStatus::Ready { model },
        },
        Err(reason) => ToolSearchResolution {
            options: ToolSearchOptions::unavailable(reason.clone()),
            status: ToolSearchEmbeddingStatus::Unavailable {
                model: config.embedding_model.clone(),
                reason,
            },
        },
    }
}

fn resolve_hybrid(
    config: &ToolSearchConfig,
    providers: &BTreeMap<ProviderId, ModelProviderConfig>,
    model_provider: Option<&Arc<dyn SemanticModelProvider>>,
) -> Result<(ToolSearchOptions, ModelRef), String> {
    let model = config
        .embedding_model
        .clone()
        .ok_or_else(|| "hybrid embedding Tool Search requires an embedding model".to_owned())?;
    let provider_config = providers.get(&model.provider).cloned().ok_or_else(|| {
        format!(
            "Tool Search embedding provider '{}' is not configured",
            model.provider
        )
    })?;
    let model_provider = model_provider.ok_or_else(|| {
        "this App Server host does not provide semantic model invocation".to_owned()
    })?;
    let embedding = model_provider
        .embedding_runtime(EmbeddingRuntimeRequest::new(model.clone(), provider_config))
        .map_err(|error| format!("Tool Search embedding model is unavailable: {error}"))?;
    let options = ToolSearchOptions::new()
        .with_embedding(embedding)
        .and_then(|options| options.with_mode(ToolSearchModeConfig::HybridEmbedding))
        .map_err(|error| error.to_string())?;
    Ok((options, model))
}

#[cfg(test)]
#[path = "tool_search_models_tests.rs"]
mod tests;

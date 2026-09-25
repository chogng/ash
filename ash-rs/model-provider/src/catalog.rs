mod kimi;
mod ollama;
mod openai;
mod xai;
mod zai;

pub(crate) use kimi::kimi_catalog_binding;
pub(crate) use ollama::ollama_catalog_binding;
pub(crate) use openai::chatgpt_catalog_binding;
pub(crate) use openai::openai_catalog_binding;
pub(crate) use xai::xai_catalog_binding;
pub(crate) use zai::zai_catalog_binding;

use ash_models_manager::CatalogScopeKey;
use ash_models_manager::ModelCatalogSource;
use std::sync::Arc;

/// Binds one exact provider configuration to its dynamic catalog identity and source.
///
/// App Server composition uses this value to refresh the shared models manager without exposing
/// endpoint details or credentials through its client protocol.
pub struct ModelCatalogBinding {
    scope: CatalogScopeKey,
    source: Arc<dyn ModelCatalogSource>,
}

impl ModelCatalogBinding {
    pub fn scope(&self) -> &CatalogScopeKey {
        &self.scope
    }

    pub fn source(&self) -> Arc<dyn ModelCatalogSource> {
        Arc::clone(&self.source)
    }
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;

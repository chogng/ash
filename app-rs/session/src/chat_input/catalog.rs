//! App Server model catalog projection for ChatInput.

use crate::ComposerModelOption;
use ash_app_server_protocol::protocol::model::ModelCatalogEntry;

/// Normalizes transport-owned model catalog entries into the Session Pane contract.
pub fn composer_model_options(entries: Vec<ModelCatalogEntry>) -> Vec<ComposerModelOption> {
    entries
        .into_iter()
        .map(|entry| ComposerModelOption {
            description: format!("{}/{}", entry.model.provider, entry.model.model),
            label: entry.display_name,
            model: entry.model,
        })
        .collect()
}

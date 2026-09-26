use crate::keymap::bindings;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionSpec;
use crate::widgets::search_box::SearchBoxModel;
use ash_app_server_protocol::protocol::config::ConfigReadResult;
use ash_app_server_protocol::protocol::config::FrontendConfigDto;
use ash_app_server_protocol::protocol::config::ModelRefDto;
use ash_app_server_protocol::protocol::model::ModelListResult;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ModelSelectionAction {
    Select { preference: String, pinned: bool },
    Pin { preference: String, pinned: bool },
}

pub(crate) type ModelChoices = ListSelectionSpec<ModelSelectionAction>;

pub(super) fn pinned_models(tui: &FrontendConfigDto) -> Result<Vec<ModelRefDto>, String> {
    let pins: Vec<ModelRefDto> = tui
        .0
        .get("pinnedModels")
        .map(|value| serde_json::from_value(value.clone()))
        .transpose()
        .map_err(|error| format!("Invalid pinned models: {error}"))?
        .unwrap_or_default();
    let mut seen = std::collections::BTreeSet::new();
    for pin in &pins {
        ash_protocol::ProviderId::new(&pin.provider).map_err(|error| error.to_string())?;
        ash_protocol::ModelId::new(&pin.model).map_err(|error| error.to_string())?;
        if !seen.insert((&pin.provider, &pin.model)) {
            return Err("Duplicate pinned model".into());
        }
    }
    Ok(pins)
}

pub(crate) fn model_choices(
    catalog: &ModelListResult,
    config: &ConfigReadResult,
) -> Result<ModelChoices, String> {
    let pins = pinned_models(&config.tui)?;
    let mut actions = BTreeMap::new();
    let mut pinned_items = Vec::new();
    let mut other_items = Vec::new();
    for entry in &catalog.models {
        // The product catalog is global; this client only offers configured providers.
        if !config.providers.contains_key(entry.model.provider.as_str()) {
            continue;
        }
        let model = ModelRefDto {
            provider: entry.model.provider.to_string(),
            model: entry.model.model.to_string(),
        };
        let preference = format!("{}/{}", model.provider, model.model);
        let pinned = pins.contains(&model);
        let id = ListSelectionItemId::new(&preference);
        actions.insert(
            id.clone(),
            ModelSelectionAction::Select { preference, pinned },
        );
        let item = ListSelectionItem::new(entry.display_name.clone()).with_id(id);
        if pinned {
            pinned_items.push(item);
        } else {
            other_items.push(item);
        }
    }
    let has_models = !pinned_items.is_empty() || !other_items.is_empty();
    let mut items = Vec::new();
    if !pinned_items.is_empty() {
        items.push(ListSelectionItem::new("Pinned").as_section_divider());
        items.extend(pinned_items);
    }
    if !other_items.is_empty() {
        if !items.is_empty() {
            items.push(ListSelectionItem::new("Other models").as_section_divider());
        }
        items.extend(other_items);
    }
    let mut model = ListSelectionModel::new("Model", vec![ListSelectionGroup::new("Model", items)])
        .without_tab_bar();
    if has_models {
        model = model
            .with_activation(bindings::MODEL_APPLY)
            .with_key_hint_note("P to pin/unpin")
            .with_search(SearchBoxModel::new("Search models"));
    } else {
        model = model.with_empty_message("No configured models · Configure a provider in /config");
    }
    Ok(ModelChoices { model, actions })
}

#[cfg(test)]
#[path = "picker_tests.rs"]
mod tests;

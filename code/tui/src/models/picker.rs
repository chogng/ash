use crate::keymap::bindings;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionSpec;
use ash_app_server_protocol::protocol::config::ConfigReadResult;
use ash_app_server_protocol::protocol::config::FrontendConfigDto;
use ash_app_server_protocol::protocol::config::ModelRefDto;
use ash_app_server_protocol::protocol::model::ModelListResult;
use ash_app_server_protocol::protocol::provider::ProviderListResult;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

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
    providers: &ProviderListResult,
) -> Result<ModelChoices, String> {
    let pins = pinned_models(&config.tui)?;
    let mut actions = BTreeMap::new();
    let mut groups = BTreeMap::<String, Vec<ListSelectionItem>>::new();
    let mut subscription_providers = BTreeSet::new();
    let mut favorites = Vec::new();
    for entry in &catalog.models {
        // Selection still requires a configured provider when another caller supplies a wider catalog.
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
        if entry.access == ash_protocol::ModelAccess::Subscription {
            subscription_providers.insert(model.provider.clone());
        }
        groups.entry(model.provider).or_default().push(item.clone());
        if pinned {
            favorites.push(item);
        }
    }
    let mut tabs = vec![ListSelectionGroup::new("Favorites", favorites)];
    let mut custom = config
        .providers
        .values()
        .filter(|provider| provider.custom.is_some())
        .collect::<Vec<_>>();
    custom.sort_by(|a, b| {
        b.custom
            .as_ref()
            .unwrap()
            .order
            .cmp(&a.custom.as_ref().unwrap().order)
            .then_with(|| a.provider.cmp(&b.provider))
    });
    for provider in custom {
        if let Some(items) = groups.remove(&provider.provider) {
            tabs.push(ListSelectionGroup::new(
                &provider.custom.as_ref().unwrap().name,
                items,
            ));
        }
    }
    for provider in &providers.providers {
        if config
            .providers
            .get(&provider.provider)
            .is_some_and(|provider| provider.custom.is_some())
        {
            continue;
        }
        if let Some(items) = groups.remove(&provider.provider) {
            let label = if provider.provider == "openai"
                && subscription_providers.contains(&provider.provider)
            {
                "ChatGPT"
            } else {
                &provider.display_name
            };
            tabs.push(ListSelectionGroup::new(label, items));
        }
    }
    for (provider, items) in groups {
        tabs.push(ListSelectionGroup::new(provider, items));
    }
    let has_models = tabs.len() > 1;
    let mut model = ListSelectionModel::new("Model", tabs);
    if has_models {
        model = model
            .with_activation(bindings::MODEL_APPLY)
            .with_key_hint_note("P to pin/unpin")
            .with_empty_message("No models here · Pin models from a provider tab to Favorites");
    } else {
        model =
            model.with_empty_message("No discovered models · Use /model provider/model or /config");
    }
    Ok(ModelChoices { model, actions })
}

#[cfg(test)]
#[path = "picker_tests.rs"]
mod tests;

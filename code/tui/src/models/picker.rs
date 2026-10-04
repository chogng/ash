use crate::keymap::KeyEvent;
use crate::keymap::bindings;
use crate::widgets::list_selection::ListSelection;
use crate::widgets::list_selection::ListSelectionAdjustment;
use crate::widgets::list_selection::ListSelectionClick;
use crate::widgets::list_selection::ListSelectionGroup;
use crate::widgets::list_selection::ListSelectionItem;
use crate::widgets::list_selection::ListSelectionItemFocus;
use crate::widgets::list_selection::ListSelectionItemId;
use crate::widgets::list_selection::ListSelectionModel;
use crate::widgets::list_selection::ListSelectionOutcome;
use crate::widgets::list_selection::ListSelectionPointerTarget;
use crate::widgets::list_selection::ListSelectionSegmentedValue;
use crate::widgets::list_selection::ListSelectionSpec;
use crate::widgets::search_box::SearchBoxModel;
use ash_app_server_protocol::protocol::config::ConfigReadResult;
use ash_app_server_protocol::protocol::config::FrontendConfigDto;
use ash_app_server_protocol::protocol::config::ModelRefDto;
use ash_app_server_protocol::protocol::model::ModelListResult;
use ash_protocol::ReasoningEffort;
use crossterm::event::KeyCode;
use crossterm::event::KeyEventKind;
use crossterm::event::KeyModifiers;
use std::collections::BTreeMap;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ModelSelectionAction {
    Select {
        preference: String,
        pinned: bool,
        effort: Option<ReasoningEffort>,
        default_effort: Option<ReasoningEffort>,
        supported_efforts: Vec<ReasoningEffort>,
        revision: u64,
        fast: Option<bool>,
        context: Option<u32>,
    },
    Configure {
        preference: String,
        revision: u64,
        option: ModelOption,
    },
    Pin {
        preference: String,
        pinned: bool,
    },
}

/// Per-model execution settings saved independently of the selected model and draft effort.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum ModelOption {
    FastOn,
    FastOff,
    Context272k,
    Context1m,
}

impl ModelSelectionAction {
    fn configure(&self, control: &str) -> Option<Self> {
        let Self::Select {
            preference,
            revision,
            fast,
            context,
            ..
        } = self
        else {
            return None;
        };
        let option = match control {
            "fast" => {
                if (*fast)? {
                    ModelOption::FastOff
                } else {
                    ModelOption::FastOn
                }
            }
            "context" => {
                if (*context)? == 272_000 {
                    ModelOption::Context1m
                } else {
                    ModelOption::Context272k
                }
            }
            _ => return None,
        };
        Some(Self::Configure {
            preference: preference.clone(),
            revision: *revision,
            option,
        })
    }

    pub(crate) fn supports_effort(&self) -> bool {
        matches!(self, Self::Select { supported_efforts, .. } if supported_efforts.len() > 1)
    }

    pub(crate) fn restore_effort(
        &mut self,
        previous: &Self,
    ) -> Option<ListSelectionSegmentedValue> {
        let Self::Select {
            effort,
            supported_efforts,
            ..
        } = self
        else {
            return None;
        };
        let Self::Select {
            effort: Some(previous_effort),
            ..
        } = previous
        else {
            return None;
        };
        if !supported_efforts.contains(previous_effort) {
            return None;
        }
        *effort = Some(*previous_effort);
        Some(effort_display(supported_efforts, *effort))
    }

    pub(crate) fn adjust_effort(
        &mut self,
        direction: isize,
    ) -> Option<ListSelectionSegmentedValue> {
        let Self::Select {
            effort,
            default_effort,
            supported_efforts,
            ..
        } = self
        else {
            return None;
        };
        if supported_efforts.len() < 2 {
            return None;
        }
        let current = (*effort).or(*default_effort);
        let next = current
            .and_then(|current| supported_efforts.iter().position(|value| *value == current))
            .map(|index| {
                (index as isize + direction).rem_euclid(supported_efforts.len() as isize) as usize
            })
            .unwrap_or(0);
        *effort = Some(supported_efforts[next]);
        Some(effort_display(supported_efforts, *effort))
    }
}

fn effort_display(
    supported: &[ReasoningEffort],
    current: Option<ReasoningEffort>,
) -> ListSelectionSegmentedValue {
    let levels = supported
        .iter()
        .filter(|effort| **effort != ReasoningEffort::None)
        .copied()
        .collect::<Vec<_>>();
    let filled = current
        .and_then(|current| levels.iter().position(|effort| *effort == current))
        .map(|index| index + 1)
        .unwrap_or(0);
    ListSelectionSegmentedValue {
        filled,
        total: levels.len(),
        label: current.map_or_else(
            || "Default".into(),
            |effort| {
                match effort {
                    ReasoningEffort::None => "None",
                    ReasoningEffort::Minimal => "Minimal",
                    ReasoningEffort::Low => "Low",
                    ReasoningEffort::Medium => "Medium",
                    ReasoningEffort::High => "High",
                    ReasoningEffort::ExtraHigh => "Extra High",
                    ReasoningEffort::Max => "Max",
                }
                .into()
            },
        ),
        adjustable: supported.len() > 1,
    }
}

pub(crate) type ModelChoices = ListSelectionSpec<ModelSelectionAction>;

/// Model identities come from the product catalog; effective budgets are refreshed after edits.
pub(crate) struct ModelPickerData {
    catalog: ModelListResult,
    config: ConfigReadResult,
}

impl ModelPickerData {
    pub(crate) fn new(catalog: ModelListResult, config: ConfigReadResult) -> Self {
        Self { catalog, config }
    }

    pub(crate) fn catalog(&self) -> &ModelListResult {
        &self.catalog
    }

    pub(crate) fn update_catalog(&mut self, catalog: ModelListResult) {
        self.catalog = catalog;
    }

    pub(crate) fn update_config(&mut self, config: ConfigReadResult) {
        self.config = config;
    }

    pub(crate) fn effort_choices(
        &self,
    ) -> Result<crate::thread::composer::options::ComposerOptions, String> {
        super::reasoning_effort::choices(&self.config, &self.catalog)
    }

    pub(crate) fn effort_selector(
        &self,
        mode: ash_protocol::CollaborationMode,
    ) -> Result<super::EffortSelector, String> {
        let (levels, current) =
            super::reasoning_effort::selected_efforts(&self.config, &self.catalog)
                .map_err(|error| error.to_string())?;
        Ok(super::EffortSelector::new(levels, current, mode))
    }

    pub(crate) fn choices(&self) -> Result<ModelChoices, String> {
        model_choices(&self.catalog, &self.config)
    }
}

impl ListSelection<ModelSelectionAction> {
    pub(crate) fn handle_model_key(
        &mut self,
        key: KeyEvent,
    ) -> ListSelectionOutcome<ModelSelectionAction> {
        if key.kind == KeyEventKind::Press && self.state().items_focused() {
            if (key.code == KeyCode::Tab && key.modifiers.is_empty())
                || (key.code == KeyCode::BackTab
                    && (key.modifiers.is_empty() || key.modifiers == KeyModifiers::SHIFT))
                || (key.code == KeyCode::Tab && key.modifiers == KeyModifiers::SHIFT)
            {
                let direction = if key.code == KeyCode::Tab && key.modifiers.is_empty() {
                    ListSelectionAdjustment::Next
                } else {
                    ListSelectionAdjustment::Previous
                };
                self.state_mut().cycle_item_setting(direction);
                return ListSelectionOutcome::Consumed;
            }
        }
        if key.kind == KeyEventKind::Press
            && key.modifiers.is_empty()
            && self.state().items_focused()
        {
            if matches!(key.code, KeyCode::Left | KeyCode::Right) {
                let Some(id) = self
                    .state()
                    .selected_item()
                    .and_then(|item| item.id())
                    .cloned()
                else {
                    return ListSelectionOutcome::Consumed;
                };
                match self.state().focused_item_setting() {
                    Some(ListSelectionItemFocus::Segmented) => {
                        if let Some(value) = self.action_mut(&id).and_then(|action| {
                            action.adjust_effort(if key.code == KeyCode::Right { 1 } else { -1 })
                        }) {
                            self.state_mut().set_item_segmented_value(&id, value);
                        }
                    }
                    Some(ListSelectionItemFocus::Control(control)) => {
                        return self
                            .action(&id)
                            .and_then(|action| action.configure(&control))
                            .map_or(
                                ListSelectionOutcome::Consumed,
                                ListSelectionOutcome::Activate,
                            );
                    }
                    None => {}
                }
                return ListSelectionOutcome::Consumed;
            }
            if key.code == KeyCode::Char('p')
                && let Some(ModelSelectionAction::Select {
                    preference, pinned, ..
                }) = self
                    .state()
                    .selected_item()
                    .and_then(|item| item.id())
                    .and_then(|id| self.action(id))
            {
                return ListSelectionOutcome::Activate(ModelSelectionAction::Pin {
                    preference: preference.clone(),
                    pinned: !pinned,
                });
            }
        }
        self.handle_key(key)
    }

    pub(crate) fn handle_model_click(
        &mut self,
        target: &ListSelectionPointerTarget,
        click: ListSelectionClick,
    ) -> ListSelectionOutcome<ModelSelectionAction> {
        if !self.state_mut().focus_pointer(target) {
            return ListSelectionOutcome::Consumed;
        }
        if matches!(target, ListSelectionPointerTarget::ItemControl { .. }) {
            return self.handle_model_key(KeyEvent::new(KeyCode::Right, KeyModifiers::NONE));
        }
        if matches!(target, ListSelectionPointerTarget::Item(_))
            && click == ListSelectionClick::Double
        {
            return self.handle_model_key(KeyEvent::new(KeyCode::Enter, KeyModifiers::NONE));
        }
        ListSelectionOutcome::Consumed
    }

    pub(crate) fn model_key_hints(&self) -> &crate::widgets::key_hint::KeyHints {
        if !self.state().items_focused() {
            return self.key_hints();
        }
        let Some(
            action @ ModelSelectionAction::Select {
                pinned,
                fast,
                context,
                ..
            },
        ) = self
            .state()
            .selected_item()
            .and_then(|item| item.id())
            .and_then(|id| self.action(id))
        else {
            return self.key_hints();
        };
        static HINTS: std::sync::LazyLock<Vec<crate::widgets::key_hint::KeyHints>> =
            std::sync::LazyLock::new(|| {
                (0..4)
                    .map(|bits| {
                        let mut hints = crate::widgets::key_hint::KeyHints::compact()
                            .with_compact_action("↑↓", "select");
                        if bits & 1 != 0 {
                            hints = hints
                                .with_compact_action("Tab", "setting")
                                .with_compact_action("←→", "adjust");
                        }
                        hints
                            .with_compact_action("/", "search")
                            .with_compact_action("p", if bits & 2 != 0 { "unpin" } else { "pin" })
                            .with_compact_action("Enter", "apply")
                            .with_compact_action("Esc", "cancel")
                    })
                    .collect()
            });
        let settings = usize::from(action.supports_effort())
            + usize::from(fast.is_some())
            + usize::from(context.is_some());
        &HINTS[usize::from(settings > 0) | (usize::from(*pinned) << 1)]
    }

    pub(crate) fn replace_model_choices(&mut self, choices: ModelChoices) {
        // A pin update rebuilds the list asynchronously; keep unconfirmed effort edits.
        let edits = choices
            .actions
            .keys()
            .filter_map(|id| self.action(id).cloned().map(|action| (id.clone(), action)))
            .collect::<Vec<_>>();
        self.replace(choices.model, choices.actions);
        for (id, previous) in edits {
            if let Some(value) = self
                .action_mut(&id)
                .and_then(|action| action.restore_effort(&previous))
            {
                self.state_mut().set_item_segmented_value(&id, value);
            }
        }
    }
}

pub(crate) fn pinned_models(tui: &FrontendConfigDto) -> Result<Vec<ModelRefDto>, String> {
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
    // Pins change the display group, never the catalog order. Iterating the catalog
    // also restores an unpinned model's place independently of pin activation order.
    for entry in &catalog.models {
        let model = ModelRefDto {
            provider: entry.model.provider.to_string(),
            model: entry.model.model.to_string(),
        };
        let preference = format!("{}/{}", model.provider, model.model);
        let pinned = pins.contains(&model);
        let id = ListSelectionItemId::new(&preference);
        let supported_efforts = entry
            .supported_reasoning_efforts
            .iter()
            .copied()
            .filter(|effort| *effort != ReasoningEffort::None)
            .collect::<Vec<_>>();
        let effort = (config.model.as_ref() == Some(&model))
            .then_some(config.model_reasoning_effort)
            .flatten()
            .and_then(|effort| {
                if effort == ReasoningEffort::None {
                    supported_efforts.first().copied()
                } else {
                    supported_efforts.contains(&effort).then_some(effort)
                }
            });
        let default_effort = entry
            .model_reasoning_effort
            .filter(|effort| supported_efforts.contains(effort))
            .or_else(|| supported_efforts.first().copied());
        let provider = config.providers.get(&model.provider);
        let fast = (entry.capabilities.fast_mode == ash_protocol::CapabilitySupport::Supported)
            .then(|| provider.is_some_and(|config| config.fast_models.contains(&model.model)));
        let context = entry
            .maximum_context_window
            .filter(|window| *window >= 1_000_000)
            .and(entry.context_window);
        actions.insert(
            id.clone(),
            ModelSelectionAction::Select {
                preference,
                pinned,
                effort,
                default_effort,
                supported_efforts: supported_efforts.clone(),
                revision: config.revision,
                fast,
                context,
            },
        );
        let mut item = ListSelectionItem::new(entry.display_name.clone()).with_id(id);
        if !supported_efforts.is_empty() {
            let value = effort_display(&supported_efforts, effort.or(default_effort));
            item = item.with_segmented_value(value);
        }
        item = match fast {
            Some(enabled) => {
                item.with_control("fast", if enabled { "Fast on" } else { "Fast off" })
            }
            None => item,
        };
        item = match context {
            Some(window) => item.with_control(
                "context",
                match window {
                    272_000 => "272k".into(),
                    1_000_000.. => "1m".into(),
                    window => format!("{}k", window / 1000),
                },
            ),
            None => item,
        };
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
    let initial_selected = config.model.as_ref().and_then(|selected| {
        let preference = format!("{}/{}", selected.provider, selected.model);
        items
            .iter()
            .position(|item| item.id() == Some(&ListSelectionItemId::new(&preference)))
    });
    let mut model = ListSelectionModel::new("Model", vec![ListSelectionGroup::new("Model", items)])
        .without_tab_bar()
        .with_initial_selected(initial_selected.unwrap_or(0));
    if has_models {
        model = model
            .with_activation(bindings::MODEL_APPLY)
            .with_search(SearchBoxModel::new("Search models"));
    } else {
        model = model.with_empty_message("No configured models · Configure a provider in /config");
    }
    Ok(ModelChoices { model, actions })
}

#[cfg(test)]
#[path = "picker_tests.rs"]
mod tests;

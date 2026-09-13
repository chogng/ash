mod picker;
mod request;

/// A completed model operation delivered to the TUI state owner.
pub(crate) enum Event {
    SummaryReceived(ModelSummary),
    PickerOpened(ModelChoices),
    PickerUpdated(ModelChoices),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum Command {
    SetModel { preference: String },
    Pin { preference: String, pinned: bool },
}

use ash_app_server_protocol::protocol::config::ModelRefDto;
use ash_app_server_protocol::protocol::model::ModelListResult;
use ash_protocol::ModelAccess;
use ash_protocol::ReasoningEffort;

pub(crate) use picker::ModelChoices;
pub(crate) use picker::ModelSelectionAction;
pub(crate) use picker::model_choices;
pub(crate) use request::ModelUpdate;
pub(crate) use request::execute;
pub(crate) use request::load_selection;
pub(crate) use request::remove_provider_pins;
pub(crate) use request::set_model;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ModelSummary {
    model: Option<ModelRefDto>,
    display_name: Option<String>,
    model_reasoning_effort: Option<ReasoningEffort>,
    access: ModelAccess,
    context_capacity: Option<u64>,
}

impl ModelSummary {
    pub(crate) fn from_catalog(
        model: Option<ModelRefDto>,
        model_reasoning_effort: Option<ReasoningEffort>,
        catalog: Option<&ModelListResult>,
    ) -> Self {
        let entry = model.as_ref().and_then(|selected| {
            catalog.and_then(|catalog| {
                catalog.models.iter().find(|entry| {
                    entry.model.provider.as_str() == selected.provider
                        && entry.model.model.as_str() == selected.model
                })
            })
        });
        let (display_name, model_reasoning_effort, access, context_capacity) = match entry {
            Some(entry) => (
                Some(entry.display_name.clone()),
                model_reasoning_effort.or(entry.model_reasoning_effort),
                entry.access,
                entry.available_context_window.map(u64::from),
            ),
            None => (None, model_reasoning_effort, ModelAccess::Unknown, None),
        };
        Self {
            model,
            display_name,
            model_reasoning_effort,
            access,
            context_capacity,
        }
    }

    pub(crate) fn model(&self) -> Option<&ModelRefDto> {
        self.model.as_ref()
    }

    pub(crate) const fn model_reasoning_effort(&self) -> Option<ReasoningEffort> {
        self.model_reasoning_effort
    }

    pub(crate) const fn context_capacity(&self) -> Option<u64> {
        self.context_capacity
    }

    pub(crate) fn model_label(&self) -> String {
        self.model
            .as_ref()
            .map(|model| format!("{}/{}", model.provider, model.model))
            .unwrap_or_else(|| "Automatic model".into())
    }

    pub(crate) fn model_and_effort_label(&self) -> String {
        let model = self
            .display_name
            .as_deref()
            .or_else(|| self.model.as_ref().map(|model| model.model.as_str()))
            .unwrap_or("Automatic model");
        match self.model_reasoning_effort {
            Some(effort) => format!("{model} ({})", reasoning_effort_label(effort)),
            None => model.into(),
        }
    }

    pub(crate) const fn access(&self) -> ModelAccess {
        self.access
    }
}

const fn reasoning_effort_label(effort: ReasoningEffort) -> &'static str {
    match effort {
        ReasoningEffort::None => "none",
        ReasoningEffort::Minimal => "minimal",
        ReasoningEffort::Low => "low",
        ReasoningEffort::Medium => "medium",
        ReasoningEffort::High => "high",
        ReasoningEffort::ExtraHigh => "extra high",
        ReasoningEffort::Max => "max",
    }
}

pub(crate) const fn access_label(access: ModelAccess) -> &'static str {
    match access {
        ModelAccess::ApiKey => "API usage billing",
        ModelAccess::Subscription => "Subscription",
        ModelAccess::Local => "Local",
        ModelAccess::Enterprise => "Enterprise",
        ModelAccess::Unknown => "Access unknown",
    }
}

#[cfg(test)]
#[path = "models_tests.rs"]
mod tests;

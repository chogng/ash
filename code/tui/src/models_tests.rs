use super::ModelSummary;
use super::access_label;
use ash_app_server_protocol::protocol::config::ModelRefDto;
use ash_app_server_protocol::protocol::model::ModelCatalogEntry;
use ash_app_server_protocol::protocol::model::ModelListResult;
use ash_protocol::ModelAccess;
use ash_protocol::ModelCapabilities;
use ash_protocol::ModelId;
use ash_protocol::ModelOutputTransport;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;
use ash_protocol::ReasoningEffort;

#[test]
fn model_summary_resolves_the_selected_models_access_path() {
    let model = ModelRefDto {
        provider: "openai".into(),
        model: "gpt-5.6".into(),
    };
    let mut selected = entry("openai", "gpt-5.6", ModelAccess::Subscription);
    selected.display_name = "GPT-5.6".into();
    selected.model_reasoning_effort = Some(ReasoningEffort::High);
    let catalog = ModelListResult {
        models: vec![selected],
    };

    let summary = ModelSummary::from_catalog(Some(model), None, Some(&catalog));

    assert_eq!(summary.model_label(), "openai/gpt-5.6");
    assert_eq!(summary.model_and_effort_label(), "GPT-5.6 (high)");
    assert_eq!(summary.access(), ModelAccess::Subscription);
    assert_eq!(access_label(summary.access()), "Subscription");
}

#[test]
fn missing_or_automatic_models_are_reported_without_guessing_access() {
    let configured = ModelSummary::from_catalog(
        Some(ModelRefDto {
            provider: "custom".into(),
            model: "unknown".into(),
        }),
        None,
        None,
    );
    let automatic = ModelSummary::from_catalog(None, None, None);

    assert_eq!(configured.access(), ModelAccess::Unknown);
    assert_eq!(access_label(configured.access()), "Access unknown");
    assert_eq!(automatic.model_label(), "Automatic model");
    assert_eq!(configured.model_and_effort_label(), "unknown");
    assert_eq!(automatic.model_and_effort_label(), "Automatic model");
}

#[test]
fn model_reasoning_effort_overrides_catalog_value() {
    let model = ModelRefDto {
        provider: "openai".into(),
        model: "gpt-5.6".into(),
    };
    let mut selected = entry("openai", "gpt-5.6", ModelAccess::Subscription);
    selected.display_name = "GPT-5.6".into();
    selected.model_reasoning_effort = Some(ReasoningEffort::Medium);
    let catalog = ModelListResult {
        models: vec![selected],
    };

    let summary =
        ModelSummary::from_catalog(Some(model), Some(ReasoningEffort::High), Some(&catalog));

    assert_eq!(summary.model_and_effort_label(), "GPT-5.6 (high)");
    assert_eq!(
        summary.model_reasoning_effort(),
        Some(ReasoningEffort::High)
    );
}

fn entry(provider: &str, model: &str, access: ModelAccess) -> ModelCatalogEntry {
    ModelCatalogEntry {
        model: ModelRef::new(
            ProviderId::new(provider).unwrap(),
            ModelId::new(model).unwrap(),
        ),
        display_name: model.into(),
        access,
        output_transport: ModelOutputTransport::Unary,
        context_window: None,
        auto_compact_token_limit: None,
        available_context_window: None,
        capabilities: ModelCapabilities::UNKNOWN,
        supported_reasoning_efforts: Vec::new(),
        model_reasoning_effort: None,
        default_personality: None,
    }
}

#[test]
fn context_capacity_comes_only_from_the_matching_catalog_entry() {
    let mut selected = entry("provider", "model", ModelAccess::ApiKey);
    selected.available_context_window = Some(90_000);
    let catalog = ModelListResult {
        models: vec![selected],
    };
    let summary = ModelSummary::from_catalog(
        Some(ModelRefDto {
            provider: "provider".into(),
            model: "model".into(),
        }),
        None,
        Some(&catalog),
    );
    assert_eq!(summary.context_capacity(), Some(90_000));
    let other = ModelSummary::from_catalog(
        Some(ModelRefDto {
            provider: "provider".into(),
            model: "other".into(),
        }),
        None,
        Some(&catalog),
    );
    assert_eq!(other.context_capacity(), None);
}

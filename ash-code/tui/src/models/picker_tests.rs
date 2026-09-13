use super::ModelSelectionAction;
use super::model_choices;
use crate::widgets::list_selection::ListSelectionState;
use ash_app_server_protocol::protocol::config::ModelRefDto;
use ash_app_server_protocol::protocol::model::ModelCatalogEntry;
use ash_app_server_protocol::protocol::model::ModelListResult;
use ash_protocol::ModelAccess;
use ash_protocol::ModelCapabilities;
use ash_protocol::ModelId;
use ash_protocol::ModelOutputTransport;
use ash_protocol::ModelRef;
use ash_protocol::ProviderId;

#[test]
fn model_picker_shows_names_only_and_keeps_selection_identity_and_pin_state() {
    let catalog = ModelListResult {
        models: vec![ModelCatalogEntry {
            model: ModelRef::new(
                ProviderId::new("openai").unwrap(),
                ModelId::new("gpt-ash").unwrap(),
            ),
            display_name: "GPT Ash".into(),
            access: ModelAccess::Unknown,
            output_transport: ModelOutputTransport::Unary,
            context_window: None,
            auto_compact_token_limit: None,
            available_context_window: None,
            capabilities: ModelCapabilities::UNKNOWN,
            supported_reasoning_efforts: Vec::new(),
            model_reasoning_effort: None,
            default_personality: None,
        }],
    };
    let model = ModelRefDto {
        provider: "openai".into(),
        model: "gpt-ash".into(),
    };

    let mut config = crate::test_support::empty_config_snapshot();
    config.model = Some(model.clone());
    config
        .tui
        .0
        .insert("pinnedModels".into(), serde_json::json!([model]));
    let view = model_choices(
        &catalog,
        &config,
        &ash_app_server_protocol::protocol::provider::ProviderListResult { providers: vec![] },
    )
    .unwrap();
    let state = ListSelectionState::new(view.model);

    assert_eq!(state.title(), "Model");
    assert!(state.search().is_none());
    assert_eq!(state.visible_items()[0].label(), "GPT Ash");
    assert_eq!(state.visible_items()[0].description(), None);
    assert_eq!(state.selected_visible_index(), Some(0));
    assert!(view.actions.values().any(|action| {
        action
            == &ModelSelectionAction::Select {
                preference: "openai/gpt-ash".into(),
                pinned: true,
            }
    }));
}

#[test]
fn malformed_or_duplicate_pins_are_rejected() {
    let mut tui = ash_app_server_protocol::protocol::config::FrontendConfigDto::default();
    for value in [
        serde_json::json!("bad"),
        serde_json::json!([{"provider":"openai","model":"gpt-x"},{"provider":"openai","model":"gpt-x"}]),
    ] {
        tui.0.insert("pinnedModels".into(), value);
        assert!(super::pinned_models(&tui).is_err());
    }
}

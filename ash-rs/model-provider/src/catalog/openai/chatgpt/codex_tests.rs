use super::super::normalize_models;
use super::*;
use ash_models_manager::CatalogSourceErrorKind;
use ash_protocol::{ModelAccess, ReasoningEffort};

#[test]
fn codex_model_list_becomes_subscription_metadata_without_hidden_entries() {
    let models: Vec<CodexModel> = serde_json::from_value(serde_json::json!([
        {
            "id":"gpt-visible", "displayName":"GPT Visible", "description":"Model overview", "hidden":false,
            "defaultReasoningEffort":"medium",
            "supportedReasoningEfforts":[{"reasoningEffort":"low","description":"Quick tasks"},{"reasoningEffort":"medium","description":"Everyday tasks"}],
            "serviceTiers":[{"id":"priority","name":"Fast","description":"Increased usage"}],
            "defaultServiceTier":"priority"
        },
        {"id":"gpt-hidden", "displayName":"GPT Hidden", "hidden":true,
         "defaultReasoningEffort":"low", "supportedReasoningEfforts":[]}
    ]))
    .unwrap();
    let models = normalize_models(
        models
            .into_iter()
            .map(CodexModel::into_catalog_entry)
            .collect(),
    )
    .unwrap();
    assert_eq!(models.len(), 1);
    assert_eq!(models[0].id.as_str(), "gpt-visible");
    assert_eq!(models[0].metadata.access, Some(ModelAccess::Subscription));
    assert_eq!(
        models[0].metadata.description.as_deref(),
        Some("Model overview")
    );
    let efforts = models[0]
        .metadata
        .supported_reasoning_efforts
        .as_ref()
        .unwrap();
    assert_eq!(efforts[0].description.as_deref(), Some("Quick tasks"));
    assert_eq!(efforts[1].description.as_deref(), Some("Everyday tasks"));
    assert_eq!(
        models[0].metadata.settings.service_tiers.as_ref().unwrap()[0].name,
        "Fast"
    );
    assert_eq!(
        models[0].metadata.settings.default_service_tier.as_deref(),
        Some("priority")
    );
    assert_eq!(
        models[0].metadata.display_name.as_deref(),
        Some("GPT Visible")
    );
    assert_eq!(
        models[0]
            .metadata
            .supported_reasoning_efforts
            .as_ref()
            .unwrap()
            .len(),
        2
    );
}

#[test]
fn empty_chatgpt_catalog_is_rejected() {
    let error = normalize_models(Vec::new()).unwrap_err();
    assert_eq!(error.kind(), CatalogSourceErrorKind::InvalidPayload);
}

#[test]
fn codex_ultra_is_not_imported_as_model_reasoning_or_a_default() {
    let models: Vec<CodexModel> = serde_json::from_value(serde_json::json!([
        {
            "id": "gpt-cooperation", "displayName": "GPT Cooperation", "hidden": false,
            "defaultReasoningEffort": "ultra",
            "supportedReasoningEfforts": [
                {"reasoningEffort": "low"}, {"reasoningEffort": "high"},
                {"reasoningEffort": "max"}, {"reasoningEffort": "ultra"}
            ]
        }
    ]))
    .unwrap();
    let imported = normalize_models(
        models
            .into_iter()
            .map(CodexModel::into_catalog_entry)
            .collect(),
    )
    .unwrap();
    assert_eq!(
        imported[0]
            .metadata
            .supported_reasoning_efforts
            .as_ref()
            .map(|options| options
                .iter()
                .map(|option| option.effort)
                .collect::<Vec<_>>()),
        Some(vec![
            ReasoningEffort::Low,
            ReasoningEffort::High,
            ReasoningEffort::Max
        ])
    );
    assert_eq!(imported[0].metadata.default_reasoning_effort, None);
}

#[test]
fn chatgpt_catalog_uses_codex_priority_and_preserves_equal_priority_order() {
    let entries: Vec<super::super::CatalogEntry> = serde_json::from_value(serde_json::json!([
        {"slug":"gpt-5.6-sol","visibility":"list","priority":4},
        {"slug":"gpt-6-sol","visibility":"list","priority":2},
        {"slug":"gpt-6-astra","visibility":"list","priority":1},
        {"slug":"gpt-6-luna","visibility":"list","priority":2}
    ]))
    .unwrap();
    let models = normalize_models(entries).unwrap();
    assert_eq!(
        models
            .iter()
            .map(|model| model.id.as_str())
            .collect::<Vec<_>>(),
        ["gpt-6-astra", "gpt-6-sol", "gpt-6-luna", "gpt-5.6-sol"]
    );
}

#[test]
fn remote_model_catalog_imports_request_defaults_and_capabilities() {
    let entries = serde_json::from_value(serde_json::json!([{
        "slug":"gpt-settings", "visibility":"list", "context_window":272000, "max_context_window":872000,
        "input_modalities":["text","image"], "supports_parallel_tool_calls":false,
        "supports_image_detail_original":true, "support_verbosity":true, "default_verbosity":"low",
        "supports_reasoning_summary_parameter":true, "default_reasoning_summary":"none",
        "truncation_policy":{"mode":"tokens","limit":10000}
    }])).unwrap();
    let imported = normalize_models(entries).unwrap();
    let info = &imported[0].metadata;
    assert_eq!(
        info.context_window,
        Some(ash_protocol::ContextWindow::Known(872000))
    );
    assert_eq!(
        info.capabilities.parallel_tool_calls,
        Some(ash_protocol::CapabilitySupport::Unsupported)
    );
    assert_eq!(
        info.capabilities.image_detail_original,
        Some(ash_protocol::CapabilitySupport::Supported)
    );
    assert_eq!(
        info.settings.default_verbosity,
        Some(ash_protocol::ModelVerbosity::Low)
    );
    assert_eq!(
        info.settings.tool_output_limit,
        Some(ash_protocol::ModelToolOutputLimit::Tokens(10000))
    );
}

#[test]
fn a_catalog_with_only_ultrafast_does_not_require_a_priority_tier() {
    let model: CodexModel = serde_json::from_value(serde_json::json!({
        "id":"tier-fixture", "displayName":"Tier fixture", "hidden":false, "supportedReasoningEfforts":[],
        "serviceTiers":[
            {"id":"default", "name":"Standard", "description":"Default processing"},
            {"id":"ultrafast", "name":"Ultra Fast", "description":"Fastest processing"}
        ], "defaultServiceTier":"default"
    }))
    .unwrap();
    let models = normalize_models(vec![model.into_catalog_entry()]).unwrap();
    assert_eq!(
        models[0].metadata.capabilities.fast_mode,
        Some(ash_protocol::CapabilitySupport::Supported)
    );
    assert_eq!(
        models[0].metadata.settings.acceleration_options(),
        vec![ash_protocol::ModelAccelerationOption {
            id: "ultrafast".into(),
            name: "Ultra Fast".into(),
            description: "Fastest processing".into(),
        }]
    );
}

use super::super::normalize_models;
use super::*;
use ash_models_manager::CatalogSourceErrorKind;
use ash_protocol::ModelAccess;

#[test]
fn codex_model_list_becomes_subscription_metadata_without_hidden_entries() {
    let models: Vec<CodexModel> = serde_json::from_value(serde_json::json!([
        {
            "id":"gpt-visible", "displayName":"GPT Visible", "hidden":false,
            "defaultReasoningEffort":"medium",
            "supportedReasoningEfforts":[{"reasoningEffort":"low"},{"reasoningEffort":"medium"}]
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

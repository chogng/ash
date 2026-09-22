use super::*;
use serde_json::json;

#[test]
fn catalog_uses_request_model_identity_and_only_advertises_visible_responses_models() {
    let models = parse_models(json!({"data": [
        {"id":"display-key","model":"grok-entitled","name":"Grok","apiBackend":"responses","_meta":{"contextWindow":500000,"reasoningEfforts":[{"value":"xhigh"},{"value":"high"}],"reasoningEffort":"high"},"baseUrl":"https://untrusted.example"},
        {"id":"hidden","apiBackend":"responses","hidden":true},
        {"id":"legacy","apiBackend":"chat_completions"}
    ]})).unwrap();
    assert_eq!(
        models,
        vec![CatalogModel {
            id: "grok-entitled".into(),
            name: Some("Grok".into()),
            context_window: Some(500000),
            reasoning_efforts: vec!["xhigh".into(), "high".into()],
            reasoning_effort: Some("high".into())
        }]
    );
    assert!(parse_models(json!({"models":[]})).is_err());
    assert!(parse_models(json!({"data":[{"apiBackend":"responses"}]})).is_err());
}

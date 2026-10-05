use super::*;
use serde_json::json;

fn row() -> serde_json::Value {
    serde_json::from_str::<serde_json::Value>(include_str!("../models.json")).unwrap()["models"][0]
        .clone()
}

#[test]
fn malformed_registered_models_fail_at_the_json_boundary() {
    for (field, invalid) in [
        ("provider_id", json!("")),
        ("model_id", json!("")),
        ("display_name", json!(" ")),
        ("context_window", json!(0)),
        ("default_context_window", json!(0)),
        ("default_context_window", json!(1_050_001)),
        ("default_context_window", json!(null)),
        ("context_window_options", json!([])),
        ("context_window_options", json!([272000, 0])),
        ("context_window_options", json!([272000, 1_050_001])),
        ("context_window_options", json!([1_000_000, 272000])),
        ("context_window_options", json!([272000, 272000])),
        ("context_window_options", json!([1_000_000])),
        ("context_window_options", json!([272000, 400000, 1000000])),
        ("auto_compact_token_limit", json!(0)),
        ("model_reasoning_effort", json!("minimal")),
        ("instructions", json!({"revision":"v1", "body":" "})),
        ("instructions", json!({"revision":" ", "body":"base"})),
        (
            "instructions",
            json!({"revision":"v1", "body":"x".repeat(65537)}),
        ),
    ] {
        let mut model = row();
        model[field] = invalid;
        assert!(
            parse_catalog(&json!({"models":[model]}).to_string()).is_err(),
            "{field}"
        );
    }
    let mut missing = row();
    missing.as_object_mut().unwrap().remove("instructions");
    assert!(parse_catalog(&json!({"models":[missing]}).to_string()).is_err());
    let mut typo = row();
    typo["instruction"] = json!("wrong field");
    assert!(parse_catalog(&json!({"models":[typo]}).to_string()).is_err());
    assert!(parse_catalog("{").is_err());
}

#[test]
fn duplicate_identities_fail_and_unknown_metadata_stays_unknown() {
    let model = row();
    assert!(parse_catalog(&json!({"models":[model, model]}).to_string()).is_err());
    let mut model = row();
    model["context_window"] = serde_json::Value::Null;
    model["default_context_window"] = serde_json::Value::Null;
    model["context_window_options"] = json!([]);
    let parsed = parse_catalog(&json!({"models":[model]}).to_string()).unwrap();
    assert_eq!(
        parsed[0].context_window,
        ash_protocol::ContextWindow::Unknown
    );
}

#[test]
fn context_preferences_are_explicit_data_independent_of_the_model_name() {
    for name in ["gpt-independent", "plain-model"] {
        let mut model = row();
        model["model_id"] = json!(name);
        model["context_window"] = json!(300000);
        model["default_context_window"] = json!(80000);
        model["context_window_options"] = json!([80000, 160000]);
        let parsed = parse_catalog(&json!({"models":[model]}).to_string()).unwrap();
        assert_eq!(
            parsed[0].default_context_window,
            ash_protocol::ContextWindow::Known(80000)
        );
        assert_eq!(parsed[0].context_window_options, [80000, 160000]);
        assert_eq!(
            parsed[0].model().context_window,
            ash_protocol::ContextWindow::Known(300000)
        );
    }
}

#[test]
fn editing_one_models_base_prompt_keeps_other_entries_independent() {
    let first = row();
    let mut second = first.clone();
    second["model_id"] = json!("different-model");
    second["instructions"] = json!({"revision":"v2", "body":"Independent model prompt"});
    let parsed = parse_catalog(&json!({"models":[first, second]}).to_string()).unwrap();
    assert_ne!(parsed[0].instructions.body, parsed[1].instructions.body);
    assert_eq!(parsed[0].instructions.revision, "model-base-v1");
    assert_eq!(parsed[1].instructions.revision, "v2");
}

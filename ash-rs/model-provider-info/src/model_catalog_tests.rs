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
        ("description", json!(" ")),
        ("supported_reasoning_efforts", json!(["low", "medium"])),
        (
            "supported_reasoning_efforts",
            json!([{"effort":"low","description":" "}]),
        ),
        (
            "supported_reasoning_efforts",
            json!([{"effort":"low"},{"effort":"low","description":"Other copy"}]),
        ),
        ("context_window", json!(0)),
        ("context_window_options", json!([272000, 0])),
        ("context_window_options", json!([272000, 1_050_001])),
        ("context_window_options", json!([1_000_000, 272000])),
        ("context_window_options", json!([272000, 272000])),
        ("context_window_options", json!([272000, 400000, 1000000])),
        ("auto_compact_token_limit", json!(0)),
        ("default_context_window", json!(272000)),
        ("default_personality", json!(null)),
        ("capabilities", json!({"personality":true})),
        ("capabilities", json!({"fast_mode":true})),
        ("capabilities", json!({"tools":"invalid"})),
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
fn editable_catalog_schema_matches_its_generated_file_and_wire_defaults() {
    let generated = serde_json::to_value(model_catalog_schema()).unwrap();
    let committed: serde_json::Value =
        serde_json::from_str(include_str!("../models.schema.json")).unwrap();
    assert_eq!(generated, committed);
    let fields = &generated["$defs"]["StaticModelSpec"]["properties"];
    for name in ["context_window", "capabilities", "settings"] {
        assert!(fields[name].get("default").is_none(), "{name}");
    }
    assert_eq!(
        generated["$defs"]["ModelCapabilitiesDeclaration"]["properties"]["tools"]["type"],
        json!(["boolean", "null"])
    );
}

#[test]
fn duplicate_identities_fail_and_unknown_metadata_stays_unknown() {
    let model = row();
    assert!(parse_catalog(&json!({"models":[model, model]}).to_string()).is_err());
    let mut model = row();
    model.as_object_mut().unwrap().remove("context_window");
    assert!(parse_catalog(&json!({"models":[model.clone()]}).to_string()).is_err());
    model
        .as_object_mut()
        .unwrap()
        .remove("context_window_options");
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
        model["context_window_options"] = json!([80000, 160000]);
        let parsed = parse_catalog(&json!({"models":[model]}).to_string()).unwrap();
        assert_eq!(parsed[0].context_window_options, [80000, 160000]);
        assert_eq!(
            parsed[0].model().context_window,
            ash_protocol::ContextWindow::Known(300000)
        );
    }
}

#[test]
fn sparse_declarations_preserve_unknowns_and_known_capacity_without_presets() {
    let minimal = json!({
        "provider_id":"example", "model_id":"plain-model", "display_name":"Plain Model",
        "instructions":{"revision":"v1", "body":"Independent base instructions"}
    });
    let parsed = parse_catalog(&json!({"models":[minimal.clone()]}).to_string()).unwrap();
    let spec = &parsed[0];
    assert_eq!(spec.context_window, ash_protocol::ContextWindow::Unknown);
    assert!(spec.context_window_options.is_empty());
    assert_eq!(spec.capabilities, ash_protocol::ModelCapabilities::UNKNOWN);
    assert!(spec.supported_reasoning_efforts.is_empty());
    assert_eq!(spec.model_reasoning_effort, None);
    assert_eq!(spec.auto_compact_token_limit, None);

    let mut fixed = minimal;
    fixed["context_window"] = json!(300000);
    fixed["capabilities"] = json!({"tools":false, "imageDetailOriginal":true});
    fixed["auto_compact_token_limit"] = json!(160000);
    let parsed = parse_catalog(&json!({"models":[fixed]}).to_string()).unwrap();
    let spec = &parsed[0];
    assert_eq!(spec.context_window_options, [300000]);
    assert_eq!(
        spec.capabilities.tools,
        ash_protocol::CapabilitySupport::Unsupported
    );
    assert_eq!(
        spec.capabilities.image_detail_original,
        ash_protocol::CapabilitySupport::Supported
    );
    assert_eq!(
        spec.capabilities.reasoning,
        ash_protocol::CapabilitySupport::Unknown
    );
    assert_eq!(spec.auto_compact_token_limit, Some(160000));
}

#[test]
fn editing_one_models_base_prompt_keeps_other_entries_independent() {
    let first = row();
    let mut second = first.clone();
    second["model_id"] = json!("different-model");
    second["instructions"] = json!({"revision":"v2", "body":"Independent model prompt"});
    let parsed = parse_catalog(&json!({"models":[first, second]}).to_string()).unwrap();
    assert_ne!(parsed[0].instructions.body, parsed[1].instructions.body);
    assert_eq!(parsed[0].instructions.revision, "model-base-v2");
    assert_eq!(parsed[1].instructions.revision, "v2");
}

#[test]
fn invalid_request_defaults_fail_before_catalog_publication() {
    for settings in [
        json!({"inputModalities":[]}),
        json!({"inputModalities":["image"]}),
        json!({"inputModalities":["text","text"]}),
        json!({"defaultVerbosity":"low"}),
        json!({"verbosity":false,"defaultVerbosity":"low"}),
        json!({"verbosity":null,"defaultVerbosity":"low"}),
        json!({"defaultReasoningSummary":"auto"}),
        json!({"reasoningSummary":false,"defaultReasoningSummary":"auto"}),
        json!({"reasoningSummary":null,"defaultReasoningSummary":"auto"}),
        json!({"serviceTiers":[{"id":"default","name":"Standard","description":"Standard processing"}],"defaultServiceTier":"priority"}),
        json!({"serviceTiers":[{"id":"default","name":"Standard","description":"One"},{"id":"default","name":"Other name","description":"Two"}]}),
        json!({"serviceTiers":[{"id":"","name":"Fast","description":"Fast processing"}]}),
        json!({"serviceTiers":[{"id":"priority","name":"","description":"Fast processing"}]}),
        json!({"serviceTiers":[{"id":"priority","name":"Fast","description":""}]}),
        json!({"acceleration":{"type":"serviceTier","serviceTier":"priority"}}),
        json!({"acceleration":{"type":"speed","speed":"fast","name":"Fast","description":""}}),
        json!({"acceleration":{"type":"model","model":"","name":"Fast","description":"Faster model"}}),
        json!({"toolOutputLimit":{"mode":"tokens","limit":0}}),
        json!({"toolOutputLimit":{"mode":"words","limit":100}}),
        json!({"defautVerbosity":"low"}),
    ] {
        let mut model = row();
        model["settings"] = settings.clone();
        assert!(
            parse_catalog(&json!({"models":[model]}).to_string()).is_err(),
            "{settings}"
        );
    }
}

#[test]
fn nullable_boolean_capabilities_reach_runtime_metadata_without_losing_unknowns() {
    use ash_protocol::CapabilitySupport;

    for (value, expected) in [
        (json!(true), CapabilitySupport::Supported),
        (json!(false), CapabilitySupport::Unsupported),
        (json!(null), CapabilitySupport::Unknown),
    ] {
        let mut model = row();
        model["capabilities"] = json!({
            "tools":value, "reasoning":value, "parallelToolCalls":value,
            "imageDetailOriginal":value, "fastMode":value
        });
        model["settings"] = json!({"verbosity":value, "reasoningSummary":value});
        let parsed = parse_catalog(&json!({"models":[model]}).to_string()).unwrap();
        let model = parsed[0].model();
        assert_eq!(model.capabilities.tools, expected);
        assert_eq!(model.capabilities.reasoning, expected);
        assert_eq!(model.capabilities.parallel_tool_calls, expected);
        assert_eq!(model.capabilities.image_detail_original, expected);
        assert_eq!(model.capabilities.fast_mode, expected);
        assert_eq!(model.capabilities.personality, CapabilitySupport::Unknown);
        assert_eq!(model.settings.verbosity, expected);
        assert_eq!(model.settings.reasoning_summary, expected);
    }

    let mut model = row();
    model["capabilities"] = json!({});
    model["settings"] = json!({});
    let parsed = parse_catalog(&json!({"models":[model]}).to_string()).unwrap();
    assert_eq!(
        parsed[0].capabilities,
        ash_protocol::ModelCapabilities::UNKNOWN
    );
    assert_eq!(parsed[0].settings, ash_protocol::ModelSettings::default());
}

#[test]
fn capability_declarations_reject_strings_and_other_non_boolean_values() {
    for value in [
        json!("supported"),
        json!("unsupported"),
        json!("unknown"),
        json!("true"),
        json!(0),
        json!(1),
        json!([]),
        json!({}),
    ] {
        for (group, fields) in [
            (
                "capabilities",
                &[
                    "tools",
                    "reasoning",
                    "parallelToolCalls",
                    "imageDetailOriginal",
                    "fastMode",
                ][..],
            ),
            ("settings", &["verbosity", "reasoningSummary"][..]),
        ] {
            for field in fields {
                let mut model = row();
                model[group] = json!({});
                model[group][field] = value.clone();
                assert!(
                    parse_catalog(&json!({"models":[model]}).to_string()).is_err(),
                    "{group}.{field} accepted {value}"
                );
            }
        }
    }
}

#[test]
fn catalog_settings_use_booleans_without_changing_the_runtime_contract() {
    let mut model = row();
    let mut settings = json!({
        "inputModalities":["text","image","audio"],
        "verbosity":true,
        "defaultVerbosity":"high",
        "reasoningSummary":true,
        "defaultReasoningSummary":"detailed",
        "serviceTiers":[{"id":"default","name":"Standard","description":"Standard processing"},{"id":"priority","name":"Fast","description":"Faster responses, increased usage"}],
        "acceleration":{"type":"serviceTier","serviceTier":"priority"},
        "defaultServiceTier":"priority",
        "toolOutputLimit":{"mode":"bytes","limit":4096}
    });
    model["settings"] = settings.clone();
    let parsed = parse_catalog(&json!({"models":[model]}).to_string()).unwrap();
    settings["verbosity"] = json!("supported");
    settings["reasoningSummary"] = json!("supported");
    let runtime_settings =
        serde_json::from_value::<ash_protocol::ModelSettings>(settings.clone()).unwrap();
    assert_eq!(parsed[0].model().settings, runtime_settings);
    assert_eq!(serde_json::to_value(&runtime_settings).unwrap(), settings);
}

#[test]
fn bundled_openai_settings_reach_runtime_model_metadata() {
    let spec = find_static_model(&ModelRef::new(
        ProviderId::new("openai").unwrap(),
        ModelId::new("gpt-6.1-sol").unwrap(),
    ))
    .unwrap();
    let model = spec.model();
    assert_eq!(
        model.settings.default_verbosity,
        Some(ash_protocol::ModelVerbosity::Low)
    );
    assert_eq!(
        model.capabilities.parallel_tool_calls,
        ash_protocol::CapabilitySupport::Supported
    );
    assert_eq!(
        model.capabilities.image_detail_original,
        ash_protocol::CapabilitySupport::Supported
    );
    assert!(
        spec.instructions
            .body
            .contains("## Handling context and output budgets")
    );
}

use super::*;
use serde_json::json;

fn row() -> serde_json::Value {
    serde_json::from_str::<serde_json::Value>(include_str!("../models/openai.json")).unwrap()["models"][0]
        .clone()
}

#[test]
fn provider_catalogs_preserve_source_and_model_order() {
    let first = row();
    let mut second = first.clone();
    second["model_id"] = json!("second-model");
    let mut third = first.clone();
    third["provider_id"] = json!("other");
    let openai = json!({"models":[second, first]}).to_string();
    let other = json!({"models":[third]}).to_string();
    let models = parse_catalogs(&[("other", &other), ("openai", &openai)]).unwrap();
    assert_eq!(
        models
            .iter()
            .map(|spec| (spec.provider_id.as_str(), spec.model_id.as_str()))
            .collect::<Vec<_>>(),
        [
            ("other", "gpt-6.1-sol"),
            ("openai", "second-model"),
            ("openai", "gpt-6.1-sol")
        ]
    );
}

#[test]
fn provider_catalog_errors_identify_the_source_and_model() {
    let model = row();
    let catalog = json!({"models":[model]}).to_string();
    let mismatch = parse_catalogs(&[("other", &catalog)])
        .unwrap_err()
        .to_string();
    assert!(mismatch.contains("models/other.json"), "{mismatch}");
    assert!(mismatch.contains("openai/gpt-6.1-sol"), "{mismatch}");
    assert!(
        mismatch.contains("must belong to provider other"),
        "{mismatch}"
    );

    let duplicate = parse_catalogs(&[("openai", &catalog), ("openai", &catalog)])
        .unwrap_err()
        .to_string();
    assert!(
        duplicate.contains("models/openai.json: duplicate model openai/gpt-6.1-sol"),
        "{duplicate}"
    );

    let mut invalid = row();
    invalid["context_window"] = json!(0);
    let invalid = json!({"models":[invalid]}).to_string();
    let error = parse_catalogs(&[("openai", &invalid)])
        .unwrap_err()
        .to_string();
    assert!(error.contains("models/openai.json"), "{error}");

    let mut invalid = row();
    invalid["display_name"] = json!(" ");
    let invalid = json!({"models":[invalid]}).to_string();
    let error = parse_catalogs(&[("openai", &invalid)])
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("models/openai.json: model openai/gpt-6.1-sol"),
        "{error}"
    );
    assert!(error.contains("model display name is empty"), "{error}");
}

#[test]
fn provider_catalogs_share_the_schema_relative_to_their_directory() {
    for schema in [
        "../models.schema.json",
        "./models.schema.json",
        "other.schema.json",
    ] {
        let catalog = json!({"$schema":schema, "models":[row()]}).to_string();
        assert_eq!(
            parse_catalog(&catalog).is_ok(),
            schema == "../models.schema.json",
            "{schema}"
        );
    }
    for &(provider, json) in &BUNDLED_CATALOGS {
        let catalog: serde_json::Value = serde_json::from_str(json).unwrap();
        assert_eq!(catalog["$schema"], "../models.schema.json", "{provider}");
    }
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
        ("max_context_window", json!(0)),
        ("max_context_window", json!(200_000)),
        ("auto_compact_token_limit", json!(0)),
        ("default_context_window", json!(272000)),
        ("default_personality", json!(null)),
        ("capabilities", json!({"personality":true})),
        ("capabilities", json!({"fastMode":true})),
        ("capabilities", json!({"tools":"invalid"})),
        ("default_reasoning_effort", json!("minimal")),
        ("model_reasoning_effort", json!("medium")),
        ("model_messages", json!({"system_instructions":" "})),
        ("model_messages", json!({})),
        ("model_messages", json!({"system_instructions":null})),
        (
            "model_messages",
            json!({"system_instructions":"base", "tools":{"spawn_agent":{"description":" "}}}),
        ),
        (
            "model_messages",
            json!({"system_instructions":"base", "tools":{"bad.name":{"description":"tool"}}}),
        ),
        (
            "model_messages",
            json!({"system_instructions":"base", "tools":{"spawn_agent":{"description":"tool", "parameters":{}}}}),
        ),
        (
            "model_messages",
            json!({"system_instructions":"base", "collaboration_modes":{"unsupported":"mode"}}),
        ),
        (
            "model_messages",
            json!({"system_instructions":"base", "collaboration_modes":{"plan":" "}}),
        ),
        (
            "model_messages",
            json!({"system_instructions":"base", "multi_agent":{"root":" "}}),
        ),
        (
            "model_messages",
            json!({"system_instructions":"base", "multi_agent":{"enabled":true}}),
        ),
        (
            "model_messages",
            json!({"system_instructions":"x".repeat(32768), "multi_agent":{"root":"x".repeat(32769)}}),
        ),
        (
            "model_messages",
            json!({"system_instructions":"base", "revision":"v1"}),
        ),
        ("instructions", json!({"revision":"v1", "body":"base"})),
        (
            "model_messages",
            json!({"system_instructions":"x".repeat(65537)}),
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
    missing.as_object_mut().unwrap().remove("model_messages");
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
    assert!(fields.get("default_reasoning_effort").is_some());
    assert!(fields.get("model_reasoning_effort").is_none());
    assert!(fields.get("instructions").is_none());
    assert_eq!(fields["model_messages"]["$ref"], "#/$defs/ModelMessages");
    assert_eq!(
        generated["$defs"]["ModelMessages"]["required"],
        json!(["system_instructions"])
    );
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
    model.as_object_mut().unwrap().remove("max_context_window");
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
        model["context_window"] = json!(80000);
        model["max_context_window"] = json!(300000);
        let parsed = parse_catalog(&json!({"models":[model]}).to_string()).unwrap();
        assert_eq!(parsed[0].context_window, ContextWindow::Known(80_000));
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
        "model_messages":{"system_instructions":"Independent base instructions"}
    });
    let parsed = parse_catalog(&json!({"models":[minimal.clone()]}).to_string()).unwrap();
    let spec = &parsed[0];
    assert_eq!(spec.context_window, ash_protocol::ContextWindow::Unknown);
    assert_eq!(spec.max_context_window, ContextWindow::Unknown);
    assert_eq!(spec.capabilities, ash_protocol::ModelCapabilities::UNKNOWN);
    assert!(spec.supported_reasoning_efforts.is_empty());
    assert_eq!(spec.default_reasoning_effort, None);
    assert_eq!(spec.auto_compact_token_limit, None);

    let mut fixed = minimal;
    fixed["context_window"] = json!(300000);
    fixed["capabilities"] = json!({"tools":false, "image_detail_original":true});
    fixed["auto_compact_token_limit"] = json!(160000);
    let parsed = parse_catalog(&json!({"models":[fixed]}).to_string()).unwrap();
    let spec = &parsed[0];
    assert_eq!(spec.max_context_window, ContextWindow::Unknown);
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
    second["model_messages"] = json!({"system_instructions":"Independent model prompt"});
    let parsed = parse_catalog(&json!({"models":[first, second]}).to_string()).unwrap();
    assert_ne!(
        parsed[0].model_messages.system_instructions,
        parsed[1].model_messages.system_instructions
    );
    assert_eq!(
        parsed[1].model_messages.system_instructions,
        "Independent model prompt"
    );
}

#[test]
fn invalid_request_defaults_fail_before_catalog_publication() {
    for settings in [
        json!({"input_modalities":[]}),
        json!({"input_modalities":["image"]}),
        json!({"input_modalities":["text","text"]}),
        json!({"default_verbosity":"low"}),
        json!({"verbosity":false,"default_verbosity":"low"}),
        json!({"verbosity":null,"default_verbosity":"low"}),
        json!({"default_reasoning_summary":"auto"}),
        json!({"reasoning_summary":false,"default_reasoning_summary":"auto"}),
        json!({"reasoning_summary":null,"default_reasoning_summary":"auto"}),
        json!({"service_tiers":[{"id":"default","name":"Standard","description":"Standard processing"}],"default_service_tier":"priority"}),
        json!({"service_tiers":[{"id":"default","name":"Standard","description":"One"},{"id":"default","name":"Other name","description":"Two"}]}),
        json!({"service_tiers":[{"id":"","name":"Fast","description":"Fast processing"}]}),
        json!({"service_tiers":[{"id":"priority","name":"","description":"Fast processing"}]}),
        json!({"service_tiers":[{"id":"priority","name":"Fast","description":""}]}),
        json!({"acceleration":{"type":"service_tier","service_tier":"priority"}}),
        json!({"acceleration":{"type":"speed","speed":"fast","name":"Fast","description":""}}),
        json!({"acceleration":{"type":"model","model":"","name":"Fast","description":"Faster model"}}),
        json!({"tool_output_limit":{"mode":"tokens","limit":0}}),
        json!({"tool_output_limit":{"mode":"words","limit":100}}),
        json!({"defaut_verbosity":"low"}),
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
            "tools":value, "reasoning":value, "parallel_tool_calls":value,
            "image_detail_original":value, "fast_mode":value
        });
        model["settings"] = json!({"verbosity":value, "reasoning_summary":value});
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
                    "parallel_tool_calls",
                    "image_detail_original",
                    "fast_mode",
                ][..],
            ),
            ("settings", &["verbosity", "reasoning_summary"][..]),
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
fn catalog_settings_preserve_snake_case_fields_in_runtime_metadata() {
    let mut model = row();
    model["settings"] = json!({
        "input_modalities":["text","image","audio"],
        "verbosity":true,
        "default_verbosity":"high",
        "reasoning_summary":true,
        "default_reasoning_summary":"detailed",
        "service_tiers":[{"id":"default","name":"Standard","description":"Standard processing"},{"id":"priority","name":"Fast","description":"Faster responses, increased usage"}],
        "acceleration":{"type":"service_tier","service_tier":"priority"},
        "default_service_tier":"priority",
        "tool_output_limit":{"mode":"bytes","limit":4096}
    });
    let parsed = parse_catalog(&json!({"models":[model]}).to_string()).unwrap();
    let settings = json!({
        "input_modalities":["text","image","audio"],
        "verbosity":"supported",
        "default_verbosity":"high",
        "reasoning_summary":"supported",
        "default_reasoning_summary":"detailed",
        "service_tiers":[{"id":"default","name":"Standard","description":"Standard processing"},{"id":"priority","name":"Fast","description":"Faster responses, increased usage"}],
        "acceleration":{"type":"service_tier","service_tier":"priority"},
        "default_service_tier":"priority",
        "tool_output_limit":{"mode":"bytes","limit":4096}
    });
    let runtime_settings =
        serde_json::from_value::<ash_protocol::ModelSettings>(settings.clone()).unwrap();
    assert_eq!(parsed[0].model().settings, runtime_settings);
    assert_eq!(serde_json::to_value(&runtime_settings).unwrap(), settings);
}

#[test]
fn camel_case_catalog_fields_and_acceleration_tags_are_rejected() {
    for (group, fields) in [
        (
            "capabilities",
            &["fastMode", "parallelToolCalls", "imageDetailOriginal"][..],
        ),
        (
            "settings",
            &[
                "inputModalities",
                "defaultVerbosity",
                "reasoningSummary",
                "defaultReasoningSummary",
                "serviceTiers",
                "defaultServiceTier",
                "toolOutputLimit",
            ][..],
        ),
    ] {
        for field in fields {
            let mut model = row();
            model[group][field] = json!(null);
            let error = parse_catalog(&json!({"models":[model]}).to_string()).unwrap_err();
            assert!(
                error.to_string().contains("unknown field"),
                "{group}.{field}: {error}"
            );
        }
    }
    for acceleration in [
        json!({"type":"serviceTier","serviceTier":"priority"}),
        json!({"type":"service_tier","serviceTier":"priority"}),
        json!({"type":"service_tier","service_tier":"priority","serviceTier":"priority"}),
    ] {
        let mut model = row();
        model["settings"]["acceleration"] = acceleration.clone();
        assert!(
            parse_catalog(&json!({"models":[model]}).to_string()).is_err(),
            "{acceleration}"
        );
    }
}

#[test]
fn speed_and_model_acceleration_declarations_reach_runtime_metadata() {
    for acceleration in [
        json!({"type":"speed","speed":"fast","name":"Fast","description":"Faster responses"}),
        json!({"type":"model","model":"highspeed-model","name":"Fast","description":"High-speed model"}),
    ] {
        let mut model = row();
        model["settings"]["acceleration"] = acceleration.clone();
        let parsed = parse_catalog(&json!({"models":[model]}).to_string()).unwrap();
        assert_eq!(
            serde_json::to_value(parsed[0].model().settings.acceleration.unwrap()).unwrap(),
            acceleration
        );
    }
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
        spec.model_messages
            .system_instructions
            .contains("## Handling context and output budgets")
    );
}

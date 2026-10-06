use super::*;
use crate::protocol::config::CustomProviderConfigDto;
use crate::protocol::config::CustomProviderProtocolDto;
use ts_rs::TS;

#[test]
fn custom_provider_order_uses_a_json_number_in_the_typescript_contract() {
    let config = CustomProviderConfigDto {
        model_aliases: Some(std::collections::BTreeMap::from([(
            "local-model".to_owned(),
            "wire-model".to_owned(),
        )])),
        context_window: 272_000,
        order: 1_790_906_000_000,
        model: None,
        name: "Private gateway".to_owned(),
        protocol: CustomProviderProtocolDto::ChatCompletions,
    };
    let value = serde_json::to_value(&config).unwrap();
    assert_eq!(value["order"], 1_790_906_000_000_u64);
    assert_eq!(
        value["modelAliases"],
        serde_json::json!({"local-model":"wire-model"})
    );
    assert_eq!(
        serde_json::from_value::<CustomProviderConfigDto>(value).unwrap(),
        config
    );
    assert!(CustomProviderConfigDto::decl(&ts_rs::Config::default()).contains("order: number"));
}

#[test]
fn fixed_catalog_request_does_not_accept_an_account_view() {
    assert!(serde_json::from_value::<ModelListParams>(serde_json::json!({})).is_ok());
    assert!(
        serde_json::from_value::<ModelListParams>(serde_json::json!({"view": "discovered"}))
            .is_err()
    );
}

#[test]
fn catalog_metadata_does_not_expose_an_execution_path() {
    let model = ash_protocol::ModelRef::new(
        ash_protocol::ProviderId::new("openai").unwrap(),
        ash_protocol::ModelId::new("model").unwrap(),
    );
    let mut info = ash_protocol::ModelInfo::new(model.model.clone(), "Model");
    info.context_window = ash_protocol::ContextWindow::Known(1_000_000);
    let mut entry = ModelCatalogEntry::from_info(model, &info);
    let fixed = serde_json::to_value(&entry).unwrap();
    assert!(fixed.get("discovered").is_none());
    entry.discovered = Some(true);
    let value = serde_json::to_value(&entry).unwrap();
    assert_eq!(value["discovered"], true);
    assert_eq!(
        serde_json::from_value::<ModelCatalogEntry>(value.clone()).unwrap(),
        entry
    );
    assert_eq!(value["context_window"], 1_000_000);
    assert!(value.get("access").is_none());
    assert!(value.get("outputTransport").is_none());
}

#[test]
fn catalog_exposes_fast_support_and_the_declared_context_ceiling() {
    let model = ModelRef::new(
        ash_protocol::ProviderId::new("openai").unwrap(),
        ash_protocol::ModelId::new("gpt-6-astra").unwrap(),
    );
    let mut info = ModelInfo::new(model.model.clone(), "GPT-6 Astra");
    info.context_window = ContextWindow::Known(872_000);
    info.capabilities.fast_mode = ash_protocol::CapabilitySupport::Supported;
    let entry = ModelCatalogEntry::from_info(model, &info);
    let value = serde_json::to_value(&entry).unwrap();
    assert_eq!(value["maximum_context_window"], 872_000);
    assert_eq!(value["capabilities"]["fast_mode"], "supported");
    assert_eq!(
        serde_json::from_value::<ModelCatalogEntry>(value).unwrap(),
        entry
    );
}

#[test]
fn model_preferences_catalog_fields_keep_unknown_capacity_explicit() {
    let model = ModelRef::new(
        ash_protocol::ProviderId::new("test").unwrap(),
        ash_protocol::ModelId::new("unknown").unwrap(),
    );
    let info = ModelInfo::new(model.model.clone(), "Unknown");
    let entry = ModelCatalogEntry::from_info(model, &info);
    let value = serde_json::to_value(&entry).unwrap();
    assert_eq!(value["default_context_window"], serde_json::Value::Null);
    assert_eq!(value["long_context"], serde_json::Value::Null);
    assert_eq!(value["selected_acceleration"], serde_json::Value::Null);
}

#[test]
fn model_preferences_request_is_strict_and_accepts_targeted_updates() {
    let request = serde_json::json!({ "command_id": "model-settings", "expected_revision": 1, "model": { "provider": "openai", "model": "gpt-6-astra" }, "acceleration": "priority" });
    let params: ModelPreferencesUpdateParams = serde_json::from_value(request.clone()).unwrap();
    assert_eq!(
        params.acceleration,
        ash_protocol::Patch::Value("priority".into())
    );
    assert_eq!(params.long_context, None);
    for enabled in [false, true] {
        let mut update = request.clone();
        update["long_context"] = serde_json::json!(enabled);
        let parsed: ModelPreferencesUpdateParams = serde_json::from_value(update.clone()).unwrap();
        assert_eq!(parsed.long_context, Some(enabled));
        assert_eq!(
            serde_json::to_value(parsed).unwrap()["long_context"],
            enabled
        );
        update["context_window"] = serde_json::json!(272000);
        assert!(serde_json::from_value::<ModelPreferencesUpdateParams>(update).is_err());
    }
    let mut invalid = request;
    invalid["config"] = serde_json::json!({});
    assert!(serde_json::from_value::<ModelPreferencesUpdateParams>(invalid).is_err());
}

#[test]
fn context_read_requires_an_explicit_detail_and_preserves_tool_schemas() {
    for detail in [ContextReadDetail::Usage, ContextReadDetail::Diagnostics] {
        let params = ContextReadParams {
            scope: ContextReadScope::Environment,
            detail,
        };
        assert_eq!(
            serde_json::from_value::<ContextReadParams>(serde_json::to_value(&params).unwrap())
                .unwrap(),
            params
        );
    }
    assert!(
        serde_json::from_value::<ContextReadParams>(
            serde_json::json!({"scope": {"type": "environment"}})
        )
        .is_err()
    );
    let definition = ContextToolDefinition {
        name: "read_file".into(),
        description: "Read a file".into(),
        strict: true,
        tokens: 229,
        parameters: serde_json::json!({"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]}),
    };
    assert_eq!(
        serde_json::from_value::<ContextToolDefinition>(serde_json::to_value(&definition).unwrap())
            .unwrap(),
        definition
    );
}

#[test]
fn acceleration_patch_distinguishes_omission_clear_and_selected_id() {
    let base = serde_json::json!({"command_id":"settings", "expected_revision":1, "model":{"provider":"openai", "model":"model"}});
    let omitted: ModelPreferencesUpdateParams = serde_json::from_value(base.clone()).unwrap();
    assert_eq!(omitted.acceleration, ash_protocol::Patch::Missing);
    assert!(
        serde_json::to_value(omitted)
            .unwrap()
            .get("acceleration")
            .is_none()
    );
    for value in [serde_json::Value::Null, serde_json::json!("ultrafast")] {
        let mut wire = base.clone();
        wire["acceleration"] = value.clone();
        let params: ModelPreferencesUpdateParams = serde_json::from_value(wire.clone()).unwrap();
        assert_eq!(serde_json::to_value(params).unwrap()["acceleration"], value);
    }
    let mut old = base;
    old["fast"] = serde_json::json!(true);
    assert!(serde_json::from_value::<ModelPreferencesUpdateParams>(old).is_err());
}

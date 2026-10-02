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
    assert_eq!(value["contextWindow"], 1_000_000);
    assert!(value.get("access").is_none());
    assert!(value.get("outputTransport").is_none());
}

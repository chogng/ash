use super::*;

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
    let value = serde_json::to_value(ModelCatalogEntry::from_info(model, &info)).unwrap();
    assert_eq!(value["contextWindow"], 1_000_000);
    assert!(value.get("access").is_none());
    assert!(value.get("outputTransport").is_none());
}

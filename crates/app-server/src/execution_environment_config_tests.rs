use super::EndpointConfig;

#[test]
fn execution_configuration_accepts_one_complete_transport() {
    for value in [
        serde_json::json!({"environment":"worker","address":"127.0.0.1:9001","token_file":"worker.token"}),
        serde_json::json!({"environment":"worker","host":"build","root":"/remote/project","runtime":"/package/bin/ash-remote-server"}),
    ] {
        serde_json::from_value::<EndpointConfig>(value).unwrap();
    }
}

#[test]
fn execution_configuration_rejects_partial_mixed_and_unknown_inputs() {
    for value in [
        serde_json::json!({"environment":"worker","address":"127.0.0.1:9001"}),
        serde_json::json!({"environment":"worker","host":"build","root":"/remote/project"}),
        serde_json::json!({"environment":"worker","host":"build","root":"/remote/project","runtime":"/runtime","token_file":"worker.token"}),
        serde_json::json!({"environment":"worker","address":"127.0.0.1:9001","token_file":"worker.token","host":"build","root":"/remote/project","runtime":"/runtime"}),
        serde_json::json!({"environment":"worker","address":"127.0.0.1:9001","token_file":"worker.token","extra":true}),
    ] {
        assert!(serde_json::from_value::<EndpointConfig>(value).is_err());
    }
}

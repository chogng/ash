use super::*;

#[test]
fn default_pattern_accepts_port_or_uri_and_preserves_format() {
    let action = Action::parse(&json!({"action":"openExternally"}), "invalid").unwrap();
    let capture = action
        .pattern
        .captures("Now listening on: http://127.0.0.1:3000")
        .unwrap();
    assert_eq!(action.uri(&capture[1]).unwrap(), "http://127.0.0.1:3000");
    assert_eq!(action.uri("8080").unwrap(), "http://localhost:8080");
    let action = Action::parse(&json!({"action":"openExternally","pattern":"port=(\\d+)","uriFormat":"https://localhost:%s/app"}), "invalid").unwrap();
    assert_eq!(action.uri("8443").unwrap(), "https://localhost:8443/app");
}
#[test]
fn rejects_invalid_configuration_and_privileged_uri() {
    for value in [
        json!({"action":"openExternally","pattern":"no capture"}),
        json!({"action":"openExternally","pattern":"(a)\\1"}),
        json!({"action":"startDebugging"}),
        json!({"action":"startDebugging","name":"child","config":{}}),
        json!({"action":"openExternally","uriFormat":"%s%s"}),
    ] {
        assert!(Action::parse(&value, "invalid").is_err());
    }
    let action = Action::parse(&json!({"action":"openExternally"}), "invalid").unwrap();
    for uri in [
        "command:execute",
        "file:///etc/passwd",
        "http://user:secret@localhost/",
    ] {
        assert!(action.uri(uri).is_err());
    }
}
#[test]
fn named_and_inline_child_launches_are_distinct() {
    assert!(
        Action::parse(
            &json!({"action":"startDebugging","name":"client","killOnServerStop":true}),
            "invalid"
        )
        .is_ok()
    );
    assert!(Action::parse(&json!({"action":"startDebugging","config":{"type":"node","request":"launch","name":"child"}}), "invalid").is_ok());
}
#[test]
fn chinese_errors_are_selected_from_product_messages() {
    let messages: Value = serde_json::from_str(include_str!("../package.nls.zh-CN.json")).unwrap();
    let message = messages["error.configuration"].as_str().unwrap();
    assert_eq!(
        Action::parse(&json!({}), message).err().unwrap().message,
        message
    );
}

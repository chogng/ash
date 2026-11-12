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
fn waits_for_complete_output_at_every_split() {
    let action = Action::parse(&json!({"action":"openExternally"}), "invalid").unwrap();
    for (category, output, uri) in [
        ("stdout", "Listening on: 3000\n", "http://localhost:3000"),
        (
            "terminal",
            "\x1b[32mNow listening on: http://127.0.0.1:3000/app?token=abcdef\x1b[0m\r\n",
            "http://127.0.0.1:3000/app?token=abcdef",
        ),
    ] {
        for (split, _) in output.char_indices() {
            let mut state = State::default();
            let (prefix, suffix) = output.split_at(split);
            assert_eq!(
                state.capture_output(category, prefix, &action.pattern),
                None,
                "premature match at byte {split} of {output:?}"
            );
            let capture = state
                .capture_output(category, suffix, &action.pattern)
                .unwrap_or_else(|| panic!("missing match at byte {split} of {output:?}"));
            assert_eq!(action.uri(&capture).unwrap(), uri);
            assert_eq!(
                state.capture_output(category, output, &action.pattern),
                None
            );
        }
    }
}

#[test]
fn incomplete_line_is_ignored_after_complete_output_and_across_categories() {
    let pattern = Regex::new(r"port=(\d+)").unwrap();
    let mut state = State::default();

    assert_eq!(
        state.capture_output("stdout", "Ready\nport=300", &pattern),
        None
    );
    assert_eq!(state.capture_output("stderr", "0\n", &pattern), None);
    assert_eq!(state.capture_output("stdout", "0", &pattern), None);
    assert_eq!(
        state
            .capture_output("stdout", "\nport=900", &pattern)
            .as_deref(),
        Some("3000")
    );
}

#[test]
fn custom_pattern_can_match_across_complete_lines() {
    let pattern = Regex::new(r"Ready\r?\nport=(\d+)\r?\n").unwrap();
    let mut state = State::default();

    assert_eq!(state.capture_output("console", "Ready\r\n", &pattern), None);
    assert_eq!(
        state
            .capture_output("console", "port=3000\r\n", &pattern)
            .as_deref(),
        Some("3000")
    );
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

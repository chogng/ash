use super::*;

#[test]
fn process_requests_reject_unknown_fields_and_preserve_entry_and_call_envelopes() {
    let call: Request = serde_json::from_str(
        r#"{"protocol_version":1,"id":7,"method":"call","entry":0,"arguments":[42]}"#,
    )
    .unwrap();
    assert_eq!(call.envelope(), (1, 7));
    assert!(matches!(call, Request::Call { entry: 0, arguments, .. } if arguments == [42]));
    let build: Request = serde_json::from_str(r#"{"protocol_version":1,"id":8,"method":"build","entries":[{"path":"src/lib.rs","function":"entry"}]}"#).unwrap();
    assert_eq!(build.envelope(), (1, 8));
    for invalid in [
        r#"{"protocol_version":1,"id":7,"method":"call","entry":0,"arguments":[],"typo":true}"#,
        r#"{"protocol_version":1,"id":8,"method":"build","entries":[{"path":"src/lib.rs","function":"entry","typo":true}]}"#,
        r#"{"protocol_version":1,"id":7,"method":"call","entry":-1,"arguments":[]}"#,
        r#"{"protocol_version":1,"id":8,"method":"build","entries":[],"check":"unchecked"}"#,
    ] {
        assert!(serde_json::from_str::<Request>(invalid).is_err());
    }
}

use super::*;

#[test]
fn framing_bounds_unterminated_messages_and_preserves_json_lines() {
    let mut input = std::io::Cursor::new(b"{\"id\":1}\n{\"id\":2}\n");
    assert_eq!(read_frame(&mut input).unwrap().unwrap(), b"{\"id\":1}\n");
    assert_eq!(read_frame(&mut input).unwrap().unwrap(), b"{\"id\":2}\n");
    assert!(read_frame(&mut input).unwrap().is_none());
    assert!(
        read_frame(&mut std::io::Cursor::new(vec![
            b'x';
            MAX_REQUEST_BYTES as usize
                + 2
        ]))
        .is_err()
    );
}

#[test]
fn protocol_rejects_unknown_fields_and_oversized_responses_are_explicit() {
    assert!(
        serde_json::from_value::<Request>(serde_json::json!({
            "id": 1, "protocol_version": 1, "revision": 0,
            "query": {"method": "function", "path": "lib.rs", "byte_offset": 0, "extra": true}
        }))
        .is_err()
    );
    let mut output = Vec::new();
    write_response(
        &mut output,
        Response {
            protocol_version: 1,
            id: Some(5),
            revision: 2,
            outcome: Outcome::Success {
                result: Value::String("x".repeat(MAX_RESPONSE_BYTES + 1)),
            },
        },
    )
    .unwrap();
    let response: Value = serde_json::from_slice(&output).unwrap();
    assert_eq!(response["id"], 5);
    assert_eq!(response["revision"], 2);
    assert_eq!(response["error"]["code"], "budget_exceeded");
}

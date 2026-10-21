use super::*;

#[test]
fn semantic_gate_requires_complete_native_scalar_contract() {
    let scalar = json!({"display": "usize", "contains_unknown": false, "layout": {"status": "available", "value": {"size_bytes": std::mem::size_of::<usize>(), "alignment_bytes": std::mem::align_of::<usize>()}}});
    let report = json!({"function": {"name": "zero_based_line_index", "crate": "ash_app_server_diff"}, "generic_parameter_count": 0, "is_async": false, "parameters": [scalar.clone()], "return_type": scalar, "mir": {"status": "available"}, "expressions_truncated": false, "calls_truncated": false, "expressions": [{"type": {"contains_unknown": false}}], "syntax_calls": [{"resolved_function": {"name": "saturating_sub"}}]});
    assert!(supports(&report));
    for (pointer, value) in [
        ("/return_type/display", json!("u32")),
        ("/return_type/layout/value/size_bytes", json!(0)),
        ("/parameters/0/contains_unknown", json!(true)),
        ("/generic_parameter_count", json!(1)),
        ("/mir/status", json!("unavailable")),
        ("/expressions_truncated", json!(true)),
        ("/syntax_calls/0/resolved_function", Value::Null),
    ] {
        let mut changed = report.clone();
        *changed.pointer_mut(pointer).unwrap() = value;
        assert!(!supports(&changed), "{pointer}");
    }
    assert!(!supports(&Value::Null));
}

#[test]
fn bridge_frames_are_bounded_and_malformed_frames_fail() {
    assert!(read_response(&mut &b""[..]).is_err());
    assert!(read_response(&mut &b"invalid\n"[..]).is_err());
    assert!(read_response(&mut &vec![b'x'; MAX_RESPONSE as usize + 1][..]).is_err());
    let mut stream = &b"{\"id\":1}\n{\"id\":2}\n"[..];
    assert_eq!(read_response(&mut stream).unwrap()["id"], 1);
    assert_eq!(read_response(&mut stream).unwrap()["id"], 2);
}

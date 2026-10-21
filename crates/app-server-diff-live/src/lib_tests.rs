use super::*;

unsafe extern "C" fn collect(context: *mut c_void, bytes: *const u8, length: usize) {
    // SAFETY: invoke supplies live bytes and this test supplies its live Vec.
    unsafe { &mut *context.cast::<Vec<u8>>() }
        .extend_from_slice(unsafe { std::slice::from_raw_parts(bytes, length) });
}

#[test]
fn exported_module_preserves_domain_results_and_errors() {
    assert_eq!(ash_dev_abi_version(), ash_dev_build::ABI_VERSION);
    for params in [
        serde_json::json!({"original": "before 😀 after", "modified": "before 🤖 after"}),
        serde_json::json!({"original": "one\ntwo", "modified": "one\nthree"}),
        serde_json::json!({"original": "a\u{0}b", "modified": ""}),
        serde_json::json!(null),
    ] {
        let input = serde_json::to_vec(&params).unwrap();
        let mut output = Vec::<u8>::new();
        // SAFETY: the input and output Vec remain live through the synchronous call.
        let status = unsafe {
            ash_dev_invoke_v1(
                input.as_ptr(),
                input.len(),
                collect,
                (&raw mut output).cast(),
            )
        };
        assert_eq!(status, 0);
        let result: Result<Value, AppServerError> = serde_json::from_slice(&output).unwrap();
        assert_eq!(result, ash_app_server_diff::compute(&params));
    }
}

#[test]
fn malformed_json_is_a_domain_error_without_crossing_the_abi() {
    let result: Result<Value, AppServerError> = serde_json::from_slice(&compute(b"{")).unwrap();
    assert_eq!(
        result.unwrap_err().data.kind,
        AppServerErrorName::InvalidParams
    );
}

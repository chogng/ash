#[test]
fn array_sort_is_safe_with_the_product_initialization_policy() {
    // Only the test harness permits intrinsics; production initialization must
    // override the unsafe optimization flags even if a caller enabled them.
    v8::V8::set_flags_from_string("--allow-natives-syntax --maglev --turbolev");
    super::ensure_v8_initialized().unwrap();
    let isolate = &mut v8::Isolate::new(
        v8::CreateParams::default().array_buffer_allocator(super::array_buffer_allocator()),
    );
    v8::scope!(let scope, isolate);
    let context = v8::Context::new(scope, Default::default());
    let scope = &mut v8::ContextScope::new(scope, context);
    let source = format!(
        "if (%IsMaglevEnabled()) throw new Error('Maglev must be disabled');\n{}",
        include_str!("../../v8-poc/src/array_sort_regression.js")
    );
    let source = v8::String::new(scope, &source).unwrap();
    let tc = std::pin::pin!(v8::TryCatch::new(scope));
    let scope = &mut tc.init();
    let result = v8::Script::compile(scope, source, None).and_then(|script| script.run(scope));
    if let Some(exception) = scope.exception() {
        panic!("{}", exception.to_rust_string_lossy(scope));
    }
    assert!(result.unwrap().is_true());
}

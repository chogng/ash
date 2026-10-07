//! Small V8 link-and-execute probe used by Cargo and Bazel.
//!
//! This crate deliberately stays separate from Code Mode. It answers one narrow question: can
//! this target compile, link, initialize, and execute the exact V8 crate selected by the workspace?

/// Returns the Bazel label for this probe.
#[must_use]
pub fn bazel_target() -> &'static str {
    "//crates/v8-poc:v8-poc"
}

/// Returns the V8 version from the linked library.
#[must_use]
pub fn embedded_v8_version() -> &'static str {
    v8::V8::get_version()
}

/// Reports whether this build enabled the V8 sandbox feature at compile time.
#[must_use]
pub const fn sandbox_feature_enabled() -> bool {
    cfg!(feature = "sandbox")
}

#[cfg(test)]
mod tests {
    use pretty_assertions::assert_eq;
    use std::sync::Once;

    use super::{bazel_target, embedded_v8_version, sandbox_feature_enabled};

    fn initialize_v8() {
        static INIT: Once = Once::new();

        INIT.call_once(|| {
            v8::V8::initialize_platform(v8::new_default_platform(0, false).make_shared());
            v8::V8::initialize();
        });
    }

    fn evaluate_expression(expression: &str) -> String {
        initialize_v8();

        let isolate = &mut v8::Isolate::new(Default::default());
        v8::scope!(let scope, isolate);

        let context = v8::Context::new(scope, Default::default());
        let scope = &mut v8::ContextScope::new(scope, context);
        let source = v8::String::new(scope, expression).expect("expression should be valid UTF-8");
        let script = v8::Script::compile(scope, source, None).expect("expression should compile");
        let result = script.run(scope).expect("expression should evaluate");

        result.to_rust_string_lossy(scope)
    }

    #[test]
    fn exposes_expected_bazel_target() {
        assert_eq!(bazel_target(), "//crates/v8-poc:v8-poc");
    }

    #[test]
    fn exposes_embedded_v8_version() {
        assert!(!embedded_v8_version().is_empty());
    }

    #[test]
    fn reports_the_selected_sandbox_feature() {
        assert_eq!(sandbox_feature_enabled(), cfg!(feature = "sandbox"));
    }

    #[test]
    fn evaluates_integer_addition() {
        assert_eq!(evaluate_expression("1 + 2"), "3");
    }

    #[test]
    fn evaluates_string_concatenation() {
        assert_eq!(evaluate_expression("'hello ' + 'world'"), "hello world");
    }

    #[test]
    fn parses_crdtp_dispatchable_messages() {
        let cbor = v8::crdtp::json_to_cbor(br#"{"id":7,"method":"Runtime.evaluate","params":{}}"#)
            .expect("JSON should convert to CBOR");
        let dispatchable = v8::crdtp::Dispatchable::new(&cbor);

        assert!(dispatchable.ok());
        assert_eq!(dispatchable.call_id(), 7);
        assert_eq!(dispatchable.method(), b"Runtime.evaluate");
    }
}

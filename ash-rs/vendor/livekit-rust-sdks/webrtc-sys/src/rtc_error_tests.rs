use super::ffi::RtcError;

#[test]
fn arbitrary_unicode_exception_messages_never_panic() {
    for offset in 0..24 {
        for symbol in ["é", "界", "🦀"] {
            let input = format!("{}{}{}", "0".repeat(offset), symbol, "0".repeat(24));
            assert!(
                std::panic::catch_unwind(|| unsafe { RtcError::from(&input) }).is_ok(),
                "offset={offset}"
            );
        }
    }
}

use super::{KeyModifiers, PasteEncoding, TerminalKey, encode_key, encode_paste};
use crate::CursorKeyMode;

#[test]
fn cursor_keys_follow_normal_application_and_modifier_encodings() {
    assert_eq!(
        encode_key(
            TerminalKey::ArrowUp,
            KeyModifiers::NONE,
            CursorKeyMode::Normal
        ),
        b"\x1b[A"
    );
    assert_eq!(
        encode_key(
            TerminalKey::ArrowUp,
            KeyModifiers::NONE,
            CursorKeyMode::Application
        ),
        b"\x1bOA"
    );
    assert_eq!(
        encode_key(
            TerminalKey::ArrowLeft,
            KeyModifiers::NONE.with_control(),
            CursorKeyMode::Application
        ),
        b"\x1b[1;5D"
    );
}

#[test]
fn text_keys_encode_control_and_alt_prefixes() {
    assert_eq!(
        encode_key(
            TerminalKey::Text("c"),
            KeyModifiers::NONE.with_control(),
            CursorKeyMode::Normal
        ),
        b"\x03"
    );
    assert_eq!(
        encode_key(
            TerminalKey::Text("x"),
            KeyModifiers::NONE.with_alt(),
            CursorKeyMode::Normal
        ),
        b"\x1bx"
    );
}

#[test]
fn bracketed_paste_wraps_text_only_when_requested() {
    assert_eq!(encode_paste("hello", PasteEncoding::Literal), b"hello");
    assert_eq!(
        encode_paste("hello", PasteEncoding::Bracketed),
        b"\x1b[200~hello\x1b[201~"
    );
}

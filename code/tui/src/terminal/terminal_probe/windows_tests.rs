use super::decode_color_ref;
use ash_terminal_detection::TerminalRgb;

#[test]
fn decodes_windows_color_refs() {
    assert_eq!(
        decode_color_ref(0x00_33_22_11),
        TerminalRgb::new(17, 34, 51)
    );
}

use super::take_output;

#[test]
fn output_preserves_fragmented_unicode_and_replaces_invalid_bytes() {
    let mut buffer = Vec::new();
    let mut output = String::new();
    for byte in "中文 🚀".as_bytes() {
        buffer.push(*byte);
        output.push_str(&take_output(&mut buffer));
        assert!(buffer.len() < 4);
    }
    assert_eq!(output, "中文 🚀");
    assert!(buffer.is_empty());
    buffer.extend_from_slice(&[0xff, b'!', 0xe4, 0xb8]);
    assert_eq!(take_output(&mut buffer), "�!");
    assert_eq!(buffer, [0xe4, 0xb8]);
    buffer.push(0xad);
    assert_eq!(take_output(&mut buffer), "中");
    assert!(buffer.is_empty());
}

use super::*;

#[test]
fn output_buffer_reports_an_explicit_gap_after_tail_truncation() {
    let mut output = StreamBuffer::new(4);
    output.append(b"abcdef");

    let chunk = output.read(0).unwrap();

    assert_eq!(chunk.text, "cdef");
    assert_eq!(chunk.next_cursor, 6);
    assert!(chunk.gap);
    assert_eq!(output.read(2).unwrap().text, "cdef");
    assert!(output.read(7).is_err());
}

#[test]
fn command_session_id_rejects_non_opaque_values() {
    assert!(CommandSessionId::new("session-1").is_err());
    assert!(CommandSessionId::new("cmd-not-hexadecimal-not-hexadecim").is_err());
    assert!(CommandSessionId::new("cmd-0123456789abcdef0123456789abcdef").is_ok());
}

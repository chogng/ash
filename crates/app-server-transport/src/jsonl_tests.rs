use crate::JsonlReader;
use crate::JsonlWriter;
use std::io::BufReader;
use std::io::Cursor;
use std::io::Read;

#[test]
fn rejects_an_unterminated_frame_before_reading_the_rest_of_the_stream() {
    struct Unending(usize);
    impl Read for Unending {
        fn read(&mut self, buffer: &mut [u8]) -> std::io::Result<usize> {
            self.0 += buffer.len();
            if self.0 > 64 {
                return Err(std::io::Error::other("reader consumed an oversized frame"));
            }
            buffer.fill(b'x');
            Ok(buffer.len())
        }
    }
    let mut reader = JsonlReader::new(BufReader::with_capacity(4, Unending(0)), 16);
    assert_eq!(
        reader.read_message().unwrap_err().kind(),
        std::io::ErrorKind::InvalidData
    );
}

#[test]
fn accepts_the_writers_exact_limit_and_keeps_following_frames() {
    let mut bytes = Vec::new();
    JsonlWriter::new(&mut bytes, 4)
        .write_message("1234")
        .unwrap();
    bytes.extend_from_slice(b"abcd\r\nlast");
    let mut reader = JsonlReader::new(Cursor::new(bytes), 4);
    assert_eq!(reader.read_message().unwrap().as_deref(), Some("1234"));
    assert_eq!(reader.read_message().unwrap().as_deref(), Some("abcd"));
    assert_eq!(reader.read_message().unwrap().as_deref(), Some("last"));
    assert!(reader.read_message().unwrap().is_none());
}

#[test]
fn rejects_oversized_and_invalid_utf8_frames() {
    for bytes in [b"12345\n".as_slice(), b"\xff\n".as_slice()] {
        let mut reader = JsonlReader::new(Cursor::new(bytes), 4);
        assert_eq!(
            reader.read_message().unwrap_err().kind(),
            std::io::ErrorKind::InvalidData
        );
    }
}

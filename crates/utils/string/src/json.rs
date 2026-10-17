//! JSON serialization for source literals and bounded output boundaries.

use serde::Serialize;
use std::io;

struct AsciiFormatter;

impl serde_json::ser::Formatter for AsciiFormatter {
    fn write_string_fragment<W: io::Write + ?Sized>(
        &mut self,
        writer: &mut W,
        fragment: &str,
    ) -> io::Result<()> {
        let mut start = 0;
        for (index, character) in fragment.char_indices() {
            if character.is_ascii() {
                continue;
            }
            writer.write_all(&fragment.as_bytes()[start..index])?;
            // JSON uses UTF-16 escapes, including a surrogate pair for supplementary scalars.
            for unit in character.encode_utf16(&mut [0; 2]) {
                write!(writer, "\\u{unit:04x}")?;
            }
            start = index + character.len_utf8();
        }
        writer.write_all(&fragment.as_bytes()[start..])
    }
}

/// Serializes JSON with non-ASCII string scalars escaped as UTF-16 `\uXXXX` sequences.
/// The serializer still owns JSON structure and escaping of quotes and control characters.
pub fn to_ascii_json_string<T: Serialize + ?Sized>(value: &T) -> serde_json::Result<String> {
    let mut bytes = Vec::new();
    value.serialize(&mut serde_json::Serializer::with_formatter(
        &mut bytes,
        AsciiFormatter,
    ))?;
    utf8(bytes)
}

/// Serializes complete UTF-8 JSON, rejecting output beyond `max_bytes` while writing.
/// No truncated or partially serialized document is returned on failure.
pub fn to_json_string_bounded<T: Serialize + ?Sized>(
    value: &T,
    max_bytes: usize,
) -> serde_json::Result<String> {
    struct Buffer {
        bytes: Vec<u8>,
        limit: usize,
    }
    impl io::Write for Buffer {
        fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
            if bytes.len() > self.limit.saturating_sub(self.bytes.len()) {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "JSON byte limit exceeded",
                ));
            }
            self.bytes.extend_from_slice(bytes);
            Ok(bytes.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    let mut buffer = Buffer {
        bytes: Vec::new(),
        limit: max_bytes,
    };
    serde_json::to_writer(&mut buffer, value)?;
    utf8(buffer.bytes)
}

fn utf8(bytes: Vec<u8>) -> serde_json::Result<String> {
    String::from_utf8(bytes)
        .map_err(|error| serde_json::Error::io(io::Error::new(io::ErrorKind::InvalidData, error)))
}

#[cfg(test)]
#[path = "json_tests.rs"]
mod tests;

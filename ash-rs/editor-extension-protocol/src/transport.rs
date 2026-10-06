use std::io::BufRead;
use std::io::Write;

use serde::Serialize;

use crate::ProtocolError;

/// Reads one newline-terminated frame without allocating beyond the negotiated byte limit.
pub fn read_frame<R: BufRead>(
    reader: &mut R,
    maximum_bytes: usize,
) -> Result<Option<Vec<u8>>, String> {
    let mut output = Vec::new();
    loop {
        let available = reader.fill_buf().map_err(|error| error.to_string())?;
        if available.is_empty() {
            return if output.is_empty() {
                Ok(None)
            } else {
                Err("protocol frame ended without a newline".into())
            };
        }
        let newline = available.iter().position(|byte| *byte == b'\n');
        let take = newline.map_or(available.len(), |position| position + 1);
        if output.len().saturating_add(take) > maximum_bytes.saturating_add(1) {
            return Err("protocol frame exceeds its byte limit".into());
        }
        output.extend_from_slice(&available[..take]);
        reader.consume(take);
        if newline.is_some() {
            output.pop();
            if output.last() == Some(&b'\r') {
                output.pop();
            }
            if output.len() > maximum_bytes {
                return Err("protocol frame exceeds its byte limit".into());
            }
            return Ok(Some(output));
        }
    }
}

/// Writes one complete frame. Callers serialize concurrent writers around this operation.
pub fn write_frame(
    writer: &mut impl Write,
    value: &impl Serialize,
    maximum_bytes: usize,
) -> Result<(), ProtocolError> {
    let encoded = serde_json::to_vec(value)
        .map_err(|error| ProtocolError::InvalidProtocol(error.to_string()))?;
    if encoded.len() > maximum_bytes {
        return Err(ProtocolError::QuotaExceeded("protocol frame bytes"));
    }
    writer.write_all(&encoded)?;
    writer.write_all(b"\n")?;
    writer.flush()?;
    Ok(())
}

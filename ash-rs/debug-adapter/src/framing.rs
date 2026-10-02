use serde_json::Value;
use tokio::io::AsyncBufRead;
use tokio::io::AsyncBufReadExt;
use tokio::io::AsyncReadExt;

use crate::service::DebugAdapterError;

pub(crate) const MAX_MESSAGE_BYTES: usize = 4 * 1024 * 1024;

pub(crate) async fn read_message(
    reader: &mut (impl AsyncBufRead + Unpin),
) -> Result<Option<Value>, DebugAdapterError> {
    let mut content_length = None;
    let mut saw_header = false;
    loop {
        let mut line = String::new();
        let read = reader.read_line(&mut line).await?;
        if read == 0 {
            if saw_header {
                return Err(DebugAdapterError::InvalidFrame(
                    "adapter closed during a DAP header".into(),
                ));
            }
            return Ok(None);
        }
        saw_header = true;
        if line == "\r\n" || line == "\n" {
            break;
        }
        let Some((name, value)) = line.trim_end_matches(['\r', '\n']).split_once(':') else {
            return Err(DebugAdapterError::InvalidFrame(
                "DAP header line is missing ':'".into(),
            ));
        };
        if name.eq_ignore_ascii_case("Content-Length") {
            if content_length.is_some() {
                return Err(DebugAdapterError::InvalidFrame(
                    "DAP frame has duplicate Content-Length headers".into(),
                ));
            }
            let length = value.trim().parse::<usize>().map_err(|_| {
                DebugAdapterError::InvalidFrame("invalid DAP Content-Length".into())
            })?;
            if length == 0 || length > MAX_MESSAGE_BYTES {
                return Err(DebugAdapterError::InvalidFrame(
                    "DAP Content-Length is outside the supported range".into(),
                ));
            }
            content_length = Some(length);
        }
    }
    let length = content_length.ok_or_else(|| {
        DebugAdapterError::InvalidFrame("DAP frame is missing Content-Length".into())
    })?;
    let mut payload = vec![0; length];
    reader.read_exact(&mut payload).await?;
    let value: Value = serde_json::from_slice(&payload)
        .map_err(|_| DebugAdapterError::InvalidFrame("DAP payload is not valid JSON".into()))?;
    validate_message(&value)?;
    Ok(Some(value))
}

pub(crate) fn encode_message(value: &Value) -> Result<Vec<u8>, DebugAdapterError> {
    validate_message(value)?;
    let payload = serde_json::to_vec(value)?;
    if payload.is_empty() || payload.len() > MAX_MESSAGE_BYTES {
        return Err(DebugAdapterError::InvalidMessage);
    }
    let mut framed = format!("Content-Length: {}\r\n\r\n", payload.len()).into_bytes();
    framed.extend(payload);
    Ok(framed)
}

fn validate_message(value: &Value) -> Result<(), DebugAdapterError> {
    let Some(object) = value.as_object() else {
        return Err(DebugAdapterError::InvalidMessage);
    };
    // LLDB-DAP emits seq=0; request pairing uses request_seq and our retained-message cursor
    // is assigned by the process owner, independently of this adapter-supplied field.
    let Some(_) = object.get("seq").and_then(Value::as_u64) else {
        return Err(DebugAdapterError::InvalidMessage);
    };
    let Some(kind) = object.get("type").and_then(Value::as_str) else {
        return Err(DebugAdapterError::InvalidMessage);
    };
    if !matches!(kind, "request" | "response" | "event") {
        return Err(DebugAdapterError::InvalidMessage);
    }
    Ok(())
}

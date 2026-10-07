use std::io;

use serde::{Deserialize, Serialize};
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::LanguageServerError;

pub(crate) const DEFAULT_MAX_HEADER_BYTES: usize = 16 * 1024;
pub(crate) const DEFAULT_MAX_MESSAGE_BYTES: usize = 64 * 1024 * 1024;

#[derive(Debug, Deserialize)]
pub(crate) struct RpcErrorObject {
    pub(crate) code: i64,
    pub(crate) message: String,
    #[serde(default)]
    pub(crate) data: Option<Value>,
}

#[derive(Debug)]
pub(crate) enum IncomingMessage {
    Response {
        id: i64,
        result: Result<Value, RpcErrorObject>,
    },
    Notification {
        method: String,
        params: Value,
    },
    Request {
        id: Value,
        method: String,
        params: Value,
    },
}

#[derive(Deserialize)]
struct IncomingEnvelope {
    jsonrpc: Option<String>,
    #[serde(default)]
    id: Option<Value>,
    #[serde(default)]
    method: Option<String>,
    #[serde(default)]
    params: Option<Value>,
    #[serde(default)]
    result: Option<Value>,
    #[serde(default)]
    error: Option<RpcErrorObject>,
}

#[derive(Serialize)]
struct RequestEnvelope<'a> {
    jsonrpc: &'static str,
    id: i64,
    method: &'a str,
    params: &'a Value,
}

#[derive(Serialize)]
struct NotificationEnvelope<'a> {
    jsonrpc: &'static str,
    method: &'a str,
    params: &'a Value,
}

#[derive(Serialize)]
struct ResultEnvelope<'a> {
    jsonrpc: &'static str,
    id: &'a Value,
    result: &'a Value,
}

#[derive(Serialize)]
struct ErrorEnvelope<'a> {
    jsonrpc: &'static str,
    id: &'a Value,
    error: OutgoingError<'a>,
}

#[derive(Serialize)]
struct OutgoingError<'a> {
    code: i64,
    message: &'a str,
}

pub(crate) fn request_bytes(
    id: i64,
    method: &str,
    params: &Value,
) -> Result<Vec<u8>, LanguageServerError> {
    serde_json::to_vec(&RequestEnvelope {
        jsonrpc: "2.0",
        id,
        method,
        params,
    })
    .map_err(invalid_serialization)
}

pub(crate) fn notification_bytes(
    method: &str,
    params: &Value,
) -> Result<Vec<u8>, LanguageServerError> {
    serde_json::to_vec(&NotificationEnvelope {
        jsonrpc: "2.0",
        method,
        params,
    })
    .map_err(invalid_serialization)
}

pub(crate) fn result_bytes(id: &Value, result: &Value) -> Result<Vec<u8>, LanguageServerError> {
    serde_json::to_vec(&ResultEnvelope {
        jsonrpc: "2.0",
        id,
        result,
    })
    .map_err(invalid_serialization)
}

pub(crate) fn method_not_found_bytes(
    id: &Value,
    method: &str,
) -> Result<Vec<u8>, LanguageServerError> {
    serde_json::to_vec(&ErrorEnvelope {
        jsonrpc: "2.0",
        id,
        error: OutgoingError {
            code: -32601,
            message: method,
        },
    })
    .map_err(invalid_serialization)
}

pub(crate) fn invalid_params_bytes(
    id: &Value,
    message: &str,
) -> Result<Vec<u8>, LanguageServerError> {
    error_bytes(id, -32602, message)
}

fn error_bytes(id: &Value, code: i64, message: &str) -> Result<Vec<u8>, LanguageServerError> {
    serde_json::to_vec(&ErrorEnvelope {
        jsonrpc: "2.0",
        id,
        error: OutgoingError { code, message },
    })
    .map_err(invalid_serialization)
}

fn invalid_serialization(error: serde_json::Error) -> LanguageServerError {
    LanguageServerError::InvalidMessage(error.to_string())
}

pub(crate) fn parse_message(bytes: &[u8]) -> Result<IncomingMessage, LanguageServerError> {
    let value: Value = serde_json::from_slice(bytes)
        .map_err(|error| LanguageServerError::InvalidMessage(error.to_string()))?;
    let has_result = value
        .as_object()
        .is_some_and(|object| object.contains_key("result"));
    let envelope: IncomingEnvelope = serde_json::from_value(value)
        .map_err(|error| LanguageServerError::InvalidMessage(error.to_string()))?;
    if envelope.jsonrpc.as_deref() != Some("2.0") {
        return Err(LanguageServerError::InvalidMessage(
            "JSON-RPC version must be 2.0".into(),
        ));
    }
    if let Some(method) = envelope.method {
        let params = envelope.params.unwrap_or(Value::Null);
        return match envelope.id {
            Some(id) if id.is_string() || id.as_i64().is_some() => {
                Ok(IncomingMessage::Request { id, method, params })
            }
            Some(_) => Err(LanguageServerError::InvalidMessage(
                "server request ID must be an integer or string".into(),
            )),
            None => Ok(IncomingMessage::Notification { method, params }),
        };
    }
    let id = envelope.id.and_then(|id| id.as_i64()).ok_or_else(|| {
        LanguageServerError::InvalidMessage("response ID must be an integer".into())
    })?;
    match (has_result, envelope.result, envelope.error) {
        (true, result, None) => Ok(IncomingMessage::Response {
            id,
            result: Ok(result.unwrap_or(Value::Null)),
        }),
        (false, None, Some(error)) => Ok(IncomingMessage::Response {
            id,
            result: Err(error),
        }),
        _ => Err(LanguageServerError::InvalidMessage(
            "response must contain exactly one result or error".into(),
        )),
    }
}

pub(crate) async fn read_frame<R>(
    reader: &mut R,
    max_header_bytes: usize,
    max_message_bytes: usize,
) -> Result<Option<Vec<u8>>, LanguageServerError>
where
    R: AsyncBufRead + Unpin,
{
    let mut header_bytes = 0usize;
    let mut content_length = None;
    loop {
        let mut line = Vec::new();
        let read = read_bounded_line(reader, &mut line, header_bytes, max_header_bytes).await?;
        if read == 0 {
            return if header_bytes == 0 {
                Ok(None)
            } else {
                Err(LanguageServerError::InvalidMessage(
                    "transport ended inside a header".into(),
                ))
            };
        }
        header_bytes = header_bytes.saturating_add(read);
        if header_bytes > max_header_bytes {
            return Err(LanguageServerError::MessageTooLarge {
                limit: max_header_bytes,
            });
        }
        if line == b"\r\n" || line == b"\n" {
            break;
        }
        let line = std::str::from_utf8(&line)
            .map_err(|_| LanguageServerError::InvalidMessage("LSP header is not UTF-8".into()))?;
        let Some((name, value)) = line.trim_end().split_once(':') else {
            return Err(LanguageServerError::InvalidMessage(
                "malformed LSP header".into(),
            ));
        };
        if name.eq_ignore_ascii_case("Content-Length") {
            if content_length.is_some() {
                return Err(LanguageServerError::InvalidMessage(
                    "duplicate Content-Length header".into(),
                ));
            }
            content_length = Some(value.trim().parse::<usize>().map_err(|_| {
                LanguageServerError::InvalidMessage("invalid Content-Length header".into())
            })?);
        }
    }
    let content_length = content_length.ok_or_else(|| {
        LanguageServerError::InvalidMessage("missing Content-Length header".into())
    })?;
    if content_length > max_message_bytes {
        return Err(LanguageServerError::MessageTooLarge {
            limit: max_message_bytes,
        });
    }
    let mut body = vec![0; content_length];
    reader
        .read_exact(&mut body)
        .await
        .map_err(LanguageServerError::Transport)?;
    Ok(Some(body))
}

async fn read_bounded_line<R>(
    reader: &mut R,
    line: &mut Vec<u8>,
    previous_bytes: usize,
    total_limit: usize,
) -> Result<usize, LanguageServerError>
where
    R: AsyncBufRead + Unpin,
{
    loop {
        let (take, complete) = {
            let available = reader
                .fill_buf()
                .await
                .map_err(LanguageServerError::Transport)?;
            if available.is_empty() {
                return Ok(line.len());
            }
            match available.iter().position(|byte| *byte == b'\n') {
                Some(index) => (index + 1, true),
                None => (available.len(), false),
            }
        };
        if previous_bytes
            .saturating_add(line.len())
            .saturating_add(take)
            > total_limit
        {
            return Err(LanguageServerError::MessageTooLarge { limit: total_limit });
        }
        let available = reader
            .fill_buf()
            .await
            .map_err(LanguageServerError::Transport)?;
        line.extend_from_slice(&available[..take]);
        reader.consume(take);
        if complete {
            return Ok(line.len());
        }
    }
}

pub(crate) async fn write_frame<W>(
    writer: &mut W,
    message: &[u8],
    max_message_bytes: usize,
) -> Result<(), LanguageServerError>
where
    W: AsyncWrite + Unpin,
{
    if message.len() > max_message_bytes {
        return Err(LanguageServerError::MessageTooLarge {
            limit: max_message_bytes,
        });
    }
    writer
        .write_all(format!("Content-Length: {}\r\n\r\n", message.len()).as_bytes())
        .await
        .map_err(LanguageServerError::Transport)?;
    writer
        .write_all(message)
        .await
        .map_err(LanguageServerError::Transport)?;
    writer.flush().await.map_err(LanguageServerError::Transport)
}

pub(crate) fn connection_closed_io() -> io::Error {
    io::Error::new(
        io::ErrorKind::UnexpectedEof,
        "language server closed stdout",
    )
}

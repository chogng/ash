use ash_arkdown::Buffer;
use base64::Engine;
use base64::engine::general_purpose::STANDARD;
use serde::Deserialize;
use serde::Serialize;

pub(crate) const SCHEMA: &str = "arkdown-markdown-v1";

/// Versioned opaque payload carried by the existing authenticated room protocol.
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Payload {
    format: String,
    version: u8,
    update: String,
}

fn decode(value: &str, limit: usize) -> Result<Vec<u8>, String> {
    if value.len() > limit {
        return Err("Markdown room payload exceeds its size limit".into());
    }
    let payload: Payload =
        serde_json::from_str(value).map_err(|_| "Invalid Markdown room payload")?;
    if payload.format != "ash.arkdown.crdt" || payload.version != 1 {
        return Err("Unsupported Markdown collaboration format".into());
    }
    STANDARD
        .decode(payload.update)
        .map_err(|_| "Invalid Markdown collaboration update encoding".into())
}

pub(crate) fn validate_document(value: &str) -> Result<(), String> {
    let mut document = Buffer::new(1, "").map_err(|error| error.to_string())?;
    document
        .apply_update(&decode(value, crate::room::MAX_DOCUMENT_BYTES)?)
        .map_err(|error| error.to_string())?;
    Ok(())
}

/// The authority derives the canonical snapshot from the prior state and update.
/// It never trusts a submitted optimistic snapshot to discard accepted CRDT IDs.
pub(crate) fn submit(previous: &str, update: &str, proposed: &str) -> Result<String, String> {
    validate_document(proposed)?;
    merge(previous, update)
}

pub(crate) fn merge(previous: &str, update: &str) -> Result<String, String> {
    let mut document = Buffer::new(1, "").map_err(|error| error.to_string())?;
    document
        .apply_update(&decode(previous, crate::room::MAX_DOCUMENT_BYTES)?)
        .map_err(|error| error.to_string())?;
    document
        .apply_update(&decode(update, crate::room::MAX_TRANSACTION_BYTES)?)
        .map_err(|error| error.to_string())?;
    document.compact();
    let snapshot = serde_json::to_string(&Payload {
        format: "ash.arkdown.crdt".into(),
        version: 1,
        update: STANDARD.encode(
            document
                .encode_update(&[])
                .map_err(|error| error.to_string())?,
        ),
    })
    .map_err(|error| error.to_string())?;
    if snapshot.len() > crate::room::MAX_DOCUMENT_BYTES {
        return Err("Markdown room snapshot exceeds its size limit".into());
    }
    Ok(snapshot)
}

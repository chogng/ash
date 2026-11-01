//! Connection-owned, opt-in transport evidence. No execution state or renderer-owned copy.
use super::RpcError;
use ash_app_server_protocol::protocol::diagnostics::WireLogDirection;
use ash_app_server_protocol::protocol::diagnostics::WireLogFrame;
use ash_app_server_protocol::protocol::diagnostics::WireLogFrameKind;
use ash_app_server_protocol::protocol::diagnostics::WireLogPage;
use ash_app_server_protocol::protocol::diagnostics::WireLogParams;
use ash_app_server_protocol::protocol::diagnostics::WireLogReadParams;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use serde_json::Value;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::VecDeque;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

const MAX_FRAMES: usize = 2000;
const MAX_BYTES: usize = 2 * 1024 * 1024;
const MAX_FRAME_BYTES: usize = 64 * 1024;
const PAGE_BYTES: usize = 256 * 1024;
const PREFIX: &str = "diagnostics/wireLog/";

#[derive(Debug, Default)]
pub(super) struct WireLog {
    capture: Option<Capture>,
    // Control replies have no method. Remember only their positive integer request IDs.
    excluded: BTreeSet<u64>,
    closed: bool,
}

#[derive(Debug)]
struct Capture {
    id: String,
    recording: bool,
    next: u64,
    bytes: usize,
    dropped: u64,
    frames: VecDeque<WireLogFrame>,
    // Direction belongs in the key: either endpoint can issue the same identifier.
    pending: BTreeMap<(bool, String), PendingRequest>,
}

// Replayed IDs can produce an error reply before the original request finishes.
// Once ambiguous, keep that ID unpaired while its latest request remains in the capture.
#[derive(Debug)]
enum PendingRequest {
    Unique {
        sequence: u64,
        started: Instant,
        method: Option<String>,
    },
    Ambiguous {
        sequence: u64,
    },
}

impl PendingRequest {
    fn sequence(&self) -> u64 {
        match self {
            Self::Unique { sequence, .. } | Self::Ambiguous { sequence } => *sequence,
        }
    }
}

fn invalid() -> RpcError {
    RpcError::new(-32602, AppServerErrorName::InvalidParams)
}
fn missing() -> RpcError {
    RpcError::new(-32004, AppServerErrorName::ResourceNotFound)
}

impl WireLog {
    pub(super) fn start(&mut self, params: &WireLogParams) -> Result<(), RpcError> {
        if self.closed {
            return Err(missing());
        }
        if params.capture_id.is_empty()
            || params.capture_id.len() > 128
            || !params
                .capture_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return Err(invalid());
        }
        if self
            .capture
            .as_ref()
            .is_some_and(|c| c.recording || c.id == params.capture_id)
        {
            return Err(RpcError::new(-32600, AppServerErrorName::InvalidRequest));
        }
        self.capture = Some(Capture {
            id: params.capture_id.clone(),
            recording: true,
            next: 1,
            bytes: 0,
            dropped: 0,
            frames: VecDeque::new(),
            pending: BTreeMap::new(),
        });
        Ok(())
    }

    pub(super) fn stop(&mut self, params: &WireLogParams) -> Result<(), RpcError> {
        let capture = self
            .capture
            .as_mut()
            .filter(|c| c.id == params.capture_id)
            .ok_or_else(missing)?;
        capture.recording = false;
        capture.pending.clear();
        Ok(())
    }

    pub(super) fn read(
        &self,
        connection_id: u64,
        params: &WireLogReadParams,
    ) -> Result<WireLogPage, RpcError> {
        let capture = self
            .capture
            .as_ref()
            .filter(|c| c.id == params.capture_id)
            .ok_or_else(missing)?;
        if params.limit == 0 || params.limit > 100 || params.after >= capture.next {
            return Err(invalid());
        }
        let mut bytes = 0;
        let frames: Vec<_> = capture
            .frames
            .iter()
            .filter(|f| f.sequence > params.after)
            .take(params.limit as usize)
            .take_while(|f| {
                bytes += f.raw.len();
                bytes <= PAGE_BYTES
            })
            .cloned()
            .collect();
        let cursor = frames.last().map_or(params.after, |f| f.sequence);
        Ok(WireLogPage {
            capture_id: capture.id.clone(),
            connection_id: connection_id.to_string(),
            recording: capture.recording,
            frames,
            cursor,
            has_more: cursor < capture.next - 1,
            dropped_frames: capture.dropped,
        })
    }

    pub(super) fn close(&mut self) {
        self.closed = true;
        self.capture = None;
        self.excluded.clear();
    }

    pub(super) fn received(&mut self, raw: &str, envelope: &Value) {
        if self.closed {
            return;
        }
        if envelope
            .get("method")
            .and_then(Value::as_str)
            .is_some_and(|m| m.starts_with(PREFIX))
        {
            if let Some(id) = envelope.get("id").and_then(Value::as_u64) {
                self.excluded.insert(id);
            }
            return;
        }
        self.record(raw, envelope, WireLogDirection::ClientToServer);
    }

    pub(super) fn sent(&mut self, raw: &str) {
        if !self
            .capture
            .as_ref()
            .is_some_and(|capture| capture.recording)
            && self.excluded.is_empty()
        {
            return;
        }
        let Ok(envelope) = serde_json::from_str::<Value>(raw) else {
            return;
        };
        if envelope.get("method").is_none()
            && envelope
                .get("id")
                .and_then(Value::as_u64)
                .is_some_and(|id| self.excluded.remove(&id))
        {
            return;
        }
        self.record(raw, &envelope, WireLogDirection::ServerToClient);
    }

    fn record(&mut self, raw: &str, envelope: &Value, direction: WireLogDirection) {
        let Some(capture) = self.capture.as_mut().filter(|c| c.recording) else {
            return;
        };
        // Metadata is bounded independently of the raw prefix, including malformed envelopes.
        let id = match envelope.get("id") {
            Some(Value::Number(id)) => Some(id.to_string()),
            Some(Value::String(id)) if id.len() <= 512 => {
                Some(serde_json::to_string(id).expect("string serializes"))
            }
            Some(Value::Null) => Some("null".to_owned()),
            _ => None,
        };
        let method_value = envelope.get("method").and_then(Value::as_str);
        let method = method_value
            .filter(|method| method.len() <= 512)
            .map(str::to_owned);
        let kind = match (method_value, envelope.get("id")) {
            (Some(_), Some(_)) => WireLogFrameKind::Request,
            (Some(_), None) => WireLogFrameKind::Notification,
            _ => WireLogFrameKind::Response,
        };
        let outgoing = direction == WireLogDirection::ServerToClient;
        let sequence = capture.next;
        capture.next += 1;
        let mut request_sequence = None;
        let mut elapsed_ms = None;
        let mut paired_method = method.clone();
        if let Some(id) = &id {
            match kind {
                WireLogFrameKind::Request => {
                    let key = (outgoing, id.clone());
                    let pending = if capture.pending.contains_key(&key) {
                        PendingRequest::Ambiguous { sequence }
                    } else {
                        PendingRequest::Unique {
                            sequence,
                            started: Instant::now(),
                            method: method.clone(),
                        }
                    };
                    capture.pending.insert(key, pending);
                }
                WireLogFrameKind::Response => {
                    let key = (!outgoing, id.clone());
                    match capture.pending.remove(&key) {
                        Some(PendingRequest::Unique {
                            sequence,
                            started,
                            method,
                        }) => {
                            request_sequence = Some(sequence);
                            elapsed_ms = Some(started.elapsed().as_millis() as u64);
                            paired_method = method;
                        }
                        Some(ambiguous @ PendingRequest::Ambiguous { .. }) => {
                            capture.pending.insert(key, ambiguous);
                        }
                        None => {}
                    }
                }
                WireLogFrameKind::Notification => {}
            }
        }
        let mut end = raw.len().min(MAX_FRAME_BYTES);
        while !raw.is_char_boundary(end) {
            end -= 1;
        }
        let frame = WireLogFrame {
            sequence,
            timestamp_ms: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
            direction,
            kind,
            request_id: id,
            method: paired_method,
            request_sequence,
            elapsed_ms,
            is_error: envelope.get("error").is_some(),
            byte_length: raw.len() as u32,
            truncated: end < raw.len(),
            raw: raw[..end].to_owned(),
        };
        capture.bytes += frame.raw.len();
        capture.frames.push_back(frame);
        while capture.bytes > MAX_BYTES || capture.frames.len() > MAX_FRAMES {
            let removed = capture
                .frames
                .pop_front()
                .expect("nonempty bounded capture");
            capture.bytes -= removed.raw.len();
            capture.dropped += 1;
            if let Some(id) = removed.request_id {
                let key = (removed.direction == WireLogDirection::ServerToClient, id);
                if capture
                    .pending
                    .get(&key)
                    .is_some_and(|pending| pending.sequence() == removed.sequence)
                {
                    capture.pending.remove(&key);
                }
            }
        }
    }
}

#[cfg(test)]
#[path = "wire_log_tests.rs"]
mod tests;

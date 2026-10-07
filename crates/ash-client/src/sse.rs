use crate::ClientError;
use std::time::Duration;

/// A decoded Server-Sent Event with provider-neutral field values.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SseEvent {
    pub event: Option<String>,
    pub data: String,
    pub id: Option<String>,
    pub retry: Option<Duration>,
}

/// One frame from a WHATWG Server-Sent Events stream.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SseFrame {
    Event(SseEvent),
    Comment,
}

/// Incrementally frames a UTF-8 SSE byte stream without interpreting provider
/// event names or `data` JSON.
pub struct SseDecoder {
    pending_bytes: Vec<u8>,
    event: PendingEvent,
    last_event_id: Option<String>,
    retry: Option<Duration>,
    max_event_bytes: usize,
}

impl SseDecoder {
    /// Creates a decoder that rejects one accumulated event over the supplied
    /// byte limit.
    pub fn new(max_event_bytes: usize) -> Result<Self, ClientError> {
        if max_event_bytes == 0 {
            return Err(ClientError::InvalidRequest(
                "SSE event size limit must be greater than zero".into(),
            ));
        }
        Ok(Self {
            pending_bytes: Vec::new(),
            event: PendingEvent::default(),
            last_event_id: None,
            retry: None,
            max_event_bytes,
        })
    }

    /// Decodes every complete frame available after appending a transport byte
    /// chunk. A final unterminated line is retained until more bytes arrive.
    pub fn push(&mut self, bytes: &[u8]) -> Result<Vec<SseFrame>, ClientError> {
        self.pending_bytes.extend_from_slice(bytes);
        let mut frames = Vec::new();

        while let Some((line_end, delimiter_length)) = find_line_end(&self.pending_bytes) {
            let line = self.pending_bytes[..line_end].to_vec();
            self.pending_bytes.drain(..line_end + delimiter_length);
            self.process_line(&line, &mut frames)?;
        }

        if self.pending_bytes.len() > self.max_event_bytes {
            return Err(frame_too_large());
        }
        Ok(frames)
    }

    /// Validates that a stream ended between events.
    pub fn finish(self) -> Result<(), ClientError> {
        if self.pending_bytes.is_empty() && self.event.is_empty() {
            Ok(())
        } else {
            Err(ClientError::Framing(
                "SSE stream ended with an unterminated event".into(),
            ))
        }
    }

    fn process_line(&mut self, line: &[u8], frames: &mut Vec<SseFrame>) -> Result<(), ClientError> {
        self.event.record_line(line.len(), self.max_event_bytes)?;
        let line = std::str::from_utf8(line)
            .map_err(|_| ClientError::Framing("SSE stream is not valid UTF-8".into()))?;
        if line.is_empty() {
            if let Some(data) = self.event.take_data() {
                frames.push(SseFrame::Event(SseEvent {
                    event: self.event.event.take(),
                    data,
                    id: self.last_event_id.clone(),
                    retry: self.retry,
                }));
            }
            self.event.reset();
            return Ok(());
        }
        if line.starts_with(':') {
            frames.push(SseFrame::Comment);
            return Ok(());
        }

        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => self.event.event = Some(value.into()),
            "data" => self.event.data.push(value.into()),
            "id" if !value.contains('\0') => self.last_event_id = Some(value.into()),
            "retry" => self.retry = value.parse::<u64>().ok().map(Duration::from_millis),
            _ => {}
        }
        Ok(())
    }
}

#[derive(Default)]
struct PendingEvent {
    event: Option<String>,
    data: Vec<String>,
    byte_len: usize,
}

impl PendingEvent {
    fn is_empty(&self) -> bool {
        self.event.is_none() && self.data.is_empty()
    }

    fn record_line(&mut self, line_len: usize, max_event_bytes: usize) -> Result<(), ClientError> {
        self.byte_len = self.byte_len.saturating_add(line_len.saturating_add(1));
        if self.byte_len > max_event_bytes {
            return Err(frame_too_large());
        }
        Ok(())
    }

    fn take_data(&mut self) -> Option<String> {
        (!self.data.is_empty()).then(|| std::mem::take(&mut self.data).join("\n"))
    }

    fn reset(&mut self) {
        self.event = None;
        self.data.clear();
        self.byte_len = 0;
    }
}

fn find_line_end(bytes: &[u8]) -> Option<(usize, usize)> {
    let index = bytes
        .iter()
        .position(|byte| matches!(byte, b'\r' | b'\n'))?;
    if bytes[index] == b'\r' && index + 1 == bytes.len() {
        return None;
    }
    let delimiter_length = if bytes[index] == b'\r' && bytes.get(index + 1) == Some(&b'\n') {
        2
    } else {
        1
    };
    Some((index, delimiter_length))
}

fn frame_too_large() -> ClientError {
    ClientError::Framing("SSE event exceeds the configured size limit".into())
}

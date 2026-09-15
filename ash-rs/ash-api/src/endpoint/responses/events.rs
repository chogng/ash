use crate::ApiError;
use ash_client::{SseEvent, SseFrame};
use ash_protocol::ModelStreamEvent;
use serde_json::Value;
use std::collections::BTreeMap;

/// Decodes already-framed OpenAI Responses events into canonical deltas.
///
/// This decoder owns event-schema validation and terminal lifecycle checks. It
/// intentionally does not own connection state, SSE framing, retry, or stream
/// resumption; those remain client/runtime concerns.
pub struct ResponsesEventDecoder {
    terminal: bool,
    response: Option<Value>,
    output: BTreeMap<u64, Value>,
}

impl Default for ResponsesEventDecoder {
    fn default() -> Self {
        Self::new()
    }
}

impl ResponsesEventDecoder {
    pub fn new() -> Self {
        Self {
            terminal: false,
            response: None,
            output: BTreeMap::new(),
        }
    }

    pub fn decode(&mut self, frame: &SseFrame) -> Result<Vec<ModelStreamEvent>, ApiError> {
        let SseFrame::Event(event) = frame else {
            return Ok(Vec::new());
        };
        if self.terminal {
            return Err(ApiError::InvalidResponse(
                "OpenAI response stream emitted an event after its terminal event".into(),
            ));
        }
        self.decode_event(event)
    }

    /// Verifies that the stream ended after a protocol terminal event.
    pub fn finish(self) -> Result<(), ApiError> {
        if self.terminal {
            Ok(())
        } else {
            Err(ApiError::InvalidResponse(
                "OpenAI response stream ended before a terminal event".into(),
            ))
        }
    }

    /// Combines completed output items with terminal response metadata.
    pub fn finish_response(mut self) -> Result<Value, ApiError> {
        if !self.terminal {
            return Err(ApiError::InvalidResponse(
                "OpenAI response stream ended before a terminal event".into(),
            ));
        }
        let mut response = self.response.ok_or_else(|| {
            ApiError::InvalidResponse(
                "OpenAI response.completed event is missing its response".into(),
            )
        })?;
        let object = response.as_object_mut().ok_or_else(|| {
            ApiError::InvalidResponse("OpenAI terminal response must be an object".into())
        })?;
        // Some Responses endpoints repeat the items in the terminal snapshot; others
        // send only metadata there. Merge by output index without duplicating items.
        if let Some(snapshot) = object.remove("output") {
            let items = snapshot.as_array().ok_or_else(|| {
                ApiError::InvalidResponse("OpenAI response output must be an array".into())
            })?;
            for (index, item) in items.iter().enumerate() {
                if let Some(completed) = self.output.insert(index as u64, item.clone())
                    && completed != *item
                {
                    return Err(ApiError::InvalidResponse(
                        "OpenAI terminal output conflicts with its completed item".into(),
                    ));
                }
            }
        }
        if self.output.keys().copied().ne(0..self.output.len() as u64) {
            return Err(ApiError::InvalidResponse(
                "OpenAI response output indices are not contiguous".into(),
            ));
        }
        object.insert(
            "output".into(),
            Value::Array(self.output.into_values().collect()),
        );
        Ok(response)
    }

    fn decode_event(&mut self, event: &SseEvent) -> Result<Vec<ModelStreamEvent>, ApiError> {
        let payload: Value = serde_json::from_str(&event.data).map_err(|_| {
            ApiError::InvalidResponse("OpenAI response stream event contains invalid JSON".into())
        })?;
        let event_type = payload
            .get("type")
            .and_then(Value::as_str)
            .or(event.event.as_deref())
            .ok_or_else(|| {
                ApiError::InvalidResponse("OpenAI response stream event is missing its type".into())
            })?;

        self.apply(&payload, event_type)
    }

    /// Decodes one JSON event shared by Responses HTTP and WebSocket transports.
    pub fn decode_json(&mut self, payload: &Value) -> Result<Vec<ModelStreamEvent>, ApiError> {
        if self.terminal {
            return Err(ApiError::InvalidResponse(
                "Responses event followed a terminal event".into(),
            ));
        }
        let event_type = payload.get("type").and_then(Value::as_str).ok_or_else(|| {
            ApiError::InvalidResponse("Responses event is missing its type".into())
        })?;
        self.apply(payload, event_type)
    }

    pub(crate) fn is_terminal(&self) -> bool {
        self.terminal
    }

    fn apply(
        &mut self,
        payload: &Value,
        event_type: &str,
    ) -> Result<Vec<ModelStreamEvent>, ApiError> {
        match event_type {
            "response.output_item.done" => {
                let index = payload
                    .get("output_index")
                    .and_then(Value::as_u64)
                    .ok_or_else(|| {
                        ApiError::InvalidResponse(
                            "OpenAI completed output item is missing output_index".into(),
                        )
                    })?;
                let item = payload
                    .get("item")
                    .filter(|item| item.is_object())
                    .ok_or_else(|| {
                        ApiError::InvalidResponse(
                            "OpenAI completed output item is missing its item object".into(),
                        )
                    })?;
                if self.output.insert(index, item.clone()).is_some() {
                    return Err(ApiError::InvalidResponse(
                        "OpenAI response repeated a completed output index".into(),
                    ));
                }
                Ok(Vec::new())
            }
            "response.output_text.delta" => Ok(vec![ModelStreamEvent::TextDelta(
                required_delta(&payload, event_type)?.into(),
            )]),
            "response.reasoning_summary_text.delta" => Ok(vec![ModelStreamEvent::ReasoningDelta(
                required_delta(&payload, event_type)?.into(),
            )]),
            "response.completed" => {
                self.terminal = true;
                self.response = payload.get("response").cloned();
                Ok(Vec::new())
            }
            "response.failed" | "response.incomplete" | "error" => {
                Err(crate::requests::stream_error(&payload.to_string()))
            }
            _ => Ok(Vec::new()),
        }
    }
}

fn required_delta<'a>(payload: &'a Value, event_type: &str) -> Result<&'a str, ApiError> {
    payload.get("delta").and_then(Value::as_str).ok_or_else(|| {
        ApiError::InvalidResponse(format!(
            "OpenAI stream event '{event_type}' is missing delta"
        ))
    })
}

#[cfg(test)]
#[path = "events_tests.rs"]
mod tests;

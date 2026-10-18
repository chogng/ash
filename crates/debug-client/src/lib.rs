//! Transport-independent DAP request ownership. The manager supplies ordered IO;
//! clients never discover executables or retain editor/window objects.

use std::collections::HashMap;
use std::time::Duration;
use std::time::Instant;

use serde_json::Value;
use serde_json::json;

const MAX_REQUESTS: usize = 128;
const MAX_SAFE_SEQUENCE: u64 = 9_007_199_254_740_991;

#[derive(Debug, thiserror::Error)]
pub enum DebugClientError {
    #[error("invalid DAP message")]
    InvalidMessage,
    #[error("DAP request capacity exceeded")]
    Capacity,
    #[error("DAP client has closed")]
    Closed,
    #[error("DAP request was not found")]
    UnknownRequest,
}

/// A response is consumed once. Keeping its original object preserves omitted
/// bodies, explicit JSON null, adapter errors and extension-specific fields.
#[derive(Debug)]
pub enum DebugResponse {
    Pending,
    Complete(Value),
    Failed(String),
}

enum PendingRequest {
    Waiting { command: String, deadline: Instant },
    Complete(Value),
    Failed(String),
}

/// One sequence space and pending table shared by every transport of a session.
/// Adapter sequence numbers are independent and may legitimately start at zero.
pub struct DebugClient {
    next_sequence: u64,
    requests: HashMap<u64, PendingRequest>,
    reverse_requests: HashMap<u64, String>,
    timeout: Duration,
    closed: bool,
}

impl DebugClient {
    pub fn new(timeout: Duration) -> Self {
        Self {
            next_sequence: 1,
            requests: HashMap::new(),
            reverse_requests: HashMap::new(),
            timeout,
            closed: false,
        }
    }

    /// Register before sending so synchronous adapters cannot race the waiter.
    pub fn request(
        &mut self,
        command: &str,
        arguments: Option<Value>,
    ) -> Result<(u64, Value), DebugClientError> {
        validate_name(command)?;
        if self.closed {
            return Err(DebugClientError::Closed);
        }
        self.expire();
        if self.requests.len() >= MAX_REQUESTS {
            return Err(DebugClientError::Capacity);
        }
        let seq = self.sequence()?;
        let mut message = json!({ "seq": seq, "type": "request", "command": command });
        if let Some(arguments) = arguments {
            message["arguments"] = arguments;
        }
        self.requests.insert(
            seq,
            PendingRequest::Waiting {
                command: command.to_owned(),
                deadline: Instant::now() + self.timeout,
            },
        );
        Ok((seq, message))
    }

    /// Validate the untrusted adapter envelope and pair responses by request_seq,
    /// never by the adapter's own seq. Timed-out or cancelled replies are ignored.
    pub fn accept(&mut self, message: &Value) -> Result<(), DebugClientError> {
        if self.closed {
            return Err(DebugClientError::Closed);
        }
        sequence(message, "seq")?;
        match message.get("type").and_then(Value::as_str) {
            Some("response") => {
                let request_id = sequence(message, "request_seq")?;
                let command = name(message, "command")?;
                if !message.get("success").is_some_and(Value::is_boolean) {
                    return Err(DebugClientError::InvalidMessage);
                }
                self.expire();
                if let Some(PendingRequest::Waiting {
                    command: expected, ..
                }) = self.requests.get(&request_id)
                {
                    if command != expected {
                        return Err(DebugClientError::InvalidMessage);
                    }
                    self.requests
                        .insert(request_id, PendingRequest::Complete(message.clone()));
                }
            }
            Some("event") => {
                name(message, "event")?;
            }
            Some("request") => {
                let id = sequence(message, "seq")?;
                let command = name(message, "command")?;
                if self.reverse_requests.contains_key(&id) {
                    return Err(DebugClientError::InvalidMessage);
                }
                if self.reverse_requests.len() >= MAX_REQUESTS {
                    return Err(DebugClientError::Capacity);
                }
                self.reverse_requests.insert(id, command.to_owned());
            }
            _ => return Err(DebugClientError::InvalidMessage),
        }
        Ok(())
    }

    /// Only a reply to an outstanding reverse request may be supplied by a host.
    /// Allocate its outgoing seq here as well, keeping a single writer identity.
    pub fn reply(&mut self, mut response: Value) -> Result<Value, DebugClientError> {
        if self.closed {
            return Err(DebugClientError::Closed);
        }
        let id = sequence(&response, "request_seq")?;
        let command = name(&response, "command")?;
        if response.get("type").and_then(Value::as_str) != Some("response")
            || !response.get("success").is_some_and(Value::is_boolean)
            || self.reverse_requests.get(&id).map(String::as_str) != Some(command)
        {
            return Err(DebugClientError::InvalidMessage);
        }
        response["seq"] = self.sequence()?.into();
        self.reverse_requests.remove(&id);
        Ok(response)
    }

    pub fn response(&mut self, id: u64) -> Result<DebugResponse, DebugClientError> {
        self.expire();
        match self.requests.remove(&id) {
            Some(waiting @ PendingRequest::Waiting { .. }) => {
                self.requests.insert(id, waiting);
                Ok(DebugResponse::Pending)
            }
            Some(PendingRequest::Complete(value)) => Ok(DebugResponse::Complete(value)),
            Some(PendingRequest::Failed(message)) => Ok(DebugResponse::Failed(message)),
            None => Err(DebugClientError::UnknownRequest),
        }
    }

    /// Failing a session settles every waiter without replaying side effects.
    pub fn close(&mut self, reason: &str) {
        self.closed = true;
        self.reverse_requests.clear();
        for request in self.requests.values_mut() {
            if matches!(request, PendingRequest::Waiting { .. }) {
                *request = PendingRequest::Failed(reason.to_owned());
            }
        }
    }

    fn sequence(&mut self) -> Result<u64, DebugClientError> {
        if self.next_sequence > MAX_SAFE_SEQUENCE {
            return Err(DebugClientError::Capacity);
        }
        let sequence = self.next_sequence;
        self.next_sequence += 1;
        Ok(sequence)
    }

    fn expire(&mut self) {
        let now = Instant::now();
        for request in self.requests.values_mut() {
            if let PendingRequest::Waiting { command, deadline } = request {
                if now >= *deadline {
                    *request = PendingRequest::Failed(format!(
                        "Debug adapter '{command}' request timed out"
                    ));
                }
            }
        }
    }
}

fn sequence(message: &Value, field: &str) -> Result<u64, DebugClientError> {
    message
        .get(field)
        .and_then(Value::as_u64)
        .filter(|value| *value <= MAX_SAFE_SEQUENCE)
        .ok_or(DebugClientError::InvalidMessage)
}

fn name<'a>(message: &'a Value, field: &str) -> Result<&'a str, DebugClientError> {
    let value = message
        .get(field)
        .and_then(Value::as_str)
        .ok_or(DebugClientError::InvalidMessage)?;
    validate_name(value)?;
    Ok(value)
}

fn validate_name(value: &str) -> Result<(), DebugClientError> {
    if value.is_empty() || value.len() > 256 || value.contains('\0') {
        return Err(DebugClientError::InvalidMessage);
    }
    Ok(())
}

#[cfg(test)]
#[path = "client_tests.rs"]
mod tests;

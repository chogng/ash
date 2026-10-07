use crate::ExecEvent;
use std::fmt;
use std::io::Write;

/// Receives ordered lifecycle events for one run.
///
/// Implementations should either accept an entire event or return an error. The runner never
/// retries a sink write because doing so could duplicate externally visible machine events.
pub trait ExecEventSink {
    fn emit(&mut self, event: &ExecEvent) -> Result<(), ExecSinkError>;
}

impl<F> ExecEventSink for F
where
    F: FnMut(&ExecEvent) -> Result<(), ExecSinkError>,
{
    fn emit(&mut self, event: &ExecEvent) -> Result<(), ExecSinkError> {
        self(event)
    }
}

/// Sink used by callers that need only the returned [`crate::ExecOutcome`].
#[derive(Clone, Copy, Debug, Default)]
pub struct DiscardExecEventSink;

impl ExecEventSink for DiscardExecEventSink {
    fn emit(&mut self, _event: &ExecEvent) -> Result<(), ExecSinkError> {
        Ok(())
    }
}

/// Writes one complete serialized event per line and flushes after each event.
pub struct JsonLinesExecEventSink<W> {
    writer: W,
}

impl<W> JsonLinesExecEventSink<W> {
    pub fn new(writer: W) -> Self {
        Self { writer }
    }

    pub fn into_inner(self) -> W {
        self.writer
    }
}

impl<W: Write> ExecEventSink for JsonLinesExecEventSink<W> {
    fn emit(&mut self, event: &ExecEvent) -> Result<(), ExecSinkError> {
        serde_json::to_writer(&mut self.writer, event)
            .map_err(|error| ExecSinkError::new(error.to_string()))?;
        self.writer
            .write_all(b"\n")
            .and_then(|()| self.writer.flush())
            .map_err(|error| ExecSinkError::new(error.to_string()))
    }
}

/// Stable error boundary for event serialization or delivery failures.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecSinkError {
    message: String,
}

impl ExecSinkError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for ExecSinkError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ExecSinkError {}

#[cfg(test)]
#[path = "output_tests.rs"]
mod tests;

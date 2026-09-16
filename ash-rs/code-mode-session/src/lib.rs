//! Shared Code Mode session state and tool invocation contracts, without a JavaScript engine.

mod output;
mod store;

use ash_code_mode_protocol::CellId;
use ash_code_mode_protocol::NestedToolCall;
use ash_code_mode_protocol::RuntimeNotification;
use serde_json::Value;

pub use output::limit_output;
pub use store::CodeModeStore;
pub use store::validate_values;

/// Bridge from JavaScript to Core's durable tool broker.
///
/// The runtime calls this method on a worker thread and resolves the JavaScript Promise back on
/// the owning V8 thread. Implementations may therefore block for approval or Tool completion
/// without blocking the cell, and independent calls may execute concurrently.
pub trait ToolInvoker: Send + Sync {
    /// Executes one projected ordinary tool call. The implementation owns approval, audit,
    /// cancellation, and durable outcome handling; the runtime only supplies the call payload.
    fn invoke(&self, call: NestedToolCall) -> Result<Value, String>;

    /// Publishes a bounded transient notification without exposing the underlying transport.
    fn notify(&self, _: RuntimeNotification) -> Result<(), String> {
        Ok(())
    }

    /// Cancels every nested call owned by this runtime session.
    fn cancel(&self) {}

    /// Cancels nested calls currently owned by one cell.
    fn cancel_cell(&self, _: &CellId) {}
}

/// Errors returned by a Code Mode session.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RuntimeError {
    Initialization(String),
    InvalidRequest(String),
    CellNotFound(CellId),
    ChannelClosed,
    Runtime(String),
}

impl std::fmt::Display for RuntimeError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Initialization(message)
            | Self::InvalidRequest(message)
            | Self::Runtime(message) => formatter.write_str(message),
            Self::CellNotFound(cell_id) => write!(formatter, "Code Mode cell not found: {cell_id}"),
            Self::ChannelClosed => formatter.write_str("Code Mode runtime channel closed"),
        }
    }
}

impl std::error::Error for RuntimeError {}

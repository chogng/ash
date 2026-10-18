//! Local diagnostic recording and serializable views of one Session tree's Thread rollouts.
//!
//! A trace groups Thread streams by the `session_id` recorded on each root event. It is an
//! inspection artifact, never a second authority or an input to runtime decisions. Raw durable
//! events can contain sensitive user and tool data. Diagnostic writes are local and opt-in;
//! artifact assembly belongs to this domain; connection authorization and file output remain
//! owned by its product callers.

mod budget;
mod diagnostics;
mod error;
mod export;
mod overview;
mod page;
mod reader;
mod recorder;
mod reducer;
mod trace;
mod worker;

pub use diagnostics::DIAGNOSTIC_TRACE_FORMAT_VERSION;
pub use diagnostics::DiagnosticError;
pub use diagnostics::DiagnosticEvent;
pub use diagnostics::DiagnosticEventKind;
pub use diagnostics::DiagnosticPage;
pub use diagnostics::DiagnosticTrace;
pub use diagnostics::InferenceContext;
pub use diagnostics::InferencePurpose;
pub use diagnostics::PayloadKind;
pub use diagnostics::PayloadRef;
pub use diagnostics::PayloadStatus;
pub use diagnostics::RecordingStatus;
pub use error::RolloutTraceError;
pub use export::TraceExportError;
pub use export::TraceExportSource;
pub use export::export_session_trace;
pub use overview::TraceMetric;
pub use overview::TraceOverview;
pub use page::TracePage;
pub use page::read_session_trace_page;
pub use reader::TraceReader;
pub use recorder::MAX_PAYLOAD_BYTES;
pub use recorder::ModelAttemptTrace;
pub use recorder::RecorderState;
pub use recorder::TRACE_ROOT_ENV;
pub use recorder::TraceRecorder;
pub use reducer::TraceEdge;
pub use reducer::TraceEdgeKind;
pub use reducer::TraceGraph;
pub use reducer::TraceNode;
pub use reducer::TraceNodeKind;
pub use reducer::reduce_trace;
pub use trace::ROLLOUT_TRACE_FORMAT_VERSION;
pub use trace::RolloutTrace;
pub use trace::ThreadRolloutTrace;
pub use trace::capture_session_trace;
pub use worker::FlushOutcome;

#[cfg(test)]
#[path = "trace_tests.rs"]
mod tests;

#[cfg(test)]
mod reducer_tests;

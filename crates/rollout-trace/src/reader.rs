use crate::TraceRecorder;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_thread_store::ThreadHistoryReader;
use core_api::CoreError;
use std::collections::BTreeMap;
use std::sync::Arc;

/// Authorized read-only diagnostics over the existing canonical history and profile recorder.
/// The App Server owns this service; Core never builds graphs or opens diagnostic files.
pub struct TraceReader {
    history: Arc<dyn ThreadHistoryReader>,
    trace_recorder: Arc<TraceRecorder>,
}

impl TraceReader {
    pub fn new(history: Arc<dyn ThreadHistoryReader>, trace_recorder: Arc<TraceRecorder>) -> Self {
        Self {
            history,
            trace_recorder,
        }
    }
    fn require_session(&self, session_id: &SessionId) -> Result<(), CoreError> {
        if self.history.session_catalog(session_id)?.is_empty() {
            return Err(CoreError::NotFound(session_id.to_string()));
        }
        Ok(())
    }
    /// Reads the canonical store; the returned artifact never becomes a second state owner.
    pub fn read_session_trace(
        &self,
        session_id: &SessionId,
    ) -> Result<crate::RolloutTrace, CoreError> {
        crate::capture_session_trace(self.history.as_ref(), session_id).map_err(|error| match error
        {
            crate::RolloutTraceError::InvalidParameters(message) => {
                CoreError::InvalidInput(message)
            }
            crate::RolloutTraceError::SessionNotFound(id) => CoreError::NotFound(id.to_string()),
            crate::RolloutTraceError::ThreadList(source)
            | crate::RolloutTraceError::ThreadStore { source, .. } => {
                CoreError::ThreadStore(source)
            }
        })
    }

    pub fn read_session_trace_page(
        &self,
        session_id: &SessionId,
        after: &BTreeMap<ThreadId, u64>,
        limit: usize,
    ) -> Result<crate::TracePage, CoreError> {
        crate::read_session_trace_page(self.history.as_ref(), session_id, after, limit).map_err(
            |error| match error {
                crate::RolloutTraceError::InvalidParameters(message) => {
                    CoreError::InvalidInput(message)
                }
                crate::RolloutTraceError::SessionNotFound(id) => {
                    CoreError::NotFound(id.to_string())
                }
                crate::RolloutTraceError::ThreadList(source)
                | crate::RolloutTraceError::ThreadStore { source, .. } => {
                    CoreError::ThreadStore(source)
                }
            },
        )
    }

    pub fn read_trace_diagnostics(
        &self,
        session_id: &SessionId,
        after: u64,
        limit: usize,
    ) -> Result<crate::DiagnosticPage, CoreError> {
        self.require_session(session_id)?;
        self.trace_recorder
            .read(session_id, after, limit)
            .map_err(diagnostic_error)
    }

    pub fn read_trace_payload(
        &self,
        session_id: &SessionId,
        capture_id: &str,
        payload_id: &str,
    ) -> Result<serde_json::Value, CoreError> {
        self.require_session(session_id)?;
        self.trace_recorder
            .read_payload(session_id, capture_id, payload_id)
            .map_err(diagnostic_error)
    }

    pub fn read_trace_graph(&self, session_id: &SessionId) -> Result<crate::TraceGraph, CoreError> {
        let trace = self.read_session_trace(session_id)?;
        let mut diagnostics = self
            .trace_recorder
            .read(session_id, 0, 500)
            .map_err(diagnostic_error)?;
        while diagnostics.has_more {
            let page = self
                .trace_recorder
                .read(session_id, diagnostics.cursor, 500)
                .map_err(diagnostic_error)?;
            diagnostics
                .diagnostics
                .events
                .extend(page.diagnostics.events);
            diagnostics.cursor = page.cursor;
            diagnostics.has_more = page.has_more;
        }
        let capture = diagnostics.diagnostics.capture_id.as_deref().unwrap_or("");
        let mut graph = crate::reduce_trace(&trace, &diagnostics.diagnostics, |reference| {
            self.trace_recorder
                .read_payload(session_id, capture, &reference.payload_id)
                .map_err(|error| error.to_string())
        });
        if diagnostics.diagnostics.recording_status == crate::RecordingStatus::Unavailable {
            graph
                .warnings
                .push("diagnostic recording unavailable".into());
        }
        if diagnostics.diagnostics.recording_status == crate::RecordingStatus::Incomplete {
            graph.warnings.push(format!(
                "diagnostic evidence incomplete: {} dropped, {} pending",
                diagnostics.diagnostics.dropped_records, diagnostics.diagnostics.pending_records
            ));
        }
        Ok(graph)
    }
}

fn diagnostic_error(error: crate::DiagnosticError) -> CoreError {
    match error {
        crate::DiagnosticError::InvalidParameters(message) => CoreError::InvalidInput(message),
        crate::DiagnosticError::NotFound => CoreError::NotFound(error.to_string()),
        crate::DiagnosticError::CaptureChanged => CoreError::InvalidInput(error.to_string()),
        crate::DiagnosticError::Storage(message) => CoreError::Journal(message),
        crate::DiagnosticError::Busy => CoreError::Journal(error.to_string()),
    }
}

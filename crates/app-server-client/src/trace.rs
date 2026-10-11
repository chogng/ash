use crate::AppServerClient;
use crate::ClientError;
use crate::JsonRpcTransport;
use ash_app_server_protocol::protocol::session::SessionTraceDiagnosticsReadParams;
use ash_app_server_protocol::protocol::session::SessionTracePayloadReadParams;
use ash_app_server_protocol::protocol::session::SessionTraceReadParams;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_rollout_trace::DiagnosticPage;
use ash_rollout_trace::RolloutTrace;
use ash_rollout_trace::TraceExportError;
use ash_rollout_trace::TraceExportSource;
use ash_rollout_trace::TracePage;
use serde_json::Value;
use std::collections::BTreeMap;

impl<T: JsonRpcTransport> AppServerClient<T> {
    /// Exports authorized history and optional evidence through the shared Trace domain contract.
    pub fn export_session_trace(
        &mut self,
        session_id: &SessionId,
    ) -> Result<RolloutTrace, ClientError> {
        ash_rollout_trace::export_session_trace(self, session_id).map_err(|error| match error {
            TraceExportError::Source(error) => error,
            TraceExportError::CaptureChanged => {
                ClientError::Protocol("diagnostic capture identity changed".into())
            }
        })
    }
}

impl<T: JsonRpcTransport> TraceExportSource for AppServerClient<T> {
    type Error = ClientError;

    fn trace_page(
        &mut self,
        session_id: &SessionId,
        after: BTreeMap<ThreadId, u64>,
    ) -> Result<TracePage, ClientError> {
        let page = self.read_session_trace(SessionTraceReadParams {
            session_id: session_id.clone(),
            after: after.clone(),
            limit: 500,
        })?;
        let trace: RolloutTrace = serde_json::from_value(page.trace)
            .map_err(|error| ClientError::Protocol(error.to_string()))?;
        if trace.session_id != *session_id
            || trace.format_version != ash_rollout_trace::ROLLOUT_TRACE_FORMAT_VERSION
            || after
                .iter()
                .any(|(id, cursor)| page.cursors.get(id).is_none_or(|next| next < cursor))
            || (page.has_more
                && !page
                    .cursors
                    .iter()
                    .any(|(id, next)| *next > after.get(id).copied().unwrap_or(0)))
        {
            return Err(ClientError::Protocol(
                "invalid trace identity or page cursors".into(),
            ));
        }
        Ok(TracePage {
            trace,
            cursors: page.cursors,
            has_more: page.has_more,
        })
    }

    fn diagnostic_page(
        &mut self,
        session_id: &SessionId,
        after: u64,
    ) -> Result<DiagnosticPage, ClientError> {
        let page = self.read_trace_diagnostics(SessionTraceDiagnosticsReadParams {
            session_id: session_id.clone(),
            after,
            limit: 500,
        })?;
        if page.cursor < after || (page.has_more && page.cursor == after) {
            return Err(ClientError::Protocol(
                "invalid diagnostic page cursor".into(),
            ));
        }
        Ok(DiagnosticPage {
            diagnostics: serde_json::from_value(page.diagnostics)
                .map_err(|error| ClientError::Protocol(error.to_string()))?,
            cursor: page.cursor,
            has_more: page.has_more,
        })
    }

    fn payload(
        &mut self,
        session_id: &SessionId,
        capture_id: &str,
        payload_id: &str,
    ) -> Result<Value, ClientError> {
        self.read_trace_payload(SessionTracePayloadReadParams {
            session_id: session_id.clone(),
            capture_id: capture_id.into(),
            payload_id: payload_id.into(),
        })
        .map(|result| result.payload)
    }
}

#[cfg(test)]
#[path = "trace_tests.rs"]
mod tests;

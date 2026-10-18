use crate::DiagnosticPage;
use crate::PayloadStatus;
use crate::RecordingStatus;
use crate::RolloutTrace;
use crate::TracePage;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use serde_json::Value;
use std::collections::BTreeMap;

/// Reads authorized pages and optional evidence without exposing a transport to the exporter.
pub trait TraceExportSource {
    type Error;

    fn trace_page(
        &mut self,
        session_id: &SessionId,
        after: BTreeMap<ThreadId, u64>,
    ) -> Result<TracePage, Self::Error>;
    fn diagnostic_page(
        &mut self,
        session_id: &SessionId,
        after: u64,
    ) -> Result<DiagnosticPage, Self::Error>;
    fn payload(
        &mut self,
        session_id: &SessionId,
        capture_id: &str,
        payload_id: &str,
    ) -> Result<Value, Self::Error>;
}

/// A failed source read or a capture replaced while its pages were being collected.
#[derive(Debug)]
pub enum TraceExportError<E> {
    Source(E),
    CaptureChanged,
}

impl<E: std::fmt::Display> std::fmt::Display for TraceExportError<E> {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Source(error) => error.fmt(formatter),
            Self::CaptureChanged => formatter.write_str("diagnostic capture identity changed"),
        }
    }
}

impl<E: std::error::Error + 'static> std::error::Error for TraceExportError<E> {}

/// Builds one self-contained artifact and derives its graph from exactly the exported evidence.
pub fn export_session_trace<S: TraceExportSource>(
    source: &mut S,
    session_id: &SessionId,
) -> Result<RolloutTrace, TraceExportError<S::Error>> {
    let mut page = source
        .trace_page(session_id, BTreeMap::new())
        .map_err(TraceExportError::Source)?;
    let mut trace = page.trace;
    while page.has_more {
        page = source
            .trace_page(session_id, page.cursors)
            .map_err(TraceExportError::Source)?;
        for thread in page.trace.threads {
            if let Some(existing) = trace
                .threads
                .iter_mut()
                .find(|existing| existing.thread_id == thread.thread_id)
            {
                existing.events.extend(thread.events);
            } else {
                trace.threads.push(thread);
            }
        }
        for prefix in page.trace.history_prefixes {
            if !trace.history_prefixes.contains(&prefix) {
                trace.history_prefixes.push(prefix);
            }
        }
    }
    let mut page = source
        .diagnostic_page(session_id, 0)
        .map_err(TraceExportError::Source)?;
    let mut diagnostics = page.diagnostics;
    while page.has_more {
        page = source
            .diagnostic_page(session_id, page.cursor)
            .map_err(TraceExportError::Source)?;
        if page.diagnostics.capture_id != diagnostics.capture_id {
            return Err(TraceExportError::CaptureChanged);
        }
        let mut events = diagnostics.events;
        events.append(&mut page.diagnostics.events);
        diagnostics = page.diagnostics;
        diagnostics.events = events;
    }
    let mut incomplete = false;
    for record in &diagnostics.events {
        let Some(reference) = record.event.payload() else {
            continue;
        };
        if reference.status != PayloadStatus::Saved {
            incomplete = true;
            continue;
        }
        if diagnostics.payloads.contains_key(&reference.payload_id) {
            continue;
        }
        let payload = diagnostics.capture_id.as_deref().and_then(|capture_id| {
            source
                .payload(session_id, capture_id, &reference.payload_id)
                .ok()
        });
        match payload {
            Some(payload) => {
                diagnostics
                    .payloads
                    .insert(reference.payload_id.clone(), payload);
            }
            None => incomplete = true,
        }
    }
    if incomplete {
        diagnostics.recording_status = RecordingStatus::Incomplete;
    }
    let mut graph = crate::reduce_trace(&trace, &diagnostics, |reference| {
        diagnostics
            .payloads
            .get(&reference.payload_id)
            .cloned()
            .ok_or_else(|| "diagnostic payload not found in exported capture".into())
    });
    match diagnostics.recording_status {
        RecordingStatus::Unavailable => graph
            .warnings
            .push("diagnostic recording unavailable".into()),
        RecordingStatus::Incomplete => graph.warnings.push(format!(
            "diagnostic evidence incomplete: {} dropped, {} pending",
            diagnostics.dropped_records, diagnostics.pending_records
        )),
        RecordingStatus::Disabled | RecordingStatus::Recording => {}
    }
    trace.graph = Some(graph);
    trace.diagnostics = Some(diagnostics);
    trace.overview = Some(crate::overview::summarize_trace(&trace));
    Ok(trace)
}

#[cfg(test)]
#[path = "export_tests.rs"]
mod tests;

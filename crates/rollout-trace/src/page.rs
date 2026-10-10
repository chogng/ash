use crate::RolloutTrace;
use crate::RolloutTraceError;
use crate::ThreadRolloutTrace;
use crate::trace::retained_prefixes;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_thread_store::ThreadHistoryReader;
use std::collections::BTreeMap;

/// A bounded capture with independent durable Thread cursors.
pub struct TracePage {
    pub trace: RolloutTrace,
    pub cursors: BTreeMap<ThreadId, u64>,
    pub has_more: bool,
}

/// Reads committed ranges through the store index; prefixes accompany their referring events.
pub fn read_session_trace_page(
    store: &(impl ThreadHistoryReader + ?Sized),
    session_id: &SessionId,
    after: &BTreeMap<ThreadId, u64>,
    limit: usize,
) -> Result<TracePage, RolloutTraceError> {
    if !(1..=500).contains(&limit) {
        return Err(RolloutTraceError::InvalidParameters(
            "trace limit must be 1..500".into(),
        ));
    }
    let catalog = store
        .session_catalog(session_id)
        .map_err(RolloutTraceError::ThreadList)?;
    if catalog.is_empty() {
        return Err(RolloutTraceError::SessionNotFound(session_id.clone()));
    }
    if after
        .keys()
        .any(|id| !catalog.iter().any(|record| &record.thread.thread_id == id))
    {
        return Err(RolloutTraceError::InvalidParameters(
            "trace cursor belongs to another Session".into(),
        ));
    }
    let mut cursors = BTreeMap::new();
    let mut remaining = limit;
    let mut has_more = false;
    let mut threads = Vec::new();
    for record in catalog {
        let thread_id = record.thread.thread_id;
        let cursor = after.get(&thread_id).copied().unwrap_or(0);
        if cursor > record.sequence {
            return Err(RolloutTraceError::InvalidParameters(
                "trace cursor exceeds committed history".into(),
            ));
        }
        let mut events = Vec::new();
        let mut current_sequence = record.sequence;
        if remaining > 0 && cursor < current_sequence {
            let page = store
                .load_range(&thread_id, cursor, remaining)
                .map_err(|source| RolloutTraceError::ThreadStore {
                    thread_id: thread_id.clone(),
                    source,
                })?;
            current_sequence = page.current_sequence;
            events = page.events;
            remaining -= events.len();
        }
        let next = events.last().map_or(cursor, |event| event.sequence);
        has_more |= next < current_sequence;
        cursors.insert(thread_id.clone(), next);
        threads.push(ThreadRolloutTrace { thread_id, events });
    }
    let history_prefixes = retained_prefixes(store, &threads)?;
    Ok(TracePage {
        trace: RolloutTrace {
            format_version: crate::ROLLOUT_TRACE_FORMAT_VERSION,
            session_id: session_id.clone(),
            threads,
            history_prefixes,
            diagnostics: None,
            graph: None,
        },
        cursors,
        has_more,
    })
}

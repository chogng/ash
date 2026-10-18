use crate::RolloutTrace;
use ash_history::StoredEvent;
use ash_protocol::ModelInvocationId;
use ash_protocol::ModelInvocationOutcome;
use ash_protocol::ModelInvocationRecord;
use ash_protocol::ModelUsage;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::ToolCallId;
use ash_protocol::TurnId;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

/// Provider-reported subtotal and its per-call coverage. Decimal strings preserve large
/// totals across JSON clients; no reports remains unknown, including an empty capture.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceMetric {
    pub reported: Option<String>,
    pub reported_calls: u64,
    pub missing_calls: u64,
}

/// Rebuildable accounting over exactly these durable prefixes. Diagnostics and retained
/// ancestry can repeat usage, so neither is a source for these metrics.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TraceOverview {
    pub format_version: u32,
    pub thread_cursors: BTreeMap<ThreadId, u64>,
    pub event_count: u64,
    pub model_calls: u64,
    pub tool_calls: u64,
    pub failed_model_calls: u64,
    pub cancelled_model_calls: u64,
    pub excluded_model_calls: u64,
    pub input_tokens: TraceMetric,
    pub output_tokens: TraceMetric,
    pub cached_input_tokens: TraceMetric,
    pub total_tokens: TraceMetric,
}

/// A transient reduction retains call identities and accounting only, not message bodies.
/// Prefix readers feed bounded store pages; this is never persisted runtime state.
#[derive(Default)]
pub(crate) struct OverviewBuilder {
    calls: BTreeMap<(ThreadId, TurnId, ModelInvocationId), Option<ModelInvocationRecord>>,
    tools: BTreeSet<(ThreadId, TurnId, ToolCallId)>,
    cursors: BTreeMap<ThreadId, u64>,
    event_count: u64,
}

impl OverviewBuilder {
    pub(crate) fn start_thread(&mut self, thread: &ThreadId) {
        self.cursors.entry(thread.clone()).or_insert(0);
    }

    pub(crate) fn observe(&mut self, thread: &ThreadId, event: &StoredEvent) {
        self.cursors.insert(thread.clone(), event.sequence);
        self.event_count += 1;
        if let ThreadEvent::ModelInvocationRecorded {
            turn_id, record, ..
        } = &event.event
        {
            let key = (
                thread.clone(),
                turn_id.clone(),
                record.invocation_id.clone(),
            );
            match self.calls.entry(key) {
                std::collections::btree_map::Entry::Vacant(entry) => {
                    entry.insert(Some(record.clone()));
                }
                std::collections::btree_map::Entry::Occupied(mut entry) => {
                    // Identical repeated facts count once. Conflicting identities stay
                    // excluded rather than selecting an arbitrary token/outcome report.
                    if entry.get().as_ref() != Some(record) {
                        entry.insert(None);
                    }
                }
            }
        }
        if let ThreadEvent::ItemCompleted {
            turn_id,
            item: ThreadItem::ToolCall { tool_call_id, .. },
            ..
        } = &event.event
        {
            self.tools
                .insert((thread.clone(), turn_id.clone(), tool_call_id.clone()));
        }
    }

    pub(crate) fn finish(self) -> TraceOverview {
        let excluded = self
            .calls
            .values()
            .filter(|record| record.is_none())
            .count() as u64;
        let calls = self
            .calls
            .values()
            .filter_map(Option::as_ref)
            .collect::<Vec<_>>();
        TraceOverview {
            format_version: 1,
            thread_cursors: self.cursors,
            event_count: self.event_count,
            model_calls: calls.len() as u64,
            tool_calls: self.tools.len() as u64,
            failed_model_calls: calls
                .iter()
                .filter(|record| record.outcome == ModelInvocationOutcome::Failed)
                .count() as u64,
            cancelled_model_calls: calls
                .iter()
                .filter(|record| record.outcome == ModelInvocationOutcome::Cancelled)
                .count() as u64,
            excluded_model_calls: excluded,
            input_tokens: metric(&calls, |usage| usage.input_tokens.map(u128::from)),
            output_tokens: metric(&calls, |usage| usage.output_tokens.map(u128::from)),
            cached_input_tokens: metric(&calls, |usage| usage.cached_input_tokens.map(u128::from)),
            // Pair coverage per invocation. Cache reads/writes are included in input,
            // and reasoning is a breakdown of output rather than extra output usage.
            total_tokens: metric(&calls, |usage| {
                Some(u128::from(usage.input_tokens?) + u128::from(usage.output_tokens?))
            }),
        }
    }
}

pub(crate) fn summarize_trace(trace: &RolloutTrace) -> TraceOverview {
    let mut builder = OverviewBuilder::default();
    for thread in &trace.threads {
        builder.start_thread(&thread.thread_id);
        for event in &thread.events {
            builder.observe(&thread.thread_id, event);
        }
    }
    builder.finish()
}

fn metric(
    calls: &[&ModelInvocationRecord],
    read: impl Fn(&ModelUsage) -> Option<u128>,
) -> TraceMetric {
    let mut subtotal = 0_u128;
    let mut reported_calls = 0;
    for record in calls {
        if let Some(value) = record.usage.as_ref().and_then(&read) {
            subtotal += value;
            reported_calls += 1;
        }
    }
    TraceMetric {
        reported: (reported_calls > 0).then(|| subtotal.to_string()),
        reported_calls,
        missing_calls: calls.len() as u64 - reported_calls,
    }
}

#[cfg(test)]
#[path = "overview_tests.rs"]
mod tests;

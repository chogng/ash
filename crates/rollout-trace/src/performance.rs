//! Rebuildable client performance over durable invocation facts, never runtime state.

use crate::ThreadRolloutTrace;
use ash_history::EventId;
use ash_protocol::ModelInvocationId;
use ash_protocol::ModelInvocationOutcome;
use ash_protocol::ModelInvocationRecord;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use serde::Deserialize;
use serde::Serialize;

#[cfg(test)]
#[path = "performance_tests.rs"]
mod tests;

/// Stable explanations shared by live readers, saved artifacts and presentation clients.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PerformanceUnknownReason {
    MissingTiming,
    NoTextDeltas,
    InconsistentTiming,
    RequestNotCompleted,
    SingleTextDelta,
    ToolOutput,
    MissingUsage,
    MissingOutputTokens,
    MissingReasoningTokens,
    InconsistentTokenUsage,
    NoTextOutputTokens,
    ZeroGenerationDuration,
}

/// Client-observed duration. Decimal microseconds remain lossless in JSON consumers.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PerformanceDuration {
    Measured { microseconds: String },
    Unknown { reason: PerformanceUnknownReason },
}

/// Body-output rate, rounded once to 0.1 token/s by the domain reducer.
/// This is an estimate including network and consumer overhead, not server decode speed.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "type", rename_all = "camelCase")]
pub enum PerformanceRate {
    Estimated {
        #[serde(rename = "tokensPerSecond")]
        tokens_per_second: String,
    },
    Unknown {
        reason: PerformanceUnknownReason,
    },
}

/// A projection linked to an exact durable event, including its invocation identity.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvocationPerformance {
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub event_id: EventId,
    pub invocation_id: ModelInvocationId,
    pub total: PerformanceDuration,
    pub first_text: PerformanceDuration,
    pub generation: PerformanceDuration,
    pub text_tps: PerformanceRate,
}

/// Per-event projections for exactly the events carried by this page or saved capture.
/// Old V3 files can omit this field; clients must not reconstruct it with another calculator.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TracePerformance {
    pub format_version: u32,
    pub calls: Vec<InvocationPerformance>,
}

pub(crate) fn summarize_performance(threads: &[ThreadRolloutTrace]) -> TracePerformance {
    let mut calls = Vec::new();
    for thread in threads {
        for event in &thread.events {
            if let ThreadEvent::ModelInvocationRecorded {
                turn_id, record, ..
            } = &event.event
            {
                calls.push(project(&thread.thread_id, turn_id, &event.event_id, record));
            }
        }
    }
    TracePerformance {
        format_version: 1,
        calls,
    }
}

fn project(
    thread: &ThreadId,
    turn: &TurnId,
    event: &EventId,
    record: &ModelInvocationRecord,
) -> InvocationPerformance {
    let total = duration(
        record
            .timing
            .as_ref()
            .map(|timing| timing.total_us)
            .ok_or(PerformanceUnknownReason::MissingTiming),
    );
    let first = first_text(record);
    let generation = first.map(|first| {
        record
            .timing
            .as_ref()
            .expect("first text requires timing")
            .total_us
            - first
    });
    InvocationPerformance {
        thread_id: thread.clone(),
        turn_id: turn.clone(),
        event_id: event.clone(),
        invocation_id: record.invocation_id.clone(),
        total,
        first_text: duration(first),
        generation: duration(generation),
        text_tps: match rate(record, generation) {
            Ok(tokens_per_second) => PerformanceRate::Estimated { tokens_per_second },
            Err(reason) => PerformanceRate::Unknown { reason },
        },
    }
}

fn duration(value: Result<u64, PerformanceUnknownReason>) -> PerformanceDuration {
    match value {
        Ok(microseconds) => PerformanceDuration::Measured {
            microseconds: microseconds.to_string(),
        },
        Err(reason) => PerformanceDuration::Unknown { reason },
    }
}

fn first_text(record: &ModelInvocationRecord) -> Result<u64, PerformanceUnknownReason> {
    let timing = record
        .timing
        .as_ref()
        .ok_or(PerformanceUnknownReason::MissingTiming)?;
    match (timing.first_text_us, timing.text_delta_count) {
        (None, 0) => Err(PerformanceUnknownReason::NoTextDeltas),
        (Some(first), count) if count > 0 && first <= timing.total_us => Ok(first),
        _ => Err(PerformanceUnknownReason::InconsistentTiming),
    }
}

fn rate(
    record: &ModelInvocationRecord,
    generation: Result<u64, PerformanceUnknownReason>,
) -> Result<String, PerformanceUnknownReason> {
    if record.outcome != ModelInvocationOutcome::Completed {
        return Err(PerformanceUnknownReason::RequestNotCompleted);
    }
    let generation = generation?;
    let timing = record.timing.as_ref().expect("generation requires timing");
    if timing.tool_call_count > 0 {
        return Err(PerformanceUnknownReason::ToolOutput);
    }
    if timing.text_delta_count < 2 {
        return Err(PerformanceUnknownReason::SingleTextDelta);
    }
    if generation == 0 {
        return Err(PerformanceUnknownReason::ZeroGenerationDuration);
    }
    let usage = record
        .usage
        .as_ref()
        .ok_or(PerformanceUnknownReason::MissingUsage)?;
    let output = usage
        .output_tokens
        .ok_or(PerformanceUnknownReason::MissingOutputTokens)?;
    let reasoning = usage
        .reasoning_tokens
        .ok_or(PerformanceUnknownReason::MissingReasoningTokens)?;
    let text = output
        .checked_sub(reasoning)
        .ok_or(PerformanceUnknownReason::InconsistentTokenUsage)?;
    if text == 0 {
        return Err(PerformanceUnknownReason::NoTextOutputTokens);
    }
    // u64 quantities fit this u128 calculation even at the shortest positive interval.
    // Round half up here, once, so clients and exported analysis consume the same value.
    let tenths =
        (u128::from(text) * 10_000_000 + u128::from(generation) / 2) / u128::from(generation);
    Ok(format!("{}.{:01}", tenths / 10, tenths % 10))
}

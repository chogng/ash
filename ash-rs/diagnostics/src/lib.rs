//! Bounded, content-free diagnostic facts shared across product hosts.

use response_debug_context::ResponseDiagnostic;
use response_debug_context::ResponseDiagnosticSink;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use ts_rs::TS;

#[derive(
    Clone, Copy, Debug, Deserialize, Eq, JsonSchema, Ord, PartialEq, PartialOrd, Serialize, TS,
)]
#[serde(rename_all = "camelCase")]
pub enum Activity {
    Rpc,
    Model,
    Http,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum Outcome {
    Succeeded,
    Failed,
    Cancelled,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Observation {
    pub activity: Activity,
    pub outcome: Outcome,
    #[ts(type = "number")]
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySummary {
    #[ts(type = "number")]
    pub count: u64,
    #[ts(type = "number")]
    pub failed: u64,
    #[ts(type = "number")]
    pub cancelled: u64,
    #[ts(type = "number")]
    pub elapsed_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DiagnosticSnapshot {
    pub build: build_info::BuildInfo,
    pub activities: BTreeMap<Activity, ActivitySummary>,
    pub recent: Vec<Observation>,
    pub usage: analytics::UsageSnapshot,
    pub responses: Vec<ResponseDiagnostic>,
}

#[derive(Debug, Default)]
struct State {
    summaries: BTreeMap<Activity, ActivitySummary>,
    recent: VecDeque<Observation>,
    responses: VecDeque<ResponseDiagnostic>,
}

#[derive(Clone, Debug, Default)]
pub struct Diagnostics {
    state: Arc<Mutex<State>>,
}

impl Diagnostics {
    pub fn record(&self, observation: Observation) {
        let mut state = self.state.lock().expect("diagnostics lock poisoned");
        let summary = state.summaries.entry(observation.activity).or_default();
        summary.count = summary.count.saturating_add(1);
        summary.failed = summary
            .failed
            .saturating_add(u64::from(observation.outcome == Outcome::Failed));
        summary.cancelled = summary
            .cancelled
            .saturating_add(u64::from(observation.outcome == Outcome::Cancelled));
        summary.elapsed_ms = summary.elapsed_ms.saturating_add(observation.elapsed_ms);
        if state.recent.len() == 256 {
            state.recent.pop_front();
        }
        state.recent.push_back(observation);
    }

    pub fn snapshot(&self, usage: analytics::UsageSnapshot) -> DiagnosticSnapshot {
        let state = self.state.lock().expect("diagnostics lock poisoned");
        DiagnosticSnapshot {
            build: build_info::BuildInfo::current(),
            activities: state.summaries.clone(),
            recent: state.recent.iter().cloned().collect(),
            usage,
            responses: state.responses.iter().cloned().collect(),
        }
    }
}

impl ResponseDiagnosticSink for Diagnostics {
    fn record_response(&self, diagnostic: ResponseDiagnostic) {
        let mut state = self.state.lock().expect("diagnostics lock poisoned");
        if state.responses.len() == 64 {
            state.responses.pop_front();
        }
        state.responses.push_back(diagnostic);
    }
}

#[cfg(test)]
#[path = "diagnostics_tests.rs"]
mod tests;

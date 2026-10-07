//! Opt-in usage counts with a fixed event vocabulary and no user content.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::collections::BTreeMap;
use std::sync::Mutex;
use ts_rs::TS;

#[derive(
    Clone, Copy, Debug, Deserialize, Eq, JsonSchema, Ord, PartialEq, PartialOrd, Serialize, TS,
)]
#[serde(rename_all = "camelCase")]
pub enum UsageEvent {
    TurnStarted,
    MessageQueued,
    MemoryAdded,
    MemoryDeleted,
    FeedbackSubmitted,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct UsageSnapshot {
    pub enabled: bool,
    #[ts(type = "{ [key in UsageEvent]?: number }")]
    pub counts: BTreeMap<UsageEvent, u64>,
}

#[derive(Debug, Default)]
pub struct Analytics {
    state: Mutex<UsageSnapshot>,
}

impl Analytics {
    /// Applies the user's current preference; revocation clears all retained counts.
    pub fn set_enabled(&self, enabled: bool) {
        let mut state = self.state.lock().expect("analytics lock poisoned");
        state.enabled = enabled;
        if !enabled {
            state.counts.clear();
        }
    }

    pub fn record(&self, event: UsageEvent) {
        let mut state = self.state.lock().expect("analytics lock poisoned");
        if state.enabled {
            let count = state.counts.entry(event).or_default();
            *count = count.saturating_add(1);
        }
    }

    pub fn snapshot(&self) -> UsageSnapshot {
        self.state.lock().expect("analytics lock poisoned").clone()
    }
}

#[cfg(test)]
#[path = "analytics_tests.rs"]
mod tests;

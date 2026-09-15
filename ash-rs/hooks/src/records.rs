use crate::outcome::HookDecision;
use crate::protocol::HookInvocation;
use std::collections::VecDeque;
use std::sync::RwLock;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;
use ash_config::HookConfig;
use core_api::CoreError;

const MAX_RECENT_RUNS: usize = 128;

/// Canonical Ash Hook point attached to a runtime record.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HookRunEvent {
    BeforeTool,
    AfterTool,
    TurnCompleted,
}

/// Current or terminal state of one Hook invocation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HookRunStatus {
    Running,
    Continued,
    Denied { reason: String },
    Failed { message: String },
}

/// Bounded, non-durable runtime projection for one configured Hook invocation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HookRunRecord {
    pub run_id: String,
    pub hook_id: String,
    pub event: HookRunEvent,
    pub status: HookRunStatus,
    pub started_at_unix_ms: u64,
    pub duration_ms: u64,
}

pub(crate) struct HookRunLog {
    next_id: AtomicU64,
    records: RwLock<VecDeque<HookRunRecord>>,
}

pub(crate) struct StartedHookRun {
    run_id: String,
    started: Instant,
}

impl HookRunLog {
    pub(crate) fn new() -> Self {
        Self {
            next_id: AtomicU64::new(1),
            records: RwLock::new(VecDeque::new()),
        }
    }

    pub(crate) fn start(
        &self,
        hook: &HookConfig,
        invocation: &HookInvocation<'_>,
    ) -> StartedHookRun {
        let ordinal = self.next_id.fetch_add(1, Ordering::Relaxed);
        let run_id = format!("hook-run-{ordinal}");
        let record = HookRunRecord {
            run_id: run_id.clone(),
            hook_id: hook.id.to_string(),
            event: event_of(invocation),
            status: HookRunStatus::Running,
            started_at_unix_ms: unix_millis(SystemTime::now()),
            duration_ms: 0,
        };
        let mut records = self
            .records
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        records.push_back(record);
        while records.len() > MAX_RECENT_RUNS {
            records.pop_front();
        }
        StartedHookRun {
            run_id,
            started: Instant::now(),
        }
    }

    pub(crate) fn finish(&self, started: StartedHookRun, result: &Result<HookDecision, CoreError>) {
        let mut records = self
            .records
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(record) = records
            .iter_mut()
            .find(|record| record.run_id == started.run_id)
        else {
            return;
        };
        record.duration_ms = millis(started.started.elapsed());
        record.status = match result {
            Ok(HookDecision::Continue) => HookRunStatus::Continued,
            Ok(HookDecision::Deny { reason }) => HookRunStatus::Denied {
                reason: reason.clone(),
            },
            Err(error) => HookRunStatus::Failed {
                message: error.to_string(),
            },
        };
    }

    pub(crate) fn snapshot(&self) -> Vec<HookRunRecord> {
        self.records
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .cloned()
            .collect()
    }
}

fn event_of(invocation: &HookInvocation<'_>) -> HookRunEvent {
    match invocation {
        HookInvocation::BeforeTool(_) => HookRunEvent::BeforeTool,
        HookInvocation::AfterTool(_) => HookRunEvent::AfterTool,
        HookInvocation::TurnCompleted(_) => HookRunEvent::TurnCompleted,
    }
}

fn unix_millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).map_or(0, millis)
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

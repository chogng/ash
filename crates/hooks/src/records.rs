use crate::outcome::HookDecision;
use crate::protocol::HookInvocation;
use ash_config::HookConfig;
use ash_config::HookEvent;
use core_api::CoreError;
use std::collections::VecDeque;
use std::sync::RwLock;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

const MAX_RECENT_RUNS: usize = 128;
static NEXT_RUN_ID: AtomicU64 = AtomicU64::new(1);

/// Canonical Ash Hook point attached to a runtime record.
pub type HookRunEvent = HookEvent;

pub use ash_protocol::HookRunRecord;
pub use ash_protocol::HookRunStatus;

pub(crate) struct HookRunLog {
    records: RwLock<VecDeque<HookRunRecord>>,
}

pub(crate) struct StartedHookRun {
    pub(crate) record: HookRunRecord,
    started: Instant,
}

impl HookRunLog {
    pub(crate) fn new() -> Self {
        Self {
            records: RwLock::new(VecDeque::new()),
        }
    }

    pub(crate) fn start(
        &self,
        hook: &HookConfig,
        invocation: &HookInvocation<'_>,
    ) -> StartedHookRun {
        let ordinal = NEXT_RUN_ID.fetch_add(1, Ordering::Relaxed);
        let timestamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        let run_id = format!("hook-run-{timestamp}-{}-{ordinal}", std::process::id());
        let record = HookRunRecord {
            run_id: run_id.clone(),
            hook_id: hook.id.to_string(),
            event: hook.event,
            status: HookRunStatus::Running,
            started_at_unix_ms: unix_millis(SystemTime::now()),
            duration_ms: 0,
            turn_id: invocation.turn_id().cloned(),
            tool_call_id: invocation.tool_call_id().cloned(),
            tool_name: invocation.tool_name().map(str::to_owned),
        };
        let mut records = self
            .records
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        records.push_back(record.clone());
        while records.len() > MAX_RECENT_RUNS {
            records.pop_front();
        }
        StartedHookRun {
            record,
            started: Instant::now(),
        }
    }

    pub(crate) fn finish(
        &self,
        mut started: StartedHookRun,
        result: &Result<HookDecision, CoreError>,
    ) -> HookRunRecord {
        let record = &mut started.record;
        record.duration_ms = millis(started.started.elapsed());
        record.status = match result {
            Ok(HookDecision::Continue) => HookRunStatus::Continued,
            Ok(HookDecision::Deny { reason }) => HookRunStatus::Denied {
                reason: reason.clone(),
            },
            Err(CoreError::Cancelled(reason)) => HookRunStatus::Cancelled {
                reason: reason.clone(),
            },
            Err(error) => HookRunStatus::Failed {
                message: error.to_string(),
            },
        };
        let mut records = self
            .records
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(retained) = records
            .iter_mut()
            .find(|retained| retained.run_id == record.run_id)
        {
            *retained = record.clone();
        }
        started.record
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

fn unix_millis(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH).map_or(0, millis)
}

fn millis(duration: Duration) -> u64 {
    u64::try_from(duration.as_millis()).unwrap_or(u64::MAX)
}

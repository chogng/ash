use super::AppServer;
use super::RpcError;
use super::core_error;
use ash_async_utils::CancellationSource;
use core_api::HookEventDecision;
use core_api::HookEventRequest;
use core_api::HookService;

pub(super) struct HookRunUpdates {
    pub(super) threads: std::sync::Weak<ash_core::ThreadController>,
    pub(super) updates: std::sync::Weak<super::UpdateBroker>,
    pub(super) published: std::sync::Mutex<std::collections::BTreeMap<ash_protocol::ThreadId, u64>>,
}

impl core_api::HookRunObserver for HookRunUpdates {
    fn updated(
        &self,
        scope: &core_api::HookEventScope,
        run: &ash_protocol::HookRunRecord,
        evidence: Option<&core_api::HookRunEvidence>,
    ) -> Result<(), core_api::CoreError> {
        // The broker owns the Hook service; weak sinks avoid keeping a stopped host alive.
        let threads = self
            .threads
            .upgrade()
            .ok_or_else(|| core_api::CoreError::Cancelled("Hook history owner stopped".into()))?;
        let updates = self
            .updates
            .upgrade()
            .ok_or_else(|| core_api::CoreError::Cancelled("Hook delivery owner stopped".into()))?;
        if let Some(update) = threads.record_hook_run(scope, run, evidence)? {
            // A safe-point can run before Core flushes its preceding item facts. Deliver that
            // prefix first so transcript consumers cannot skip it after seeing the Hook sequence.
            let mut published = self
                .published
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            let sequence = published.entry(update.thread_id.clone()).or_default();
            for pending in threads.thread_updates_after(&update.thread_id, *sequence)? {
                *sequence = pending.durable_sequence;
                updates.publish_thread_update(pending);
            }
        }
        Ok(())
    }
}

impl AppServer {
    pub(super) fn emit_hook_event(
        &self,
        request: &HookEventRequest,
    ) -> Result<HookEventDecision, RpcError> {
        let Some(hooks) = self.local_hook_runtime() else {
            return Ok(HookEventDecision::Continue);
        };
        let cancellation = CancellationSource::new();
        hooks
            .event(request, &cancellation.token())
            .map_err(core_error)
    }
}

#[cfg(all(test, unix))]
#[path = "hook_events_tests.rs"]
mod tests;

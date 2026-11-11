use super::AppServer;
use super::update_broker::UpdateBroker;
use crate::model_catalog::ModelCatalog;
use crate::model_catalog::short_text_reasoning_effort;
use ash_app_server_protocol::protocol::model::ModelCatalogEntry;
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use ash_core::ThreadController;
use ash_core::ThreadRecapRequest;
use ash_protocol::ModelAccess;
use ash_protocol::ModelPurpose;
use ash_protocol::ModelRef;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadId;
use ash_protocol::ThreadUpdate;
use core_api::CoreError;
use core_api::ModelService;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;
use std::time::Duration;
use std::time::Instant;

pub(super) struct ThreadRecaps {
    config: Arc<ash_config::ConfigStore>,
    threads: Arc<ThreadController>,
    model: Arc<dyn ModelService>,
    catalog: Arc<dyn ModelCatalog>,
    updates: Weak<UpdateBroker>,
}

impl AppServer {
    pub(super) fn bind_thread_recaps(&mut self) {
        let Some(config) = &self.config else {
            return;
        };
        let recaps = Arc::new(ThreadRecaps {
            config: Arc::clone(config),
            threads: Arc::clone(&self.threads),
            model: Arc::clone(&self.model),
            catalog: Arc::clone(&self.model_catalog),
            updates: Arc::downgrade(&self.updates),
        });
        self.thread_recaps = Some(recaps);
    }
}

impl ThreadRecaps {
    pub(super) fn manual(&self, thread_id: &ThreadId) -> Result<String, CoreError> {
        let source = CancellationSource::new();
        let timeout = super::request_dispatch::runtime()
            .map_err(|error| CoreError::Execution(error.to_string()))?
            .spawn({
                let source = source.clone();
                async move {
                    tokio::time::sleep(Duration::from_secs(25)).await;
                    source.cancel_with(ash_async_utils::CancellationReason::DeadlineExceeded);
                }
            });
        let result = self.generate(thread_id, false, &source.token());
        timeout.abort();
        result?.ok_or_else(|| CoreError::InvalidInput(
            "A recap requires an idle conversation with a completed reply and an available recap model.".into(),
        ))
    }

    fn generate(
        &self,
        thread_id: &ThreadId,
        automatic: bool,
        cancellation: &CancellationToken,
    ) -> Result<Option<String>, CoreError> {
        let Some(updates) = self.updates.upgrade() else {
            return Ok(None);
        };
        let config = self
            .config
            .read_snapshot()
            .map_err(|error| CoreError::Execution(error.to_string()))?;
        if (automatic && !config.values.thread_recap_enabled) || cancellation.is_cancelled() {
            return Ok(None);
        }
        let mut in_flight = updates
            .recap_presence
            .in_flight
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if !in_flight.insert(thread_id.clone()) {
            return Err(CoreError::InvalidInput(
                "A conversation recap is already being generated.".into(),
            ));
        }
        drop(in_flight);
        let _release = InFlight {
            threads: &updates.recap_presence.in_flight,
            thread_id,
        };
        let Some(request) = ThreadRecapRequest::prepare(&self.threads, thread_id, automatic)?
        else {
            return Ok(None);
        };
        let entries = self.catalog.list().unwrap_or_default();
        let selection = config.values.thread_recap_model.as_ref();
        let selected = selection.map(|selection| &selection.model).or_else(|| {
            automatic_recap_model(&entries, &request.conversation_model, |model| {
                self.catalog
                    .current_access(model)
                    .is_ok_and(|access| access != ModelAccess::Unknown)
            })
        });
        let Some(selected) = selected else {
            return Ok(None);
        };
        let effort = short_text_reasoning_effort(
            entries.iter().find(|entry| &entry.model == selected),
            selection.and_then(|selection| selection.reasoning_effort),
        );
        if let Some(update) = request.generate(
            &self.threads,
            self.model.as_ref(),
            selected,
            effort,
            cancellation,
        )? {
            let ThreadUpdate::Committed {
                event: ThreadEvent::ThreadRecapUpdated { text, .. },
            } = &update.update
            else {
                return Err(CoreError::Execution("unexpected recap update".into()));
            };
            let text = text.clone();
            updates.publish_thread_update(update);
            return Ok(Some(text));
        }
        Ok(None)
    }
}

struct InFlight<'a> {
    threads: &'a Mutex<BTreeSet<ThreadId>>,
    thread_id: &'a ThreadId,
}

impl Drop for InFlight<'_> {
    fn drop(&mut self) {
        self.threads
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(self.thread_id);
    }
}

/// Focus reports are scoped to a connection and surface, and shared across directory brokers.
#[derive(Default)]
pub(super) struct RecapPresence {
    watches: Mutex<BTreeMap<ThreadId, RecapWatch>>,
    in_flight: Mutex<BTreeSet<ThreadId>>,
}

#[derive(Clone, Copy)]
pub(super) enum RecapTurnChange {
    Started,
    Finished,
}

struct RecapWatch {
    worker: Weak<ThreadRecaps>,
    views: BTreeMap<(u64, String), bool>,
    job: Option<CancellationSource>,
    turn_sequence: u64,
}

impl RecapPresence {
    pub(super) fn set(
        self: &Arc<Self>,
        worker: Weak<ThreadRecaps>,
        thread: ThreadId,
        connection: u64,
        surface: String,
        focused: Option<bool>,
    ) {
        let mut watches = self
            .watches
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if focused.is_none() && !watches.contains_key(&thread) {
            return;
        }
        let watch = watches.entry(thread.clone()).or_insert_with(|| RecapWatch {
            worker: worker.clone(),
            views: BTreeMap::new(),
            job: None,
            turn_sequence: 0,
        });
        let was_focused = watch.views.values().any(|focused| *focused);
        let first_observation = watch.views.is_empty() && watch.job.is_none();
        let key = (connection, surface);
        if let Some(focused) = focused {
            watch.worker = worker;
            watch.views.insert(key, focused);
        } else {
            watch.views.remove(&key);
        }
        let focused = watch.views.values().any(|focused| *focused);
        if focused || was_focused || first_observation {
            self.reschedule(&thread, watch);
        }
    }

    pub(super) fn close_connection(self: &Arc<Self>, connection: u64) {
        let mut watches = self
            .watches
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        watches.retain(|thread, watch| {
            let was_focused = watch.views.values().any(|focused| *focused);
            watch.views.retain(|(owner, _), _| *owner != connection);
            if was_focused && !watch.views.values().any(|focused| *focused) {
                self.reschedule(thread, watch);
            }
            !watch.views.is_empty() || watch.job.is_some()
        });
    }

    pub(super) fn turn_changed(
        self: &Arc<Self>,
        thread: &ThreadId,
        sequence: u64,
        change: RecapTurnChange,
    ) {
        let mut watches = self
            .watches
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(watch) = watches.get_mut(thread) else {
            return;
        };
        if sequence <= watch.turn_sequence {
            return;
        }
        watch.turn_sequence = sequence;
        match change {
            RecapTurnChange::Started => {
                if let Some(job) = watch.job.take() {
                    job.cancel();
                }
            }
            RecapTurnChange::Finished => self.reschedule(thread, watch),
        }
    }

    fn reschedule(self: &Arc<Self>, thread: &ThreadId, watch: &mut RecapWatch) {
        if let Some(job) = watch.job.take() {
            job.cancel();
        }
        if watch.views.values().any(|focused| *focused) {
            return;
        }
        let Ok(executor) = super::request_dispatch::runtime() else {
            return;
        };
        let source = CancellationSource::new();
        let token = source.token();
        watch.job = Some(source.clone());
        let worker = watch.worker.clone();
        let presence = Arc::clone(self);
        let thread = thread.clone();
        // Both losing the last focused view and finishing a Turn restart the same idle deadline.
        let deadline = Instant::now() + Duration::from_secs(30 * 60);
        executor.spawn(async move {
            tokio::select! {
                _ = token.cancelled() => return,
                _ = tokio::time::sleep_until(deadline.into()) => {}
            }
            static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
            if let Some(worker) = worker.upgrade()
                && let Ok(Ok(slot)) =
                    tokio::time::timeout(Duration::from_secs(20), SLOTS.acquire()).await
                && !token.is_cancelled()
            {
                let work_thread = thread.clone();
                let work_token = token.clone();
                let mut task = tokio::task::spawn_blocking(move || {
                    let _slot = slot;
                    if let Err(error) = worker.generate(&work_thread, true, &work_token) {
                        log::debug!("automatic conversation recap failed: {error}");
                    }
                });
                if tokio::time::timeout(Duration::from_secs(25), &mut task)
                    .await
                    .is_err()
                {
                    source.cancel_with(ash_async_utils::CancellationReason::DeadlineExceeded);
                    task.abort();
                }
            }
            let mut watches = presence
                .watches
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if let Some(watch) = watches.get_mut(&thread)
                && watch
                    .job
                    .as_ref()
                    .is_some_and(|job| job.id() == source.id())
            {
                watch.job = None;
                if watch.views.is_empty() {
                    watches.remove(&thread);
                }
            }
        });
    }
}

fn automatic_recap_model<'a>(
    entries: &'a [ModelCatalogEntry],
    conversation_model: &ModelRef,
    available: impl Fn(&ModelRef) -> bool,
) -> Option<&'a ModelRef> {
    entries
        .iter()
        .filter(|entry| {
            entry.model.provider == conversation_model.provider
                && entry.recommended_for.contains(&ModelPurpose::ThreadRecap)
                && entry.retirement.is_none()
                && entry.discovered != Some(false)
                && available(&entry.model)
        })
        .min_by_key(|entry| entry.model.model.as_str() != "gpt-6-luna")
        .map(|entry| &entry.model)
}

#[cfg(test)]
#[path = "thread_recap_tests.rs"]
mod tests;

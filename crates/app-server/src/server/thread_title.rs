use super::AppServer;
use crate::model_catalog::short_text_reasoning_effort;
use ash_core::ThreadTitleRequest;
use ash_protocol::ModelAccess;
use ash_protocol::ModelPurpose;
use core_api::ThreadUpdateSink;
use std::sync::Arc;
use std::time::Duration;

impl AppServer {
    /// Title inference is bounded independently of a client connection or its Turn.
    pub(super) fn schedule_thread_title(
        &self,
        request: ThreadTitleRequest,
        updates: Arc<dyn ThreadUpdateSink>,
    ) {
        let Some(config) = self.config.clone() else {
            return;
        };
        let Ok(executor) = super::request_dispatch::runtime() else {
            return;
        };
        static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
        let threads = Arc::clone(&self.threads);
        let model = Arc::clone(&self.model);
        let catalog = Arc::clone(&self.model_catalog);
        executor.spawn(async move {
            let Ok(Ok(slot)) = tokio::time::timeout(Duration::from_secs(15), SLOTS.acquire()).await
            else {
                return;
            };
            let cancellation = ash_async_utils::CancellationSource::new();
            let token = cancellation.token();
            let mut worker = tokio::task::spawn_blocking(move || {
                let _slot = slot;
                let snapshot = config.read_snapshot().ok()?;
                let entries = catalog.list().unwrap_or_default();
                let entry = match &snapshot.values.thread_title_model {
                    Some(selection) => entries.iter().find(|entry| entry.model == selection.model),
                    None => entries.iter().find(|entry| {
                        entry.model.provider == request.conversation_model.provider
                            && entry.recommended_for.contains(&ModelPurpose::ThreadTitle)
                            && entry.retirement.is_none()
                            && entry.discovered != Some(false)
                            && catalog
                                .current_access(&entry.model)
                                .is_ok_and(|access| access != ModelAccess::Unknown)
                    }),
                };
                let selection = snapshot.values.thread_title_model.as_ref();
                let selected = selection
                    .map(|selection| &selection.model)
                    .or_else(|| entry.map(|entry| &entry.model))?;
                let effort = short_text_reasoning_effort(
                    entry,
                    selection.and_then(|selection| selection.reasoning_effort),
                );
                if let Err(error) = request.generate(
                    &threads,
                    model.as_ref(),
                    selected,
                    effort,
                    updates.as_ref(),
                    &token,
                ) {
                    log::debug!("thread title generation failed: {error}");
                }
                Some(())
            });
            if tokio::time::timeout(Duration::from_secs(15), &mut worker)
                .await
                .is_err()
            {
                cancellation.cancel_with(ash_async_utils::CancellationReason::DeadlineExceeded);
                worker.abort();
            }
        });
    }
}

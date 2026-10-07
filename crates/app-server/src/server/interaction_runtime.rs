use super::update_broker::UpdateBroker;
use super::update_broker::unix_time_millis;
use core_api::InteractionLifecycle;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;

const DEADLINE_POLL_INTERVAL: Duration = Duration::from_millis(50);

/// Enforces durable Agent interaction deadlines at the App Server delivery boundary.
pub(super) struct InteractionDeadlineWatcher {
    shutdown: Option<mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

impl InteractionDeadlineWatcher {
    pub(super) fn start(
        threads: Arc<dyn InteractionLifecycle>,
        updates: Arc<UpdateBroker>,
        mutation_gate: Arc<Mutex<()>>,
    ) -> Self {
        let (shutdown, shutdown_receiver) = mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("ash-agent-interaction-deadlines".into())
            .spawn(move || {
                loop {
                    match shutdown_receiver.recv_timeout(DEADLINE_POLL_INTERVAL) {
                        Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => {
                            expire_deadlines(threads.as_ref(), &updates, &mutation_gate);
                        }
                    }
                }
            })
            .ok();
        Self {
            shutdown: Some(shutdown),
            thread,
        }
    }
}

impl Drop for InteractionDeadlineWatcher {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

fn expire_deadlines(
    runtime: &dyn InteractionLifecycle,
    updates: &UpdateBroker,
    mutation_gate: &Mutex<()>,
) {
    for request in updates.expired_agent_requests(unix_time_millis()) {
        let Ok(_mutation) = mutation_gate.lock() else {
            return;
        };
        match runtime.expire_interaction(
            &request.thread_id,
            &request.turn_id,
            &request.interaction.request_id,
            unix_time_millis(),
        ) {
            Ok(Some(published)) => {
                updates.retire_agent_request(&request.interaction.request_id);
                updates.publish_thread(&request.thread_id, &published);
            }
            Ok(None) => {}
            Err(error) => log::warn!("Agent interaction expiry failed: {error}"),
        }
    }
}

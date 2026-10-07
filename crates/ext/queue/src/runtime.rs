use crate::QueueError;
use crate::QueueStore;
use crate::QueuedMessage;
use protocol::TurnId;
use std::sync::Arc;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

pub enum Delivery {
    Waiting,
    Started(TurnId),
    Rejected(String),
}

/// Host adapter for directory routing and idempotent Turn acceptance.
/// Implementations reconcile the command receipt before returning Started or retrying delivery.
pub trait QueueExecutor: Send + Sync + 'static {
    fn accepts(&self, message: &QueuedMessage) -> bool;
    fn ready(&self, message: &QueuedMessage) -> Result<bool, String>;
    fn deliver(&self, message: &QueuedMessage) -> Result<Delivery, String>;
    fn changed(&self);
    fn report_error(&self, error: &str);
}

pub struct QueueRuntime {
    stop: mpsc::Sender<()>,
    worker: Option<JoinHandle<()>>,
    store: Arc<QueueStore>,
}

impl QueueRuntime {
    pub fn start(
        store: Arc<QueueStore>,
        executor: Arc<dyn QueueExecutor>,
    ) -> Result<Self, std::io::Error> {
        let (stop, receiver) = mpsc::channel();
        let worker_store = store.clone();
        let worker = std::thread::Builder::new()
            .name("ash-message-queue".into())
            .spawn(move || {
                let store = worker_store;
                let mut revision = None;
                loop {
                    if let Err(error) = tick(&store, executor.as_ref()) {
                        executor.report_error(&error.to_string());
                    }
                    match store.revision() {
                        Ok(current) if revision != Some(current) => {
                            revision = Some(current);
                            executor.changed();
                        }
                        Ok(_) => {}
                        Err(error) => executor.report_error(&error.to_string()),
                    }
                    match receiver.try_recv() {
                        Ok(()) | Err(mpsc::TryRecvError::Disconnected) => break,
                        Err(mpsc::TryRecvError::Empty) => {}
                    }
                    store.wait(Duration::from_millis(100));
                }
            })?;
        Ok(Self {
            stop,
            worker: Some(worker),
            store,
        })
    }
}
impl Drop for QueueRuntime {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        self.store.wake();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn tick(store: &QueueStore, executor: &dyn QueueExecutor) -> Result<(), QueueError> {
    let now = i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|error| QueueError::Storage(error.to_string()))?
            .as_millis(),
    )
    .map_err(|_| QueueError::Storage("clock overflow".into()))?;
    for candidate in store.candidates(now)? {
        if !executor.accepts(&candidate) {
            continue;
        }
        match executor.ready(&candidate) {
            Ok(false) => continue,
            Ok(true) => {}
            Err(error) => {
                executor.report_error(&error);
                continue;
            }
        }
        let Some(message) = store.claim(&candidate, now)? else {
            continue;
        };
        match executor.deliver(&message) {
            Ok(delivery) => store.finish(&message, &delivery, now)?,
            // Unknown delivery outcomes retain the lease and stable command ID for reconciliation.
            Err(error) => executor.report_error(&error),
        }
    }
    Ok(())
}

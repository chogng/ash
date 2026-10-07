use crate::AutomationError;
use crate::AutomationStore;
use ash_protocol::AutomationRun;
use ash_protocol::UnixMillis;
use std::sync::Arc;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

/// Host adapter that delivers a stable run identity to the existing execution owner and returns
/// its observed state. Implementations must reconcile accepted commands before retrying delivery.
pub trait AutomationExecutor: Send + Sync + 'static {
    fn advance(&self, run: &AutomationRun, now: UnixMillis) -> Result<AutomationRun, String>;
    fn changed(&self);
    fn report_error(&self, message: &str);
}

/// One profile scheduler. Dropping it stops new dispatches and joins the scheduling thread.
pub struct AutomationRuntime {
    stop: mpsc::Sender<()>,
    worker: Option<JoinHandle<()>>,
}

impl AutomationRuntime {
    pub fn start(
        store: Arc<AutomationStore>,
        executor: Arc<dyn AutomationExecutor>,
    ) -> Result<Self, std::io::Error> {
        let (stop, receiver) = mpsc::channel();
        let worker = std::thread::Builder::new()
            .name("ash-automation".into())
            .spawn(move || {
                let mut last_checked = match now() {
                    Ok(now) => now,
                    Err(error) => {
                        executor.report_error(&error.to_string());
                        return;
                    }
                };
                loop {
                    match tick(&store, executor.as_ref(), last_checked) {
                        Ok(current) => last_checked = current,
                        Err(error) => executor.report_error(&error.to_string()),
                    }
                    match receiver.recv_timeout(Duration::from_secs(1)) {
                        Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                    }
                }
            })?;
        Ok(Self {
            stop,
            worker: Some(worker),
        })
    }
}

impl Drop for AutomationRuntime {
    fn drop(&mut self) {
        let _ = self.stop.send(());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

pub fn now() -> Result<UnixMillis, AutomationError> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| AutomationError::Invalid(error.to_string()))?
        .as_millis();
    let millis =
        u64::try_from(millis).map_err(|_| AutomationError::Invalid("timestamp overflow".into()))?;
    UnixMillis::new(millis).map_err(|message| AutomationError::Invalid(message.into()))
}

fn tick(
    store: &AutomationStore,
    executor: &dyn AutomationExecutor,
    last_checked: UnixMillis,
) -> Result<UnixMillis, AutomationError> {
    let current = now()?;
    let plans_before = store.list()?;
    // A long host suspension is treated like downtime, not a backlog of due recurring runs.
    let from = if current.get().saturating_sub(last_checked.get()) > 60_000 {
        current
    } else {
        last_checked
    };
    store.poll(from, current)?;
    let mut changed = plans_before != store.list()?;
    for run in store.active_runs()? {
        match executor.advance(&run, current) {
            Ok(observed) if observed != run => {
                store.observe(&observed)?;
                changed = true;
            }
            Ok(_) => {}
            // An unavailable observation must not turn an unknown outcome into a new execution.
            Err(error) => {
                if run.message.as_deref() != Some(&error) {
                    let mut observed = run;
                    observed.message = Some(error.clone());
                    store.observe(&observed)?;
                    changed = true;
                    executor.report_error(&error);
                }
            }
        }
    }
    if changed {
        executor.changed();
    }
    Ok(current)
}

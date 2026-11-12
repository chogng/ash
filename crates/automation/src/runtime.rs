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

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;

const POLL_INTERVAL: Duration = Duration::from_secs(1);
const SUSPENSION_THRESHOLD_MS: u64 = 60_000;

/// Host adapter that delivers a stable run identity to the existing execution owner and returns
/// its observed state. Calls for distinct runs can overlap. Implementations must reconcile
/// accepted commands before retrying delivery.
pub trait AutomationExecutor: Send + Sync + 'static {
    fn advance(&self, run: &AutomationRun, now: UnixMillis) -> Result<AutomationRun, String>;
    fn changed(&self);
    fn report_error(&self, message: &str);
}

/// One profile scheduler. Dropping it stops new dispatches and joins its workers.
pub struct AutomationRuntime {
    workers: Vec<(mpsc::Sender<()>, JoinHandle<()>)>,
}

impl AutomationRuntime {
    pub fn start(
        store: Arc<AutomationStore>,
        executor: Arc<dyn AutomationExecutor>,
    ) -> Result<Self, std::io::Error> {
        let mut runtime = Self {
            workers: Vec::new(),
        };
        let schedule_store = Arc::clone(&store);
        let schedule_executor = Arc::clone(&executor);
        runtime.spawn("ash-automation-schedule", move |stop| {
            if let Err(error) = schedule(&schedule_store, schedule_executor.as_ref(), &stop) {
                schedule_executor.report_error(&error.to_string());
            }
        })?;
        // Provider checks can wait on network IO. Give them their own worker so neither
        // scheduling nor advancing an unrelated run waits for those observations.
        for (name, kind) in [
            ("ash-automation-execution", RunKind::Unconditional),
            ("ash-automation-provider", RunKind::Conditional),
        ] {
            let store = Arc::clone(&store);
            let executor = Arc::clone(&executor);
            runtime.spawn(name, move |stop| {
                execute(&store, executor.as_ref(), kind, &stop);
            })?;
        }
        Ok(runtime)
    }

    fn spawn(
        &mut self,
        name: &str,
        task: impl FnOnce(mpsc::Receiver<()>) + Send + 'static,
    ) -> Result<(), std::io::Error> {
        let (stop, receiver) = mpsc::channel();
        let worker = std::thread::Builder::new()
            .name(name.into())
            .spawn(move || task(receiver))?;
        self.workers.push((stop, worker));
        Ok(())
    }
}

impl Drop for AutomationRuntime {
    fn drop(&mut self) {
        for (stop, _) in &self.workers {
            let _ = stop.send(());
        }
        for (_, worker) in self.workers.drain(..) {
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

fn schedule(
    store: &AutomationStore,
    executor: &dyn AutomationExecutor,
    stop: &mpsc::Receiver<()>,
) -> Result<(), AutomationError> {
    let mut last_checked = now()?;
    let mut idle_since = last_checked;
    loop {
        match now().and_then(|current| poll_due(store, &mut last_checked, idle_since, current)) {
            Ok(true) => executor.changed(),
            Ok(false) => {}
            Err(error) => executor.report_error(&error.to_string()),
        }
        idle_since = now()?;
        if stop.recv_timeout(POLL_INTERVAL) != Err(mpsc::RecvTimeoutError::Timeout) {
            return Ok(());
        }
    }
}

fn poll_due(
    store: &AutomationStore,
    last_checked: &mut UnixMillis,
    idle_since: UnixMillis,
    current: UnixMillis,
) -> Result<bool, AutomationError> {
    // Only a long pause during the idle wait counts as suspension. Time spent
    // processing the previous poll belongs to the interval we still need to scan.
    if current.get().saturating_sub(idle_since.get()) > SUSPENSION_THRESHOLD_MS {
        *last_checked = current;
    }
    let plans_before = store.list()?;
    store.poll(*last_checked, current)?;
    *last_checked = current;
    Ok(plans_before != store.list()?)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum RunKind {
    Unconditional,
    Conditional,
}

fn execute(
    store: &AutomationStore,
    executor: &dyn AutomationExecutor,
    kind: RunKind,
    stop: &mpsc::Receiver<()>,
) {
    loop {
        match store.active_runs() {
            Ok(runs) => {
                for run in runs.into_iter().filter(|run| {
                    run.definition.condition.is_some() == (kind == RunKind::Conditional)
                }) {
                    if stop.try_recv() != Err(mpsc::TryRecvError::Empty) {
                        return;
                    }
                    if let Err(error) =
                        now().and_then(|current| advance(store, executor, &run, current))
                    {
                        executor.report_error(&error.to_string());
                    }
                }
            }
            Err(error) => executor.report_error(&error.to_string()),
        }
        if stop.recv_timeout(POLL_INTERVAL) != Err(mpsc::RecvTimeoutError::Timeout) {
            return;
        }
    }
}

fn advance(
    store: &AutomationStore,
    executor: &dyn AutomationExecutor,
    run: &AutomationRun,
    current: UnixMillis,
) -> Result<(), AutomationError> {
    match executor.advance(run, current) {
        Ok(observed) if observed != *run => {
            store.observe(&observed)?;
            executor.changed();
        }
        Ok(_) => {}
        // An unavailable observation must not turn an unknown outcome into a new execution.
        Err(error) if run.message.as_deref() != Some(&error) => {
            // advance may already have durably reserved a provider event. Preserve
            // that reservation and any concurrent stop instead of republishing the old snapshot.
            let mut observed = store.get_run(&run.id)?;
            observed.message = Some(error.clone());
            store.observe(&observed)?;
            executor.changed();
            executor.report_error(&error);
        }
        Err(_) => {}
    }
    Ok(())
}

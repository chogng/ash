use crate::Issue;
use crate::Job;
use crate::Observation;
use crate::Store;
use crate::Workflow;
use crate::store::active;
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Arc;
use std::sync::mpsc;
use std::thread::JoinHandle;
use std::time::Duration;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

/// The profile host supplies tracker IO and Core execution; the scheduler owns dispatch policy.
/// Repeated delivery must reconcile the frozen attempt's durable command before starting work.
pub trait Executor: Send + Sync + 'static {
    fn poll(
        &self,
        workflow: &Workflow,
        cancellation: &CancellationToken,
    ) -> Result<Vec<Issue>, String>;
    fn advance(&self, job: &Job, cancellation: &CancellationToken) -> Result<Observation, String>;
    fn cleanup(&self, job: &Job, cancellation: &CancellationToken) -> Result<(), String>;
    fn changed(&self);
    fn report_error(&self, error: &str);
}

/// One profile scheduler, independent of renderer connections. Drop cancels IO and joins workers.
pub struct Runtime {
    cancellation: CancellationSource,
    stop: mpsc::Sender<()>,
    worker: Option<JoinHandle<()>>,
}

impl Runtime {
    pub fn start(store: Arc<Store>, executor: Arc<dyn Executor>) -> Result<Self, std::io::Error> {
        let cancellation = CancellationSource::new();
        let token = cancellation.token();
        let (stop, receiver) = mpsc::channel();
        let worker = std::thread::Builder::new()
            .name("ash-symphony".into())
            .spawn(move || {
                let (poll_result, results) = mpsc::sync_channel(4);
                let mut polls: BTreeMap<String, JoinHandle<()>> = BTreeMap::new();
                let (execution_result, observations) = mpsc::sync_channel(100);
                let mut executions: BTreeMap<String, JoinHandle<()>> = BTreeMap::new();
                let mut retry_execution = BTreeMap::new();
                let mut last_reload = 0;
                loop {
                    let before = store.jobs().ok();
                    let plans_before = store.workflows().ok();
                    let current = now();
                    while let Ok((workflow, result)) = results.try_recv() {
                        let workflow: Workflow = workflow;
                        if let Some(worker) = polls.remove(&workflow.id) {
                            let _ = worker.join();
                        }
                        let saved = match result {
                            Ok(issues) => store.ingest(&workflow, issues, current),
                            Err(error) => store.poll_error(&workflow.id, error, current),
                        };
                        if let Err(error) = saved {
                            executor.report_error(&error.to_string());
                        }
                    }
                    while let Ok((job, result)) = observations.try_recv() {
                        let job: Job = job;
                        if let Some(worker) = executions.remove(&job.id) {
                            let _ = worker.join();
                        }
                        match result {
                            Ok(observation) => {
                                if let Err(error) = store.observe(&job, observation, current) {
                                    executor.report_error(&error.to_string());
                                }
                            }
                            Err(error) => {
                                // An uncertain delivery keeps its frozen command and input. Never reserve a second attempt.
                                retry_execution
                                    .insert(job.id.clone(), current.saturating_add(5000));
                                let _ = store.advance_error(&job, error);
                            }
                        }
                    }
                    let reloading = current.saturating_sub(last_reload) >= 2000;
                    if reloading {
                        last_reload = current;
                    }
                    match store.plans() {
                        Ok(plans) => {
                            for plan in plans {
                                if reloading {
                                    let _ = store.reload(
                                        &plan.workflow,
                                        Workflow::load(Path::new(&plan.workflow.path)),
                                    );
                                }
                                if (plan.enabled
                                    || before.as_ref().is_some_and(|jobs| {
                                        jobs.iter().any(|job| {
                                            job.workflow_id == plan.workflow.id
                                                && active(job.status)
                                        })
                                    }))
                                    && !matches!(plan.workflow.tracker, crate::Tracker::Local)
                                    && current.saturating_sub(plan.polled_at)
                                        >= plan.workflow.poll_interval_ms
                                    && polls.len() < 4
                                    && !polls.contains_key(&plan.workflow.id)
                                {
                                    let workflow = plan.workflow;
                                    let id = workflow.id.clone();
                                    let executor = Arc::clone(&executor);
                                    let token = token.clone();
                                    let results = poll_result.clone();
                                    match std::thread::Builder::new()
                                        .name("ash-symphony-tracker".into())
                                        .spawn(move || {
                                            let result = executor.poll(&workflow, &token);
                                            // The channel has one slot per admitted poll, so shutdown cannot deadlock.
                                            let _ = results.send((workflow, result));
                                        }) {
                                        Ok(worker) => {
                                            polls.insert(id, worker);
                                        }
                                        Err(error) => {
                                            let _ =
                                                store.poll_error(&id, error.to_string(), current);
                                        }
                                    }
                                }
                            }
                        }
                        Err(error) => executor.report_error(&error.to_string()),
                    }
                    if let Err(error) = store.reserve(current) {
                        executor.report_error(&error.to_string());
                    }
                    match store.jobs() {
                        Ok(jobs) => {
                            for job in jobs
                                .into_iter()
                                .filter(|job| active(job.status) || job.cleanup_pending)
                            {
                                if token.is_cancelled() {
                                    break;
                                }
                                if executions.len() >= 100
                                    || executions.contains_key(&job.id)
                                    || retry_execution
                                        .get(&job.id)
                                        .is_some_and(|retry| *retry > current)
                                {
                                    continue;
                                }
                                let worker_executor = Arc::clone(&executor);
                                let token = token.clone();
                                let results = execution_result.clone();
                                let id = job.id.clone();
                                match std::thread::Builder::new()
                                    .name("ash-symphony-execution".into())
                                    .spawn(move || {
                                        let result = if !active(job.status) && job.cleanup_pending {
                                            worker_executor.cleanup(&job, &token).map(|()| {
                                                Observation {
                                                    status: job.status,
                                                    session_id: job.session_id.clone(),
                                                    thread_id: job.thread_id.clone(),
                                                    turn_id: job.turn_id.clone(),
                                                    error: None,
                                                }
                                            })
                                        } else {
                                            worker_executor.advance(&job, &token)
                                        };
                                        let _ = results.send((job, result));
                                    }) {
                                    Ok(worker) => {
                                        executions.insert(id, worker);
                                    }
                                    Err(error) => executor.report_error(&error.to_string()),
                                }
                            }
                        }
                        Err(error) => executor.report_error(&error.to_string()),
                    }
                    if before != store.jobs().ok() || plans_before != store.workflows().ok() {
                        executor.changed();
                    }
                    match receiver.recv_timeout(Duration::from_millis(250)) {
                        Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                    }
                }
                // Cancellation is raised by Drop before joining this coordinator.
                for (_, worker) in executions {
                    let _ = worker.join();
                }
                for (_, worker) in polls {
                    let _ = worker.join();
                }
            })?;
        Ok(Self {
            cancellation,
            stop,
            worker: Some(worker),
        })
    }
}

impl Drop for Runtime {
    fn drop(&mut self) {
        self.cancellation.cancel();
        let _ = self.stop.send(());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

pub fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .try_into()
        .unwrap_or(u64::MAX)
}

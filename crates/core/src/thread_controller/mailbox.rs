use super::loaded_thread::LoadedThreads;
use super::loaded_thread::ThreadIncarnationId;
use crate::CoreError;
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use ash_protocol::ThreadId;
use ash_protocol::TurnId;
use std::collections::BTreeMap;
use std::num::NonZeroUsize;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::sync::mpsc::Receiver;
use std::sync::mpsc::SyncSender;
use std::sync::mpsc::TryRecvError;
use std::sync::mpsc::TrySendError;
use std::sync::mpsc::sync_channel;
use std::thread;
use std::time::Duration;

const DEFAULT_EXECUTION_MAILBOX_CAPACITY: NonZeroUsize =
    NonZeroUsize::new(8).expect("execution mailbox capacity is non-zero");
const DEFAULT_IDLE_TIMEOUT: Duration = Duration::from_secs(30);

type ExecutionTask = Box<dyn FnOnce(ThreadExecutionContext) + Send + 'static>;

struct QueuedExecution {
    trace_context: opentelemetry::Context,
    thread_id: ThreadId,
    turn_id: TurnId,
    incarnation: ThreadIncarnationId,
    operation_id: u64,
    cancellation: CancellationSource,
    task: ExecutionTask,
}

struct ExecutionLane {
    incarnation: ThreadIncarnationId,
    sender: SyncSender<QueuedExecution>,
}

struct ActiveExecution {
    incarnation: ThreadIncarnationId,
    operation_id: u64,
    cancellation: CancellationSource,
}

/// Cancellation and stale-operation guard for one accepted backend execution.
///
/// Turn execution backends receive this value only from
/// [`ThreadController::enqueue_turn_execution`](super::ThreadController::enqueue_turn_execution).
/// They must check it before external side effects and observe its cancellation token while
/// waiting on model or tool I/O.
pub struct ThreadExecutionContext {
    thread_id: ThreadId,
    turn_id: TurnId,
    incarnation: ThreadIncarnationId,
    operation_id: u64,
    cancellation: CancellationToken,
    loaded_threads: Arc<LoadedThreads>,
    active: Arc<Mutex<BTreeMap<(ThreadId, TurnId), ActiveExecution>>>,
}

impl ThreadExecutionContext {
    pub fn cancellation(&self) -> &CancellationToken {
        &self.cancellation
    }

    pub fn check_current(&self) -> Result<(), CoreError> {
        let active = self
            .active
            .lock()
            .map_err(|_| CoreError::Execution("execution mailbox state lock poisoned".into()))?;
        let is_current_operation = active
            .get(&(self.thread_id.clone(), self.turn_id.clone()))
            .is_some_and(|execution| {
                execution.incarnation == self.incarnation
                    && execution.operation_id == self.operation_id
            });
        if is_current_operation
            && self
                .loaded_threads
                .is_current(&self.thread_id, self.incarnation)
        {
            return Ok(());
        }
        Err(CoreError::Cancelled(format!(
            "stale Thread execution operation: {}",
            self.thread_id
        )))
    }
}

enum EnqueueError {
    StaleIncarnation(ExecutionTask),
    Core(CoreError),
}

/// Owns bounded FIFO execution lanes for loaded Threads.
///
/// Each lane is tied to one explicit Thread incarnation. Workers reject stale queued work before
/// it runs, exit after an idle timeout, and evict only the matching loaded projection. A later
/// command reloads the durable projection with a new incarnation and creates a fresh lane.
pub(crate) struct ThreadExecutionMailboxes {
    capacity: NonZeroUsize,
    idle_timeout: Duration,
    lanes: Arc<Mutex<BTreeMap<ThreadId, ExecutionLane>>>,
    active: Arc<Mutex<BTreeMap<(ThreadId, TurnId), ActiveExecution>>>,
    loaded_threads: Arc<LoadedThreads>,
    next_operation: AtomicU64,
}

impl ThreadExecutionMailboxes {
    pub(crate) fn new(loaded_threads: Arc<LoadedThreads>) -> Self {
        Self::with_settings(
            loaded_threads,
            DEFAULT_EXECUTION_MAILBOX_CAPACITY,
            DEFAULT_IDLE_TIMEOUT,
        )
    }

    fn with_settings(
        loaded_threads: Arc<LoadedThreads>,
        capacity: NonZeroUsize,
        idle_timeout: Duration,
    ) -> Self {
        Self {
            capacity,
            idle_timeout,
            lanes: Arc::new(Mutex::new(BTreeMap::new())),
            active: Arc::new(Mutex::new(BTreeMap::new())),
            loaded_threads,
            next_operation: AtomicU64::new(1),
        }
    }

    pub(crate) fn enqueue(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        task: impl FnOnce(ThreadExecutionContext) + Send + 'static,
    ) -> Result<(), CoreError> {
        let mut task: ExecutionTask = Box::new(task);
        loop {
            match self.enqueue_once(thread_id, turn_id, task) {
                Ok(()) => return Ok(()),
                Err(EnqueueError::StaleIncarnation(returned)) => {
                    task = returned;
                    thread::yield_now();
                }
                Err(EnqueueError::Core(error)) => return Err(error),
            }
        }
    }

    pub(crate) fn cancel(&self, thread_id: &ThreadId, turn_id: &TurnId) {
        let cancellation = self.active.lock().ok().and_then(|active| {
            active
                .get(&(thread_id.clone(), turn_id.clone()))
                .map(|execution| execution.cancellation.clone())
        });
        if let Some(cancellation) = cancellation {
            cancellation.cancel();
        }
    }

    #[cfg(test)]
    pub(crate) fn has_work(&self, thread_id: &ThreadId) -> Result<bool, CoreError> {
        Ok(self
            .active
            .lock()
            .map_err(|_| CoreError::Execution("execution mailbox state lock poisoned".into()))?
            .keys()
            .any(|(active_thread_id, _)| active_thread_id == thread_id))
    }

    pub(crate) fn retire_idle(&self, thread_id: &ThreadId) -> Result<(), CoreError> {
        let mut lanes = self
            .lanes
            .lock()
            .map_err(|_| CoreError::Execution("execution mailbox registry lock poisoned".into()))?;
        let active = self
            .active
            .lock()
            .map_err(|_| CoreError::Execution("execution mailbox state lock poisoned".into()))?;
        if active
            .keys()
            .any(|(active_thread_id, _)| active_thread_id == thread_id)
        {
            return Err(CoreError::Execution(format!(
                "cannot reload an active Thread: {thread_id}"
            )));
        }
        lanes.remove(thread_id);
        Ok(())
    }

    pub(crate) fn retire(&self, thread_id: &ThreadId) -> Result<(), CoreError> {
        let mut lanes = self
            .lanes
            .lock()
            .map_err(|_| CoreError::Execution("execution mailbox registry lock poisoned".into()))?;
        let active = self
            .active
            .lock()
            .map_err(|_| CoreError::Execution("execution mailbox state lock poisoned".into()))?;
        for ((active_thread_id, _), execution) in active.iter() {
            if active_thread_id == thread_id {
                execution.cancellation.cancel();
            }
        }
        lanes.remove(thread_id);
        Ok(())
    }

    fn enqueue_once(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        task: ExecutionTask,
    ) -> Result<(), EnqueueError> {
        let incarnation = self
            .loaded_threads
            .ensure_loaded_incarnation(thread_id)
            .map_err(EnqueueError::Core)?;
        let operation_id = self.next_operation.fetch_add(1, Ordering::Relaxed);
        let cancellation = CancellationSource::new();
        let mut lanes = self.lanes.lock().map_err(|_| {
            EnqueueError::Core(CoreError::Execution(
                "execution mailbox registry lock poisoned".into(),
            ))
        })?;
        if !self.loaded_threads.is_current(thread_id, incarnation) {
            return Err(EnqueueError::StaleIncarnation(task));
        }
        let sender = match lanes.get(thread_id) {
            Some(lane) if lane.incarnation == incarnation => lane.sender.clone(),
            _ => self
                .start_lane(thread_id, incarnation)
                .map_err(EnqueueError::Core)
                .map(|lane| {
                    let sender = lane.sender.clone();
                    lanes.insert(thread_id.clone(), lane);
                    sender
                })?,
        };
        self.active
            .lock()
            .map_err(|_| {
                EnqueueError::Core(CoreError::Execution(
                    "execution mailbox state lock poisoned".into(),
                ))
            })?
            .insert(
                (thread_id.clone(), turn_id.clone()),
                ActiveExecution {
                    incarnation,
                    operation_id,
                    cancellation: cancellation.clone(),
                },
            );
        let queued = QueuedExecution {
            trace_context: opentelemetry::Context::current(),
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            incarnation,
            operation_id,
            cancellation,
            task,
        };
        match sender.try_send(queued) {
            Ok(()) => Ok(()),
            Err(error) => {
                clear_active(&self.active, thread_id, turn_id, incarnation, operation_id);
                Err(EnqueueError::Core(match error {
                    TrySendError::Full(_) => CoreError::Execution(format!(
                        "Thread execution mailbox is full: {thread_id}"
                    )),
                    TrySendError::Disconnected(_) => CoreError::Execution(format!(
                        "Thread execution mailbox stopped: {thread_id}"
                    )),
                }))
            }
        }
    }

    fn start_lane(
        &self,
        thread_id: &ThreadId,
        incarnation: ThreadIncarnationId,
    ) -> Result<ExecutionLane, CoreError> {
        let (sender, receiver) = sync_channel(self.capacity.get());
        let lanes = self.lanes.clone();
        let active = self.active.clone();
        let loaded_threads = self.loaded_threads.clone();
        let idle_timeout = self.idle_timeout;
        let lane_thread_id = thread_id.clone();
        let name = format!("ash-thread-{}", thread_id.as_str());
        thread::Builder::new()
            .name(name)
            .spawn(move || {
                run_lane(
                    lane_thread_id,
                    incarnation,
                    receiver,
                    lanes,
                    active,
                    loaded_threads,
                    idle_timeout,
                );
            })
            .map_err(|error| {
                CoreError::Execution(format!("failed to start Thread mailbox: {error}"))
            })?;
        Ok(ExecutionLane {
            incarnation,
            sender,
        })
    }
}

fn run_lane(
    lane_thread_id: ThreadId,
    lane_incarnation: ThreadIncarnationId,
    receiver: Receiver<QueuedExecution>,
    lanes: Arc<Mutex<BTreeMap<ThreadId, ExecutionLane>>>,
    active: Arc<Mutex<BTreeMap<(ThreadId, TurnId), ActiveExecution>>>,
    loaded_threads: Arc<LoadedThreads>,
    idle_timeout: Duration,
) {
    loop {
        match receiver.recv_timeout(idle_timeout) {
            Ok(queued) => run_queued(queued, &active, &loaded_threads),
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => return,
            Err(std::sync::mpsc::RecvTimeoutError::Timeout) => {
                let Ok(mut lanes) = lanes.lock() else {
                    return;
                };
                match receiver.try_recv() {
                    Ok(queued) => {
                        drop(lanes);
                        run_queued(queued, &active, &loaded_threads);
                    }
                    Err(TryRecvError::Disconnected | TryRecvError::Empty) => {
                        let is_current_lane = lanes
                            .get(&lane_thread_id)
                            .is_some_and(|lane| lane.incarnation == lane_incarnation);
                        if is_current_lane {
                            lanes.remove(&lane_thread_id);
                            let _ =
                                loaded_threads.evict_if_current(&lane_thread_id, lane_incarnation);
                        }
                        return;
                    }
                }
            }
        }
    }
}

fn run_queued(
    queued: QueuedExecution,
    active: &Arc<Mutex<BTreeMap<(ThreadId, TurnId), ActiveExecution>>>,
    loaded_threads: &Arc<LoadedThreads>,
) {
    let QueuedExecution {
        trace_context,
        thread_id,
        turn_id,
        incarnation,
        operation_id,
        cancellation,
        task,
    } = queued;
    if loaded_threads.is_current(&thread_id, incarnation) {
        let execution = ThreadExecutionContext {
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            incarnation,
            operation_id,
            cancellation: cancellation.token(),
            loaded_threads: loaded_threads.clone(),
            active: active.clone(),
        };
        let _context = trace_context.attach();
        task(execution);
    } else {
        cancellation.cancel();
    }
    clear_active(active, &thread_id, &turn_id, incarnation, operation_id);
}

fn clear_active(
    active: &Mutex<BTreeMap<(ThreadId, TurnId), ActiveExecution>>,
    thread_id: &ThreadId,
    turn_id: &TurnId,
    incarnation: ThreadIncarnationId,
    operation_id: u64,
) {
    if let Ok(mut active) = active.lock() {
        let key = (thread_id.clone(), turn_id.clone());
        if active.get(&key).is_some_and(|execution| {
            execution.incarnation == incarnation && execution.operation_id == operation_id
        }) {
            active.remove(&key);
        }
    }
}

#[cfg(test)]
#[path = "mailbox_tests.rs"]
mod tests;

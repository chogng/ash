use std::collections::HashMap;
use std::collections::HashSet;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use ash_app_server_protocol::protocol::registry::SerializationAccess;
use ash_async_utils::CancellationSource;
use ash_async_utils::CancellationToken;
use std::path::PathBuf;

/// Outcome of cancelling a connection-owned operation, before or during execution.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RequestCancelStatus {
    Requested,
    AlreadyRequested,
    Completed,
}

/// Backend admission keys contain resolved domain identities, never caller-selected aliases.
#[derive(Clone, Debug)]
pub(crate) enum RequestSerializationScope {
    Global {
        access: SerializationAccess,
    },
    Session {
        session_id: String,
        access: SerializationAccess,
    },
    ConnectionResource {
        namespace: &'static str,
        resource_id: String,
        access: SerializationAccess,
    },
    Repository {
        common_dir: PathBuf,
        access: SerializationAccess,
    },
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
enum RequestSerializationKey {
    Global(u64),
    Repository(PathBuf),
    Session(u64, String),
    ConnectionResource {
        owner_id: u64,
        connection_id: u64,
        namespace: &'static str,
        resource_id: String,
    },
}

impl RequestSerializationKey {
    fn from_scope(
        owner_id: u64,
        connection_id: u64,
        scope: RequestSerializationScope,
    ) -> (Self, Access) {
        match scope {
            RequestSerializationScope::Global { access } => {
                (Self::Global(owner_id), Access::from(access))
            }
            RequestSerializationScope::Repository { common_dir, access } => {
                (Self::Repository(common_dir), Access::from(access))
            }
            RequestSerializationScope::Session { session_id, access } => {
                (Self::Session(owner_id, session_id), Access::from(access))
            }
            RequestSerializationScope::ConnectionResource {
                namespace,
                resource_id,
                access,
            } => (
                Self::ConnectionResource {
                    owner_id,
                    connection_id,
                    namespace,
                    resource_id,
                },
                Access::from(access),
            ),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Access {
    Exclusive,
    SharedRead,
}

impl From<SerializationAccess> for Access {
    fn from(access: SerializationAccess) -> Self {
        match access {
            SerializationAccess::Exclusive => Self::Exclusive,
            SerializationAccess::SharedRead => Self::SharedRead,
        }
    }
}

#[derive(Default)]
struct Queue {
    active: Active,
    waiting: VecDeque<Arc<Waiter>>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum Active {
    #[default]
    None,
    Exclusive,
    SharedRead(usize),
}

struct Waiter {
    owner_id: u64,
    connection_id: u64,
    access: Access,
    cancellation: CancellationToken,
    completion: Mutex<Option<Box<dyn FnOnce(WaiterState) + Send>>>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum WaiterState {
    Acquired,
    Cancelled,
}

impl Waiter {
    fn new(
        owner_id: u64,
        connection_id: u64,
        access: Access,
        cancellation: CancellationToken,
    ) -> Self {
        Self {
            owner_id,
            connection_id,
            access,
            cancellation,
            completion: Mutex::new(None),
        }
    }

    fn complete(&self, state: WaiterState) {
        let completion = lock(&self.completion).take();
        if let Some(completion) = completion {
            completion(state);
        }
    }
}

#[derive(Default)]
struct SchedulerState {
    queues: HashMap<RequestSerializationKey, Queue>,
    cancelled_connections: std::collections::BTreeSet<(u64, u64)>,
}

#[derive(Clone)]
pub(crate) struct RequestScheduler {
    owner_id: u64,
    state: Arc<Mutex<SchedulerState>>,
}

impl Default for RequestScheduler {
    fn default() -> Self {
        static NEXT_OWNER: AtomicU64 = AtomicU64::new(1);
        static STATE: OnceLock<Arc<Mutex<SchedulerState>>> = OnceLock::new();
        Self {
            owner_id: NEXT_OWNER.fetch_add(1, Ordering::Relaxed),
            // Repository admission spans directory runtimes, including separate worktrees.
            // Other keys retain their runtime identity so unrelated directory state stays independent.
            state: Arc::clone(
                STATE.get_or_init(|| Arc::new(Mutex::new(SchedulerState::default()))),
            ),
        }
    }
}

impl RequestScheduler {
    /// Enqueues resource admission without retaining an execution thread while it waits.
    pub(super) fn schedule(
        &self,
        connection_id: u64,
        scope: RequestSerializationScope,
        cancellation: CancellationToken,
        ready: impl FnOnce(Result<RequestPermit, ConnectionClosed>) + Send + 'static,
    ) {
        let (key, access) =
            RequestSerializationKey::from_scope(self.owner_id, connection_id, scope);
        let scheduler = self.clone();
        let permit_key = key.clone();
        let waiter = Arc::new(Waiter::new(
            self.owner_id,
            connection_id,
            access,
            cancellation,
        ));
        *lock(&waiter.completion) = Some(Box::new(move |state| {
            ready(match state {
                WaiterState::Acquired => Ok(RequestPermit {
                    scheduler,
                    key: Some(permit_key),
                    access,
                }),
                WaiterState::Cancelled => Err(ConnectionClosed),
            });
        }));
        let completed = {
            let mut state = lock(&self.state);
            if state
                .cancelled_connections
                .contains(&(self.owner_id, connection_id))
                || waiter.cancellation.is_cancelled()
            {
                Some(WaiterState::Cancelled)
            } else {
                let queue = state.queues.entry(key).or_default();
                if can_acquire_immediately(queue, access) {
                    activate(queue, access);
                    Some(WaiterState::Acquired)
                } else {
                    queue.waiting.push_back(Arc::clone(&waiter));
                    None
                }
            }
        };
        if let Some(completed) = completed {
            waiter.complete(completed);
        }
    }

    /// A cancellation command removes waiting work before the owning resource becomes free.
    pub(super) fn cancel_waiting_requests(&self) {
        let mut cancelled = Vec::new();
        let mut acquired = Vec::new();
        {
            let mut state = lock(&self.state);
            state.queues.retain(|_, queue| {
                queue.waiting.retain(|waiter| {
                    if waiter.cancellation.is_cancelled() {
                        cancelled.push(Arc::clone(waiter));
                        false
                    } else {
                        true
                    }
                });
                if queue.active == Active::None {
                    acquired.extend(promote(queue));
                }
                queue.active != Active::None || !queue.waiting.is_empty()
            });
        }
        for waiter in cancelled {
            waiter.complete(WaiterState::Cancelled);
        }
        for waiter in acquired {
            waiter.complete(WaiterState::Acquired);
        }
    }
    #[cfg(test)]
    pub(super) fn acquire(
        &self,
        connection_id: u64,
        scope: RequestSerializationScope,
    ) -> Result<RequestPermit, ConnectionClosed> {
        let cancellation = CancellationSource::new();
        self.acquire_with_cancellation(connection_id, scope, &cancellation.token())
    }

    pub(super) fn acquire_with_cancellation(
        &self,
        connection_id: u64,
        scope: RequestSerializationScope,
        cancellation: &CancellationToken,
    ) -> Result<RequestPermit, ConnectionClosed> {
        let (sender, receiver) = std::sync::mpsc::channel();
        self.schedule(connection_id, scope, cancellation.clone(), move |permit| {
            let _ = sender.send(permit);
        });
        loop {
            if cancellation.is_cancelled() {
                self.cancel_waiting_requests();
            }
            match receiver.recv_timeout(std::time::Duration::from_millis(25)) {
                Ok(permit) => {
                    if cancellation.is_cancelled() {
                        drop(permit);
                        return Err(ConnectionClosed);
                    }
                    return permit;
                }
                Err(std::sync::mpsc::RecvTimeoutError::Timeout) => continue,
                Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
                    return Err(ConnectionClosed);
                }
            }
        }
    }

    pub(super) fn cancel_connection(&self, connection_id: u64) {
        let cancelled = {
            let mut state = lock(&self.state);
            state
                .cancelled_connections
                .insert((self.owner_id, connection_id));
            state
                .queues
                .values_mut()
                .flat_map(|queue| {
                    let mut cancelled = Vec::new();
                    queue.waiting.retain(|waiter| {
                        if waiter.owner_id == self.owner_id && waiter.connection_id == connection_id
                        {
                            cancelled.push(Arc::clone(waiter));
                            false
                        } else {
                            true
                        }
                    });
                    cancelled
                })
                .collect::<Vec<_>>()
        };
        for waiter in cancelled {
            waiter.complete(WaiterState::Cancelled);
        }
    }

    pub(super) fn is_connection_cancelled(&self, connection_id: u64) -> bool {
        lock(&self.state)
            .cancelled_connections
            .contains(&(self.owner_id, connection_id))
    }

    pub(super) fn finish_connection(&self, connection_id: u64) {
        lock(&self.state)
            .cancelled_connections
            .remove(&(self.owner_id, connection_id));
    }

    fn release(&self, key: RequestSerializationKey, access: Access) {
        let ready = {
            let mut state = lock(&self.state);
            let Some(queue) = state.queues.get_mut(&key) else {
                return;
            };
            deactivate(queue, access);
            let ready = if queue.active == Active::None {
                promote(queue)
            } else {
                Vec::new()
            };
            if queue.active == Active::None && queue.waiting.is_empty() {
                state.queues.remove(&key);
            }
            ready
        };
        for waiter in ready {
            waiter.complete(WaiterState::Acquired);
        }
    }

    #[cfg(test)]
    pub(super) fn waiting_count(&self) -> usize {
        lock(&self.state)
            .queues
            .values()
            .map(|queue| {
                queue
                    .waiting
                    .iter()
                    .filter(|waiter| waiter.owner_id == self.owner_id)
                    .count()
            })
            .sum()
    }
}

#[derive(Clone, Default)]
pub(super) struct RequestCancellationRegistry {
    state: Arc<Mutex<CancellationRegistryState>>,
}

#[derive(Default)]
struct CancellationRegistryState {
    active: HashMap<(u64, u64), CancellationSource>,
    request_operations: HashMap<(u64, u64), String>,
    active_operations: HashMap<(u64, String), CancellationSource>,
    requested_before_start: HashSet<(u64, String)>,
    requested_before_start_order: VecDeque<(u64, String)>,
    completed_operations: HashSet<(u64, String)>,
    completed_operation_order: VecDeque<(u64, String)>,
}

const RETAINED_OPERATION_LIMIT: usize = 1_024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) struct DuplicateOperationId;

impl RequestCancellationRegistry {
    pub(super) fn start(
        &self,
        connection_id: u64,
        request_id: u64,
        operation_id: Option<String>,
    ) -> Result<CancellationToken, DuplicateOperationId> {
        let source = CancellationSource::new();
        let token = source.token();
        let mut state = lock(&self.state);
        if let Some(operation_id) = operation_id {
            let operation = (connection_id, operation_id.clone());
            if state.active_operations.contains_key(&operation)
                || state.completed_operations.contains(&operation)
            {
                return Err(DuplicateOperationId);
            }
            if state.requested_before_start.remove(&operation) {
                state
                    .requested_before_start_order
                    .retain(|queued| queued != &operation);
                source.cancel();
            }
            state.active_operations.insert(operation, source.clone());
            state
                .request_operations
                .insert((connection_id, request_id), operation_id);
        }
        state.active.insert((connection_id, request_id), source);
        Ok(token)
    }

    pub(super) fn cancel_operation(
        &self,
        connection_id: u64,
        operation_id: String,
    ) -> RequestCancelStatus {
        let mut state = lock(&self.state);
        let operation = (connection_id, operation_id);
        if let Some(source) = state.active_operations.get(&operation) {
            if source.token().is_cancelled() {
                return RequestCancelStatus::AlreadyRequested;
            }
            source.cancel();
            return RequestCancelStatus::Requested;
        }
        if state.completed_operations.contains(&operation) {
            return RequestCancelStatus::Completed;
        }
        if state.requested_before_start.contains(&operation) {
            return RequestCancelStatus::AlreadyRequested;
        }
        let CancellationRegistryState {
            requested_before_start,
            requested_before_start_order,
            ..
        } = &mut *state;
        remember_bounded(
            requested_before_start,
            requested_before_start_order,
            operation,
        );
        RequestCancelStatus::Requested
    }

    pub(super) fn finish(&self, connection_id: u64, request_id: u64) {
        let mut state = lock(&self.state);
        state.active.remove(&(connection_id, request_id));
        let Some(operation_id) = state
            .request_operations
            .remove(&(connection_id, request_id))
        else {
            return;
        };
        let operation = (connection_id, operation_id);
        state.active_operations.remove(&operation);
        let CancellationRegistryState {
            completed_operations,
            completed_operation_order,
            ..
        } = &mut *state;
        remember_bounded(completed_operations, completed_operation_order, operation);
    }

    pub(super) fn cancel_connection(&self, connection_id: u64) {
        let mut state = lock(&self.state);
        for ((active_connection_id, _), source) in &state.active {
            if *active_connection_id == connection_id {
                source.cancel();
            }
        }
        state
            .request_operations
            .retain(|(active_connection_id, _), _| *active_connection_id != connection_id);
        state
            .active_operations
            .retain(|(active_connection_id, _), _| *active_connection_id != connection_id);
        state
            .requested_before_start
            .retain(|(active_connection_id, _)| *active_connection_id != connection_id);
        state
            .requested_before_start_order
            .retain(|(active_connection_id, _)| *active_connection_id != connection_id);
        state
            .completed_operations
            .retain(|(active_connection_id, _)| *active_connection_id != connection_id);
        state
            .completed_operation_order
            .retain(|(active_connection_id, _)| *active_connection_id != connection_id);
    }
}

fn remember_bounded(
    retained: &mut HashSet<(u64, String)>,
    order: &mut VecDeque<(u64, String)>,
    operation: (u64, String),
) {
    if retained.insert(operation.clone()) {
        order.push_back(operation);
    }
    while retained.len() > RETAINED_OPERATION_LIMIT {
        let Some(oldest) = order.pop_front() else {
            break;
        };
        retained.remove(&oldest);
    }
}

pub(crate) struct RequestPermit {
    scheduler: RequestScheduler,
    key: Option<RequestSerializationKey>,
    access: Access,
}

impl Drop for RequestPermit {
    fn drop(&mut self) {
        if let Some(key) = self.key.take() {
            self.scheduler.release(key, self.access);
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) struct ConnectionClosed;

fn can_acquire_immediately(queue: &Queue, access: Access) -> bool {
    match (queue.active, access) {
        (Active::None, _) => queue.waiting.is_empty(),
        (Active::SharedRead(_), Access::SharedRead) => queue.waiting.is_empty(),
        _ => false,
    }
}

fn activate(queue: &mut Queue, access: Access) {
    queue.active = match (queue.active, access) {
        (Active::None, Access::Exclusive) => Active::Exclusive,
        (Active::None, Access::SharedRead) => Active::SharedRead(1),
        (Active::SharedRead(count), Access::SharedRead) => Active::SharedRead(count + 1),
        _ => unreachable!("scheduler only activates compatible access"),
    };
}

fn deactivate(queue: &mut Queue, access: Access) {
    queue.active = match (queue.active, access) {
        (Active::Exclusive, Access::Exclusive) => Active::None,
        (Active::SharedRead(1), Access::SharedRead) => Active::None,
        (Active::SharedRead(count), Access::SharedRead) => Active::SharedRead(count - 1),
        _ => unreachable!("released access must match the active scheduler state"),
    };
}

fn promote(queue: &mut Queue) -> Vec<Arc<Waiter>> {
    let Some(first) = queue.waiting.pop_front() else {
        return Vec::new();
    };
    let access = first.access;
    let mut ready = vec![first];
    if access == Access::SharedRead {
        while queue
            .waiting
            .front()
            .is_some_and(|waiter| waiter.access == Access::SharedRead)
        {
            ready.push(queue.waiting.pop_front().expect("front waiter exists"));
        }
    }
    queue.active = match access {
        Access::Exclusive => Active::Exclusive,
        Access::SharedRead => Active::SharedRead(ready.len()),
    };
    ready
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

#[cfg(test)]
#[path = "request_serialization_tests.rs"]
mod tests;

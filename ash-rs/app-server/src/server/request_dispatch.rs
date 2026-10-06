use super::message_queue::InputBudgets;
use super::message_queue::MessageBytes;
use super::request_serialization::ConnectionClosed;
use super::request_serialization::RequestPermit;
use super::request_serialization::RequestScheduler;
use super::request_serialization::RequestSerializationScope;
use ash_app_server_transport::JsonlWriter;
use ash_async_utils::CancellationToken;
use std::collections::HashMap;
use std::future::Future;
use std::io;
use std::io::Write;
use std::ops::Deref;
use std::pin::Pin;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::OnceLock;
use std::sync::mpsc;
use std::thread;
use std::time::Instant;
use std::time::SystemTime;

const REQUEST_CAPACITY: usize = 64;
const CONTROL_CAPACITY: usize = 16;
const NETWORK_CAPACITY: usize = 8;
// Request workers synchronously poll Git worktree provisioning. Its nested futures
// exceed the platform's default stack in unoptimized builds, including Bazel scenarios.
const REQUEST_WORKER_STACK_BYTES: usize = 8 * 1024 * 1024;

/// All directory runtimes share the network executor. The request lease bounds both
/// async tasks and HTTP work queued in its blocking pool; a connection owns their completion.
pub(super) fn runtime() -> io::Result<&'static tokio::runtime::Runtime> {
    static RUNTIME: OnceLock<Result<tokio::runtime::Runtime, String>> = OnceLock::new();
    RUNTIME
        .get_or_init(|| {
            tokio::runtime::Builder::new_multi_thread()
                .enable_all()
                .worker_threads(2)
                .max_blocking_threads(32)
                .thread_name("ash-request-network")
                .build()
                .map_err(|error| error.to_string())
        })
        .as_ref()
        .map_err(|error| io::Error::other(error.clone()))
}

#[derive(Clone)]
pub(crate) struct IncomingRequest {
    raw: Arc<zeroize::Zeroizing<String>>,
    received_at: Instant,
    received_time: SystemTime,
    bytes: Option<Arc<MessageBytes>>,
    host_bytes: Option<Arc<MessageBytes>>,
}

impl From<String> for IncomingRequest {
    fn from(raw: String) -> Self {
        Self {
            raw: Arc::new(zeroize::Zeroizing::new(raw)),
            received_at: Instant::now(),
            received_time: SystemTime::now(),
            bytes: None,
            host_bytes: None,
        }
    }
}

impl IncomingRequest {
    pub(crate) fn clear(&mut self) {
        // Routing clones share one allocation. Its last owner zeroizes the original frame.
        self.raw = Arc::new(zeroize::Zeroizing::new(String::new()));
    }
    pub(crate) fn retain(&mut self, budgets: &InputBudgets, lane: RequestLane) -> Result<(), ()> {
        if self.bytes.is_none() {
            let budget = match lane {
                RequestLane::Control => &budgets.control,
                _ => &budgets.ordinary,
            };
            let bytes = budget.try_reserve(self.len()).ok_or(())?;
            let host_budget = if lane == RequestLane::Control {
                &budgets.host.control
            } else {
                &budgets.host.ordinary
            };
            let host_bytes = host_budget.try_reserve(self.len()).ok_or(())?;
            self.bytes = Some(Arc::new(bytes));
            self.host_bytes = Some(Arc::new(host_bytes));
        }
        Ok(())
    }
}

impl Deref for IncomingRequest {
    type Target = str;
    fn deref(&self) -> &str {
        &self.raw
    }
}

pub(crate) struct OutgoingMessage {
    pub(crate) raw: String,
    trace: ash_otel::OutboundTrace,
    pub(super) bytes: Option<MessageBytes>,
}

impl From<String> for OutgoingMessage {
    fn from(raw: String) -> Self {
        Self {
            raw,
            trace: ash_otel::OutboundTrace::capture(),
            bytes: None,
        }
    }
}

impl OutgoingMessage {
    pub(crate) fn write_to<W: Write>(
        self,
        writer: &mut JsonlWriter<W>,
        telemetry: &ash_otel::Telemetry,
    ) -> io::Result<()> {
        let span = telemetry.start_outbound(self.trace);
        let started = Instant::now();
        let result = writer.write_message(&self.raw);
        span.record_duration("rpc.write_ms", started.elapsed());
        span.finish(if result.is_ok() {
            diagnostics::Outcome::Succeeded
        } else {
            diagnostics::Outcome::Failed
        });
        result
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum RequestLane {
    Interactive,
    Background,
    Control,
    Network,
}

impl RequestLane {
    fn workers(self) -> usize {
        match self {
            Self::Interactive => 2,
            Self::Background | Self::Control | Self::Network => 1,
        }
    }

    fn index(self) -> usize {
        match self {
            Self::Interactive => 0,
            Self::Background => 1,
            Self::Control => 2,
            Self::Network => 3,
        }
    }
}

type HostRequestPermit = (MessageBytes, Option<MessageBytes>);

fn reserve_host_request(
    budgets: &InputBudgets,
    lane: RequestLane,
) -> Result<HostRequestPermit, ()> {
    let budget = if lane == RequestLane::Control {
        &budgets.host.control_requests
    } else {
        &budgets.host.requests
    };
    let request = budget.try_reserve(1).ok_or(())?;
    let network = if lane == RequestLane::Network {
        Some(budgets.host.network_requests.try_reserve(1).ok_or(())?)
    } else {
        None
    };
    Ok((request, network))
}

/// Synchronous embedders use the same host ceilings as transport requests. Initializing
/// a connection does not consume ordinary execution capacity.
pub(super) fn inline_admission(
    method: &str,
    params: &serde_json::Value,
    bytes: usize,
) -> Result<(HostRequestPermit, MessageBytes), ()> {
    let budgets = InputBudgets::default();
    let lane = RequestLane::for_message(method, params);
    let budget = if lane == RequestLane::Control {
        &budgets.host.control
    } else {
        &budgets.host.ordinary
    };
    let bytes = budget.try_reserve(bytes).ok_or(())?;
    Ok((reserve_host_request(&budgets, lane)?, bytes))
}

pub(crate) struct RequestAdmission {
    pub(crate) permit: Result<Option<RequestPermit>, ConnectionClosed>,
    pub(crate) ready_at: Instant,
}

type Job<'env> = Box<dyn FnOnce(RequestAdmission) -> io::Result<()> + Send + 'env>;
pub(super) type NetworkResult = Option<Result<serde_json::Value, super::RpcError>>;
pub(super) type NetworkFuture = Pin<Box<dyn Future<Output = NetworkResult> + Send + 'static>>;
type NetworkCompletion<'env> = Box<dyn FnOnce(NetworkResult) -> io::Result<()> + Send + 'env>;

struct NetworkWork<'env> {
    future: NetworkFuture,
    complete: NetworkCompletion<'env>,
    completion_sender: Arc<mpsc::Sender<Ready>>,
}

enum PendingJob<'env> {
    Blocking(Job<'env>),
    Network(Box<dyn FnOnce(RequestAdmission) -> NetworkWork<'env> + Send + 'env>),
}

struct Pending<'env> {
    next_ticket: u64,
    ordinary: usize,
    control: usize,
    network: usize,
    jobs: HashMap<u64, PendingJob<'env>>,
    completions: HashMap<u64, NetworkCompletion<'env>>,
    host_permits: HashMap<u64, HostRequestPermit>,
    failure: Option<io::Error>,
}

enum Ready {
    Stop,
    Execute {
        ticket: u64,
        admission: RequestAdmission,
    },
    Complete {
        ticket: u64,
        result: NetworkResult,
    },
}

/// One connection's bounded execution capacity, shared by direct and routed transports.
/// Resource waiters live in the scheduler; only admitted work enters a worker queue. Network
/// futures retain request capacity through completion without occupying a blocking worker. Control
/// commands have separate admission and execution capacity so saturation cannot prevent cancel.
pub(crate) struct RequestDispatcher<'scope, 'env> {
    handle: RequestDispatchHandle<'env>,
    workers: Vec<thread::ScopedJoinHandle<'scope, ()>>,
    _connection: MessageBytes,
}

#[derive(Clone)]
pub(crate) struct RequestDispatchHandle<'env> {
    pending: Arc<(Mutex<Pending<'env>>, Condvar)>,
    ready: Vec<Arc<mpsc::Sender<Ready>>>,
    budgets: InputBudgets,
}

impl<'env> Deref for RequestDispatcher<'_, 'env> {
    type Target = RequestDispatchHandle<'env>;

    fn deref(&self) -> &Self::Target {
        &self.handle
    }
}

impl<'scope, 'env: 'scope> RequestDispatcher<'scope, 'env> {
    pub(crate) fn start(scope: &'scope thread::Scope<'scope, 'env>) -> io::Result<Self> {
        let budgets = InputBudgets::default();
        let connection = budgets
            .host
            .connections
            .try_reserve(1)
            .ok_or_else(|| io::Error::other("ServerOverloaded"))?;
        let pending = Arc::new((
            Mutex::new(Pending {
                next_ticket: 0,
                ordinary: 0,
                control: 0,
                network: 0,
                jobs: HashMap::new(),
                completions: HashMap::new(),
                host_permits: HashMap::new(),
                failure: None,
            }),
            Condvar::new(),
        ));
        let network_runtime = runtime()?;
        let mut ready = Vec::new();
        let mut workers = Vec::new();
        for lane in [
            RequestLane::Interactive,
            RequestLane::Background,
            RequestLane::Control,
            RequestLane::Network,
        ] {
            let capacity = lane.workers();
            let (sender, receiver) = mpsc::channel::<Ready>();
            let sender = Arc::new(sender);
            ready.push(Arc::clone(&sender));
            let receiver = Arc::new(Mutex::new(receiver));
            for index in 0..capacity {
                let receiver = Arc::clone(&receiver);
                let pending = Arc::clone(&pending);
                let worker = thread::Builder::new()
                    .name(format!("ash-request-{}-{index}", lane.index()))
                    .stack_size(REQUEST_WORKER_STACK_BYTES)
                    .spawn_scoped(scope, move || {
                        loop {
                            let Ok(ready) = receiver.lock().unwrap().recv() else {
                                break;
                            };
                            if matches!(ready, Ready::Stop) {
                                break;
                            }
                            let ticket = match &ready {
                                Ready::Stop => unreachable!("worker stop handled above"),
                                Ready::Execute { ticket, .. } | Ready::Complete { ticket, .. } => {
                                    *ticket
                                }
                            };
                            let mut completion = Completion {
                                pending: Arc::clone(&pending),
                                lane,
                                ticket,
                                active: true,
                            };
                            let result = match ready {
                                Ready::Stop => unreachable!("worker stop handled above"),
                                Ready::Execute { ticket, admission } => {
                                    let job = pending
                                        .0
                                        .lock()
                                        .unwrap()
                                        .jobs
                                        .remove(&ticket)
                                        .expect("admitted work retains its job");
                                    match job {
                                        PendingJob::Blocking(job) => job(admission),
                                        PendingJob::Network(prepare) => {
                                            let work = prepare(admission);
                                            pending
                                                .0
                                                .lock()
                                                .unwrap()
                                                .completions
                                                .insert(ticket, work.complete);
                                            let complete = work.completion_sender;
                                            let task = network_runtime.spawn(work.future);
                                            network_runtime.spawn(async move {
                                                let result = task.await.unwrap_or_else(|_| {
                                                    Some(Err(super::RpcError::new(
                                                        -32603,
                                                        super::AppServerErrorName::InternalError,
                                                    )))
                                                });
                                                let _ = complete
                                                    .send(Ready::Complete { ticket, result });
                                            });
                                            completion.active = false;
                                            continue;
                                        }
                                    }
                                }
                                Ready::Complete { ticket, result } => {
                                    let complete = pending
                                        .0
                                        .lock()
                                        .unwrap()
                                        .completions
                                        .remove(&ticket)
                                        .expect("network work retains its completion");
                                    complete(result)
                                }
                            };
                            if let Err(error) = result {
                                pending.0.lock().unwrap().failure.get_or_insert(error);
                            }
                        }
                    });
                match worker {
                    Ok(worker) => workers.push(worker),
                    Err(error) => {
                        // Join workers already registered with this connection before
                        // returning a construction error to its scoped thread owner.
                        for (index, sender) in ready.iter().enumerate() {
                            let count = if index == RequestLane::Interactive.index() {
                                2
                            } else {
                                1
                            };
                            for _ in 0..count {
                                let _ = sender.send(Ready::Stop);
                            }
                        }
                        for worker in workers {
                            let _ = worker.join();
                        }
                        return Err(error);
                    }
                }
            }
        }
        Ok(Self {
            handle: RequestDispatchHandle {
                pending,
                ready,
                budgets,
            },
            workers,
            _connection: connection,
        })
    }

    pub(crate) fn handle(&self) -> RequestDispatchHandle<'env> {
        self.handle.clone()
    }

    /// Route owners must stop and join before this call, releasing their dispatch handles.
    pub(crate) fn finish(self) -> io::Result<()> {
        let failure = {
            let mut pending = self.pending.0.lock().unwrap();
            while pending.ordinary + pending.control != 0 {
                pending = self.pending.1.wait(pending).unwrap();
            }
            pending.failure.take()
        };
        // Explicit stop frames end workers after all borrowed jobs drain, including when
        // the route owner still holds a dispatch handle.
        for lane in [
            RequestLane::Interactive,
            RequestLane::Background,
            RequestLane::Control,
            RequestLane::Network,
        ] {
            for _ in 0..lane.workers() {
                let _ = self.ready[lane.index()].send(Ready::Stop);
            }
        }
        drop(self.handle);
        for worker in self.workers {
            worker
                .join()
                .map_err(|_| io::Error::other("App Server request worker panicked"))?;
        }
        match failure {
            Some(error) => Err(error),
            None => Ok(()),
        }
    }
}

impl<'env> RequestDispatchHandle<'env> {
    pub(crate) fn budgets(&self) -> InputBudgets {
        self.budgets.clone()
    }

    pub(crate) fn retain_input(
        &self,
        raw: &mut IncomingRequest,
        lane: RequestLane,
    ) -> Result<(), ()> {
        raw.retain(&self.budgets, lane)
    }
    fn reserve(&self, lane: RequestLane) -> Result<u64, ()> {
        let mut pending = self.pending.0.lock().unwrap();
        let (count, capacity) = match lane {
            RequestLane::Control => (pending.control, CONTROL_CAPACITY),
            _ => (pending.ordinary, REQUEST_CAPACITY),
        };
        if count == capacity
            || (lane == RequestLane::Network && pending.network == NETWORK_CAPACITY)
        {
            return Err(());
        }
        let permit = reserve_host_request(&self.budgets, lane)?;
        match lane {
            RequestLane::Control => pending.control += 1,
            _ => pending.ordinary += 1,
        }
        if lane == RequestLane::Network {
            pending.network += 1;
        }
        pending.next_ticket += 1;
        let ticket = pending.next_ticket;
        pending.host_permits.insert(ticket, permit);
        Ok(pending.next_ticket)
    }

    fn schedule(
        &self,
        ticket: u64,
        scheduler: &RequestScheduler,
        connection_id: u64,
        resource: Option<RequestSerializationScope>,
        cancellation: CancellationToken,
        lane: RequestLane,
        job: PendingJob<'env>,
    ) {
        self.pending.0.lock().unwrap().jobs.insert(ticket, job);
        let sender = self.ready[lane.index()].clone();
        let ready = move |permit| {
            let _ = sender.send(Ready::Execute {
                ticket,
                admission: RequestAdmission {
                    permit,
                    ready_at: Instant::now(),
                },
            });
        };
        match resource {
            Some(resource) => {
                scheduler.schedule(connection_id, resource, cancellation, move |permit| {
                    ready(permit.map(Some))
                })
            }
            None => ready(Ok(None)),
        }
    }

    pub(crate) fn dispatch(
        &self,
        server: impl Deref<Target = super::AppServer> + Send + 'env,
        connection: &super::ConnectionState,
        raw: impl Into<IncomingRequest>,
        deliver: impl FnOnce(String) -> io::Result<()> + Send + 'env,
    ) -> io::Result<()> {
        let mut raw = raw.into();
        let prepared = server.prepare_request(connection, &raw);
        let mut prepared = match prepared {
            Ok(prepared) => prepared,
            Err(response) => {
                raw.clear();
                return deliver(response);
            }
        };
        prepared.received_at = raw.received_at;
        prepared.received_time = raw.received_time;
        let lane = RequestLane::for_message(&prepared.request.method, &prepared.request.params);
        let request_id = prepared.request.id.clone();
        let request_number = request_id.as_u64().expect("validated request ID");
        let scheduler = server.request_scheduler.clone();
        let cancellations = server.request_cancellations.clone();
        let connection_id = connection.connection_id;
        let resource = prepared.scope.clone();
        let cancellation = prepared.cancellation.clone();
        let mut connection = connection.clone();
        let retained = self.retain_input(&mut raw, lane);
        raw.clear();
        let bytes = (raw.bytes.take(), raw.host_bytes.take());
        let ticket = match retained.and_then(|()| self.reserve(lane)) {
            Ok(ticket) => ticket,
            Err(()) => {
                cancellations.finish(connection_id, request_number);
                return deliver(super::serialize_response(super::error_response(
                    request_id,
                    -32000,
                    super::AppServerErrorName::ServerOverloaded,
                )));
            }
        };
        let job = if lane == RequestLane::Network && connection.is_initialized() {
            // The accepted job owns completion delivery, including when its dispatcher
            // is dropped before a worker starts it. Idle workers own no input sender.
            let completion_sender = Arc::clone(&self.ready[lane.index()]);
            PendingJob::Network(Box::new(move |admission| {
                let started_at = Instant::now();
                let future = server.prepare_network_request(&mut prepared, &admission);
                NetworkWork {
                    future,
                    completion_sender,
                    complete: Box::new(move |result| {
                        let _bytes = bytes;
                        server.execute_request_with(
                            &mut connection,
                            prepared,
                            admission,
                            started_at,
                            |_, _| result,
                            deliver,
                        )
                    }),
                }
            }))
        } else {
            PendingJob::Blocking(Box::new(move |admission| {
                let _bytes = bytes;
                server.execute_request(&mut connection, prepared, admission, deliver)
            }))
        };
        self.schedule(
            ticket,
            &scheduler,
            connection_id,
            resource,
            cancellation,
            lane,
            job,
        );

        Ok(())
    }
}

struct Completion<'env> {
    pending: Arc<(Mutex<Pending<'env>>, Condvar)>,
    lane: RequestLane,
    ticket: u64,
    active: bool,
}

impl Drop for Completion<'_> {
    fn drop(&mut self) {
        if !self.active {
            return;
        }
        let mut pending = self.pending.0.lock().unwrap();
        match self.lane {
            RequestLane::Control => pending.control -= 1,
            _ => pending.ordinary -= 1,
        }
        if self.lane == RequestLane::Network {
            pending.network -= 1;
        }
        pending.host_permits.remove(&self.ticket);
        self.pending.1.notify_all();
    }
}

#[cfg(test)]
#[path = "request_dispatch_tests.rs"]
pub(crate) mod tests;

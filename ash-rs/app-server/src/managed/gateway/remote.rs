use super::Catalogs;
use super::PendingRemoteRequests;
use super::RemotePending;
use super::RemoteSessionIndex;
use super::fail_remote_requests;
use super::read_remote_messages;
use super::remote_key;
use super::tag_host_request;
use crate::server::message_queue::InputBudgets;
use crate::server::message_queue::MessageBytes;
use crate::server::message_queue::OutboundSender;
use crate::server::request_dispatch::IncomingRequest;
use crate::server::request_dispatch::RequestLane;
use ash_app_server_protocol::protocol::initialize::InitializeResult;
use ash_app_server_protocol::protocol::initialize::ensure_protocol_compatible;
use ash_app_server_protocol::rpc::JsonRpcRequest;
use ash_app_server_protocol::rpc::JsonRpcResponse;
use ash_app_server_transport::DEFAULT_MAX_MESSAGE_BYTES;
use ash_app_server_transport::JsonlReader;
use ash_app_server_transport::JsonlWriter;
use ash_remote::RemoteProfile;
use ash_remote::remote_app_server_command;
use serde_json::Value;
use std::collections::VecDeque;
use std::ffi::OsString;
use std::io;
use std::io::BufReader;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

const REQUEST_CAPACITY: usize = 64;
const CONTROL_CAPACITY: usize = 16;
const HOST_REPLY_CAPACITY: usize = 16;
const CLOSE_POLL_INTERVAL: Duration = Duration::from_millis(25);

#[derive(Clone, Copy)]
enum MessageKind {
    Ordinary,
    Control,
    HostReply,
}

impl MessageKind {
    fn index(self) -> usize {
        match self {
            Self::HostReply => 0,
            Self::Control => 1,
            Self::Ordinary => 2,
        }
    }

    fn capacity(self) -> usize {
        match self {
            Self::Ordinary => REQUEST_CAPACITY,
            Self::Control => CONTROL_CAPACITY,
            Self::HostReply => HOST_REPLY_CAPACITY,
        }
    }
}

struct RemoteMessage {
    raw: String,
    _bytes: MessageBytes,
}

#[derive(Default)]
struct MailboxState {
    closed: bool,
    messages: [VecDeque<RemoteMessage>; 3],
}

#[derive(Default)]
struct RemoteMailbox {
    state: Mutex<MailboxState>,
    changed: Condvar,
}

impl RemoteMailbox {
    fn send(&self, kind: MessageKind, message: RemoteMessage) -> io::Result<()> {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return Err(io::Error::from(io::ErrorKind::BrokenPipe));
        }
        let queue = &mut state.messages[kind.index()];
        if queue.len() == kind.capacity() {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "SSH message capacity exhausted",
            ));
        }
        queue.push_back(message);
        self.changed.notify_one();
        Ok(())
    }

    fn recv(&self) -> io::Result<Option<RemoteMessage>> {
        let mut state = self.state.lock().unwrap();
        if !state.closed && state.messages.iter().all(VecDeque::is_empty) {
            state = self
                .changed
                .wait_timeout(state, CLOSE_POLL_INTERVAL)
                .unwrap()
                .0;
        }
        if state.closed {
            return Err(io::Error::from(io::ErrorKind::BrokenPipe));
        }
        // Replies release remote handlers; controls stop work. Ordinary backlog cannot delay
        // either class once the current pipe write finishes. FIFO holds within each class.
        Ok(state.messages.iter_mut().find_map(VecDeque::pop_front))
    }

    fn close(&self) {
        let discarded = {
            let mut state = self.state.lock().unwrap();
            state.closed = true;
            std::mem::take(&mut state.messages)
        };
        drop(discarded);
        self.changed.notify_all();
    }
}

/// Process launch settings are selected by the managed host, independently of persisted targets.
#[derive(Clone)]
pub(in crate::managed) struct RemoteLaunch {
    pub(in crate::managed) executable: OsString,
    pub(in crate::managed) initialize_timeout: Duration,
}

impl RemoteLaunch {
    pub(in crate::managed) fn from_environment() -> Self {
        Self {
            executable: std::env::var_os("ASH_SSH_PATH").unwrap_or_else(|| "ssh".into()),
            initialize_timeout: Duration::from_secs(10),
        }
    }
}

#[derive(Default)]
struct RemoteProcess {
    closed: AtomicBool,
    child: Mutex<Option<Child>>,
}

impl RemoteProcess {
    fn install(&self, mut child: Child) -> io::Result<()> {
        let mut owned = self.child.lock().unwrap();
        // Closing may win while process creation is in progress. Registration and close share
        // this lock so no newly created child can escape its renderer's lifetime.
        if self.closed.load(Ordering::Acquire) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(io::Error::from(io::ErrorKind::ConnectionAborted));
        }
        *owned = Some(child);
        Ok(())
    }

    fn close(&self) {
        self.closed.store(true, Ordering::Release);
        if let Some(child) = self.child.lock().unwrap().as_mut() {
            let _ = child.kill();
        }
    }

    fn reap(&self) {
        self.close();
        let child = self.child.lock().unwrap().take();
        if let Some(mut child) = child {
            let _ = child.wait();
        }
    }
}

/// Owns one remote route's bounded admission and child lifetime; pipe IO never runs on the reader.
pub(super) struct RemoteTarget {
    pub(super) route_id: usize,
    input: Arc<RemoteMailbox>,
    budgets: InputBudgets,
    process: Arc<RemoteProcess>,
    alive: Arc<AtomicBool>,
    pending: RemotePending,
}

impl RemoteTarget {
    pub(super) fn start<'scope, 'env: 'scope>(
        scope: &'scope thread::Scope<'scope, 'env>,
        profile: RemoteProfile,
        initialize: IncomingRequest,
        route_id: usize,
        launch: RemoteLaunch,
        budgets: InputBudgets,
        outbound: OutboundSender,
        sessions: RemoteSessionIndex,
        catalogs: Catalogs,
        pending: RemotePending,
        requirements: &'static [ash_app_server_protocol::protocol::initialize::CapabilityRequirement],
    ) -> Self {
        let input = Arc::new(RemoteMailbox::default());
        let incoming = Arc::clone(&input);
        let process = Arc::new(RemoteProcess::default());
        let alive = Arc::new(AtomicBool::new(true));
        let worker_process = Arc::clone(&process);
        let worker_alive = Arc::clone(&alive);
        pending
            .lock()
            .unwrap()
            .insert(route_id, PendingRemoteRequests::default());
        let target_pending = Arc::clone(&pending);
        scope.spawn(move || {
            let result = run(
                profile,
                initialize,
                route_id,
                launch,
                &incoming,
                &worker_process,
                Arc::clone(&worker_alive),
                &outbound,
                sessions,
                Arc::clone(&catalogs),
                Arc::clone(&pending),
                requirements,
            );
            worker_process.reap();
            incoming.close();
            if let Err(error) = result {
                fail_remote_requests(route_id, &error, &pending, &catalogs, &outbound);
            }
            worker_alive.store(false, Ordering::Release);
            pending.lock().unwrap().remove(&route_id);
        });
        Self {
            route_id,
            input,
            budgets,
            process,
            alive,
            pending: target_pending,
        }
    }

    pub(super) fn send(&self, request: Value) -> io::Result<()> {
        let lane = request
            .get("method")
            .and_then(Value::as_str)
            .map(|method| RequestLane::for_message(method, &request["params"]));
        let kind = match lane {
            None => MessageKind::HostReply,
            Some(RequestLane::Control) => MessageKind::Control,
            _ => MessageKind::Ordinary,
        };
        // Register accepted request IDs under the same lock that seals the route on EOF.
        // A remote can reply or exit immediately; neither may race ahead of admission.
        let mut pending = self.pending.lock().unwrap();
        let route = pending
            .get_mut(&self.route_id)
            .filter(|route| !route.closed)
            .ok_or_else(|| io::Error::from(io::ErrorKind::BrokenPipe))?;
        let id = request
            .get("method")
            .and_then(|_| request.get("id"))
            .filter(|id| id.is_u64())
            .cloned();
        let count = route
            .ids
            .iter()
            .filter(|(_, pending_lane)| {
                (*pending_lane == RequestLane::Control) == (lane == Some(RequestLane::Control))
            })
            .count();
        if id.is_some() && count == kind.capacity() {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "SSH pending request capacity exhausted",
            ));
        }
        let raw = request.to_string();
        let budget = match kind {
            MessageKind::Ordinary => &self.budgets.ordinary,
            MessageKind::Control => &self.budgets.control,
            MessageKind::HostReply => &self.budgets.host_replies,
        };
        let bytes = budget.try_reserve(raw.len()).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::WouldBlock,
                "SSH message byte capacity exhausted",
            )
        })?;
        self.input
            .send(kind, RemoteMessage { raw, _bytes: bytes })?;
        if let Some(id) = id {
            route
                .ids
                .push((id, lane.expect("client request has a method")));
        }
        Ok(())
    }

    pub(super) fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub(super) fn close(&self) {
        self.input.close();
        self.process.close();
    }

    pub(super) fn fail(&self, error: &io::Error, catalogs: &Catalogs, outbound: &OutboundSender) {
        self.close();
        fail_remote_requests(self.route_id, error, &self.pending, catalogs, outbound);
    }
}

impl Drop for RemoteTarget {
    fn drop(&mut self) {
        self.close();
    }
}

#[cfg(test)]
#[path = "remote_tests.rs"]
mod tests;

fn run(
    profile: RemoteProfile,
    initialize: IncomingRequest,
    route_id: usize,
    launch: RemoteLaunch,
    incoming: &RemoteMailbox,
    process: &RemoteProcess,
    alive: Arc<AtomicBool>,
    outbound: &OutboundSender,
    sessions: RemoteSessionIndex,
    catalogs: Catalogs,
    pending: RemotePending,
    requirements: &[ash_app_server_protocol::protocol::initialize::CapabilityRequirement],
) -> io::Result<()> {
    let mut child = Command::new(launch.executable)
        .args([
            "-T",
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=10",
            profile.target().host().as_str(),
        ])
        .arg(remote_app_server_command(&profile))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()?;
    let stdin = child.stdin.take().expect("SSH stdin was piped");
    let stdout = child.stdout.take().expect("SSH stdout was piped");
    process.install(child)?;
    thread::scope(|scope| {
        let (initialized, handshake) = mpsc::channel();
        let reader_output = outbound.clone();
        let reader_pending = Arc::clone(&pending);
        let mut writer = JsonlWriter::new(stdin, DEFAULT_MAX_MESSAGE_BYTES);
        let reader = scope.spawn(move || {
            let mut reader = JsonlReader::new(BufReader::new(stdout), DEFAULT_MAX_MESSAGE_BYTES);
            let result = (|| {
                writer.write_message(&initialize)?;
                read_initialize(
                    &mut reader,
                    &initialize,
                    route_id,
                    &reader_output,
                    requirements,
                )?;
                Ok::<_, io::Error>(writer)
            })();
            let succeeded = result.is_ok();
            if initialized.send(result).is_err() || !succeeded {
                return;
            }
            read_remote_messages(
                reader,
                remote_key(&profile),
                route_id,
                alive,
                reader_output,
                sessions,
                catalogs,
                reader_pending,
            );
        });
        let result = (|| {
            let mut writer = handshake.recv_timeout(launch.initialize_timeout).map_err(
                |error| match error {
                    mpsc::RecvTimeoutError::Timeout => {
                        io::Error::new(io::ErrorKind::TimedOut, "SSH initialize deadline elapsed")
                    }
                    mpsc::RecvTimeoutError::Disconnected => {
                        io::Error::from(io::ErrorKind::UnexpectedEof)
                    }
                },
            )??;
            loop {
                if process.closed.load(Ordering::Acquire) {
                    return Err(io::Error::from(io::ErrorKind::ConnectionAborted));
                }
                match incoming.recv()? {
                    Some(request) => {
                        if let Err(error) = writer.write_message(&request.raw) {
                            return Err(error);
                        }
                    }
                    None => {
                        if reader.is_finished() {
                            return Err(io::Error::from(io::ErrorKind::BrokenPipe));
                        }
                    }
                }
            }
        })();
        // Killing closes both pipes, waking initialization and blocked writes before joining.
        process.close();
        reader
            .join()
            .map_err(|_| io::Error::other("SSH reader panicked"))?;
        result
    })
}

fn read_initialize(
    reader: &mut JsonlReader<impl std::io::BufRead>,
    initialize: &str,
    route_id: usize,
    outbound: &OutboundSender,
    requirements: &[ash_app_server_protocol::protocol::initialize::CapabilityRequirement],
) -> io::Result<()> {
    let initialize: JsonRpcRequest<Value> = serde_json::from_str(initialize)
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    while let Some(raw) = reader.read_message()? {
        let message: Value = serde_json::from_str(&raw)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        if message.get("method").is_some() {
            outbound
                .send(tag_host_request(raw, route_id).into())
                .map_err(|_| io::Error::from(io::ErrorKind::BrokenPipe))?;
            continue;
        }
        let response: JsonRpcResponse<InitializeResult, Value> = serde_json::from_value(message)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
        let response = match response {
            JsonRpcResponse::Success(response) => response,
            JsonRpcResponse::Failure(response) => {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    response.error.to_string(),
                ));
            }
        };
        if response.id != initialize.id {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "SSH initialize response ID mismatch",
            ));
        }
        return ensure_protocol_compatible(&response.result, requirements)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error));
    }
    Err(io::Error::new(
        io::ErrorKind::UnexpectedEof,
        "SSH App Server closed during initialize",
    ))
}

use super::Catalogs;
use super::OutgoingMessage;
use super::PendingRemoteRequests;
use super::RemotePending;
use super::RemoteSessionIndex;
use super::fail_remote_requests;
use super::read_remote_messages;
use super::remote_key;
use super::tag_host_request;
use ash_app_server_protocol::protocol::initialize::InitializeResult;
use ash_app_server_protocol::protocol::initialize::REQUIRED_SESSION_CAPABILITIES;
use ash_app_server_protocol::protocol::initialize::ensure_protocol_compatible;
use ash_app_server_protocol::rpc::JsonRpcRequest;
use ash_app_server_protocol::rpc::JsonRpcResponse;
use ash_app_server_transport::DEFAULT_MAX_MESSAGE_BYTES;
use ash_app_server_transport::JsonlReader;
use ash_app_server_transport::JsonlWriter;
use ash_remote::RemoteProfile;
use ash_remote::remote_app_server_command;
use serde_json::Value;
use std::ffi::OsString;
use std::io;
use std::io::BufReader;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

const REQUEST_CAPACITY: usize = 64;
const CLOSE_POLL_INTERVAL: Duration = Duration::from_millis(25);

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
    input: mpsc::SyncSender<Value>,
    process: Arc<RemoteProcess>,
    alive: Arc<AtomicBool>,
    pending: RemotePending,
}

impl RemoteTarget {
    pub(super) fn start<'scope, 'env: 'scope>(
        scope: &'scope thread::Scope<'scope, 'env>,
        profile: RemoteProfile,
        initialize: String,
        route_id: usize,
        launch: RemoteLaunch,
        outbound: mpsc::SyncSender<OutgoingMessage>,
        sessions: RemoteSessionIndex,
        catalogs: Catalogs,
        pending: RemotePending,
    ) -> Self {
        let (input, incoming) = mpsc::sync_channel(REQUEST_CAPACITY);
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
            );
            worker_process.reap();
            if let Err(error) = result {
                fail_remote_requests(route_id, &error, &pending, &catalogs, &outbound);
            }
            worker_alive.store(false, Ordering::Release);
            pending.lock().unwrap().remove(&route_id);
        });
        Self {
            route_id,
            input,
            process,
            alive,
            pending: target_pending,
        }
    }

    pub(super) fn send(&self, request: Value) -> io::Result<()> {
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
        if id.is_some() && route.ids.len() == REQUEST_CAPACITY {
            return Err(io::Error::new(
                io::ErrorKind::WouldBlock,
                "SSH pending request capacity exhausted",
            ));
        }
        self.input.try_send(request).map_err(|error| match error {
            mpsc::TrySendError::Full(_) => {
                io::Error::new(io::ErrorKind::WouldBlock, "SSH request capacity exhausted")
            }
            mpsc::TrySendError::Disconnected(_) => {
                io::Error::new(io::ErrorKind::BrokenPipe, "SSH App Server disconnected")
            }
        })?;
        if let Some(id) = id {
            route.ids.push(id);
        }
        Ok(())
    }

    pub(super) fn is_alive(&self) -> bool {
        self.alive.load(Ordering::Acquire)
    }

    pub(super) fn close(&self) {
        self.process.close();
    }
}

impl Drop for RemoteTarget {
    fn drop(&mut self) {
        self.close();
    }
}

fn run(
    profile: RemoteProfile,
    initialize: String,
    route_id: usize,
    launch: RemoteLaunch,
    incoming: &mpsc::Receiver<Value>,
    process: &RemoteProcess,
    alive: Arc<AtomicBool>,
    outbound: &mpsc::SyncSender<OutgoingMessage>,
    sessions: RemoteSessionIndex,
    catalogs: Catalogs,
    pending: RemotePending,
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
                read_initialize(&mut reader, &initialize, route_id, &reader_output)?;
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
                match incoming.recv_timeout(CLOSE_POLL_INTERVAL) {
                    Ok(request) => {
                        if let Err(error) = writer.write_message(&request.to_string()) {
                            return Err(error);
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        if reader.is_finished() {
                            return Err(io::Error::from(io::ErrorKind::BrokenPipe));
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(()),
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
    outbound: &mpsc::SyncSender<OutgoingMessage>,
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
        let response: JsonRpcResponse<InitializeResult, Value> =
            serde_json::from_value(message)
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
        return ensure_protocol_compatible(&response.result, REQUIRED_SESSION_CAPABILITIES)
            .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error));
    }
    Err(io::Error::new(
        io::ErrorKind::UnexpectedEof,
        "SSH App Server closed during initialize",
    ))
}

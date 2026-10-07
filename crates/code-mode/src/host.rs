use crate::RuntimeError;
use crate::ToolInvoker;
use crate::session::Snapshot;
use ash_code_mode_protocol::CODE_MODE_PROTOCOL_VERSION;
use ash_code_mode_protocol::CellId;
use ash_code_mode_protocol::ClientToHost;
use ash_code_mode_protocol::CodeModeSessionId;
use ash_code_mode_protocol::HostFrame;
use ash_code_mode_protocol::HostToClient;
use ash_code_mode_protocol::read_frame;
use ash_code_mode_protocol::validate_values;
use ash_code_mode_protocol::write_frame;
use std::collections::BTreeMap;
use std::io::BufReader;
use std::io::BufWriter;
use std::path::PathBuf;
use std::process::Child;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

const MAX_REQUESTS: usize = 128;
const MAX_QUEUED_BYTES: usize = 64 * 1024 * 1024;
type Reply = Result<HostToClient, RuntimeError>;

pub(super) struct Connection {
    shared: Arc<Shared>,
}

struct Shared {
    state: Mutex<State>,
    writer: mpsc::SyncSender<Vec<u8>>,
    queued_bytes: AtomicUsize,
    workers: AtomicUsize,
    child: Mutex<Option<Child>>,
}

#[derive(Default)]
struct State {
    failure: Option<String>,
    next_request: u64,
    pending: BTreeMap<u64, mpsc::Sender<Reply>>,
    cells: BTreeMap<CellId, Arc<dyn ToolInvoker>>,
    snapshots: BTreeMap<CodeModeSessionId, Snapshot>,
}

impl Connection {
    pub(super) fn spawn(program: PathBuf) -> Result<Self, RuntimeError> {
        let mut command = Command::new(&program);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = command.spawn().map_err(|error| {
            RuntimeError::Initialization(format!(
                "failed to start Code Mode Host {}: {error}",
                program.display()
            ))
        })?;
        let mut writer = BufWriter::new(child.stdin.take().unwrap());
        let mut reader = BufReader::new(child.stdout.take().unwrap());
        let (sender, receiver) = mpsc::sync_channel::<Vec<u8>>(MAX_REQUESTS);
        let shared = Arc::new(Shared {
            state: Mutex::new(State::default()),
            writer: sender,
            queued_bytes: AtomicUsize::new(0),
            workers: AtomicUsize::new(0),
            child: Mutex::new(Some(child)),
        });
        let output = Arc::clone(&shared);
        thread::spawn(move || {
            use std::io::Write;
            while output.failure().is_none() {
                match receiver.recv_timeout(Duration::from_millis(100)) {
                    Ok(bytes) => {
                        let result = writer.write_all(&bytes).and_then(|()| writer.flush());
                        output.queued_bytes.fetch_sub(bytes.len(), Ordering::AcqRel);
                        if let Err(error) = result {
                            output.fail(error.to_string());
                            break;
                        }
                    }
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });
        let input = Arc::clone(&shared);
        thread::spawn(move || {
            loop {
                match read_frame::<_, HostFrame<HostToClient>>(&mut reader) {
                    Ok(frame) => input.receive(frame),
                    Err(error) => {
                        input.fail(format!("Code Mode Host exited or closed its output ({error}); active outcomes are unknown"));
                        break;
                    }
                }
            }
        });
        let connection = Self { shared };
        match connection.request(
            ClientToHost::Hello {
                protocol_version: CODE_MODE_PROTOCOL_VERSION,
            },
            Duration::from_secs(5),
        )? {
            HostToClient::Hello {
                protocol_version, ..
            } if protocol_version == CODE_MODE_PROTOCOL_VERSION => Ok(connection),
            reply => Err(RuntimeError::Initialization(format!(
                "unexpected Code Mode Host handshake: {reply:?}"
            ))),
        }
    }

    pub(super) fn request(&self, message: ClientToHost, timeout: Duration) -> Reply {
        let (sender, receiver) = mpsc::channel();
        let id = {
            let mut state = self.shared.state.lock().unwrap();
            if let Some(error) = &state.failure {
                return Err(RuntimeError::Runtime(error.clone()));
            }
            if state.pending.len() >= MAX_REQUESTS {
                return Err(RuntimeError::InvalidRequest(
                    "Code Mode Host has too many pending requests".into(),
                ));
            }
            state.next_request += 1;
            let id = state.next_request;
            state.pending.insert(id, sender);
            id
        };
        if let Err(error) = self.shared.send(HostFrame {
            request_id: Some(id),
            message,
        }) {
            self.shared.state.lock().unwrap().pending.remove(&id);
            return Err(error);
        }
        match receiver.recv_timeout(timeout) {
            Ok(reply) => reply,
            Err(_) => {
                self.shared.fail(
                    "Code Mode Host request timed out; execution will not be replayed".into(),
                );
                Err(RuntimeError::Runtime(self.failure().unwrap()))
            }
        }
    }

    pub(super) fn failure(&self) -> Option<String> {
        self.shared.failure()
    }
    pub(super) fn register_snapshot(&self, id: CodeModeSessionId, snapshot: Snapshot) {
        self.shared
            .state
            .lock()
            .unwrap()
            .snapshots
            .insert(id, snapshot);
    }
    pub(super) fn remove_snapshot(&self, id: &CodeModeSessionId) {
        self.shared.state.lock().unwrap().snapshots.remove(id);
    }
    pub(super) fn register_cell(&self, id: CellId, invoker: Arc<dyn ToolInvoker>) {
        let mut state = self.shared.state.lock().unwrap();
        if state.failure.is_some() {
            drop(state);
            invoker.cancel_cell(&id);
        } else {
            state.cells.insert(id, invoker);
        }
    }
    pub(super) fn remove_cell(&self, id: &CellId) {
        let invoker = self.shared.state.lock().unwrap().cells.remove(id);
        if let Some(invoker) = invoker {
            invoker.cancel_cell(id);
        }
    }
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.shared.fail("Code Mode Host owner closed".into());
    }
}

impl Shared {
    fn failure(&self) -> Option<String> {
        self.state.lock().unwrap().failure.clone()
    }

    fn fail(&self, reason: String) {
        let (pending, cells) = {
            let mut state = self.state.lock().unwrap();
            if state.failure.is_some() {
                return;
            }
            state.failure = Some(reason.clone());
            (
                std::mem::take(&mut state.pending),
                std::mem::take(&mut state.cells),
            )
        };
        // Killing the child unblocks a partial stdout frame or a blocked stdin write.
        if let Some(mut child) = self.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
        for sender in pending.into_values() {
            let _ = sender.send(Err(RuntimeError::Runtime(reason.clone())));
        }
        for (id, invoker) in cells {
            invoker.cancel_cell(&id);
        }
    }

    fn send(&self, frame: HostFrame<ClientToHost>) -> Result<(), RuntimeError> {
        if let Some(error) = self.failure() {
            return Err(RuntimeError::Runtime(error));
        }
        let mut bytes = Vec::new();
        write_frame(&mut bytes, &frame)
            .map_err(|error| RuntimeError::InvalidRequest(error.to_string()))?;
        let size = bytes.len();
        if self
            .queued_bytes
            .fetch_add(size, Ordering::AcqRel)
            .saturating_add(size)
            > MAX_QUEUED_BYTES
        {
            self.queued_bytes.fetch_sub(size, Ordering::AcqRel);
            return Err(RuntimeError::InvalidRequest(
                "Code Mode Host output queue is full".into(),
            ));
        }
        if self.writer.try_send(bytes).is_err() {
            self.queued_bytes.fetch_sub(size, Ordering::AcqRel);
            return Err(RuntimeError::InvalidRequest(
                "Code Mode Host output queue is full".into(),
            ));
        }
        Ok(())
    }

    fn receive(self: &Arc<Self>, frame: HostFrame<HostToClient>) {
        if self.failure().is_some() {
            return;
        }
        if let Some(id) = frame.request_id {
            let sender = self.state.lock().unwrap().pending.remove(&id);
            if let Some(sender) = sender {
                let reply = match frame.message {
                    HostToClient::Error { message } => Err(RuntimeError::Runtime(message)),
                    message => Ok(message),
                };
                let _ = sender.send(reply);
            } else {
                self.fail("Code Mode Host returned an unknown request ID".into());
            }
            return;
        }
        match frame.message {
            HostToClient::StoreSnapshot { session_id, values } => {
                let result = {
                    let state = self.state.lock().unwrap();
                    if state.failure.is_some() {
                        return;
                    }
                    state.snapshots.get(&session_id).map(|snapshot| {
                        validate_values(&values)?;
                        *snapshot.lock().map_err(|_| {
                            "Code Mode recovery snapshot was poisoned".to_string()
                        })? = values;
                        Ok::<(), String>(())
                    })
                };
                if let Some(Err(error)) = result {
                    self.fail(error.to_string());
                }
            }
            HostToClient::ToolCall(call) => {
                let invoker = self.state.lock().unwrap().cells.get(&call.cell_id).cloned();
                let shared = Arc::clone(self);
                if self.workers.fetch_add(1, Ordering::AcqRel) >= MAX_REQUESTS {
                    self.workers.fetch_sub(1, Ordering::AcqRel);
                    self.complete(
                        call.cell_id,
                        call.runtime_tool_call_id,
                        Err("Code Mode Host callback limit reached".into()),
                    );
                    return;
                }
                thread::spawn(move || {
                    let id = call.cell_id.clone();
                    let call_id = call.runtime_tool_call_id.clone();
                    let result =
                        std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| match invoker {
                            Some(invoker) => invoker.invoke(call),
                            None => Err("Code Mode cell is closed".into()),
                        }))
                        .unwrap_or_else(|_| Err("Code Mode tool callback panicked".into()));
                    shared.complete(id, call_id, result);
                    shared.workers.fetch_sub(1, Ordering::AcqRel);
                });
            }
            HostToClient::Notification(notification) => {
                let invoker = self
                    .state
                    .lock()
                    .unwrap()
                    .cells
                    .get(&notification.cell_id)
                    .cloned();
                if let Some(invoker) = invoker {
                    let _ = invoker.notify(notification);
                }
            }
            HostToClient::CancelCellTools { cell_id }
            | HostToClient::CellClosed { cell_id, .. } => {
                let invoker = self.state.lock().unwrap().cells.get(&cell_id).cloned();
                if let Some(invoker) = invoker {
                    invoker.cancel_cell(&cell_id);
                }
            }
            other => self.fail(format!("unexpected Code Mode Host event: {other:?}")),
        }
    }

    fn complete(
        &self,
        cell_id: CellId,
        runtime_tool_call_id: String,
        result: Result<serde_json::Value, String>,
    ) {
        let (result, error_text) = match result {
            Ok(value) => (value, None),
            Err(error) => (serde_json::Value::Null, Some(error)),
        };
        if let Err(error) = self.send(HostFrame {
            request_id: None,
            message: ClientToHost::CompleteToolCall {
                cell_id,
                runtime_tool_call_id,
                result,
                error_text,
            },
        }) {
            self.fail(error.to_string());
        }
    }
}

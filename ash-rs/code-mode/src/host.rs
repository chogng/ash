use ash_code_mode_protocol::{
    CODE_MODE_PROTOCOL_VERSION, CellId, ClientToHost, CodeModeLimits, CodeModeSessionId,
    HostToClient, RuntimeResponse, StartedCell, WaitOutcome, WaitRequest, read_frame, write_frame,
};
use ash_code_mode_runtime::{CodeModeStore, RuntimeError, ToolInvoker};
use serde_json::Value;
use std::collections::BTreeMap;
use std::io::{BufReader, BufWriter};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

type HostResult<T> = Result<T, String>;

#[derive(Clone)]
pub(super) struct HostRuntime {
    inner: Arc<HostRuntimeInner>,
}

struct HostRuntimeInner {
    session_id: CodeModeSessionId,
    shared: Arc<HostShared>,
    child: Mutex<Option<Child>>,
    execute_guard: Mutex<()>,
    closed: AtomicBool,
}

struct HostShared {
    writer: Mutex<Option<BufWriter<ChildStdin>>>,
    invoker: Arc<dyn ToolInvoker>,
    stored_values: CodeModeStore,
    session_opened: Mutex<Option<Sender<HostResult<()>>>>,
    started_cells: Sender<HostResult<StartedCell>>,
    started_receiver: Mutex<Receiver<HostResult<StartedCell>>>,
    cells: Mutex<BTreeMap<CellId, Arc<HostCell>>>,
    fatal_error: Mutex<Option<String>>,
}

struct HostCell {
    receiver: Mutex<Receiver<RuntimeResponse>>,
    sender: Sender<RuntimeResponse>,
    last_response: Mutex<Option<RuntimeResponse>>,
}

impl HostRuntime {
    pub(super) fn spawn(
        program: PathBuf,
        session_id: CodeModeSessionId,
        limits: CodeModeLimits,
        invoker: Arc<dyn ToolInvoker>,
        stored_values: CodeModeStore,
    ) -> Result<Self, RuntimeError> {
        let mut child = Command::new(&program)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .map_err(|error| {
                RuntimeError::Initialization(format!(
                    "failed to start Code Mode Host {}: {error}",
                    program.display()
                ))
            })?;
        let handshake = (|| {
            let stdin = child.stdin.take().ok_or_else(|| {
                RuntimeError::Initialization("Code Mode Host stdin is unavailable".into())
            })?;
            let stdout = child.stdout.take().ok_or_else(|| {
                RuntimeError::Initialization("Code Mode Host stdout is unavailable".into())
            })?;
            let mut writer = BufWriter::new(stdin);
            let mut reader = BufReader::new(stdout);
            write_frame(
                &mut writer,
                &ClientToHost::Hello {
                    protocol_version: CODE_MODE_PROTOCOL_VERSION,
                },
            )
            .map_err(|error| RuntimeError::Initialization(error.to_string()))?;
            match read_frame::<_, HostToClient>(&mut reader)
                .map_err(|error| RuntimeError::Initialization(error.to_string()))?
            {
                HostToClient::Hello {
                    protocol_version, ..
                } if protocol_version == CODE_MODE_PROTOCOL_VERSION => Ok((writer, reader)),
                HostToClient::Error { message } => Err(RuntimeError::Initialization(message)),
                message => Err(RuntimeError::Initialization(format!(
                    "unexpected Code Mode Host handshake response: {message:?}"
                ))),
            }
        })();
        let (writer, reader) = match handshake {
            Ok(transport) => transport,
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(error);
            }
        };

        let (session_opened_tx, session_opened_rx) = mpsc::channel();
        let (started_cells_tx, started_cells_rx) = mpsc::channel();
        let shared = Arc::new(HostShared {
            writer: Mutex::new(Some(writer)),
            invoker,
            stored_values: stored_values.clone(),
            session_opened: Mutex::new(Some(session_opened_tx)),
            started_cells: started_cells_tx,
            started_receiver: Mutex::new(started_cells_rx),
            cells: Mutex::new(BTreeMap::new()),
            fatal_error: Mutex::new(None),
        });
        let reader_shared = Arc::clone(&shared);
        let reader_session_id = session_id.clone();
        thread::spawn(move || read_host(reader, reader_session_id, reader_shared));

        let runtime = Self {
            inner: Arc::new(HostRuntimeInner {
                session_id: session_id.clone(),
                shared,
                child: Mutex::new(Some(child)),
                execute_guard: Mutex::new(()),
                closed: AtomicBool::new(false),
            }),
        };
        runtime.inner.shared.send(ClientToHost::OpenSession {
            session_id,
            limits,
            stored_values: stored_values.snapshot()?,
        })?;
        match session_opened_rx.recv_timeout(Duration::from_secs(5)) {
            Ok(Ok(())) => Ok(runtime),
            Ok(Err(error)) => Err(RuntimeError::Initialization(error)),
            Err(_) => Err(RuntimeError::Initialization(
                "Code Mode Host did not open the session".into(),
            )),
        }
    }

    pub(super) fn execute(
        &self,
        request: ash_code_mode_protocol::ExecuteRequest,
    ) -> Result<StartedCell, RuntimeError> {
        if request.session_id != self.inner.session_id {
            return Err(RuntimeError::InvalidRequest(
                "Execute request belongs to another Code Mode Host session".into(),
            ));
        }
        let _guard = self.inner.execute_guard.lock().map_err(|_| {
            RuntimeError::Runtime("Code Mode Host execute lock was poisoned".into())
        })?;
        self.inner.shared.ensure_live()?;
        self.inner.shared.send(ClientToHost::Execute(request))?;
        let started = self
            .inner
            .shared
            .receive_started(Duration::from_secs(5))?
            .map_err(RuntimeError::Runtime)?;
        let (sender, receiver) = mpsc::channel();
        self.inner
            .shared
            .cells
            .lock()
            .map_err(|_| RuntimeError::Runtime("Code Mode Host cell map was poisoned".into()))?
            .insert(
                started.cell_id.clone(),
                Arc::new(HostCell {
                    receiver: Mutex::new(receiver),
                    sender,
                    last_response: Mutex::new(None),
                }),
            );
        if self.inner.shared.fatal_message().is_some() {
            self.inner.shared.mark_unknown_cells();
        }
        Ok(started)
    }

    pub(super) fn wait(&self, request: WaitRequest) -> Result<WaitOutcome, RuntimeError> {
        if !self.has_cell(&request.cell_id) {
            return Ok(WaitOutcome::MissingCell {
                cell_id: request.cell_id,
            });
        }
        let cell = self.cell(&request.cell_id)?;
        if let Some(response) = terminal_response(&cell)? {
            self.inner
                .shared
                .cells
                .lock()
                .map_err(|_| RuntimeError::Runtime("Code Mode Host cell map was poisoned".into()))?
                .remove(&request.cell_id);
            return Ok(WaitOutcome::LiveCell { response });
        }
        if self.inner.shared.fatal_message().is_some() {
            self.inner.shared.mark_unknown_cells();
        } else {
            if let Err(error) = self.inner.shared.send(ClientToHost::Wait(request.clone())) {
                self.inner.shared.fail(format!(
                    "Code Mode Host request failed after the cell started ({error}); active nested tool outcomes are unknown"
                ));
            }
        }
        let timeout =
            Duration::from_millis(request.yield_time_ms).saturating_add(Duration::from_secs(1));
        let response = match cell
            .receiver
            .lock()
            .map_err(|_| RuntimeError::Runtime("Code Mode Host cell receiver was poisoned".into()))?
            .recv_timeout(timeout)
        {
            Ok(response) => response,
            Err(RecvTimeoutError::Timeout) => RuntimeResponse::Running {
                cell_id: request.cell_id,
                content_items: Vec::new(),
            },
            Err(RecvTimeoutError::Disconnected) => unknown_response(
                request.cell_id,
                self.inner.shared.fatal_message().unwrap_or_else(|| {
                    "Code Mode Host response channel closed; nested tool outcome is unknown".into()
                }),
            ),
        };
        *cell.last_response.lock().map_err(|_| {
            RuntimeError::Runtime("Code Mode Host cell response was poisoned".into())
        })? = Some(response.clone());
        if is_terminal(&response) {
            self.inner
                .shared
                .cells
                .lock()
                .map_err(|_| RuntimeError::Runtime("Code Mode Host cell map was poisoned".into()))?
                .remove(&response_cell_id(&response));
        }
        Ok(WaitOutcome::LiveCell { response })
    }

    pub(super) fn terminate(&self, cell_id: &CellId) -> Result<WaitOutcome, RuntimeError> {
        self.wait(WaitRequest {
            cell_id: cell_id.clone(),
            yield_time_ms: 0,
            max_output_tokens: None,
            terminate: true,
        })
    }

    pub(super) fn has_cell(&self, cell_id: &CellId) -> bool {
        self.inner
            .shared
            .cells
            .lock()
            .map(|cells| cells.contains_key(cell_id))
            .unwrap_or(false)
    }

    pub(super) fn close(&self) {
        self.inner.close();
    }

    fn cell(&self, cell_id: &CellId) -> Result<Arc<HostCell>, RuntimeError> {
        self.inner
            .shared
            .cells
            .lock()
            .map_err(|_| RuntimeError::Runtime("Code Mode Host cell map was poisoned".into()))?
            .get(cell_id)
            .cloned()
            .ok_or_else(|| RuntimeError::CellNotFound(cell_id.clone()))
    }
}

impl HostRuntimeInner {
    fn close(&self) {
        if self.closed.swap(true, Ordering::AcqRel) {
            return;
        }
        self.shared.invoker.cancel();
        let _ = self.shared.send(ClientToHost::CloseSession {
            session_id: self.session_id.clone(),
        });
        if let Ok(mut writer) = self.shared.writer.lock() {
            writer.take();
        }
        if let Ok(mut child) = self.child.lock()
            && let Some(mut child) = child.take()
        {
            for _ in 0..10 {
                if child.try_wait().ok().flatten().is_some() {
                    return;
                }
                thread::sleep(Duration::from_millis(10));
            }
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

impl Drop for HostRuntimeInner {
    fn drop(&mut self) {
        self.close();
    }
}

impl HostShared {
    fn send(&self, message: ClientToHost) -> Result<(), RuntimeError> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| RuntimeError::Runtime("Code Mode Host writer was poisoned".into()))?;
        let writer = writer.as_mut().ok_or_else(|| {
            RuntimeError::Runtime(
                self.fatal_message()
                    .unwrap_or_else(|| "Code Mode Host is closed".into()),
            )
        })?;
        write_frame(writer, &message).map_err(|error| RuntimeError::Runtime(error.to_string()))
    }

    fn ensure_live(&self) -> Result<(), RuntimeError> {
        match self.fatal_message() {
            Some(error) => Err(RuntimeError::Runtime(error)),
            None => Ok(()),
        }
    }

    fn fatal_message(&self) -> Option<String> {
        self.fatal_error.lock().ok().and_then(|error| error.clone())
    }

    fn fail(&self, message: String) {
        if let Ok(mut fatal_error) = self.fatal_error.lock() {
            if fatal_error.is_some() {
                return;
            }
            *fatal_error = Some(message.clone());
        }
        self.invoker.cancel();
        if let Ok(mut sender) = self.session_opened.lock()
            && let Some(sender) = sender.take()
        {
            let _ = sender.send(Err(message.clone()));
        }
        let _ = self.started_cells.send(Err(message));
        self.mark_unknown_cells();
    }

    fn mark_unknown_cells(&self) {
        let reason = self
            .fatal_message()
            .unwrap_or_else(|| "Code Mode Host closed; nested tool outcome is unknown".into());
        let cells = self
            .cells
            .lock()
            .map(|cells| {
                cells
                    .iter()
                    .map(|(id, cell)| (id.clone(), Arc::clone(cell)))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for (cell_id, cell) in cells {
            let terminal = cell
                .last_response
                .lock()
                .ok()
                .and_then(|response| response.clone())
                .is_some_and(|response| is_terminal(&response));
            if !terminal {
                let _ = cell.sender.send(unknown_response(cell_id, reason.clone()));
            }
        }
    }

    fn receive_started(&self, timeout: Duration) -> Result<HostResult<StartedCell>, RuntimeError> {
        self.started_receiver
            .lock()
            .map_err(|_| {
                RuntimeError::Runtime("Code Mode Host started receiver was poisoned".into())
            })?
            .recv_timeout(timeout)
            .map_err(|_| RuntimeError::Runtime("Code Mode Host did not start the cell".into()))
    }
}

fn read_host(
    mut reader: BufReader<std::process::ChildStdout>,
    session_id: CodeModeSessionId,
    shared: Arc<HostShared>,
) {
    loop {
        let message = match read_frame::<_, HostToClient>(&mut reader) {
            Ok(message) => message,
            Err(error) => {
                shared.fail(format!(
                    "Code Mode Host exited or closed its output ({error}); active nested tool outcomes are unknown"
                ));
                return;
            }
        };
        match message {
            HostToClient::SessionOpened { session_id: opened } if opened == session_id => {
                if let Ok(mut sender) = shared.session_opened.lock()
                    && let Some(sender) = sender.take()
                {
                    let _ = sender.send(Ok(()));
                }
            }
            HostToClient::StartedCell(started) => {
                let _ = shared.started_cells.send(Ok(started));
            }
            HostToClient::ToolCall(call) => {
                let invoker = Arc::clone(&shared.invoker);
                let callback_shared = Arc::clone(&shared);
                thread::spawn(move || {
                    let cell_id = call.cell_id.clone();
                    let runtime_tool_call_id = call.runtime_tool_call_id.clone();
                    let (result, error_text) = match invoker.invoke(call) {
                        Ok(result) => (result, None),
                        Err(error) => (Value::Null, Some(error)),
                    };
                    let _ = callback_shared.send(ClientToHost::CompleteToolCall {
                        cell_id,
                        runtime_tool_call_id,
                        result,
                        error_text,
                    });
                });
            }
            HostToClient::Notification(notification) => {
                let _ = shared.invoker.notify(notification);
            }
            HostToClient::StoreSnapshot {
                session_id: snapshot_session_id,
                values,
            } if snapshot_session_id == session_id => {
                if let Err(error) = shared.stored_values.replace(values) {
                    shared.fail(error.to_string());
                    return;
                }
            }
            HostToClient::Response { response } => {
                let cell_id = response_cell_id(&response);
                if is_terminal(&response) {
                    shared.invoker.cancel_cell(&cell_id);
                }
                let cell = shared
                    .cells
                    .lock()
                    .ok()
                    .and_then(|cells| cells.get(&cell_id).cloned());
                if let Some(cell) = cell {
                    let _ = cell.sender.send(response);
                } else {
                    shared.fail(format!(
                        "Code Mode Host returned an unknown cell: {cell_id}"
                    ));
                    return;
                }
            }
            HostToClient::CancelCellTools { cell_id }
            | HostToClient::CellClosed { cell_id, .. } => {
                shared.invoker.cancel_cell(&cell_id);
            }
            HostToClient::Error { message } => {
                shared.fail(format!("Code Mode Host error: {message}"));
                return;
            }
            other => {
                shared.fail(format!("unexpected Code Mode Host message: {other:?}"));
                return;
            }
        }
    }
}

fn terminal_response(cell: &HostCell) -> Result<Option<RuntimeResponse>, RuntimeError> {
    Ok(cell
        .last_response
        .lock()
        .map_err(|_| RuntimeError::Runtime("Code Mode Host cell response was poisoned".into()))?
        .clone()
        .filter(is_terminal))
}

fn is_terminal(response: &RuntimeResponse) -> bool {
    matches!(
        response,
        RuntimeResponse::Result { .. }
            | RuntimeResponse::Terminated { .. }
            | RuntimeResponse::Unknown { .. }
    )
}

fn response_cell_id(response: &RuntimeResponse) -> CellId {
    match response {
        RuntimeResponse::Running { cell_id, .. }
        | RuntimeResponse::Yielded { cell_id, .. }
        | RuntimeResponse::Terminated { cell_id, .. }
        | RuntimeResponse::Result { cell_id, .. }
        | RuntimeResponse::Unknown { cell_id, .. } => cell_id.clone(),
    }
}

fn unknown_response(cell_id: CellId, reason: String) -> RuntimeResponse {
    RuntimeResponse::Unknown {
        cell_id,
        content_items: Vec::new(),
        reason,
    }
}

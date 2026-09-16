use crate::CodeModeHost;
use crate::CodeModeStore;
use crate::RuntimeError;
use crate::ToolInvoker;
use crate::host::Connection;
use ash_code_mode_protocol::CellId;
use ash_code_mode_protocol::ClientToHost;
use ash_code_mode_protocol::CodeModeLimits;
use ash_code_mode_protocol::CodeModeSessionId;
use ash_code_mode_protocol::ExecuteRequest;
use ash_code_mode_protocol::HostToClient;
use ash_code_mode_protocol::RuntimeResponse;
use ash_code_mode_protocol::StartedCell;
use ash_code_mode_protocol::WaitOutcome;
use ash_code_mode_protocol::WaitRequest;
use std::collections::BTreeMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

static NEXT_SESSION: AtomicU64 = AtomicU64::new(1);
const CONTROL_TIMEOUT: Duration = Duration::from_secs(5);

/// Logical thread session. Stored values survive a Host failure; running code never does.
#[derive(Clone)]
pub struct CodeModeSession {
    inner: Arc<Session>,
}

struct Session {
    host: CodeModeHost,
    id: CodeModeSessionId,
    limits: CodeModeLimits,
    store: CodeModeStore,
    state: Mutex<SessionState>,
    cells: Mutex<BTreeMap<CellId, Arc<Connection>>>,
}

#[derive(Default)]
struct SessionState {
    closed: bool,
    binding: Option<(Arc<Connection>, CodeModeSessionId)>,
}

impl CodeModeHost {
    /// Creates a logical session without starting a process or retaining tool authority.
    pub fn session(&self, id: CodeModeSessionId, limits: CodeModeLimits) -> CodeModeSession {
        CodeModeSession {
            inner: Arc::new(Session {
                host: self.clone(),
                id,
                limits,
                store: CodeModeStore::new(),
                state: Mutex::new(SessionState::default()),
                cells: Mutex::new(BTreeMap::new()),
            }),
        }
    }
}

impl CodeModeSession {
    /// Binds the current turn's tool authority to this cell only.
    pub fn execute(
        &self,
        mut request: ExecuteRequest,
        invoker: Arc<dyn ToolInvoker>,
    ) -> Result<StartedCell, RuntimeError> {
        if request.session_id != self.inner.id {
            return Err(RuntimeError::InvalidRequest(
                "Execute request belongs to another session".into(),
            ));
        }
        let mut state = self.inner.state.lock().unwrap();
        if state.closed {
            return Err(RuntimeError::InvalidRequest(
                "Code Mode session is closed".into(),
            ));
        }
        if self.inner.cells.lock().unwrap().len() >= 8 {
            return Err(RuntimeError::InvalidRequest(
                "Code Mode session has too many unobserved cells".into(),
            ));
        }
        let connection = self.inner.host.connection()?;
        if !state
            .binding
            .as_ref()
            .is_some_and(|(bound, _)| Arc::ptr_eq(bound, &connection))
        {
            if let Some((previous, id)) = state.binding.take() {
                previous.remove_store(&id);
            }
            let wire_id = CodeModeSessionId::new(format!(
                "session-{}",
                NEXT_SESSION.fetch_add(1, Ordering::Relaxed)
            ))
            .map_err(|error| RuntimeError::Initialization(error.to_string()))?;
            connection.register_store(wire_id.clone(), self.inner.store.clone());
            let reply = connection.request(
                ClientToHost::OpenSession {
                    session_id: wire_id.clone(),
                    limits: self.inner.limits,
                    stored_values: self.inner.store.snapshot()?,
                },
                CONTROL_TIMEOUT,
            );
            match reply {
                Ok(HostToClient::SessionOpened { session_id }) if session_id == wire_id => {}
                result => {
                    connection.remove_store(&wire_id);
                    return Err(unexpected(result));
                }
            }
            state.binding = Some((Arc::clone(&connection), wire_id));
        }
        request.session_id = state.binding.as_ref().unwrap().1.clone();
        let started = match connection.request(ClientToHost::Execute(request), CONTROL_TIMEOUT)? {
            HostToClient::StartedCell(started) => started,
            other => return Err(unexpected(Ok(other))),
        };
        // JavaScript starts on first observation, after Core records its durable parent.
        connection.register_cell(started.cell_id.clone(), invoker);
        self.inner
            .cells
            .lock()
            .unwrap()
            .insert(started.cell_id.clone(), connection);
        Ok(started)
    }

    pub fn wait(&self, mut request: WaitRequest) -> Result<WaitOutcome, RuntimeError> {
        request.yield_time_ms = request
            .yield_time_ms
            .min(self.inner.limits.max_yield_time_ms);
        let timeout = Duration::from_millis(request.yield_time_ms).saturating_add(CONTROL_TIMEOUT);
        self.observe(
            request.cell_id.clone(),
            ClientToHost::Wait(request),
            timeout,
        )
    }

    pub fn terminate(&self, cell_id: &CellId) -> Result<WaitOutcome, RuntimeError> {
        self.observe(
            cell_id.clone(),
            ClientToHost::Terminate {
                cell_id: cell_id.clone(),
            },
            CONTROL_TIMEOUT,
        )
    }

    fn observe(
        &self,
        cell_id: CellId,
        message: ClientToHost,
        timeout: Duration,
    ) -> Result<WaitOutcome, RuntimeError> {
        let connection = self.inner.cells.lock().unwrap().get(&cell_id).cloned();
        let Some(connection) = connection else {
            return Ok(WaitOutcome::MissingCell { cell_id });
        };
        let result = connection.request(message, timeout);
        let response = match result {
            Ok(HostToClient::MissingCell { cell_id: missing }) if missing == cell_id => {
                self.inner.cells.lock().unwrap().remove(&cell_id);
                connection.remove_cell(&cell_id);
                return Ok(WaitOutcome::MissingCell { cell_id });
            }
            Ok(HostToClient::Response { response }) if response_id(&response) == &cell_id => {
                response
            }
            result => match connection.failure() {
                Some(reason) => RuntimeResponse::Unknown {
                    cell_id: cell_id.clone(),
                    content_items: Vec::new(),
                    reason,
                },
                None => return Err(unexpected(result)),
            },
        };
        if !matches!(
            response,
            RuntimeResponse::Running { .. } | RuntimeResponse::Yielded { .. }
        ) {
            self.inner.cells.lock().unwrap().remove(&cell_id);
            connection.remove_cell(&cell_id);
        }
        Ok(WaitOutcome::LiveCell { response })
    }

    pub fn has_cell(&self, cell_id: &CellId) -> bool {
        self.inner.cells.lock().unwrap().contains_key(cell_id)
    }

    pub fn close(&self) {
        self.inner.close();
    }
}

impl Session {
    fn close(&self) {
        let mut state = self.state.lock().unwrap();
        if state.closed {
            return;
        }
        state.closed = true;
        for (cell_id, connection) in std::mem::take(&mut *self.cells.lock().unwrap()) {
            connection.remove_cell(&cell_id);
        }
        if let Some((connection, session_id)) = state.binding.take() {
            let _ = connection.request(
                ClientToHost::CloseSession {
                    session_id: session_id.clone(),
                },
                CONTROL_TIMEOUT,
            );
            connection.remove_store(&session_id);
        }
    }
}

impl Drop for Session {
    fn drop(&mut self) {
        self.close();
    }
}

fn unexpected(result: Result<HostToClient, RuntimeError>) -> RuntimeError {
    match result {
        Err(error) => error,
        Ok(message) => {
            RuntimeError::Runtime(format!("unexpected Code Mode Host reply: {message:?}"))
        }
    }
}

fn response_id(response: &RuntimeResponse) -> &CellId {
    match response {
        RuntimeResponse::Running { cell_id, .. }
        | RuntimeResponse::Yielded { cell_id, .. }
        | RuntimeResponse::Result { cell_id, .. }
        | RuntimeResponse::Terminated { cell_id, .. }
        | RuntimeResponse::Unknown { cell_id, .. } => cell_id,
    }
}

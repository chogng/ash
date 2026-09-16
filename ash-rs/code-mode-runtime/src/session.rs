use crate::v8_init::ensure_v8_initialized;
use ash_code_mode_protocol::{
    CellId, CellState, CodeModeLimits, CodeModeSessionId, EnabledTool, ExecuteRequest, OutputItem,
    RuntimeResponse, StartedCell, WaitOutcome, WaitRequest,
};
use serde_json::Value;
use std::collections::BTreeMap;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

mod cell;
mod store;
use ash_code_mode_protocol::RuntimeError;
use ash_code_mode_protocol::ToolInvoker;
pub use store::CodeModeStore;

/// One process-local Code Mode session containing isolated JavaScript cells and shared values.
#[derive(Clone)]
pub struct CodeModeRuntime {
    inner: Arc<RuntimeInner>,
}

struct RuntimeInner {
    session_id: CodeModeSessionId,
    limits: CodeModeLimits,
    invoker: Arc<dyn ToolInvoker>,
    cells: Mutex<BTreeMap<CellId, Arc<CellEntry>>>,
    stored_values: CodeModeStore,
    next_cell_id: AtomicU64,
}

struct CellEntry {
    observation: Mutex<()>,
    command_tx: Sender<CellCommand>,
    events: Mutex<Receiver<CellEvent>>,
    started: AtomicBool,
    termination_requested: Arc<AtomicBool>,
    waiting_for_command: AtomicBool,
    terminal: AtomicBool,
    state: Mutex<CellState>,
    last_response: Mutex<Option<RuntimeResponse>>,
    isolate_handle: Mutex<Option<v8::IsolateHandle>>,
}

struct CellEvent {
    response: RuntimeResponse,
    stored_value_writes: BTreeMap<String, Option<Value>>,
}

enum CellCommand {
    Start,
    Resume,
    Terminate,
}

/// Mutable state visible to the JavaScript callbacks for one cell.
pub(super) struct RuntimeState {
    pub(super) invoker: Arc<dyn ToolInvoker>,
    pub(super) cell_id: CellId,
    pub(super) tool_call_id: String,
    pub(super) enabled_tools: Vec<EnabledTool>,
    pub(super) stored_values: BTreeMap<String, Value>,
    pub(super) stored_value_writes: BTreeMap<String, Option<Value>>,
    pub(super) output_items: Vec<OutputItem>,
    pub(super) output_bytes: usize,
    pub(super) max_output_bytes: usize,
    pub(super) max_nested_calls: usize,
    pub(super) next_tool_call_id: usize,
    pub(super) tool_completion_tx: Sender<ToolCompletion>,
    pub(super) tool_completion_rx: Receiver<ToolCompletion>,
    pub(super) pending_tool_calls: BTreeMap<String, v8::Global<v8::PromiseResolver>>,
    pub(super) yield_requested: bool,
    pub(super) yield_resolver: Option<v8::Global<v8::PromiseResolver>>,
    pub(super) exit_requested: bool,
}

pub(super) struct ToolCompletion {
    pub(super) runtime_tool_call_id: String,
    pub(super) result: Result<Value, String>,
}

impl RuntimeState {
    pub(super) fn push_output(&mut self, item: OutputItem) -> Result<(), String> {
        let item_bytes = serde_json::to_vec(&item)
            .map_err(|error| format!("failed to measure Code Mode output: {error}"))?
            .len();
        self.output_bytes = self
            .output_bytes
            .checked_add(item_bytes)
            .ok_or_else(|| "Code Mode output limit exceeded".to_string())?;
        if self.output_bytes > self.max_output_bytes {
            return Err(format!(
                "Code Mode output exceeds the {} byte limit",
                self.max_output_bytes
            ));
        }
        self.output_items.push(item);
        Ok(())
    }

    fn take_output_items(&mut self) -> Vec<OutputItem> {
        std::mem::take(&mut self.output_items)
    }

    fn take_yield_resolver(&mut self) -> Option<v8::Global<v8::PromiseResolver>> {
        self.yield_resolver.take()
    }
}

impl CodeModeRuntime {
    /// Returns the owning session identifier.
    pub fn session_id(&self) -> &CodeModeSessionId {
        &self.inner.session_id
    }

    /// Creates an embedded runtime. V8 is initialized lazily here, so Direct mode never needs it.
    pub fn new(
        session_id: CodeModeSessionId,
        limits: CodeModeLimits,
        invoker: Arc<dyn ToolInvoker>,
    ) -> Result<Self, RuntimeError> {
        Self::new_with_store(session_id, limits, invoker, CodeModeStore::new())
    }

    /// Creates a runtime backed by an existing owning Thread Session store.
    pub fn new_with_store(
        session_id: CodeModeSessionId,
        limits: CodeModeLimits,
        invoker: Arc<dyn ToolInvoker>,
        stored_values: CodeModeStore,
    ) -> Result<Self, RuntimeError> {
        ensure_v8_initialized().map_err(RuntimeError::Initialization)?;
        if limits.max_output_bytes == 0 || limits.max_heap_bytes == 0 {
            return Err(RuntimeError::InvalidRequest(
                "Code Mode resource limits must be greater than zero".into(),
            ));
        }
        Ok(Self {
            inner: Arc::new(RuntimeInner {
                session_id,
                limits,
                invoker,
                cells: Mutex::new(BTreeMap::new()),
                stored_values,
                next_cell_id: AtomicU64::new(1),
            }),
        })
    }

    /// Registers a cell and returns before JavaScript finishes, matching `exec`/`wait` semantics.
    /// The first observation starts the cell, which gives Core time to register its durable parent
    /// before JavaScript can emit a nested Tool Call.
    pub fn execute(&self, request: ExecuteRequest) -> Result<StartedCell, RuntimeError> {
        cell::validate_request(&request, &self.inner.session_id)?;
        let cell_id = CellId::from_internal(format!(
            "cell-{}-{}",
            self.inner.session_id,
            self.inner.next_cell_id.fetch_add(1, Ordering::Relaxed)
        ));
        let (command_tx, command_rx) = mpsc::channel();
        let (event_tx, event_rx) = mpsc::channel();
        let done = Arc::new(AtomicBool::new(false));
        let timed_out = Arc::new(AtomicBool::new(false));
        let termination_requested = Arc::new(AtomicBool::new(false));
        let watchdog_tx = command_tx.clone();
        let entry = Arc::new(CellEntry {
            observation: Mutex::new(()),
            command_tx,
            events: Mutex::new(event_rx),
            started: AtomicBool::new(false),
            termination_requested: Arc::clone(&termination_requested),
            waiting_for_command: AtomicBool::new(false),
            terminal: AtomicBool::new(false),
            state: Mutex::new(CellState::Running),
            last_response: Mutex::new(None),
            isolate_handle: Mutex::new(None),
        });
        self.inner
            .cells
            .lock()
            .map_err(|_| RuntimeError::Runtime("Code Mode cell registry was poisoned".into()))?
            .insert(cell_id.clone(), Arc::clone(&entry));

        let stored_values = self.inner.stored_values.snapshot()?;
        let limits = self.inner.limits;
        let invoker = Arc::clone(&self.inner.invoker);
        let runtime_cell_id = cell_id.clone();
        let panic_cell_id = cell_id.clone();
        let (handle_tx, handle_rx) = mpsc::sync_channel(1);
        let cleanup_invoker = Arc::clone(&invoker);
        let thread_done = Arc::clone(&done);
        let thread_timed_out = Arc::clone(&timed_out);
        let thread_termination_requested = Arc::clone(&termination_requested);
        thread::spawn(move || {
            let result = catch_unwind(AssertUnwindSafe(|| {
                cell::run_cell(
                    runtime_cell_id,
                    request,
                    limits,
                    stored_values,
                    invoker,
                    command_rx,
                    watchdog_tx,
                    thread_timed_out,
                    thread_termination_requested,
                    event_tx.clone(),
                    handle_tx,
                    Arc::clone(&thread_done),
                )
            }));
            cleanup_invoker.cancel_cell(&panic_cell_id);
            if result.is_err() {
                let _ = event_tx.send(CellEvent {
                    response: RuntimeResponse::Unknown {
                        cell_id: panic_cell_id,
                        content_items: Vec::new(),
                        reason: "Code Mode runtime panicked; nested tool outcome is unknown".into(),
                    },
                    stored_value_writes: BTreeMap::new(),
                });
                thread_done.store(true, Ordering::Release);
            }
        });
        let handle = handle_rx
            .recv_timeout(Duration::from_secs(5))
            .map_err(|_| RuntimeError::Initialization("V8 cell did not initialize".into()))?;
        *entry
            .isolate_handle
            .lock()
            .map_err(|_| RuntimeError::Runtime("Code Mode cell was poisoned".into()))? =
            Some(handle.clone());
        Ok(StartedCell { cell_id })
    }

    /// Waits for one cell, returning a bounded live/terminal response instead of hiding state in a
    /// boolean. A timed observation is represented by `RuntimeResponse::Running`.
    pub fn wait(&self, request: WaitRequest) -> Result<WaitOutcome, RuntimeError> {
        if request.max_output_tokens == Some(0) {
            return Err(RuntimeError::InvalidRequest(
                "max_output_tokens must be greater than zero".into(),
            ));
        }
        let budget = request.max_output_tokens;
        let cell_id = request.cell_id.clone();
        let mut outcome = self.wait_cell(request)?;
        if let WaitOutcome::LiveCell { response } = &mut outcome {
            if !matches!(
                response,
                RuntimeResponse::Running { .. } | RuntimeResponse::Yielded { .. }
            ) {
                self.inner
                    .cells
                    .lock()
                    .map_err(|_| {
                        RuntimeError::Runtime("Code Mode cell registry was poisoned".into())
                    })?
                    .remove(&cell_id);
            }
            ash_code_mode_protocol::limit_output(response, budget);
        }
        Ok(outcome)
    }

    fn wait_cell(&self, request: WaitRequest) -> Result<WaitOutcome, RuntimeError> {
        let Some(entry) = self
            .inner
            .cells
            .lock()
            .map_err(|_| RuntimeError::Runtime("Code Mode cell registry was poisoned".into()))?
            .get(&request.cell_id)
            .cloned()
        else {
            return Ok(WaitOutcome::MissingCell {
                cell_id: request.cell_id,
            });
        };

        let terminate = request.action() == ash_code_mode_protocol::WaitAction::Terminate;
        // Interrupt before acquiring the observation lock so an in-flight long poll wakes up.
        if terminate {
            entry.termination_requested.store(true, Ordering::Release);
            let _ = entry.command_tx.send(CellCommand::Terminate);
            if let Ok(handle) = entry.isolate_handle.lock()
                && let Some(handle) = handle.as_ref()
            {
                let _ = handle.terminate_execution();
            }
            self.inner.invoker.cancel_cell(&request.cell_id);
        }
        let _observation = if terminate {
            entry
                .observation
                .lock()
                .map_err(|_| RuntimeError::Runtime("Cell observation was poisoned".into()))?
        } else {
            entry.observation.try_lock().map_err(|_| {
                RuntimeError::InvalidRequest("Cell already has an active observation".into())
            })?
        };
        if entry.terminal.load(Ordering::Acquire) {
            return Ok(WaitOutcome::MissingCell {
                cell_id: request.cell_id,
            });
        }
        if terminate {
            return self.terminate_cell(&request.cell_id, &entry);
        }
        if let Some(event) = try_receive_event(&entry)? {
            return Ok(WaitOutcome::LiveCell {
                response: self.record_event(&entry, event)?,
            });
        }
        if !entry.started.swap(true, Ordering::AcqRel) {
            entry
                .command_tx
                .send(CellCommand::Start)
                .map_err(|_| RuntimeError::ChannelClosed)?;
        } else if entry.waiting_for_command.swap(false, Ordering::AcqRel) {
            entry
                .command_tx
                .send(CellCommand::Resume)
                .map_err(|_| RuntimeError::ChannelClosed)?;
        }

        let timeout = request
            .yield_time_ms
            .min(self.inner.limits.max_yield_time_ms);
        let event = entry
            .events
            .lock()
            .map_err(|_| RuntimeError::Runtime("Code Mode cell was poisoned".into()))?
            .recv_timeout(Duration::from_millis(timeout));
        match event {
            Ok(event) => Ok(WaitOutcome::LiveCell {
                response: self.record_event(&entry, event)?,
            }),
            Err(RecvTimeoutError::Timeout) => Ok(WaitOutcome::LiveCell {
                response: RuntimeResponse::Running {
                    cell_id: request.cell_id,
                    content_items: Vec::new(),
                },
            }),
            Err(RecvTimeoutError::Disconnected) => Err(RuntimeError::ChannelClosed),
        }
    }

    /// Requests termination and interrupts CPU-bound JavaScript through V8's isolate handle.
    pub fn terminate(&self, cell_id: &CellId) -> Result<WaitOutcome, RuntimeError> {
        self.wait(WaitRequest {
            cell_id: cell_id.clone(),
            yield_time_ms: 0,
            max_output_tokens: None,
            terminate: true,
        })
    }

    /// Reports whether this session owns a cell without waiting for its runtime thread.
    pub fn has_cell(&self, cell_id: &CellId) -> bool {
        self.inner
            .cells
            .lock()
            .map(|cells| cells.contains_key(cell_id))
            .unwrap_or(false)
    }

    /// Returns the current session values for an isolated Host transport.
    pub fn store_snapshot(&self) -> Result<BTreeMap<String, Value>, RuntimeError> {
        self.inner.stored_values.snapshot()
    }

    /// Terminates all active cells when the owning Thread or Host closes.
    pub fn close(&self) {
        self.inner.invoker.cancel();
        let entries = self
            .inner
            .cells
            .lock()
            .map(|cells| cells.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for entry in entries {
            entry.termination_requested.store(true, Ordering::Release);
            let _ = entry.command_tx.send(CellCommand::Terminate);
            if let Ok(handle) = entry.isolate_handle.lock()
                && let Some(handle) = handle.as_ref()
            {
                let _ = handle.terminate_execution();
            }
        }
    }

    fn record_event(
        &self,
        entry: &CellEntry,
        mut event: CellEvent,
    ) -> Result<RuntimeResponse, RuntimeError> {
        if !event.stored_value_writes.is_empty()
            && let Err(error) = self.inner.stored_values.apply(event.stored_value_writes)
        {
            let cell_id = match &event.response {
                RuntimeResponse::Running { cell_id, .. }
                | RuntimeResponse::Yielded { cell_id, .. }
                | RuntimeResponse::Terminated { cell_id, .. }
                | RuntimeResponse::Result { cell_id, .. }
                | RuntimeResponse::Unknown { cell_id, .. } => cell_id.clone(),
            };
            self.inner.invoker.cancel_cell(&cell_id);
            entry.termination_requested.store(true, Ordering::Release);
            let _ = entry.command_tx.send(CellCommand::Terminate);
            if let Ok(handle) = entry.isolate_handle.lock()
                && let Some(handle) = handle.as_ref()
            {
                let _ = handle.terminate_execution();
            }
            event.response = RuntimeResponse::Result {
                cell_id,
                content_items: Vec::new(),
                error_text: Some(error.to_string()),
            };
        }
        let state = response_state(&event.response);
        *entry
            .state
            .lock()
            .map_err(|_| RuntimeError::Runtime("Code Mode cell was poisoned".into()))? = state;
        if matches!(
            state,
            CellState::Completed | CellState::Terminated | CellState::Failed | CellState::Unknown
        ) {
            entry.terminal.store(true, Ordering::Release);
        } else {
            entry.waiting_for_command.store(true, Ordering::Release);
        }
        *entry
            .last_response
            .lock()
            .map_err(|_| RuntimeError::Runtime("Code Mode cell was poisoned".into()))? =
            Some(event.response.clone());
        Ok(event.response)
    }

    fn terminate_cell(
        &self,
        cell_id: &CellId,
        entry: &CellEntry,
    ) -> Result<WaitOutcome, RuntimeError> {
        if entry.terminal.load(Ordering::Acquire)
            && let Some(response) = entry
                .last_response
                .lock()
                .map_err(|_| RuntimeError::Runtime("Code Mode cell was poisoned".into()))?
                .clone()
        {
            return Ok(WaitOutcome::LiveCell { response });
        }
        entry.waiting_for_command.store(false, Ordering::Release);
        self.inner.invoker.cancel_cell(cell_id);
        entry.termination_requested.store(true, Ordering::Release);
        let _ = entry.command_tx.send(CellCommand::Terminate);
        if let Ok(handle) = entry.isolate_handle.lock()
            && let Some(handle) = handle.as_ref()
        {
            let _ = handle.terminate_execution();
        }
        let event = entry
            .events
            .lock()
            .map_err(|_| RuntimeError::Runtime("Code Mode cell was poisoned".into()))?
            .recv_timeout(Duration::from_secs(1));
        match event {
            Ok(event) => Ok(WaitOutcome::LiveCell {
                response: self.record_event(entry, event)?,
            }),
            Err(RecvTimeoutError::Timeout) => {
                let response = RuntimeResponse::Terminated {
                    cell_id: cell_id.clone(),
                    content_items: Vec::new(),
                };
                entry.terminal.store(true, Ordering::Release);
                *entry
                    .state
                    .lock()
                    .map_err(|_| RuntimeError::Runtime("Code Mode cell was poisoned".into()))? =
                    CellState::Terminated;
                *entry
                    .last_response
                    .lock()
                    .map_err(|_| RuntimeError::Runtime("Code Mode cell was poisoned".into()))? =
                    Some(response.clone());
                Ok(WaitOutcome::LiveCell { response })
            }
            Err(RecvTimeoutError::Disconnected) => Err(RuntimeError::ChannelClosed),
        }
    }
}

fn try_receive_event(entry: &CellEntry) -> Result<Option<CellEvent>, RuntimeError> {
    let event = entry
        .events
        .lock()
        .map_err(|_| RuntimeError::Runtime("Code Mode cell was poisoned".into()))?
        .try_recv();
    match event {
        Ok(event) => Ok(Some(event)),
        Err(mpsc::TryRecvError::Empty) => Ok(None),
        Err(mpsc::TryRecvError::Disconnected) => Err(RuntimeError::ChannelClosed),
    }
}

fn response_state(response: &RuntimeResponse) -> CellState {
    match response {
        RuntimeResponse::Running { .. } => CellState::Running,
        RuntimeResponse::Yielded { .. } => CellState::Yielded,
        RuntimeResponse::Terminated { .. } => CellState::Terminated,
        RuntimeResponse::Result { error_text, .. } => {
            if error_text.is_some() {
                CellState::Failed
            } else {
                CellState::Completed
            }
        }
        RuntimeResponse::Unknown { .. } => CellState::Unknown,
    }
}

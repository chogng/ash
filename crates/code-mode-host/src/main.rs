mod output;

use ash_code_mode_protocol::CellId;
use ash_code_mode_protocol::CodeModeLimits;
use ash_code_mode_protocol::CodeModeSessionId;
use ash_code_mode_protocol::HostFrame;
use ash_code_mode_protocol::{
    CODE_MODE_PROTOCOL_VERSION, ClientToHost, HostToClient, NestedToolCall, RuntimeNotification,
};
use ash_code_mode_runtime::{CodeModeRuntime, ToolInvoker};
use output::send;
use output::send_wait_result;
use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, BufReader, BufWriter};
use std::sync::atomic::AtomicUsize;
use std::sync::atomic::Ordering;
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

type ToolResult = Result<serde_json::Value, String>;

struct StdioToolInvoker {
    writer: Arc<Mutex<BufWriter<io::Stdout>>>,
    pending: Mutex<BTreeMap<String, Sender<ToolResult>>>,
    active_cells: Mutex<BTreeSet<ash_code_mode_protocol::CellId>>,
}

impl ToolInvoker for StdioToolInvoker {
    fn invoke(&self, call: NestedToolCall) -> ToolResult {
        let key = pending_key(&call.cell_id, &call.runtime_tool_call_id);
        let (sender, receiver) = mpsc::channel();
        let _active_cells = self
            .active_cells
            .lock()
            .map_err(|_| "Host cell cancellation registry was poisoned".to_string())?;
        if !_active_cells.contains(&call.cell_id) {
            return Err("Code Mode cell has been cancelled".into());
        }
        self.pending
            .lock()
            .map_err(|_| "Host tool callback registry was poisoned".to_string())?
            .insert(key, sender);
        drop(_active_cells);
        self.send(HostToClient::ToolCall(call))?;
        receiver
            .recv()
            .map_err(|_| "Host tool callback was closed before a result arrived".to_string())?
    }

    fn notify(&self, notification: RuntimeNotification) -> Result<(), String> {
        self.send(HostToClient::Notification(notification))
    }

    fn cancel_cell(&self, cell_id: &ash_code_mode_protocol::CellId) {
        let Ok(mut active_cells) = self.active_cells.lock() else {
            return;
        };
        if !active_cells.remove(cell_id) {
            return;
        }
        self.close_cell_pending(cell_id);
        drop(active_cells);
        let _ = self.send(HostToClient::CancelCellTools {
            cell_id: cell_id.clone(),
        });
    }
}

impl StdioToolInvoker {
    fn send(&self, message: HostToClient) -> Result<(), String> {
        send(&self.writer, None, message).map_err(|error| error.to_string())
    }

    fn complete(
        &self,
        cell_id: &ash_code_mode_protocol::CellId,
        runtime_call_id: &str,
        result: ToolResult,
    ) -> bool {
        let key = pending_key(cell_id, runtime_call_id);
        self.pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&key))
            .map(|sender| sender.send(result).is_ok())
            .unwrap_or(false)
    }

    fn close_pending(&self) {
        let pending = self
            .pending
            .lock()
            .map(|mut pending| std::mem::take(&mut *pending))
            .unwrap_or_default();
        for sender in pending.into_values() {
            let _ = sender.send(Err(
                "Code Mode Host closed before the tool callback completed".into(),
            ));
        }
    }

    fn close_cell_pending(&self, cell_id: &ash_code_mode_protocol::CellId) {
        let pending = self
            .pending
            .lock()
            .map(|mut pending| {
                let prefix = format!("{cell_id}:");
                let keys = pending
                    .iter()
                    .filter(|(key, _)| key.starts_with(&prefix))
                    .map(|(key, _)| key.clone())
                    .collect::<Vec<_>>();
                keys.into_iter()
                    .filter_map(|key| pending.remove(&key))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for sender in pending {
            let _ = sender.send(Err(
                "Code Mode cell closed before the tool callback completed".into(),
            ));
        }
    }
}

fn pending_key(cell_id: &ash_code_mode_protocol::CellId, runtime_call_id: &str) -> String {
    format!("{}:{}", cell_id, runtime_call_id)
}

// Admissions are released when a terminal response is observed or its session is closed.
struct Allocation {
    session_id: CodeModeSessionId,
    heap_bytes: usize,
}

type Allocations = Arc<Mutex<BTreeMap<CellId, Allocation>>>;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _package_lease =
        ash_package_store::acquire_package_lease_for_executable(std::env::current_exe()?)?;
    let stdout = Arc::new(Mutex::new(BufWriter::new(io::stdout())));
    let invoker = Arc::new(StdioToolInvoker {
        writer: Arc::clone(&stdout),
        pending: Mutex::new(BTreeMap::new()),
        active_cells: Mutex::new(BTreeSet::new()),
    });
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut sessions: BTreeMap<CodeModeSessionId, (CodeModeRuntime, CodeModeLimits)> =
        BTreeMap::new();
    let allocations: Allocations = Arc::new(Mutex::new(BTreeMap::new()));
    let waits = Arc::new(AtomicUsize::new(0));
    let mut handshake_complete = false;

    loop {
        let frame =
            match ash_code_mode_protocol::read_frame::<_, HostFrame<ClientToHost>>(&mut reader) {
                Ok(frame) => frame,
                Err(ash_code_mode_protocol::ProtocolError::UnexpectedEof) => break,
                Err(error) => {
                    send(
                        &stdout,
                        None,
                        HostToClient::Error {
                            message: error.to_string(),
                        },
                    )?;
                    break;
                }
            };
        let request_id = frame.request_id;
        if matches!(frame.message, ClientToHost::CompleteToolCall { .. }) != request_id.is_none() {
            send(
                &stdout,
                request_id,
                HostToClient::Error {
                    message: "invalid request correlation".into(),
                },
            )?;
            break;
        }
        let reply = |message| send(&stdout, request_id, message);
        let error = |message: String| reply(HostToClient::Error { message });
        match frame.message {
            ClientToHost::Hello { protocol_version } => {
                if handshake_complete || protocol_version != CODE_MODE_PROTOCOL_VERSION {
                    error(format!(
                        "unsupported or repeated Code Mode handshake: {protocol_version}"
                    ))?;
                    break;
                }
                handshake_complete = true;
                reply(HostToClient::Hello {
                    protocol_version: CODE_MODE_PROTOCOL_VERSION,
                    max_frame_bytes: ash_code_mode_protocol::MAX_FRAME_BYTES,
                })?;
            }
            _ if !handshake_complete => {
                error("Code Mode Host requires Hello before other messages".into())?;
                break;
            }
            ClientToHost::OpenSession {
                session_id,
                limits,
                stored_values,
            } => {
                if sessions.contains_key(&session_id) || sessions.len() >= 32 {
                    error("Code Mode session already exists or session limit reached".into())?;
                    continue;
                }
                let maximum = CodeModeLimits::default();
                if limits.max_heap_bytes == 0
                    || limits.max_heap_bytes > maximum.max_heap_bytes
                    || limits.max_execution_time_ms == 0
                    || limits.max_execution_time_ms > maximum.max_execution_time_ms
                    || limits.max_yield_time_ms > maximum.max_yield_time_ms
                    || limits.max_output_bytes > maximum.max_output_bytes
                    || limits.max_nested_calls > maximum.max_nested_calls
                {
                    error("Code Mode session limits exceed Host policy".into())?;
                    continue;
                }
                match ash_code_mode_runtime::CodeModeStore::from_values(stored_values).and_then(
                    |store| {
                        CodeModeRuntime::new_with_store(
                            session_id.clone(),
                            limits,
                            invoker.clone(),
                            store,
                        )
                    },
                ) {
                    Ok(runtime) => {
                        sessions.insert(session_id.clone(), (runtime, limits));
                        reply(HostToClient::SessionOpened { session_id })?;
                    }
                    Err(cause) => error(cause.to_string())?,
                }
            }
            ClientToHost::CloseSession { session_id } => {
                let cells = {
                    let mut allocations = allocations.lock().unwrap();
                    let cells = allocations
                        .iter()
                        .filter(|(_, value)| value.session_id == session_id)
                        .map(|(id, _)| id.clone())
                        .collect::<Vec<_>>();
                    for cell in &cells {
                        allocations.remove(cell);
                    }
                    cells
                };
                for cell in cells {
                    invoker.cancel_cell(&cell);
                }
                if let Some((runtime, _)) = sessions.remove(&session_id) {
                    runtime.close();
                }
                reply(HostToClient::SessionClosed { session_id })?;
            }
            ClientToHost::Execute(request) => {
                let Some((runtime, limits)) = sessions.get(&request.session_id) else {
                    error("Execute request references a closed Code Mode session".into())?;
                    continue;
                };
                let full = {
                    let allocations = allocations.lock().unwrap();
                    allocations.len() >= 32
                        || allocations
                            .values()
                            .filter(|entry| entry.session_id == request.session_id)
                            .count()
                            >= 8
                        || allocations
                            .values()
                            .map(|entry| entry.heap_bytes)
                            .sum::<usize>()
                            + limits.max_heap_bytes
                            > 512 * 1024 * 1024
                };
                if full {
                    error("Code Mode Host cell or heap admission limit reached".into())?;
                    continue;
                }
                let session_id = request.session_id.clone();
                match runtime.execute(request) {
                    Ok(started) => {
                        allocations.lock().unwrap().insert(
                            started.cell_id.clone(),
                            Allocation {
                                session_id,
                                heap_bytes: limits.max_heap_bytes,
                            },
                        );
                        invoker
                            .active_cells
                            .lock()
                            .unwrap()
                            .insert(started.cell_id.clone());
                        reply(HostToClient::StartedCell(started))?;
                    }
                    Err(cause) => error(cause.to_string())?,
                }
            }
            message @ (ClientToHost::Wait(_) | ClientToHost::Terminate { .. }) => {
                let cell_id = match &message {
                    ClientToHost::Wait(request) => request.cell_id.clone(),
                    ClientToHost::Terminate { cell_id } => cell_id.clone(),
                    _ => unreachable!(),
                };
                let runtime = sessions
                    .values()
                    .find(|(runtime, _)| runtime.has_cell(&cell_id))
                    .map(|(runtime, _)| runtime.clone());
                let Some(runtime) = runtime else {
                    reply(HostToClient::MissingCell { cell_id })?;
                    continue;
                };
                if waits.fetch_add(1, Ordering::AcqRel) >= 128 {
                    waits.fetch_sub(1, Ordering::AcqRel);
                    error("Code Mode Host observation limit reached".into())?;
                    continue;
                }
                let writer = Arc::clone(&stdout);
                let waits = Arc::clone(&waits);
                let allocations = Arc::clone(&allocations);
                let invoker = Arc::clone(&invoker);
                thread::spawn(move || {
                    let result = match message {
                        ClientToHost::Wait(request) => runtime.wait(request),
                        ClientToHost::Terminate { cell_id } => runtime.terminate(&cell_id),
                        _ => unreachable!(),
                    };
                    if !runtime.has_cell(&cell_id) {
                        allocations.lock().unwrap().remove(&cell_id);
                        invoker.cancel_cell(&cell_id);
                    }
                    let _ = send_wait_result(&writer, request_id, &runtime, result);
                    waits.fetch_sub(1, Ordering::AcqRel);
                });
            }
            ClientToHost::CompleteToolCall {
                cell_id,
                runtime_tool_call_id,
                result,
                error_text,
            } => {
                // Late completion after cancellation is expected and has no authority over another cell.
                invoker.complete(
                    &cell_id,
                    &runtime_tool_call_id,
                    match error_text {
                        Some(error) => Err(error),
                        None => Ok(result),
                    },
                );
            }
        }
    }

    invoker.close_pending();
    for (runtime, _) in sessions.values() {
        runtime.close();
    }
    Ok(())
}

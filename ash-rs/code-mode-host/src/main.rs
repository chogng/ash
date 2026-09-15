use ash_code_mode_protocol::{
    CODE_MODE_PROTOCOL_VERSION, CellOutcome, ClientToHost, HostToClient, NestedToolCall,
    RuntimeNotification, RuntimeResponse, write_frame,
};
use ash_code_mode_runtime::{CodeModeRuntime, ToolInvoker};
use std::collections::{BTreeMap, BTreeSet};
use std::io::{self, BufReader, BufWriter, Write};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;

type ToolResult = Result<serde_json::Value, String>;

struct StdioToolInvoker {
    writer: Arc<Mutex<BufWriter<io::Stdout>>>,
    pending: Mutex<BTreeMap<String, Sender<ToolResult>>>,
    cancelled_cells: Mutex<BTreeSet<ash_code_mode_protocol::CellId>>,
}

impl ToolInvoker for StdioToolInvoker {
    fn invoke(&self, call: NestedToolCall) -> ToolResult {
        let key = pending_key(&call.cell_id, &call.runtime_tool_call_id);
        let (sender, receiver) = mpsc::channel();
        let _cancelled_cells = self
            .cancelled_cells
            .lock()
            .map_err(|_| "Host cell cancellation registry was poisoned".to_string())?;
        if _cancelled_cells.contains(&call.cell_id) {
            return Err("Code Mode cell has been cancelled".into());
        }
        self.pending
            .lock()
            .map_err(|_| "Host tool callback registry was poisoned".to_string())?
            .insert(key, sender);
        drop(_cancelled_cells);
        self.send(HostToClient::ToolCall(call))?;
        receiver
            .recv()
            .map_err(|_| "Host tool callback was closed before a result arrived".to_string())?
    }

    fn notify(&self, notification: RuntimeNotification) -> Result<(), String> {
        self.send(HostToClient::Notification(notification))
    }

    fn cancel_cell(&self, cell_id: &ash_code_mode_protocol::CellId) {
        let Ok(mut cancelled_cells) = self.cancelled_cells.lock() else {
            return;
        };
        cancelled_cells.insert(cell_id.clone());
        self.close_cell_pending(cell_id);
    }
}

impl StdioToolInvoker {
    fn send(&self, message: HostToClient) -> Result<(), String> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| "Host output writer was poisoned".to_string())?;
        write_frame(&mut *writer, &message).map_err(|error| error.to_string())
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

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _package_lease =
        ash_package_store::acquire_package_lease_for_executable(std::env::current_exe()?)?;
    let stdout = Arc::new(Mutex::new(BufWriter::new(io::stdout())));
    let invoker = Arc::new(StdioToolInvoker {
        writer: Arc::clone(&stdout),
        pending: Mutex::new(BTreeMap::new()),
        cancelled_cells: Mutex::new(BTreeSet::new()),
    });
    let stdin = io::stdin();
    let mut reader = BufReader::new(stdin.lock());
    let mut sessions: BTreeMap<ash_code_mode_protocol::CodeModeSessionId, CodeModeRuntime> =
        BTreeMap::new();
    let mut session_cells: BTreeMap<
        ash_code_mode_protocol::CodeModeSessionId,
        BTreeSet<ash_code_mode_protocol::CellId>,
    > = BTreeMap::new();
    let mut handshake_complete = false;

    loop {
        let message = match ash_code_mode_protocol::read_frame::<_, ClientToHost>(&mut reader) {
            Ok(message) => message,
            Err(ash_code_mode_protocol::ProtocolError::UnexpectedEof) => break,
            Err(error) => {
                send(
                    &stdout,
                    HostToClient::Error {
                        message: error.to_string(),
                    },
                )?;
                break;
            }
        };
        match message {
            ClientToHost::Hello { protocol_version } => {
                if protocol_version != CODE_MODE_PROTOCOL_VERSION {
                    send(
                        &stdout,
                        HostToClient::Error {
                            message: format!(
                                "unsupported Code Mode protocol version {}",
                                protocol_version
                            ),
                        },
                    )?;
                    break;
                }
                handshake_complete = true;
                send(
                    &stdout,
                    HostToClient::Hello {
                        protocol_version: CODE_MODE_PROTOCOL_VERSION,
                        max_frame_bytes: ash_code_mode_protocol::MAX_FRAME_BYTES,
                    },
                )?;
            }
            message if !handshake_complete => {
                let _ = message;
                send(
                    &stdout,
                    HostToClient::Error {
                        message: "Code Mode Host requires Hello before other messages".into(),
                    },
                )?;
                break;
            }
            ClientToHost::OpenSession {
                session_id,
                limits,
                stored_values,
            } => {
                if sessions.contains_key(&session_id) {
                    send(
                        &stdout,
                        HostToClient::Error {
                            message: format!("Code Mode session already exists: {}", session_id),
                        },
                    )?;
                    continue;
                }
                match CodeModeRuntime::new_with_store(
                    session_id.clone(),
                    limits,
                    invoker.clone(),
                    ash_code_mode_runtime::CodeModeStore::from_values(stored_values),
                ) {
                    Ok(runtime) => {
                        sessions.insert(session_id.clone(), runtime);
                        session_cells.insert(session_id.clone(), BTreeSet::new());
                        send(&stdout, HostToClient::SessionOpened { session_id })?;
                    }
                    Err(error) => send(
                        &stdout,
                        HostToClient::Error {
                            message: error.to_string(),
                        },
                    )?,
                }
            }
            ClientToHost::CloseSession { session_id } => {
                if let Some(cells) = session_cells.remove(&session_id) {
                    for cell_id in cells {
                        invoker.close_cell_pending(&cell_id);
                    }
                }
                if let Some(runtime) = sessions.remove(&session_id) {
                    runtime.close();
                }
            }
            ClientToHost::Execute(request) => {
                let Some(runtime) = sessions.get(&request.session_id) else {
                    send(
                        &stdout,
                        HostToClient::Error {
                            message: "Execute request references a closed Code Mode session".into(),
                        },
                    )?;
                    continue;
                };
                let session_id = request.session_id.clone();
                match runtime.execute(request) {
                    Ok(started) => {
                        session_cells
                            .entry(session_id)
                            .or_default()
                            .insert(started.cell_id.clone());
                        send(&stdout, HostToClient::StartedCell(started))?
                    }
                    Err(error) => send(
                        &stdout,
                        HostToClient::Error {
                            message: error.to_string(),
                        },
                    )?,
                }
            }
            ClientToHost::Wait(request) => {
                let runtime = sessions
                    .values()
                    .find(|runtime| runtime.has_cell(&request.cell_id))
                    .cloned();
                let Some(runtime) = runtime else {
                    send(
                        &stdout,
                        HostToClient::Error {
                            message: "Code Mode cell not found".into(),
                        },
                    )?;
                    continue;
                };
                let writer = Arc::clone(&stdout);
                thread::spawn(move || {
                    let result = runtime.wait(request);
                    send_wait_result(&writer, &runtime, result);
                });
            }
            ClientToHost::Terminate { cell_id } => {
                let result = sessions
                    .iter()
                    .find(|(_, runtime)| runtime.has_cell(&cell_id))
                    .map(|(session_id, runtime)| (session_id.clone(), runtime.clone()));
                let Some((_, runtime)) = result else {
                    send(
                        &stdout,
                        HostToClient::Error {
                            message: format!("Code Mode cell not found: {}", cell_id),
                        },
                    )?;
                    continue;
                };
                invoker.close_cell_pending(&cell_id);
                let writer = Arc::clone(&stdout);
                thread::spawn(move || {
                    let result = runtime.terminate(&cell_id);
                    send_wait_result(&writer, &runtime, result);
                });
            }
            ClientToHost::CompleteToolCall {
                cell_id,
                runtime_tool_call_id,
                result,
                error_text,
            } => {
                let completed = invoker.complete(
                    &cell_id,
                    &runtime_tool_call_id,
                    match error_text {
                        Some(error) => Err(error),
                        None => Ok(result),
                    },
                );
                if !completed {
                    send(
                        &stdout,
                        HostToClient::Error {
                            message: "unknown Code Mode tool callback".into(),
                        },
                    )?;
                }
            }
        }
    }

    invoker.close_pending();
    for runtime in sessions.values() {
        runtime.close();
    }
    Ok(())
}

fn send(
    writer: &Arc<Mutex<BufWriter<io::Stdout>>>,
    message: HostToClient,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut writer = writer
        .lock()
        .map_err(|_| io::Error::other("Host output writer was poisoned"))?;
    write_frame(&mut *writer, &message)?;
    writer.flush()?;
    Ok(())
}

fn terminal_outcome(response: &RuntimeResponse) -> Option<CellOutcome> {
    match response {
        RuntimeResponse::Result { error_text, .. } => Some(if error_text.is_some() {
            CellOutcome::Failed
        } else {
            CellOutcome::Completed
        }),
        RuntimeResponse::Terminated { .. } => Some(CellOutcome::Terminated),
        RuntimeResponse::Unknown { .. } => Some(CellOutcome::Unknown),
        RuntimeResponse::Running { .. } | RuntimeResponse::Yielded { .. } => None,
    }
}

fn response_cell_id(response: &RuntimeResponse) -> ash_code_mode_protocol::CellId {
    match response {
        RuntimeResponse::Running { cell_id, .. }
        | RuntimeResponse::Yielded { cell_id, .. }
        | RuntimeResponse::Terminated { cell_id, .. }
        | RuntimeResponse::Result { cell_id, .. }
        | RuntimeResponse::Unknown { cell_id, .. } => cell_id.clone(),
    }
}

fn send_wait_result(
    writer: &Arc<Mutex<BufWriter<io::Stdout>>>,
    runtime: &CodeModeRuntime,
    result: Result<ash_code_mode_protocol::WaitOutcome, ash_code_mode_runtime::RuntimeError>,
) {
    let message = match result {
        Ok(ash_code_mode_protocol::WaitOutcome::LiveCell { response }) => {
            let session_values =
                runtime
                    .store_snapshot()
                    .ok()
                    .map(|values| HostToClient::StoreSnapshot {
                        session_id: runtime.session_id().clone(),
                        values,
                    });
            let terminal = terminal_outcome(&response).map(|outcome| HostToClient::CellClosed {
                cell_id: response_cell_id(&response),
                outcome,
            });
            if let Some(message) = session_values
                && send(writer, message).is_err()
            {
                return;
            }
            if send(writer, HostToClient::Response { response }).is_err() {
                return;
            }
            if let Some(message) = terminal {
                let _ = send(writer, message);
            }
            return;
        }
        Ok(ash_code_mode_protocol::WaitOutcome::MissingCell { cell_id }) => HostToClient::Error {
            message: format!("Code Mode cell not found: {}", cell_id),
        },
        Err(error) => HostToClient::Error {
            message: error.to_string(),
        },
    };
    let _ = send(writer, message);
}

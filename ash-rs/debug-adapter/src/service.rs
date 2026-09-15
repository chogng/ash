use std::collections::HashMap;
use std::collections::VecDeque;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use ash_file_access::Authorization;
use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;
use tokio::process::Child;
use tokio::process::ChildStdin;
use tokio::runtime::Runtime;
use tokio::sync::Mutex as AsyncMutex;

use crate::framing::MAX_MESSAGE_BYTES;
use crate::framing::encode_message;
use crate::framing::read_message;

const MAX_ACTIVE_SESSIONS: usize = 8;
const MAX_ARGUMENTS: usize = 128;
const MAX_ARGUMENT_BYTES: usize = 32 * 1024;
const MAX_BUFFERED_MESSAGES: usize = 512;
const MAX_BUFFERED_STDERR_BYTES: usize = 256 * 1024;

/// Validated command used to start one directory-bound debug adapter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DebugAdapterCommand {
    program: String,
    arguments: Vec<String>,
}

impl DebugAdapterCommand {
    pub fn new(
        program: impl Into<String>,
        arguments: Vec<String>,
    ) -> Result<Self, DebugAdapterError> {
        let program = program.into();
        let argument_bytes = arguments.iter().map(String::len).sum::<usize>();
        if program.trim().is_empty()
            || program.contains('\0')
            || program.len() > 4096
            || arguments.len() > MAX_ARGUMENTS
            || argument_bytes > MAX_ARGUMENT_BYTES
            || arguments.iter().any(|argument| argument.contains('\0'))
        {
            return Err(DebugAdapterError::InvalidCommand);
        }
        Ok(Self { program, arguments })
    }
}

/// Opaque identity for one running debug adapter process.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct DebugAdapterSessionId(String);

impl DebugAdapterSessionId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// One ordered DAP message read from an adapter.
#[derive(Clone, Debug, PartialEq)]
pub struct DebugAdapterMessage {
    pub sequence: u64,
    pub message: Value,
}

/// Bounded incremental adapter output.
#[derive(Clone, Debug, PartialEq)]
pub struct DebugAdapterRead {
    pub messages: Vec<DebugAdapterMessage>,
    pub next_sequence: u64,
    pub output_gap: bool,
    pub stderr: String,
    pub exited: bool,
    pub exit_code: Option<i32>,
    pub protocol_error: Option<String>,
}

#[derive(Debug, thiserror::Error)]
pub enum DebugAdapterError {
    #[error("debug adapter command is invalid")]
    InvalidCommand,
    #[error("debug adapter message is invalid")]
    InvalidMessage,
    #[error("debug adapter frame is invalid: {0}")]
    InvalidFrame(String),
    #[error("debug adapter session was not found")]
    NotFound,
    #[error("debug adapter service is busy")]
    Busy,
    #[error("debug adapter operation failed")]
    OperationFailed,
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
}

/// Owns bounded DAP stdio processes under explicit config and execution authorizations.
pub struct DebugAdapterService {
    executable_configuration: Authorization,
    process_execution: Authorization,
    environment: HashMap<String, String>,
    runtime: Runtime,
    sessions: Mutex<HashMap<DebugAdapterSessionId, DebugAdapterSession>>,
    next_session_id: AtomicU64,
}

impl DebugAdapterService {
    pub fn new(
        executable_configuration: Authorization,
        process_execution: Authorization,
        environment: HashMap<String, String>,
    ) -> Result<Self, DebugAdapterError> {
        if executable_configuration.permission() != ash_file_access::Permission::LoadConfig
            || process_execution.permission() != ash_file_access::Permission::ExecuteCommands
            || executable_configuration.dir() != process_execution.dir()
        {
            return Err(DebugAdapterError::OperationFailed);
        }
        executable_configuration
            .ensure_active()
            .map_err(|_| DebugAdapterError::OperationFailed)?;
        process_execution
            .ensure_active()
            .map_err(|_| DebugAdapterError::OperationFailed)?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("ash-debug-adapter")
            .build()
            .map_err(|_| DebugAdapterError::OperationFailed)?;
        Ok(Self {
            executable_configuration,
            process_execution,
            environment,
            runtime,
            sessions: Mutex::new(HashMap::new()),
            next_session_id: AtomicU64::new(1),
        })
    }

    pub fn start(
        &self,
        command: DebugAdapterCommand,
    ) -> Result<DebugAdapterSessionId, DebugAdapterError> {
        self.ensure_active()?;
        let mut sessions = self.sessions.lock().map_err(|_| DebugAdapterError::Busy)?;
        if sessions.len() >= MAX_ACTIVE_SESSIONS {
            return Err(DebugAdapterError::Busy);
        }
        let root = self.process_execution.dir().canonical_path();
        let _runtime_guard = self.runtime.enter();
        let mut process = tokio::process::Command::new(&command.program);
        process
            .args(&command.arguments)
            .current_dir(root)
            .env_clear()
            .envs(&self.environment)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);
        let mut child = {
            let _runtime = self.runtime.enter();
            process
                .spawn()
                .map_err(|_| DebugAdapterError::OperationFailed)?
        };
        let stdin = child
            .stdin
            .take()
            .ok_or(DebugAdapterError::OperationFailed)?;
        let stdout = child
            .stdout
            .take()
            .ok_or(DebugAdapterError::OperationFailed)?;
        let stderr = child
            .stderr
            .take()
            .ok_or(DebugAdapterError::OperationFailed)?;
        let state = Arc::new(Mutex::new(DebugAdapterState::default()));
        spawn_stdout_reader(&self.runtime, stdout, Arc::clone(&state));
        spawn_stderr_reader(&self.runtime, stderr, Arc::clone(&state));
        let id = DebugAdapterSessionId(format!(
            "debug-adapter-{:x}",
            self.next_session_id.fetch_add(1, Ordering::Relaxed)
        ));
        sessions.insert(
            id.clone(),
            DebugAdapterSession {
                process: Arc::new(AsyncMutex::new(Some(child))),
                stdin: Arc::new(AsyncMutex::new(stdin)),
                state,
            },
        );
        Ok(id)
    }

    pub fn send(
        &self,
        session_id: &DebugAdapterSessionId,
        message: &Value,
    ) -> Result<(), DebugAdapterError> {
        self.ensure_active()?;
        let framed = encode_message(message)?;
        let stdin = self.session(session_id)?.stdin;
        self.runtime.block_on(async move {
            let mut stdin = stdin.lock().await;
            stdin.write_all(&framed).await?;
            stdin.flush().await
        })?;
        Ok(())
    }

    pub fn read(
        &self,
        session_id: &DebugAdapterSessionId,
        after_sequence: u64,
        max_messages: usize,
    ) -> Result<DebugAdapterRead, DebugAdapterError> {
        self.ensure_active()?;
        if max_messages == 0 || max_messages > 128 {
            return Err(DebugAdapterError::InvalidMessage);
        }
        let session = self.session(session_id)?;
        refresh_process_state(&self.runtime, &session)?;
        let mut state = session.state.lock().map_err(|_| DebugAdapterError::Busy)?;
        read_buffered_state(&mut state, after_sequence, max_messages)
    }

    pub fn close(&self, session_id: &DebugAdapterSessionId) -> Result<(), DebugAdapterError> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| DebugAdapterError::Busy)?
            .remove(session_id)
            .ok_or(DebugAdapterError::NotFound)?;
        terminate(&self.runtime, session);
        Ok(())
    }

    pub fn terminate_all(&self) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        for (_, session) in sessions.drain() {
            terminate(&self.runtime, session);
        }
    }

    fn session(
        &self,
        session_id: &DebugAdapterSessionId,
    ) -> Result<DebugAdapterSession, DebugAdapterError> {
        self.sessions
            .lock()
            .map_err(|_| DebugAdapterError::Busy)?
            .get(session_id)
            .cloned()
            .ok_or(DebugAdapterError::NotFound)
    }

    fn ensure_active(&self) -> Result<(), DebugAdapterError> {
        self.executable_configuration
            .ensure_active()
            .map_err(|_| DebugAdapterError::OperationFailed)?;
        self.process_execution
            .ensure_active()
            .map_err(|_| DebugAdapterError::OperationFailed)
    }
}

fn read_buffered_state(
    state: &mut DebugAdapterState,
    after_sequence: u64,
    max_messages: usize,
) -> Result<DebugAdapterRead, DebugAdapterError> {
    if after_sequence > state.next_sequence {
        return Err(DebugAdapterError::InvalidMessage);
    }
    let first_sequence = state
        .messages
        .front()
        .map(|message| message.sequence)
        .unwrap_or(state.next_sequence);
    let output_gap = after_sequence < first_sequence;
    let effective_sequence = after_sequence.max(first_sequence);
    let messages: Vec<DebugAdapterMessage> = state
        .messages
        .iter()
        .filter(|message| message.sequence >= effective_sequence)
        .take(max_messages)
        .cloned()
        .collect();
    let next_sequence = messages.last().map_or(effective_sequence, |message| {
        message.sequence.saturating_add(1)
    });
    let stderr = std::mem::take(&mut state.stderr);
    Ok(DebugAdapterRead {
        messages,
        next_sequence,
        output_gap,
        stderr,
        exited: state.exited,
        exit_code: state.exit_code,
        protocol_error: state.protocol_error.clone(),
    })
}

impl Drop for DebugAdapterService {
    fn drop(&mut self) {
        self.terminate_all();
    }
}

#[derive(Clone)]
struct DebugAdapterSession {
    process: Arc<AsyncMutex<Option<Child>>>,
    stdin: Arc<AsyncMutex<ChildStdin>>,
    state: Arc<Mutex<DebugAdapterState>>,
}

#[derive(Default)]
struct DebugAdapterState {
    messages: VecDeque<DebugAdapterMessage>,
    next_sequence: u64,
    buffered_message_bytes: usize,
    stderr: String,
    exited: bool,
    exit_code: Option<i32>,
    protocol_error: Option<String>,
}

fn spawn_stdout_reader(
    runtime: &Runtime,
    stdout: tokio::process::ChildStdout,
    state: Arc<Mutex<DebugAdapterState>>,
) {
    runtime.spawn(async move {
        let mut reader = BufReader::new(stdout);
        loop {
            match read_message(&mut reader).await {
                Ok(Some(message)) => push_message(&state, message),
                Ok(None) => break,
                Err(error) => {
                    if let Ok(mut state) = state.lock() {
                        state.protocol_error = Some(error.to_string());
                    }
                    break;
                }
            }
        }
    });
}

fn spawn_stderr_reader(
    runtime: &Runtime,
    mut stderr: tokio::process::ChildStderr,
    state: Arc<Mutex<DebugAdapterState>>,
) {
    runtime.spawn(async move {
        let mut buffer = vec![0; 8192];
        while let Ok(read) = stderr.read(&mut buffer).await {
            if read == 0 {
                break;
            }
            let text = String::from_utf8_lossy(&buffer[..read]);
            if let Ok(mut state) = state.lock() {
                let remaining = MAX_BUFFERED_STDERR_BYTES.saturating_sub(state.stderr.len());
                state
                    .stderr
                    .push_str(&text[..floor_char_boundary(&text, remaining)]);
            }
        }
    });
}

fn floor_char_boundary(value: &str, maximum_bytes: usize) -> usize {
    let mut end = value.len().min(maximum_bytes);
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    end
}

fn push_message(state: &Arc<Mutex<DebugAdapterState>>, message: Value) {
    let Ok(mut state) = state.lock() else {
        return;
    };
    let size = serde_json::to_vec(&message).map_or(MAX_MESSAGE_BYTES, |bytes| bytes.len());
    let sequence = state.next_sequence;
    state.next_sequence = state.next_sequence.saturating_add(1);
    state.buffered_message_bytes = state.buffered_message_bytes.saturating_add(size);
    state
        .messages
        .push_back(DebugAdapterMessage { sequence, message });
    while state.messages.len() > MAX_BUFFERED_MESSAGES
        || state.buffered_message_bytes > MAX_MESSAGE_BYTES
    {
        let Some(removed) = state.messages.pop_front() else {
            break;
        };
        state.buffered_message_bytes = state
            .buffered_message_bytes
            .saturating_sub(serde_json::to_vec(&removed.message).map_or(0, |bytes| bytes.len()));
    }
}

fn refresh_process_state(
    runtime: &Runtime,
    session: &DebugAdapterSession,
) -> Result<(), DebugAdapterError> {
    let process = Arc::clone(&session.process);
    let status = runtime.block_on(async move {
        let mut process = process.lock().await;
        match process.as_mut() {
            Some(child) => child.try_wait(),
            None => Ok(None),
        }
    })?;
    if let Some(status) = status {
        let mut state = session.state.lock().map_err(|_| DebugAdapterError::Busy)?;
        state.exited = true;
        state.exit_code = status.code();
    }
    Ok(())
}

fn terminate(runtime: &Runtime, session: DebugAdapterSession) {
    let process = session.process;
    runtime.block_on(async move {
        let mut process = process.lock().await;
        if let Some(child) = process.as_mut() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        *process = None;
    });
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;

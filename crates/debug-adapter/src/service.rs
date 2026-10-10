use std::collections::HashMap;
use std::collections::VecDeque;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use ash_file_access::Authorization;
use serde_json::Value;
use std::time::Duration;
use tokio::io::AsyncRead;
use tokio::io::AsyncReadExt;
use tokio::io::AsyncWrite;
use tokio::io::AsyncWriteExt;
use tokio::io::BufReader;
use tokio::process::Child;
use tokio::runtime::Runtime;
use tokio::sync::Mutex as AsyncMutex;
use tokio::task::JoinHandle;

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
    cwd: Option<PathBuf>,
    environment: HashMap<String, Option<String>>,
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
        Ok(Self {
            program,
            arguments,
            cwd: None,
            environment: HashMap::new(),
        })
    }

    /// Environment changes apply only to this child; cwd remains inside its authorized directory.
    pub fn with_options(
        mut self,
        cwd: Option<PathBuf>,
        environment: HashMap<String, Option<String>>,
    ) -> Result<Self, DebugAdapterError> {
        if cwd
            .as_ref()
            .is_some_and(|value| value.as_os_str().len() > 32768)
            || environment.len() > 128
            || environment.iter().any(|(key, value)| {
                key.is_empty()
                    || key.len() > 256
                    || key.contains(['=', '\0'])
                    || value
                        .as_ref()
                        .is_some_and(|value| value.len() > 32768 || value.contains('\0'))
            })
        {
            return Err(DebugAdapterError::InvalidCommand);
        }
        self.cwd = cwd;
        self.environment = environment;
        Ok(self)
    }
}

/// Endpoint of a DAP peer; connection IO shares the executable session owner.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DebugAdapterConnection {
    Server { port: u16, host: Option<String> },
    NamedPipe { path: PathBuf },
}

impl DebugAdapterConnection {
    fn validate(&self) -> Result<(), DebugAdapterError> {
        let valid = match self {
            Self::Server { port, host } => {
                *port != 0
                    && host.as_ref().is_none_or(|host| {
                        !host.trim().is_empty() && host.len() <= 256 && !host.contains('\0')
                    })
            }
            Self::NamedPipe { path } => {
                !path.as_os_str().is_empty()
                    && path.as_os_str().len() <= 32768
                    && path.to_str().is_some_and(|path| !path.contains('\0'))
            }
        };
        if valid {
            Ok(())
        } else {
            Err(DebugAdapterError::InvalidCommand)
        }
    }
}

type AdapterWriter = Box<dyn AsyncWrite + Unpin + Send>;

/// Opaque identity for one running debug adapter transport.
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

/// Owns bounded DAP processes and connections under config and execution authorizations.
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
            environment: environment
                .into_iter()
                .map(|(key, value)| {
                    (
                        if cfg!(windows) {
                            key.to_ascii_uppercase()
                        } else {
                            key
                        },
                        value,
                    )
                })
                .collect(),
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
        let cwd = match command.cwd {
            Some(path) => {
                let path = root
                    .join(path)
                    .canonicalize()
                    .map_err(|_| DebugAdapterError::InvalidCommand)?;
                if !path.is_dir() || !path.starts_with(root) {
                    return Err(DebugAdapterError::InvalidCommand);
                }
                path
            }
            None => root.to_path_buf(),
        };
        let mut environment = self.environment.clone();
        for (key, value) in command.environment {
            let key = if cfg!(windows) {
                key.to_ascii_uppercase()
            } else {
                key
            };
            match value {
                Some(value) => {
                    environment.insert(key, value);
                }
                None => {
                    environment.remove(&key);
                }
            }
        }
        let _runtime_guard = self.runtime.enter();
        let mut process = tokio::process::Command::new(&command.program);
        process
            .args(&command.arguments)
            .current_dir(cwd)
            .env_clear()
            .envs(&environment)
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
        let readers = vec![
            spawn_message_reader(
                &self.runtime,
                stdout,
                Arc::clone(&state),
                ReaderLifetime::Process,
            ),
            spawn_stderr_reader(&self.runtime, stderr, Arc::clone(&state)),
        ];
        let id = DebugAdapterSessionId(format!(
            "debug-adapter-{:x}",
            self.next_session_id.fetch_add(1, Ordering::Relaxed)
        ));
        sessions.insert(
            id.clone(),
            DebugAdapterSession {
                process: Arc::new(AsyncMutex::new(Some(child))),
                stdin: Arc::new(AsyncMutex::new(Some(Box::new(stdin)))),
                readers: Arc::new(AsyncMutex::new(readers)),
                state,
            },
        );
        Ok(id)
    }

    /// Connect before allocating an identity; failed and excess connections drop their IO.
    pub fn connect(
        &self,
        connection: DebugAdapterConnection,
    ) -> Result<DebugAdapterSessionId, DebugAdapterError> {
        connection.validate()?;
        self.ensure_active()?;
        if self
            .sessions
            .lock()
            .map_err(|_| DebugAdapterError::Busy)?
            .len()
            >= MAX_ACTIVE_SESSIONS
        {
            return Err(DebugAdapterError::Busy);
        }
        let (reader, writer): (Box<dyn AsyncRead + Unpin + Send>, AdapterWriter) =
            self.runtime.block_on(async {
                tokio::time::timeout(Duration::from_secs(10), async {
                    match connection {
                        DebugAdapterConnection::Server { port, host } => {
                            let stream = tokio::net::TcpStream::connect((
                                host.as_deref().unwrap_or("127.0.0.1"),
                                port,
                            ))
                            .await?;
                            stream.set_nodelay(true)?;
                            let (reader, writer) = stream.into_split();
                            Ok((
                                Box::new(reader) as Box<dyn AsyncRead + Unpin + Send>,
                                Box::new(writer) as AdapterWriter,
                            ))
                        }
                        DebugAdapterConnection::NamedPipe { path } => {
                            connect_named_pipe(path).await
                        }
                    }
                })
                .await
                .map_err(|_| DebugAdapterError::OperationFailed)?
            })?;
        self.ensure_active()?;
        let mut sessions = self.sessions.lock().map_err(|_| DebugAdapterError::Busy)?;
        if sessions.len() >= MAX_ACTIVE_SESSIONS {
            return Err(DebugAdapterError::Busy);
        }
        let state = Arc::new(Mutex::new(DebugAdapterState::default()));
        let reader = spawn_message_reader(
            &self.runtime,
            reader,
            Arc::clone(&state),
            ReaderLifetime::Connection,
        );
        let id = DebugAdapterSessionId(format!(
            "debug-adapter-{:x}",
            self.next_session_id.fetch_add(1, Ordering::Relaxed)
        ));
        sessions.insert(
            id.clone(),
            DebugAdapterSession {
                process: Arc::new(AsyncMutex::new(None)),
                stdin: Arc::new(AsyncMutex::new(Some(writer))),
                readers: Arc::new(AsyncMutex::new(vec![reader])),
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
            let stdin = stdin.as_mut().ok_or(DebugAdapterError::NotFound)?;
            tokio::time::timeout(Duration::from_secs(10), async {
                stdin.write_all(&framed).await?;
                stdin.flush().await
            })
            .await
            .map_err(|_| DebugAdapterError::OperationFailed)?
            .map_err(DebugAdapterError::Io)
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
    stdin: Arc<AsyncMutex<Option<AdapterWriter>>>,
    readers: Arc<AsyncMutex<Vec<JoinHandle<()>>>>,
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

enum ReaderLifetime {
    Process,
    Connection,
}

fn spawn_message_reader(
    runtime: &Runtime,
    stdout: impl AsyncRead + Unpin + Send + 'static,
    state: Arc<Mutex<DebugAdapterState>>,
    lifetime: ReaderLifetime,
) -> JoinHandle<()> {
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
        // Process exit is observed from the child status; a connection has no exit code.
        if let ReaderLifetime::Connection = lifetime {
            if let Ok(mut state) = state.lock() {
                state.exited = true;
            }
        }
    })
}

fn spawn_stderr_reader(
    runtime: &Runtime,
    mut stderr: tokio::process::ChildStderr,
    state: Arc<Mutex<DebugAdapterState>>,
) -> JoinHandle<()> {
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
    })
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
    runtime.block_on(async move {
        let mut process = session.process.lock().await;
        if let Some(child) = process.as_mut() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        *process = None;
        // Reader halves keep sockets alive even after writer shutdown. Await their cancellation
        // before acknowledging close, including peers which never send another byte.
        for reader in session.readers.lock().await.drain(..) {
            reader.abort();
            let _ = reader.await;
        }
        if let Some(mut writer) = session.stdin.lock().await.take() {
            let _ = tokio::time::timeout(Duration::from_secs(1), writer.shutdown()).await;
        }
    });
}

async fn connect_named_pipe(
    path: PathBuf,
) -> Result<(Box<dyn AsyncRead + Unpin + Send>, AdapterWriter), DebugAdapterError> {
    #[cfg(unix)]
    {
        let stream = tokio::net::UnixStream::connect(path).await?;
        let (reader, writer) = stream.into_split();
        Ok((Box::new(reader), Box::new(writer)))
    }
    #[cfg(windows)]
    {
        let client = loop {
            match tokio::net::windows::named_pipe::ClientOptions::new().open(&path) {
                Ok(client) => break client,
                Err(error) if error.raw_os_error() == Some(231) => {
                    tokio::time::sleep(Duration::from_millis(10)).await
                }
                Err(error) => return Err(error.into()),
            }
        };
        let (reader, writer) = tokio::io::split(client);
        Ok((Box::new(reader), Box::new(writer)))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Err(DebugAdapterError::OperationFailed)
    }
}

#[cfg(test)]
#[path = "service_tests.rs"]
mod tests;

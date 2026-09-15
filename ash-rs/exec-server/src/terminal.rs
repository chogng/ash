//! Authorized interactive PTY sessions, bounded output, and reconnect leases.

mod command_status;
mod environment;
mod profiles;

use crate::terminal::command_status::ParsedTerminalOutput;
use crate::terminal::command_status::TerminalCommandStatusTracker;
use crate::terminal::profiles::TerminalProfileCatalog;
use ash_file_access::Authorization;
use ash_file_access::Permission;
use ash_utils_pty::ProcessHandle;
use ash_utils_pty::SpawnedProcess;
use ash_utils_pty::TerminalSize;
use ash_utils_pty::spawn_pty_process;
pub use environment::safe_process_environment;
pub use exec_server_protocol::terminal::TerminalAttachRequest;
pub use exec_server_protocol::terminal::TerminalAttachResult;
pub use exec_server_protocol::terminal::TerminalCommandStatus;
pub use exec_server_protocol::terminal::TerminalCommandStatusEvent;
pub use exec_server_protocol::terminal::TerminalCreateRequest;
pub use exec_server_protocol::terminal::TerminalCreateResult;
pub use exec_server_protocol::terminal::TerminalLifecycle;
pub use exec_server_protocol::terminal::TerminalOutputChunk;
pub use exec_server_protocol::terminal::TerminalProfile;
pub use exec_server_protocol::terminal::TerminalProfileSelection;
pub use exec_server_protocol::terminal::TerminalReadRequest;
pub use exec_server_protocol::terminal::TerminalReadResult;
pub use exec_server_protocol::terminal::TerminalReconnectLease;
pub use exec_server_protocol::terminal::TerminalResizeRequest;
pub use exec_server_protocol::terminal::TerminalWriteRequest;
use getrandom::getrandom;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::RwLock;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;
use std::time::Instant;
use tokio::runtime::Runtime;

const MAX_ACTIVE_TERMINALS: usize = 16;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_INPUT_BYTES: usize = 64 * 1024;
const RECONNECT_GRACE_PERIOD: Duration = Duration::from_secs(30);
const RECONNECT_GRACE_PERIOD_MILLIS: u64 = 30_000;
const RECONNECT_SWEEP_INTERVAL: Duration = Duration::from_secs(1);
const RECONNECT_TOKEN_BYTES: usize = 32;

/// Owns connection-scoped and briefly reconnectable PTY processes under one
/// `ExecuteCommands` authorization.
pub struct TerminalService {
    authorization: RwLock<Authorization>,
    next_terminal_id: AtomicU64,
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
    runtime: Runtime,
    profiles: TerminalProfileCatalog,
}

impl TerminalService {
    pub fn new(authorization: Authorization) -> Result<Self, TerminalError> {
        validate_authorization(&authorization)?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .thread_name("ash-terminal")
            .build()
            .map_err(|_| TerminalError::OperationFailed)?;
        let sessions = Arc::new(Mutex::new(HashMap::new()));
        spawn_reconnect_sweeper(&runtime, Arc::clone(&sessions));
        Ok(Self {
            authorization: RwLock::new(authorization),
            next_terminal_id: AtomicU64::new(1),
            sessions,
            runtime,
            profiles: TerminalProfileCatalog::discover(),
        })
    }

    pub fn set_dir(&self, authorization: Authorization) -> Result<(), TerminalError> {
        validate_authorization(&authorization)?;
        *self
            .authorization
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = authorization;
        Ok(())
    }

    pub fn profiles(&self) -> Vec<TerminalProfile> {
        self.profiles.list()
    }

    pub fn default_shell_command(&self, command: &str) -> (String, Vec<String>) {
        self.profiles.default_command(command)
    }

    pub fn create(
        &self,
        owner_connection_id: u64,
        params: TerminalCreateRequest,
    ) -> Result<TerminalCreateResult, TerminalError> {
        self.ensure_active()?;
        let authorization = self
            .authorization
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        self.create_in_dir(owner_connection_id, params, authorization)
    }

    pub fn create_in_dir(
        &self,
        owner_connection_id: u64,
        params: TerminalCreateRequest,
        authorization: Authorization,
    ) -> Result<TerminalCreateResult, TerminalError> {
        validate_authorization(&authorization)?;
        validate_size(params.rows, params.cols)?;
        let reconnect = match params.lifecycle {
            TerminalLifecycle::ConnectionOwned => None,
            TerminalLifecycle::Reconnectable => Some(new_reconnect_lease()?),
        };
        let profile = self
            .profiles
            .resolve(&params.profile)
            .ok_or(TerminalError::InvalidInput)?;
        let mut sessions = self.sessions.lock().map_err(|_| TerminalError::Busy)?;
        if sessions.len() >= MAX_ACTIVE_TERMINALS {
            return Err(TerminalError::Busy);
        }
        let dir_root = authorization.dir().canonical_path().to_path_buf();
        let spawned = self
            .runtime
            .block_on(spawn_pty_process(
                &profile.program,
                &profile.launch_args(),
                &dir_root,
                self.profiles.environment(),
                &None,
                TerminalSize {
                    rows: params.rows,
                    cols: params.cols,
                },
                &[],
            ))
            .map_err(|_| TerminalError::OperationFailed)?;
        let terminal_id = format!(
            "terminal-{:x}",
            self.next_terminal_id.fetch_add(1, Ordering::Relaxed)
        );
        let state = Arc::new(Mutex::new(TerminalState::new(
            profile.command_status_enabled(),
        )));
        let process = spawn_output_drainers(&self.runtime, spawned, state.clone());
        sessions.insert(
            terminal_id.clone(),
            TerminalSession {
                owner: TerminalOwner::Attached(owner_connection_id),
                reconnect_token: reconnect
                    .as_ref()
                    .map(|lease| lease.reconnect_token.clone()),
                process,
                state,
                authorization,
            },
        );
        Ok(TerminalCreateResult {
            terminal_id,
            profile: profile.profile(),
            reconnect,
        })
    }

    pub fn attach(
        &self,
        owner_connection_id: u64,
        params: TerminalAttachRequest,
    ) -> Result<TerminalAttachResult, TerminalError> {
        self.ensure_active()?;
        validate_size(params.rows, params.cols)?;
        let reconnect = new_reconnect_lease()?;
        let mut sessions = self.sessions.lock().map_err(|_| TerminalError::Busy)?;
        remove_expired_sessions(&mut sessions, Instant::now());
        let session = sessions
            .get_mut(&params.terminal_id)
            .ok_or(TerminalError::AttachRejected)?;
        let TerminalOwner::Detached { expires_at } = session.owner else {
            return Err(TerminalError::AttachRejected);
        };
        if expires_at <= Instant::now()
            || !session
                .reconnect_token
                .as_deref()
                .is_some_and(|expected| constant_time_eq(expected, &params.reconnect_token))
        {
            return Err(TerminalError::AttachRejected);
        }
        session
            .process
            .resize(TerminalSize {
                rows: params.rows,
                cols: params.cols,
            })
            .map_err(|_| TerminalError::OperationFailed)?;
        session.owner = TerminalOwner::Attached(owner_connection_id);
        session.reconnect_token = Some(reconnect.reconnect_token.clone());
        Ok(TerminalAttachResult {
            terminal_id: params.terminal_id,
            reconnect,
        })
    }

    pub fn write(
        &self,
        owner_connection_id: u64,
        params: TerminalWriteRequest,
    ) -> Result<(), TerminalError> {
        self.ensure_active()?;
        if params.data.is_empty() || params.data.len() > MAX_INPUT_BYTES {
            return Err(TerminalError::InvalidInput);
        }
        let sessions = self.owned_sessions(owner_connection_id, &params.terminal_id)?;
        let session = sessions
            .get(&params.terminal_id)
            .expect("terminal ownership was just validated");
        let writer = session.process.writer_sender();
        let state = session.state.clone();
        drop(sessions);
        {
            let mut state = state.lock().map_err(|_| TerminalError::Busy)?;
            let after_output_sequence = state.next_sequence;
            state
                .command_status
                .note_input(&params.data, after_output_sequence);
        }
        self.runtime
            .block_on(writer.send(params.data.into_bytes()))
            .map_err(|_| TerminalError::OperationFailed)
    }

    pub fn resize(
        &self,
        owner_connection_id: u64,
        params: TerminalResizeRequest,
    ) -> Result<(), TerminalError> {
        self.ensure_active()?;
        validate_size(params.rows, params.cols)?;
        let sessions = self.owned_sessions(owner_connection_id, &params.terminal_id)?;
        sessions
            .get(&params.terminal_id)
            .expect("terminal ownership was just validated")
            .process
            .resize(TerminalSize {
                rows: params.rows,
                cols: params.cols,
            })
            .map_err(|_| TerminalError::OperationFailed)
    }

    pub fn read(
        &self,
        owner_connection_id: u64,
        params: TerminalReadRequest,
    ) -> Result<TerminalReadResult, TerminalError> {
        self.ensure_active()?;
        if params.max_chunks == 0 || params.max_chunks > 128 {
            return Err(TerminalError::InvalidInput);
        }
        let sessions = self.owned_sessions(owner_connection_id, &params.terminal_id)?;
        let state = sessions
            .get(&params.terminal_id)
            .expect("terminal ownership was just validated")
            .state
            .clone();
        drop(sessions);
        let state = state.lock().map_err(|_| TerminalError::Busy)?;
        if params.after_sequence > state.next_sequence {
            return Err(TerminalError::InvalidInput);
        }
        if params.after_command_sequence > state.command_status.next_event_sequence() {
            return Err(TerminalError::InvalidInput);
        }
        Ok(read_state(&params, &state))
    }

    pub fn close(&self, owner_connection_id: u64, terminal_id: &str) -> Result<(), TerminalError> {
        let mut sessions = self.sessions.lock().map_err(|_| TerminalError::Busy)?;
        let session = sessions.get(terminal_id).ok_or(TerminalError::NotFound)?;
        if session.owner != TerminalOwner::Attached(owner_connection_id) {
            return Err(TerminalError::NotOwner);
        }
        if let Ok(mut state) = session.state.lock() {
            let after_output_sequence = state.next_sequence;
            state.command_status.cancel_active(after_output_sequence);
        }
        sessions
            .remove(terminal_id)
            .expect("terminal existed immediately before removal")
            .process
            .request_terminate();
        Ok(())
    }

    pub fn close_owner(&self, owner_connection_id: u64) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        sessions.retain(|_, session| {
            if session.owner != TerminalOwner::Attached(owner_connection_id) {
                return true;
            }
            if session.reconnect_token.is_some() {
                session.owner = TerminalOwner::Detached {
                    expires_at: Instant::now() + RECONNECT_GRACE_PERIOD,
                };
                true
            } else {
                session.process.request_terminate();
                false
            }
        });
    }

    pub fn active_count(&self) -> usize {
        let Ok(mut sessions) = self.sessions.lock() else {
            return MAX_ACTIVE_TERMINALS;
        };
        remove_expired_sessions(&mut sessions, Instant::now());
        sessions.len()
    }

    pub fn terminate_all(&self) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        for (_, session) in sessions.drain() {
            session.process.request_terminate();
        }
    }

    pub fn terminate_revoked_dirs(&self) {
        let Ok(mut sessions) = self.sessions.lock() else {
            return;
        };
        sessions.retain(|_, session| {
            if session.authorization.ensure_active().is_ok() {
                true
            } else {
                session.process.request_terminate();
                false
            }
        });
    }

    fn ensure_active(&self) -> Result<(), TerminalError> {
        self.authorization
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .ensure_active()
            .map_err(|_| TerminalError::OperationFailed)
    }

    fn owned_sessions(
        &self,
        owner_connection_id: u64,
        terminal_id: &str,
    ) -> Result<std::sync::MutexGuard<'_, HashMap<String, TerminalSession>>, TerminalError> {
        let sessions = self.sessions.lock().map_err(|_| TerminalError::Busy)?;
        let session = sessions.get(terminal_id).ok_or(TerminalError::NotFound)?;
        if session.owner != TerminalOwner::Attached(owner_connection_id) {
            return Err(TerminalError::NotOwner);
        }
        if session.authorization.ensure_active().is_err() {
            return Err(TerminalError::OperationFailed);
        }
        Ok(sessions)
    }
}

fn validate_authorization(authorization: &Authorization) -> Result<(), TerminalError> {
    if authorization.permission() == Permission::ExecuteCommands
        && authorization.ensure_active().is_ok()
    {
        Ok(())
    } else {
        Err(TerminalError::OperationFailed)
    }
}

struct TerminalSession {
    owner: TerminalOwner,
    reconnect_token: Option<String>,
    process: Arc<ProcessHandle>,
    state: Arc<Mutex<TerminalState>>,
    authorization: Authorization,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TerminalOwner {
    Attached(u64),
    Detached { expires_at: Instant },
}

struct TerminalState {
    chunks: VecDeque<BufferedOutput>,
    next_sequence: u64,
    output_bytes: usize,
    command_status: TerminalCommandStatusTracker,
    exited: bool,
    output_closed: bool,
    exit_code: Option<i32>,
}

impl TerminalState {
    fn new(command_status_enabled: bool) -> Self {
        Self {
            chunks: VecDeque::new(),
            next_sequence: 0,
            output_bytes: 0,
            command_status: TerminalCommandStatusTracker::new(command_status_enabled),
            exited: false,
            output_closed: false,
            exit_code: None,
        }
    }
}

impl Default for TerminalState {
    fn default() -> Self {
        Self::new(false)
    }
}

struct BufferedOutput {
    sequence: u64,
    bytes: Vec<u8>,
}

fn spawn_output_drainers(
    runtime: &Runtime,
    spawned: SpawnedProcess,
    state: Arc<Mutex<TerminalState>>,
) -> Arc<ProcessHandle> {
    let SpawnedProcess {
        session,
        mut stdout_rx,
        stderr_rx: _,
        exit_rx,
    } = spawned;
    let session = Arc::new(session);
    let output_state = state.clone();
    runtime.spawn(async move {
        while let Some(bytes) = stdout_rx.recv().await {
            if let Ok(mut state) = output_state.lock() {
                for item in state.command_status.parse_output(bytes) {
                    match item {
                        ParsedTerminalOutput::Bytes(bytes) => push_output(&mut state, bytes),
                        ParsedTerminalOutput::CommandFinished(exit_code) => {
                            let after_output_sequence = state.next_sequence;
                            state
                                .command_status
                                .finish_active(exit_code, after_output_sequence);
                        }
                    }
                }
            }
        }
        if let Ok(mut state) = output_state.lock() {
            let pending_output = state.command_status.flush_output();
            push_output(&mut state, pending_output);
            state.output_closed = true;
            state.exited = state.exit_code.is_some();
        }
    });
    let exit_session = session.clone();
    runtime.spawn(async move {
        let exit_code = exit_rx.await.unwrap_or(-1);
        exit_session.release_pty_handles_after_exit();
        if let Ok(mut state) = state.lock() {
            let after_output_sequence = state.next_sequence;
            state
                .command_status
                .finish_active(Some(exit_code), after_output_sequence);
            state.exit_code = Some(exit_code);
            state.exited = state.output_closed;
        }
    });
    session
}

fn push_output(state: &mut TerminalState, bytes: Vec<u8>) {
    if bytes.is_empty() {
        return;
    }
    state.next_sequence = state.next_sequence.saturating_add(1);
    state.output_bytes = state.output_bytes.saturating_add(bytes.len());
    state.chunks.push_back(BufferedOutput {
        sequence: state.next_sequence,
        bytes,
    });
    while state.output_bytes > MAX_OUTPUT_BYTES {
        let Some(removed) = state.chunks.pop_front() else {
            break;
        };
        state.output_bytes = state.output_bytes.saturating_sub(removed.bytes.len());
    }
}

fn read_state(params: &TerminalReadRequest, state: &TerminalState) -> TerminalReadResult {
    let oldest_sequence = state
        .chunks
        .front()
        .map_or(state.next_sequence.saturating_add(1), |chunk| {
            chunk.sequence
        });
    let requested_sequence = params.after_sequence.saturating_add(1);
    let output_gap = requested_sequence < oldest_sequence;
    let first_sequence = if output_gap {
        oldest_sequence
    } else {
        requested_sequence
    };
    let chunks = state
        .chunks
        .iter()
        .filter(|chunk| chunk.sequence >= first_sequence)
        .take(params.max_chunks)
        .map(|chunk| TerminalOutputChunk {
            sequence: chunk.sequence,
            data: chunk.bytes.clone(),
        })
        .collect::<Vec<_>>();
    let next_sequence = chunks.last().map_or_else(
        || {
            if output_gap {
                state.next_sequence
            } else {
                params.after_sequence
            }
        },
        |chunk| chunk.sequence,
    );
    let (command_events, next_command_sequence, command_event_gap) = state
        .command_status
        .read_events(params.after_command_sequence, params.max_chunks);
    TerminalReadResult {
        terminal_id: params.terminal_id.clone(),
        chunks,
        next_sequence,
        output_gap,
        command_events,
        next_command_sequence,
        command_event_gap,
        exited: state.exited,
        exit_code: state.exit_code,
    }
}

fn validate_size(rows: u16, cols: u16) -> Result<(), TerminalError> {
    if rows == 0 || rows > 512 || cols == 0 || cols > 512 {
        return Err(TerminalError::InvalidInput);
    }
    Ok(())
}

fn new_reconnect_lease() -> Result<TerminalReconnectLease, TerminalError> {
    let mut bytes = [0_u8; RECONNECT_TOKEN_BYTES];
    getrandom(&mut bytes).map_err(|_| TerminalError::OperationFailed)?;
    let mut reconnect_token = String::with_capacity(RECONNECT_TOKEN_BYTES * 2);
    for byte in bytes {
        use std::fmt::Write;
        write!(&mut reconnect_token, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(TerminalReconnectLease {
        reconnect_token,
        reconnect_grace_period_millis: RECONNECT_GRACE_PERIOD_MILLIS,
    })
}

fn constant_time_eq(left: &str, right: &str) -> bool {
    if left.len() != right.len() {
        return false;
    }
    left.bytes()
        .zip(right.bytes())
        .fold(0_u8, |difference, (left, right)| {
            difference | (left ^ right)
        })
        == 0
}

fn spawn_reconnect_sweeper(
    runtime: &Runtime,
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
) {
    runtime.spawn(async move {
        let mut interval = tokio::time::interval(RECONNECT_SWEEP_INTERVAL);
        loop {
            interval.tick().await;
            let Ok(mut sessions) = sessions.lock() else {
                return;
            };
            remove_expired_sessions(&mut sessions, Instant::now());
        }
    });
}

fn remove_expired_sessions(sessions: &mut HashMap<String, TerminalSession>, now: Instant) {
    sessions.retain(|_, session| match session.owner {
        TerminalOwner::Detached { expires_at } if expires_at <= now => {
            session.process.request_terminate();
            false
        }
        _ => true,
    });
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalError {
    InvalidInput,
    NotFound,
    NotOwner,
    AttachRejected,
    Busy,
    OperationFailed,
}

#[cfg(test)]
#[path = "terminal/service_tests.rs"]
mod tests;

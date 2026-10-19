//! Authorized interactive PTY sessions, bounded output, and reconnect leases.

mod command_status;
mod environment;
mod profiles;
mod shell_integration;

use crate::terminal::command_status::CommandStatusMode;
use crate::terminal::command_status::ParsedTerminalOutput;
use crate::terminal::command_status::TerminalCommandStatusTracker;
use crate::terminal::profiles::TerminalProfileCatalog;
use crate::terminal::shell_integration::ShellEnvironmentMode;
use crate::terminal::shell_integration::ShellIntegration;
use ash_file_access::Authorization;
use ash_file_access::Permission;
use ash_utils_pty::ProcessHandle;
use ash_utils_pty::ProcessSignal;
use ash_utils_pty::PtyArguments;
use ash_utils_pty::SpawnedProcess;
use ash_utils_pty::TerminalSize;
use ash_utils_pty::spawn_pty_process;
pub use environment::is_private_process_environment_key;
pub use environment::safe_process_environment;
pub use exec_server_protocol::terminal::TerminalArguments;
pub use exec_server_protocol::terminal::TerminalAttachRequest;
pub use exec_server_protocol::terminal::TerminalAttachResult;
pub use exec_server_protocol::terminal::TerminalCommandStatus;
pub use exec_server_protocol::terminal::TerminalCommandStatusEvent;
pub use exec_server_protocol::terminal::TerminalCreateRequest;
pub use exec_server_protocol::terminal::TerminalCreateResult;
pub use exec_server_protocol::terminal::TerminalCwd;
pub use exec_server_protocol::terminal::TerminalExecution;
pub use exec_server_protocol::terminal::TerminalLifecycle;
pub use exec_server_protocol::terminal::TerminalOutputChunk;
pub use exec_server_protocol::terminal::TerminalProcessInfo;
pub use exec_server_protocol::terminal::TerminalProcessReady;
pub use exec_server_protocol::terminal::TerminalProfile;
pub use exec_server_protocol::terminal::TerminalProfileSelection;
pub use exec_server_protocol::terminal::TerminalReadRequest;
pub use exec_server_protocol::terminal::TerminalReadResult;
pub use exec_server_protocol::terminal::TerminalReconnectLease;
pub use exec_server_protocol::terminal::TerminalResizeRequest;
pub use exec_server_protocol::terminal::TerminalResolvedProfile;
pub use exec_server_protocol::terminal::TerminalShellIntegration;
pub use exec_server_protocol::terminal::TerminalShellIntegrationEvent;
pub use exec_server_protocol::terminal::TerminalShellType;
pub use exec_server_protocol::terminal::TerminalSignal;
pub use exec_server_protocol::terminal::TerminalWriteBinaryRequest;
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
use tokio::sync::Notify;
use tokio::task::AbortHandle;

const MAX_ACTIVE_TERMINALS: usize = 16;
const MAX_OUTPUT_BYTES: usize = 1024 * 1024;
const MAX_OUTPUT_CHUNKS: usize = 16_384;
// Leave room in the replay ring for one bounded PTY read or parsed OSC record.
const OUTPUT_HIGH_WATER_BYTES: usize = MAX_OUTPUT_BYTES / 2;
const OUTPUT_HIGH_WATER_CHUNKS: usize = MAX_OUTPUT_CHUNKS / 2;
const MAX_INPUT_BYTES: usize = 64 * 1024;
const RECONNECT_GRACE_PERIOD: Duration = Duration::from_secs(30);
const RECONNECT_GRACE_PERIOD_MILLIS: u64 = 30_000;
const RECONNECT_SWEEP_INTERVAL: Duration = Duration::from_secs(1);
const RECONNECT_TOKEN_BYTES: usize = 32;

/// Owns connection-scoped and briefly reconnectable PTY processes under one
/// `ExecuteCommands` authorization.
pub struct TerminalService {
    authorization: RwLock<Authorization>,
    terminal_id_prefix: String,
    next_terminal_id: AtomicU64,
    sessions: Arc<Mutex<HashMap<String, TerminalSession>>>,
    runtime: Runtime,
    profiles: TerminalProfileCatalog,
}

impl TerminalService {
    pub fn new(authorization: Authorization) -> Result<Self, TerminalError> {
        validate_authorization(&authorization)?;
        // Clients retain leases across directory changes, including service recreation.
        let terminal_id_prefix = random_hex::<16>()?;
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
            terminal_id_prefix,
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

    /// Reads only requested values from the environment used to spawn this service's shells.
    pub fn environment(&self, names: &[String]) -> Result<HashMap<String, String>, TerminalError> {
        self.ensure_active()?;
        if names.len() > 128
            || names
                .iter()
                .any(|name| name.is_empty() || name.len() > 256 || name.contains(['=', '\0']))
        {
            return Err(TerminalError::InvalidInput);
        }
        Ok(names
            .iter()
            .filter_map(|name| {
                let key = if cfg!(windows) {
                    name.to_ascii_uppercase()
                } else {
                    name.clone()
                };
                self.profiles
                    .environment()
                    .get(&key)
                    .map(|value| (name.clone(), value.clone()))
            })
            .collect())
    }

    /// Resolves a profile on this authorized execution host without allocating a PTY.
    pub fn resolve_profile(
        &self,
        selection: &TerminalProfileSelection,
    ) -> Result<TerminalResolvedProfile, TerminalError> {
        self.ensure_active()?;
        let spec = self
            .profiles
            .resolve(selection)
            .ok_or(TerminalError::InvalidInput)?;
        Ok(TerminalResolvedProfile {
            profile: spec.profile(),
            executable: spec.program.clone(),
            args: spec.args.clone(),
        })
    }

    /// Returns the same sanitized snapshot inherited by children, excluding launcher authority.
    pub fn environment_snapshot(&self) -> Result<HashMap<String, String>, TerminalError> {
        self.ensure_active()?;
        Ok(self.profiles.environment().clone())
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
        let authorized_root = authorization.dir().canonical_path();
        let dir_root = match params.cwd {
            Some(path) => {
                // The directory owner resolves Windows ordinary/verbatim aliases
                // and checks containment against the opened authorization.
                let path = authorization
                    .dir()
                    .resolve_existing_path(path)
                    .map_err(|_| TerminalError::InvalidInput)?;
                if !path.is_dir() {
                    return Err(TerminalError::InvalidInput);
                }
                path
            }
            None => authorized_root.to_path_buf(),
        };
        let mut environment = if params.strict_env.unwrap_or(false) {
            HashMap::new()
        } else {
            self.profiles.environment().clone()
        };
        if let Some(overrides) = params.env {
            if overrides.len() > 128 {
                return Err(TerminalError::InvalidInput);
            }
            for (key, value) in overrides {
                if key.is_empty()
                    || key.len() > 256
                    || key.contains(['=', '\0'])
                    || value
                        .as_ref()
                        .is_some_and(|value| value.len() > 32768 || value.contains('\0'))
                {
                    return Err(TerminalError::InvalidInput);
                }
                let key = if cfg!(windows) {
                    key.to_ascii_uppercase()
                } else {
                    key
                };
                // A client override cannot reintroduce launcher authentication.
                if is_private_process_environment_key(&key) {
                    continue;
                }
                match value {
                    Some(value) => {
                        environment.insert(key, value);
                    }
                    None => {
                        environment.remove(&key);
                    }
                }
            }
        }
        // Interactive shells retain their startup wrappers until output closes.
        // Task process/shell executions preserve argv and do not source those wrappers.
        let integration = if params.execution.is_none() {
            Some(
                ShellIntegration::prepare(
                    &profile,
                    &environment,
                    if params.strict_env.unwrap_or(false) {
                        ShellEnvironmentMode::Literal
                    } else {
                        ShellEnvironmentMode::ApplyCollections
                    },
                )
                .map_err(|error| {
                    if error.kind() == std::io::ErrorKind::InvalidInput {
                        TerminalError::InvalidInput
                    } else {
                        TerminalError::OperationFailed
                    }
                })?,
            )
        } else {
            None
        };
        // Path commands are supported only by an interactive, identified shell,
        // never by a Task's arbitrary executable or one-shot shell command.
        let shell_type = if params.execution.is_none() {
            match profile.shell_kind() {
                profiles::ShellKind::Bash => Some(TerminalShellType::Bash),
                profiles::ShellKind::Zsh => Some(TerminalShellType::Zsh),
                profiles::ShellKind::PowerShell => Some(TerminalShellType::PowerShell),
                profiles::ShellKind::Other => None,
            }
        } else {
            None
        };
        let (program, args) = match params.execution {
            Some(TerminalExecution::Process { program, args }) => {
                if program.trim().is_empty()
                    || program.len() > 32768
                    || program.contains('\0')
                    || !profiles::valid_arguments(&args)
                {
                    return Err(TerminalError::InvalidInput);
                }
                (program, args)
            }
            Some(TerminalExecution::Shell { command_line }) => {
                if command_line.trim().is_empty()
                    || command_line.len() > 32768
                    || command_line.contains('\0')
                {
                    return Err(TerminalError::InvalidInput);
                }
                (
                    profile.program.clone(),
                    TerminalArguments::Argv(profile.command_args(&command_line)),
                )
            }
            None => (
                profile.program.clone(),
                integration
                    .as_ref()
                    .expect("interactive shell integration was prepared")
                    .args
                    .clone(),
            ),
        };
        let spawned = self
            .runtime
            .block_on(spawn_pty_process(
                &program,
                match &args {
                    TerminalArguments::Argv(args) => PtyArguments::Argv(args),
                    TerminalArguments::CommandLine(args) => PtyArguments::WindowsCommandLine(args),
                },
                &dir_root,
                integration
                    .as_ref()
                    .map(|value| &value.environment)
                    .unwrap_or(&environment),
                &None,
                TerminalSize {
                    rows: params.rows,
                    cols: params.cols,
                },
            ))
            .map_err(|_| TerminalError::OperationFailed)?;
        let ready = TerminalProcessReady {
            pid: spawned
                .session
                .process_id()
                .ok_or(TerminalError::OperationFailed)?,
            cwd: dir_root
                .to_str()
                .ok_or(TerminalError::InvalidInput)?
                .to_owned(),
            shell_type,
        };
        let terminal_id = format!(
            "terminal-{}-{:x}",
            self.terminal_id_prefix,
            self.next_terminal_id.fetch_add(1, Ordering::Relaxed)
        );
        let mode = if integration.is_some() {
            profile.command_status_mode()
        } else {
            CommandStatusMode::Disabled
        };
        let state = Arc::new(Mutex::new(TerminalState::new(
            mode,
            integration
                .as_ref()
                .and_then(|integration| integration.nonce.clone()),
            profile.shell_kind(),
        )));
        let (process, output_task) =
            spawn_output_drainers(&self.runtime, spawned, state.clone(), integration);
        sessions.insert(
            terminal_id.clone(),
            TerminalSession {
                owner: TerminalOwner::Attached(owner_connection_id),
                reconnect_token: reconnect
                    .as_ref()
                    .map(|lease| lease.reconnect_token.clone()),
                ready: ready.clone(),
                size: TerminalSize {
                    rows: params.rows,
                    cols: params.cols,
                },
                process,
                output_task,
                state,
                authorization,
            },
        );
        Ok(TerminalCreateResult {
            ready,
            terminal_id,
            profile: profile.profile(),
            reconnect,
        })
    }

    /// Revokes this connection's access while retaining the PTY for one short handoff.
    /// Rotating the token also invalidates credentials captured before the transfer.
    pub fn detach(
        &self,
        owner_connection_id: u64,
        terminal_id: &str,
    ) -> Result<TerminalReconnectLease, TerminalError> {
        self.ensure_active()?;
        let reconnect = new_reconnect_lease()?;
        let mut sessions = self.owned_sessions(owner_connection_id, terminal_id)?;
        let session = sessions
            .get_mut(terminal_id)
            .expect("terminal ownership was just validated");
        session.reconnect_token = Some(reconnect.reconnect_token.clone());
        session.owner = TerminalOwner::Detached {
            expires_at: Instant::now() + RECONNECT_GRACE_PERIOD,
        };
        Ok(reconnect)
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
        // A service may host terminals created under different Session grants.
        // The service grant cannot substitute for the process's own authorization.
        validate_authorization(&session.authorization)?;
        session
            .process
            .resize(TerminalSize {
                rows: params.rows,
                cols: params.cols,
            })
            .map_err(|_| TerminalError::OperationFailed)?;
        session.size = TerminalSize {
            rows: params.rows,
            cols: params.cols,
        };
        session.owner = TerminalOwner::Attached(owner_connection_id);
        session.reconnect_token = Some(reconnect.reconnect_token.clone());
        Ok(TerminalAttachResult {
            ready: session.ready.clone(),
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
        self.write_input(
            owner_connection_id,
            &params.terminal_id,
            params.data.into_bytes(),
        )
    }

    /// Raw input shares the PTY's bounded writer channel but never becomes shell command text.
    pub fn write_binary(
        &self,
        owner_connection_id: u64,
        params: TerminalWriteBinaryRequest,
    ) -> Result<(), TerminalError> {
        self.ensure_active()?;
        if params.data.is_empty() || params.data.len() > MAX_INPUT_BYTES {
            return Err(TerminalError::InvalidInput);
        }
        self.write_input(owner_connection_id, &params.terminal_id, params.data)
    }

    fn write_input(
        &self,
        owner_connection_id: u64,
        terminal_id: &str,
        data: Vec<u8>,
    ) -> Result<(), TerminalError> {
        let sessions = self.owned_sessions(owner_connection_id, terminal_id)?;
        let writer = sessions
            .get(terminal_id)
            .expect("terminal ownership was just validated")
            .process
            .writer_sender();
        drop(sessions);
        // Waiting for input capacity cannot block reads or a transfer. Once a slot
        // is available, recheck ownership and admit input atomically with detach.
        let permit = self
            .runtime
            .block_on(writer.reserve_owned())
            .map_err(|_| TerminalError::OperationFailed)?;
        let sessions = self.owned_sessions(owner_connection_id, terminal_id)?;
        permit.send(data);
        drop(sessions);
        Ok(())
    }

    pub fn send_signal(
        &self,
        owner_connection_id: u64,
        terminal_id: &str,
        signal: TerminalSignal,
    ) -> Result<(), TerminalError> {
        self.ensure_active()?;
        let sessions = self.owned_sessions(owner_connection_id, terminal_id)?;
        let process = &sessions
            .get(terminal_id)
            .expect("terminal ownership was just validated")
            .process;
        if process.has_exited() {
            return Err(TerminalError::OperationFailed);
        }
        let signal = match signal {
            TerminalSignal::Interrupt => ProcessSignal::Interrupt,
        };
        process.signal(signal).map_err(|error| {
            if error.kind() == std::io::ErrorKind::Unsupported {
                TerminalError::Unsupported
            } else {
                TerminalError::OperationFailed
            }
        })
    }

    pub fn process_info(
        &self,
        owner_connection_id: u64,
        terminal_id: &str,
    ) -> Result<TerminalProcessInfo, TerminalError> {
        self.ensure_active()?;
        let sessions = self.owned_sessions(owner_connection_id, terminal_id)?;
        let session = sessions
            .get(terminal_id)
            .expect("terminal ownership was just validated");
        let detected = session
            .state
            .lock()
            .map_err(|_| TerminalError::Busy)?
            .command_status
            .cwd()
            .map(|cwd| cwd.value.clone());
        let cwd = match detected {
            Some(cwd) => Some(cwd),
            None => session
                .process
                .current_working_directory()
                .map_err(|_| TerminalError::OperationFailed)?
                .map(|path| path.to_string_lossy().into_owned()),
        };
        Ok(TerminalProcessInfo {
            ready: session.ready.clone(),
            cwd,
            rows: session.size.rows,
            cols: session.size.cols,
            has_child_processes: session.process.has_child_processes(),
        })
    }

    pub fn resize(
        &self,
        owner_connection_id: u64,
        params: TerminalResizeRequest,
    ) -> Result<(), TerminalError> {
        self.ensure_active()?;
        validate_size(params.rows, params.cols)?;
        let mut sessions = self.owned_sessions(owner_connection_id, &params.terminal_id)?;
        let session = sessions
            .get_mut(&params.terminal_id)
            .expect("terminal ownership was just validated");
        let size = TerminalSize {
            rows: params.rows,
            cols: params.cols,
        };
        // The renderer can resize its retained terminal after the child exits,
        // before the next output poll reports that exit. Released PTY handles
        // must not turn a completed task into a transport failure.
        if !session.process.has_exited()
            && session.process.resize(size).is_err()
            && !session.process.has_exited()
        {
            return Err(TerminalError::OperationFailed);
        }
        session.size = size;
        Ok(())
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
        // Serialize the output acknowledgement with detach as well as reads.
        let mut state = state.lock().map_err(|_| TerminalError::Busy)?;
        if params.after_sequence > state.next_sequence {
            return Err(TerminalError::InvalidInput);
        }
        if params.after_command_sequence > state.command_status.next_event_sequence() {
            return Err(TerminalError::InvalidInput);
        }
        // The sole attached screen advances this cursor only after committing the
        // preceding output. Replayed reads must not move that acknowledgement back.
        if params.after_sequence > state.acknowledged_sequence {
            state.acknowledged_sequence = params.after_sequence;
            state.output_consumed.notify_one();
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
    ready: TerminalProcessReady,
    size: TerminalSize,
    owner: TerminalOwner,
    reconnect_token: Option<String>,
    process: Arc<ProcessHandle>,
    output_task: AbortHandle,
    state: Arc<Mutex<TerminalState>>,
    authorization: Authorization,
}

impl Drop for TerminalSession {
    fn drop(&mut self) {
        // Every removal path, including lease expiry and revoked grants, must
        // release a drainer waiting for a screen which no longer exists.
        self.output_task.abort();
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum TerminalOwner {
    Attached(u64),
    Detached { expires_at: Instant },
}

struct TerminalState {
    chunks: VecDeque<BufferedOutput>,
    next_sequence: u64,
    acknowledged_sequence: u64,
    output_bytes: usize,
    output_consumed: Arc<Notify>,
    command_status: TerminalCommandStatusTracker,
    exited: bool,
    output_closed: bool,
    exit_code: Option<i32>,
}

impl TerminalState {
    fn new(
        command_status_mode: CommandStatusMode,
        nonce: Option<String>,
        shell: profiles::ShellKind,
    ) -> Self {
        let integrated = matches!(command_status_mode, CommandStatusMode::ShellIntegration);
        let mut state = Self {
            chunks: VecDeque::new(),
            next_sequence: 0,
            acknowledged_sequence: 0,
            output_bytes: 0,
            output_consumed: Arc::new(Notify::new()),
            command_status: TerminalCommandStatusTracker::new(command_status_mode, nonce),
            exited: false,
            output_closed: false,
            exit_code: None,
        };
        if integrated {
            push_shell_boundary(
                &mut state,
                TerminalShellIntegrationEvent::ProcessReady {
                    is_windows_pty: cfg!(windows),
                    shell_type: match shell {
                        profiles::ShellKind::Bash => Some(TerminalShellType::Bash),
                        profiles::ShellKind::Zsh => Some(TerminalShellType::Zsh),
                        profiles::ShellKind::PowerShell => Some(TerminalShellType::PowerShell),
                        profiles::ShellKind::Other => None,
                    },
                },
            );
        }
        state
    }
}

impl Default for TerminalState {
    fn default() -> Self {
        Self::new(
            CommandStatusMode::Disabled,
            None,
            profiles::ShellKind::Other,
        )
    }
}

struct BufferedOutput {
    sequence: u64,
    bytes: Vec<u8>,
    shell_integration: Option<TerminalShellIntegrationEvent>,
    retained_bytes: usize,
}

fn spawn_output_drainers(
    runtime: &Runtime,
    spawned: SpawnedProcess,
    state: Arc<Mutex<TerminalState>>,
    integration: Option<ShellIntegration>,
) -> (Arc<ProcessHandle>, AbortHandle) {
    let SpawnedProcess {
        session,
        mut stdout_rx,
        stderr_rx: _,
        exit_rx,
    } = spawned;
    let session = Arc::new(session);
    let output_state = state.clone();
    let output_consumed = state
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
        .output_consumed
        .clone();
    let output_task = runtime.spawn(async move {
        loop {
            if !wait_for_output_capacity(&output_state, &output_consumed).await {
                return;
            }
            let Some(bytes) = stdout_rx.recv().await else {
                break;
            };
            let parsed = match output_state.lock() {
                Ok(mut state) => state.command_status.parse_output(bytes),
                Err(_) => return,
            };
            for item in parsed {
                if !wait_for_output_capacity(&output_state, &output_consumed).await {
                    return;
                }
                if let Ok(mut state) = output_state.lock() {
                    match item {
                        ParsedTerminalOutput::Bytes(bytes) => push_output(&mut state, bytes),
                        ParsedTerminalOutput::CommandStarted => {
                            let after_output_sequence = state.next_sequence;
                            let already_active = state.command_status.executed_boundary().is_some();
                            state.command_status.start_active(after_output_sequence);
                            if !already_active
                                && let Some(boundary) = state.command_status.executed_boundary()
                            {
                                push_shell_boundary(&mut state, boundary);
                            }
                        }
                        ParsedTerminalOutput::Cwd(value, trusted) => {
                            push_shell_boundary(
                                &mut state,
                                TerminalShellIntegrationEvent::Cwd {
                                    value: value.clone(),
                                    is_trusted: trusted,
                                },
                            );
                            let sequence = state.next_sequence;
                            state.command_status.record_cwd(value, trusted, sequence);
                        }
                        ParsedTerminalOutput::CommandLine(command, trusted) => {
                            if !state.command_status.is_command_storage_disabled() {
                                push_shell_boundary(
                                    &mut state,
                                    TerminalShellIntegrationEvent::CommandLine {
                                        value: command.clone(),
                                        is_trusted: trusted,
                                    },
                                );
                            }
                            let sequence = state.next_sequence;
                            state
                                .command_status
                                .record_command_line(command, trusted, sequence);
                        }
                        ParsedTerminalOutput::ShellIntegration(boundary) => {
                            push_shell_boundary(&mut state, boundary)
                        }
                        ParsedTerminalOutput::PromptStart => {
                            push_shell_boundary(
                                &mut state,
                                TerminalShellIntegrationEvent::PromptStart,
                            );
                            let sequence = state.next_sequence;
                            state.command_status.record_prompt(sequence);
                        }
                        ParsedTerminalOutput::RichCommandDetection(rich) => {
                            push_shell_boundary(
                                &mut state,
                                TerminalShellIntegrationEvent::HasRichCommandDetection {
                                    value: rich,
                                },
                            );
                            let sequence = state.next_sequence;
                            state.command_status.record_rich_detection(rich, sequence);
                        }
                        ParsedTerminalOutput::CommandStorageDisabled => {
                            push_shell_boundary(
                                &mut state,
                                TerminalShellIntegrationEvent::CommandStorageDisabled,
                            );
                            for chunk in &mut state.chunks {
                                match chunk.shell_integration.as_mut() {
                                    Some(TerminalShellIntegrationEvent::CommandLine {
                                        value,
                                        is_trusted,
                                    }) => {
                                        value.clear();
                                        *is_trusted = false;
                                    }
                                    Some(TerminalShellIntegrationEvent::CommandExecuted {
                                        command,
                                        is_trusted,
                                        command_storage_disabled,
                                        ..
                                    }) => {
                                        *command = None;
                                        *is_trusted = false;
                                        *command_storage_disabled = true;
                                    }
                                    _ => {}
                                }
                            }
                            let sequence = state.next_sequence;
                            state.command_status.disable_command_storage(sequence);
                        }
                        ParsedTerminalOutput::PromptType(value) => {
                            push_shell_boundary(
                                &mut state,
                                TerminalShellIntegrationEvent::PromptType {
                                    value: value.clone(),
                                },
                            );
                            let sequence = state.next_sequence;
                            state.command_status.record_prompt_type(value, sequence);
                        }
                        ParsedTerminalOutput::CommandFinished(exit_code) => {
                            if state.command_status.executed_boundary().is_some() {
                                let boundary = state.command_status.finished_boundary(exit_code);
                                push_shell_boundary(&mut state, boundary);
                            }
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
            if state.exited {
                let exit_code = state.exit_code;
                if state.command_status.executed_boundary().is_some() {
                    let boundary = state.command_status.finished_boundary(exit_code);
                    push_shell_boundary(&mut state, boundary);
                }
                let after_output_sequence = state.next_sequence;
                state
                    .command_status
                    .finish_active(exit_code, after_output_sequence);
            }
        }
        drop(integration);
    });
    let exit_session = session.clone();
    runtime.spawn(async move {
        let exit_code = exit_rx.await.unwrap_or(-1);
        exit_session.release_pty_handles_after_exit();
        if let Ok(mut state) = state.lock() {
            // OSC command markers can still be queued when OS exit arrives.
            // Finish the active command only after its output has been drained.
            state.exit_code = Some(exit_code);
            state.exited = state.output_closed;
            if state.exited {
                if state.command_status.executed_boundary().is_some() {
                    let boundary = state.command_status.finished_boundary(Some(exit_code));
                    push_shell_boundary(&mut state, boundary);
                }
                let after_output_sequence = state.next_sequence;
                state
                    .command_status
                    .finish_active(Some(exit_code), after_output_sequence);
            }
        }
    });
    (session, output_task.abort_handle())
}

async fn wait_for_output_capacity(state: &Mutex<TerminalState>, consumed: &Notify) -> bool {
    loop {
        // notify_one retains a permit if the screen commits between checking the
        // high-water mark and awaiting. No mutex is held while the producer waits.
        let notified = consumed.notified();
        match state.lock() {
            Ok(state) => {
                let mut bytes = 0_usize;
                let mut chunks = 0;
                for chunk in state
                    .chunks
                    .iter()
                    .rev()
                    .take_while(|chunk| chunk.sequence > state.acknowledged_sequence)
                {
                    bytes = bytes.saturating_add(chunk.retained_bytes);
                    chunks += 1;
                    if bytes >= OUTPUT_HIGH_WATER_BYTES || chunks >= OUTPUT_HIGH_WATER_CHUNKS {
                        break;
                    }
                }
                if bytes < OUTPUT_HIGH_WATER_BYTES && chunks < OUTPUT_HIGH_WATER_CHUNKS {
                    return true;
                }
            }
            Err(_) => return false,
        }
        notified.await;
    }
}

fn push_output(state: &mut TerminalState, bytes: Vec<u8>) {
    if bytes.is_empty() {
        return;
    }
    state.next_sequence = state.next_sequence.saturating_add(1);
    state.output_bytes = state.output_bytes.saturating_add(bytes.len());
    state.chunks.push_back(BufferedOutput {
        sequence: state.next_sequence,
        retained_bytes: bytes.len(),
        bytes,
        shell_integration: None,
    });
    trim_output(state);
}

fn push_shell_boundary(state: &mut TerminalState, boundary: TerminalShellIntegrationEvent) {
    state.next_sequence = state.next_sequence.saturating_add(1);
    let retained_bytes = shell_boundary_bytes(&boundary);
    state.output_bytes = state.output_bytes.saturating_add(retained_bytes);
    state.chunks.push_back(BufferedOutput {
        sequence: state.next_sequence,
        bytes: Vec::new(),
        shell_integration: Some(boundary),
        retained_bytes,
    });
    trim_output(state);
}

fn shell_boundary_bytes(event: &TerminalShellIntegrationEvent) -> usize {
    use TerminalShellIntegrationEvent as Event;
    std::mem::size_of::<Event>()
        + match event {
            Event::CommandExecuted {
                command_id,
                command,
                cwd,
                ..
            } => {
                command_id.capacity()
                    + command.as_ref().map_or(0, String::capacity)
                    + cwd.as_ref().map_or(0, String::capacity)
            }
            Event::CommandLine { value, .. }
            | Event::Cwd { value, .. }
            | Event::PromptType { value } => value.capacity(),
            Event::Environment { values, .. } => values.as_ref().map_or(0, |values| {
                values
                    .iter()
                    .map(|(key, value)| key.capacity() + value.as_ref().map_or(0, String::capacity))
                    .sum()
            }),
            Event::EnvironmentEntry { key, value, .. }
            | Event::EnvironmentDelete { key, value, .. } => {
                key.capacity() + value.as_ref().map_or(0, String::capacity)
            }
            Event::EnvironmentStart { .. } | Event::EnvironmentEnd { .. } => 0,
            Event::ProcessReady { .. }
            | Event::CommandFinished { .. }
            | Event::PromptStart
            | Event::CommandStart
            | Event::ContinuationStart
            | Event::ContinuationEnd
            | Event::RightPromptStart
            | Event::RightPromptEnd
            | Event::HasRichCommandDetection { .. }
            | Event::CommandStorageDisabled => 0,
        }
}

fn trim_output(state: &mut TerminalState) {
    // Metadata-only children must be bounded even when they produce no display bytes.
    while state.output_bytes > MAX_OUTPUT_BYTES || state.chunks.len() > MAX_OUTPUT_CHUNKS {
        let Some(removed) = state.chunks.pop_front() else {
            break;
        };
        state.output_bytes = state.output_bytes.saturating_sub(removed.retained_bytes);
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
            shell_integration: chunk.shell_integration.clone(),
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
        cwd: state.command_status.cwd().cloned(),
        shell_integration: state.command_status.shell_integration(),
    }
}

fn validate_size(rows: u16, cols: u16) -> Result<(), TerminalError> {
    if rows == 0 || rows > 512 || cols == 0 || cols > 512 {
        return Err(TerminalError::InvalidInput);
    }
    Ok(())
}

fn new_reconnect_lease() -> Result<TerminalReconnectLease, TerminalError> {
    Ok(TerminalReconnectLease {
        reconnect_token: random_hex::<RECONNECT_TOKEN_BYTES>()?,
        reconnect_grace_period_millis: RECONNECT_GRACE_PERIOD_MILLIS,
    })
}

fn random_hex<const N: usize>() -> Result<String, TerminalError> {
    let mut bytes = [0_u8; N];
    getrandom(&mut bytes).map_err(|_| TerminalError::OperationFailed)?;
    let mut encoded = String::with_capacity(N * 2);
    for byte in bytes {
        use std::fmt::Write;
        write!(&mut encoded, "{byte:02x}").expect("writing to a String cannot fail");
    }
    Ok(encoded)
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
    Unsupported,
}

#[cfg(test)]
#[path = "terminal/service_tests.rs"]
mod tests;

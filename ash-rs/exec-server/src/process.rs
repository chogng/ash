use ash_async_utils::CancellationSource;
use ash_file_access::Grant;
use ash_file_access::Permission;
use ash_protocol::ProcessExitStatus;
use ash_sandboxing::SandboxBackend;
use ash_sandboxing::SandboxBackends;
use ash_sandboxing::SandboxPolicy;
use ash_tool_executor::ApprovalPolicy;
use ash_tool_executor::ApprovalRequirement;
use ash_tool_executor::CommandExecutionAuthority;
use ash_tool_executor::CommandExecutionOutcome;
use ash_tool_executor::CommandExecutor;
use ash_tool_executor::CommandInput;
use ash_tool_executor::CommandRequest;
use ash_tool_executor::CommandSessionCursor;
use ash_tool_executor::CommandSessionOptions;
use ash_tool_executor::CommandSessionOwner;
use ash_tool_executor::CommandSessionStart;
use ash_tool_executor::CommandSessionStatus;
use ash_tool_executor::ExecutionError;
use ash_tool_executor::ExecutionLimits;
use exec_server_protocol::ExecError;
use exec_server_protocol::FileAccess;
use exec_server_protocol::NetworkAccess;
use exec_server_protocol::Output;
use exec_server_protocol::ProcessRead;
use exec_server_protocol::ProcessSnapshot;
use exec_server_protocol::ProcessStart;
use exec_server_protocol::ProcessState;
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread;
use std::time::Duration;
use std::time::Instant;

const MAX_RECORDS: usize = 1024;
const MAX_ACTIVE: usize = 32;
const RETENTION: Duration = Duration::from_secs(3600);

pub(crate) struct Processes {
    grant: Grant,
    policy: SandboxPolicy,
    backend: Arc<dyn SandboxBackend>,
    records: Mutex<HashMap<String, Arc<Record>>>,
    workers: Mutex<Vec<thread::JoinHandle<()>>>,
}

struct Record {
    request: ProcessStart,
    cancellation: CancellationSource,
    data: Mutex<Data>,
    session: Mutex<Option<Session>>,
}

struct Session {
    executor: Arc<CommandExecutor<HostAuthorized, SandboxBackends>>,
    owner: CommandSessionOwner,
    id: ash_tool_executor::CommandSessionId,
}

struct Data {
    state: ProcessState,
    stdout: Buffer,
    stderr: Buffer,
    finished: Option<Instant>,
}

#[derive(Default)]
struct Buffer {
    text: String,
    end: u64,
    truncated: bool,
}
impl Buffer {
    fn append(&mut self, text: &str) {
        self.end += text.len() as u64;
        self.text.push_str(text);
        let mut remove = self
            .text
            .len()
            .saturating_sub(exec_server_protocol::MAX_OUTPUT_BYTES);
        while !self.text.is_char_boundary(remove) {
            remove += 1;
        }
        self.text.drain(..remove);
    }
    fn update(&mut self, output: &ash_tool_executor::CommandSessionOutput) {
        if output.gap {
            self.text.clear();
        }
        self.append(&output.text);
        self.end = output.next_cursor;
    }
    fn read(&self, cursor: u64) -> Result<Output, ExecError> {
        if cursor > self.end {
            return Err(ExecError::InvalidInput);
        }
        let begin = self.end - self.text.len() as u64;
        let offset = cursor.saturating_sub(begin) as usize;
        if !self.text.is_char_boundary(offset) {
            return Err(ExecError::InvalidInput);
        }
        Ok(Output {
            text: self.text[offset..].into(),
            next_cursor: self.end,
            gap: cursor < begin || (cursor == 0 && self.truncated),
        })
    }
}

struct HostAuthorized;
impl ApprovalPolicy for HostAuthorized {
    fn requirement_for(&self, _: &str) -> ApprovalRequirement {
        ApprovalRequirement::NotRequired
    }
}

impl Processes {
    pub fn new(
        grant: Grant,
        access: FileAccess,
        network: NetworkAccess,
        backend: Arc<dyn SandboxBackend>,
    ) -> Self {
        Self {
            grant,
            policy: SandboxPolicy::new(
                match access {
                    FileAccess::ReadOnly => ash_sandboxing::FileSystemAccess::ReadOnly,
                    FileAccess::ReadWrite => ash_sandboxing::FileSystemAccess::DirectoryWrite,
                },
                match network {
                    NetworkAccess::Denied => ash_sandboxing::NetworkAccess::Denied,
                    NetworkAccess::Allowed => ash_sandboxing::NetworkAccess::Allowed,
                },
            ),
            backend,
            records: Mutex::new(HashMap::new()),
            workers: Mutex::new(Vec::new()),
        }
    }

    pub fn start(&self, request: ProcessStart) -> Result<ProcessSnapshot, ExecError> {
        request.validate()?;
        let authorization = self
            .grant
            .authorize(Permission::ExecuteCommands)
            .map_err(|_| ExecError::PermissionDenied)?;
        let mut records = self.records.lock().map_err(|_| ExecError::Busy)?;
        records.retain(|_, record| {
            record
                .data
                .lock()
                .map(|data| data.finished.is_none_or(|at| at.elapsed() < RETENTION))
                .unwrap_or(true)
        });
        if let Some(record) = records.get(&request.operation_id) {
            if record.request != request {
                return Err(ExecError::Conflict);
            }
            return record.snapshot(0, 0);
        }
        if records.len() >= MAX_RECORDS
            || records
                .values()
                .filter(|record| {
                    record
                        .data
                        .lock()
                        .map(|data| data.finished.is_none())
                        .unwrap_or(true)
                })
                .count()
                >= MAX_ACTIVE
        {
            return Err(ExecError::Busy);
        }
        let record = Arc::new(Record {
            session: Mutex::new(None),
            request: request.clone(),
            cancellation: CancellationSource::new(),
            data: Mutex::new(Data {
                state: ProcessState::Running,
                stdout: Buffer::default(),
                stderr: Buffer::default(),
                finished: None,
            }),
        });
        records.insert(request.operation_id.clone(), record.clone());
        let backend = SandboxBackends::new(vec![("host", self.backend.clone())]);
        let policy = self.policy;
        let worker = record.clone();
        let handle = thread::Builder::new()
            .name("exec-process".into())
            .spawn(move || {
                let result = authorization.execute(
                    authorization.subject(),
                    authorization.dir(),
                    Permission::ExecuteCommands,
                    || run(&worker, authorization.dir(), backend, policy),
                );
                if result.is_err() {
                    worker.finish(ProcessState::Failed {
                        message: "execution permission revoked".into(),
                    });
                }
            });
        match handle {
            Ok(handle) => {
                let mut workers = self
                    .workers
                    .lock()
                    .unwrap_or_else(|error| error.into_inner());
                let mut index = 0;
                while index < workers.len() {
                    if workers[index].is_finished() {
                        let _ = workers.swap_remove(index).join();
                    } else {
                        index += 1;
                    }
                }
                workers.push(handle);
            }
            Err(_) => record.finish(ProcessState::Failed {
                message: "could not start execution worker".into(),
            }),
        }
        record.snapshot(0, 0)
    }

    pub fn read(&self, request: &ProcessRead) -> Result<ProcessSnapshot, ExecError> {
        self.record(&request.operation_id)?
            .snapshot(request.stdout_cursor, request.stderr_cursor)
    }
    pub fn cancel(&self, id: &str) -> Result<ProcessSnapshot, ExecError> {
        let record = self.record(id)?;
        record.cancellation.cancel();
        record.snapshot(0, 0)
    }
    pub fn write(&self, id: &str, bytes: Vec<u8>) -> Result<(), ExecError> {
        if bytes.len() > exec_server_protocol::MAX_OUTPUT_BYTES {
            return Err(ExecError::InvalidInput);
        }
        self.control(id, |session| {
            session
                .executor
                .write_session(&session.owner, &session.id, bytes)
        })
    }
    pub fn close_input(&self, id: &str) -> Result<(), ExecError> {
        if matches!(
            self.record(id)?.request.input,
            exec_server_protocol::ProcessInput::Terminal { .. }
        ) {
            return Err(ExecError::InvalidInput);
        }
        self.control(id, |session| {
            session
                .executor
                .close_session_input(&session.owner, &session.id)
        })
    }
    pub fn resize(&self, id: &str, rows: u16, cols: u16) -> Result<(), ExecError> {
        if rows == 0 || cols == 0 {
            return Err(ExecError::InvalidInput);
        }
        self.control(id, |session| {
            session.executor.resize_session(
                &session.owner,
                &session.id,
                ash_tool_executor::CommandTerminalSize { rows, cols },
            )
        })
    }
    pub fn interrupt(&self, id: &str) -> Result<(), ExecError> {
        self.control(id, |session| {
            session
                .executor
                .interrupt_session(&session.owner, &session.id)
        })
    }
    fn control(
        &self,
        id: &str,
        operation: impl FnOnce(&Session) -> Result<(), ExecutionError>,
    ) -> Result<(), ExecError> {
        let record = self.record(id)?;
        let session = record.session.lock().map_err(|_| ExecError::Busy)?;
        let session = session.as_ref().ok_or(ExecError::Conflict)?;
        operation(session).map_err(|_| ExecError::Conflict)
    }
    fn record(&self, id: &str) -> Result<Arc<Record>, ExecError> {
        self.records
            .lock()
            .map_err(|_| ExecError::Busy)?
            .get(id)
            .cloned()
            .ok_or(ExecError::NotFound)
    }
}

impl Drop for Processes {
    fn drop(&mut self) {
        if let Ok(records) = self.records.lock() {
            for record in records.values() {
                record.cancellation.cancel();
            }
        }
        if let Ok(workers) = self.workers.get_mut() {
            for worker in workers.drain(..) {
                let _ = worker.join();
            }
        }
    }
}

impl Record {
    fn snapshot(&self, stdout: u64, stderr: u64) -> Result<ProcessSnapshot, ExecError> {
        let data = self.data.lock().map_err(|_| ExecError::Busy)?;
        Ok(ProcessSnapshot {
            operation_id: self.request.operation_id.clone(),
            state: data.state.clone(),
            stdout: data.stdout.read(stdout)?,
            stderr: data.stderr.read(stderr)?,
        })
    }
    fn finish(&self, state: ProcessState) {
        if let Ok(mut data) = self.data.lock() {
            data.state = state;
            data.finished = Some(Instant::now());
        }
    }
}

fn run(
    record: &Record,
    dir: &ash_file_access::Dir,
    backend: SandboxBackends,
    policy: SandboxPolicy,
) {
    let executor = Arc::new(CommandExecutor::new(
        dir.clone(),
        backend,
        HostAuthorized,
        ExecutionLimits {
            timeout: Duration::from_millis(record.request.timeout_millis),
            max_output_bytes: exec_server_protocol::MAX_OUTPUT_BYTES,
        },
    ));
    let owner = CommandSessionOwner::new("exec-server", &record.request.operation_id, "host");
    let terminal = match record.request.input {
        exec_server_protocol::ProcessInput::Terminal { rows, cols } => {
            Some(ash_tool_executor::CommandTerminalSize { rows, cols })
        }
        _ => None,
    };
    let input = match record.request.input {
        exec_server_protocol::ProcessInput::Closed => CommandInput::Closed,
        _ => CommandInput::Open,
    };
    let result = executor.start_session_scoped_with_network(
        CommandRequest {
            program: record.request.program.clone(),
            arguments: record.request.arguments.clone(),
            working_directory: record.request.cwd.clone().into(),
            input,
        },
        CommandExecutionAuthority::Sandboxed(policy),
        &record.cancellation.token(),
        None,
        None,
        owner.clone(),
        CommandSessionOptions {
            execution_timeout: Duration::from_millis(record.request.timeout_millis),
            wait_budget: Duration::ZERO,
            terminal,
        },
    );
    let state = match result {
        Ok(CommandSessionStart::Completed(CommandExecutionOutcome::Completed(output))) => {
            if let Ok(mut data) = record.data.lock() {
                data.stdout.truncated = output.stdout_truncated;
                data.stderr.truncated = output.stderr_truncated;
                data.stdout.append(&output.stdout);
                data.stderr.append(&output.stderr);
            }
            ProcessState::Exited {
                code: output.exit_code,
            }
        }
        Ok(CommandSessionStart::Completed(CommandExecutionOutcome::SandboxDenied(_))) => {
            ProcessState::Failed {
                message: "sandbox denied process".into(),
            }
        }
        Ok(CommandSessionStart::Running(mut update)) => {
            let id = update.session_id.clone();
            if matches!(
                record.request.input,
                exec_server_protocol::ProcessInput::Closed
            ) {
                let _ = executor.close_session_input(&owner, &id);
            }
            if let Ok(mut session) = record.session.lock() {
                *session = Some(Session {
                    executor: executor.clone(),
                    owner: owner.clone(),
                    id: id.clone(),
                });
            }
            let final_state = loop {
                if let Ok(mut data) = record.data.lock() {
                    data.stdout.update(&update.stdout);
                    data.stderr.update(&update.stderr);
                }
                let state = match update.status {
                    CommandSessionStatus::Running => None,
                    CommandSessionStatus::Exited(status) => Some(ProcessState::Exited {
                        code: match status {
                            ProcessExitStatus::Code(code) => Some(code),
                            ProcessExitStatus::Terminated => None,
                        },
                    }),
                    CommandSessionStatus::Cancelled | CommandSessionStatus::Terminated => {
                        Some(ProcessState::Cancelled)
                    }
                    CommandSessionStatus::TimedOut => Some(ProcessState::TimedOut),
                    CommandSessionStatus::SandboxDenied => Some(ProcessState::Failed {
                        message: "sandbox denied process".into(),
                    }),
                    CommandSessionStatus::Failed(_) => Some(ProcessState::Failed {
                        message: "process supervision failed".into(),
                    }),
                };
                if let Some(state) = state {
                    break state;
                }
                match executor.read_session(
                    &owner,
                    &id,
                    CommandSessionCursor {
                        stdout: update.stdout.next_cursor,
                        stderr: update.stderr.next_cursor,
                    },
                    Duration::from_millis(25),
                ) {
                    Ok(next) => update = next,
                    Err(error) => break execution_error(error),
                }
            };
            if let Ok(mut session) = record.session.lock() {
                *session = None;
            }
            let _ = executor.release_session(&owner, &id);
            final_state
        }
        Err(error) => execution_error(error),
    };
    record.finish(state);
}

fn execution_error(error: ExecutionError) -> ProcessState {
    match error {
        ExecutionError::CancelledBeforeStart(_) | ExecutionError::CancelledAfterStart(_) => {
            ProcessState::Cancelled
        }
        ExecutionError::TimedOut => ProcessState::TimedOut,
        error => ProcessState::Failed {
            message: format!("{error:?}"),
        },
    }
}

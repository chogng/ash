//! RPC operation identity and retention over the shared process session owner.
use crate::execution::CommandExecutionAuthority;
use crate::execution::CommandInput;
use crate::execution::CommandRequest;
use crate::execution::CommandSessionCursor;
use crate::execution::CommandSessionId;
use crate::execution::CommandSessionOptions;
use crate::execution::CommandSessionOutput;
use crate::execution::CommandSessionStatus;
use crate::execution::CommandTerminalSize;
use crate::execution::ExecutionError;
use crate::execution::ExecutionLimits;
use crate::execution::ProcessExecutor;
use crate::execution::ProcessSessionOwner;
use ash_async_utils::CancellationSource;
use ash_file_access::Grant;
use ash_file_access::Permission;
use ash_sandboxing::SandboxBackend;
use ash_sandboxing::SandboxBackends;
use ash_sandboxing::SandboxPolicy;
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
use std::sync::Condvar;
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
    executor: Arc<ProcessExecutor<SandboxBackends>>,
    records: Mutex<HashMap<String, Arc<Record>>>,
    workers: Mutex<Vec<thread::JoinHandle<()>>>,
}
struct Record {
    request: ProcessStart,
    cancellation: CancellationSource,
    state: Mutex<LaunchState>,
    launched: Condvar,
    finished: Mutex<Option<Instant>>,
}
// Only preparation failures lack a process session. Running and completed process data live
// exclusively in ProcessExecutor; this table owns RPC idempotency and expiration.
#[derive(Clone)]
enum LaunchState {
    Starting,
    Session(CommandSessionId),
    Rejected(ProcessState),
}
impl Processes {
    pub fn new(
        grant: Grant,
        access: FileAccess,
        network: NetworkAccess,
        backend: Arc<dyn SandboxBackend>,
    ) -> Self {
        let policy = SandboxPolicy::new(
            match access {
                FileAccess::ReadOnly => ash_sandboxing::FileSystemAccess::ReadOnly,
                FileAccess::ReadWrite => ash_sandboxing::FileSystemAccess::DirectoryWrite,
            },
            match network {
                NetworkAccess::Denied => ash_sandboxing::NetworkAccess::Denied,
                NetworkAccess::Allowed => ash_sandboxing::NetworkAccess::Allowed,
            },
        );
        let executor = Arc::new(ProcessExecutor::new(
            grant.dir().clone(),
            SandboxBackends::new(vec![("host", backend)]),
            ExecutionLimits {
                timeout: Duration::from_secs(60),
                max_output_bytes: exec_server_protocol::MAX_OUTPUT_BYTES,
            },
        ));
        Self {
            grant,
            policy,
            executor,
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
            let expired = record
                .finished
                .lock()
                .map(|at| at.is_some_and(|at| at.elapsed() >= RETENTION))
                .unwrap_or(false);
            if expired && let Ok(LaunchState::Session(id)) = record.state.lock().as_deref() {
                let _ = self.executor.release_session(&record.owner(), id);
            }
            !expired
        });
        if let Some(record) = records.get(&request.operation_id) {
            if record.request != request {
                return Err(ExecError::Conflict);
            }
            return self.snapshot(record, 0, 0, Duration::ZERO);
        }
        if records.len() >= MAX_RECORDS
            || records
                .values()
                .filter(|r| r.finished.lock().map(|at| at.is_none()).unwrap_or(true))
                .count()
                >= MAX_ACTIVE
        {
            return Err(ExecError::Busy);
        }
        let record = Arc::new(Record {
            request: request.clone(),
            cancellation: CancellationSource::new(),
            state: Mutex::new(LaunchState::Starting),
            launched: Condvar::new(),
            finished: Mutex::new(None),
        });
        records.insert(request.operation_id, record.clone());
        let worker = record.clone();
        let executor = self.executor.clone();
        let policy = self.policy;
        let handle = thread::Builder::new()
            .name("exec-process".into())
            .spawn(move || {
                let result = authorization.execute(
                    authorization.subject(),
                    authorization.dir(),
                    Permission::ExecuteCommands,
                    || run(&worker, &executor, policy),
                );
                if result.is_err() {
                    worker.reject("execution permission revoked".into());
                }
            });
        match handle {
            Ok(handle) => {
                let mut workers = self.workers.lock().unwrap_or_else(|e| e.into_inner());
                let mut i = 0;
                while i < workers.len() {
                    if workers[i].is_finished() {
                        let _ = workers.swap_remove(i).join();
                    } else {
                        i += 1;
                    }
                }
                workers.push(handle);
            }
            Err(_) => record.reject("could not start execution worker".into()),
        }
        self.snapshot(&record, 0, 0, Duration::ZERO)
    }
    fn snapshot(
        &self,
        record: &Record,
        stdout: u64,
        stderr: u64,
        wait: Duration,
    ) -> Result<ProcessSnapshot, ExecError> {
        let deadline = Instant::now() + wait;
        let state = record.state.lock().map_err(|_| ExecError::Busy)?;
        let (state, _) = record
            .launched
            .wait_timeout_while(state, wait, |state| matches!(state, LaunchState::Starting))
            .map_err(|_| ExecError::Busy)?;
        let launch = state.clone();
        drop(state);
        let (state, out, err) = match launch {
            LaunchState::Session(id) => {
                let update = self
                    .executor
                    .read_session(
                        &record.owner(),
                        &id,
                        CommandSessionCursor { stdout, stderr },
                        deadline.saturating_duration_since(Instant::now()),
                    )
                    .map_err(|_| ExecError::InvalidInput)?;
                (
                    process_state(update.status),
                    output(update.stdout),
                    output(update.stderr),
                )
            }
            state => {
                if stdout != 0 || stderr != 0 {
                    return Err(ExecError::InvalidInput);
                }
                let state = match state {
                    LaunchState::Starting => ProcessState::Running,
                    LaunchState::Rejected(state) => state,
                    _ => unreachable!(),
                };
                (
                    state,
                    Output {
                        text: String::new(),
                        next_cursor: 0,
                        gap: false,
                    },
                    Output {
                        text: String::new(),
                        next_cursor: 0,
                        gap: false,
                    },
                )
            }
        };
        Ok(ProcessSnapshot {
            operation_id: record.request.operation_id.clone(),
            state,
            stdout: out,
            stderr: err,
        })
    }
    pub fn read(&self, request: &ProcessRead) -> Result<ProcessSnapshot, ExecError> {
        if request.wait_millis > exec_server_protocol::MAX_READ_WAIT_MILLIS {
            return Err(ExecError::InvalidInput);
        }
        self.snapshot(
            self.record(&request.operation_id)?.as_ref(),
            request.stdout_cursor,
            request.stderr_cursor,
            Duration::from_millis(request.wait_millis),
        )
    }
    pub fn cancel(&self, id: &str) -> Result<ProcessSnapshot, ExecError> {
        let record = self.record(id)?;
        record.cancellation.cancel();
        self.snapshot(&record, 0, 0, Duration::ZERO)
    }
    pub fn write(&self, id: &str, bytes: Vec<u8>) -> Result<(), ExecError> {
        if bytes.len() > exec_server_protocol::MAX_OUTPUT_BYTES {
            return Err(ExecError::InvalidInput);
        }
        self.control(id, |owner, id| {
            self.executor.write_session(owner, id, bytes)
        })
    }
    pub fn close_input(&self, id: &str) -> Result<(), ExecError> {
        if matches!(
            self.record(id)?.request.input,
            exec_server_protocol::ProcessInput::Terminal { .. }
        ) {
            return Err(ExecError::InvalidInput);
        }
        self.control(id, |owner, id| self.executor.close_session_input(owner, id))
    }
    pub fn resize(&self, id: &str, rows: u16, cols: u16) -> Result<(), ExecError> {
        if rows == 0 || cols == 0 {
            return Err(ExecError::InvalidInput);
        }
        self.control(id, |owner, id| {
            self.executor
                .resize_session(owner, id, CommandTerminalSize { rows, cols })
        })
    }
    pub fn interrupt(&self, id: &str) -> Result<(), ExecError> {
        self.control(id, |owner, id| self.executor.interrupt_session(owner, id))
    }
    fn control(
        &self,
        id: &str,
        operation: impl FnOnce(&ProcessSessionOwner, &CommandSessionId) -> Result<(), ExecutionError>,
    ) -> Result<(), ExecError> {
        let record = self.record(id)?;
        let state = record.state.lock().map_err(|_| ExecError::Busy)?;
        let LaunchState::Session(id) = &*state else {
            return Err(ExecError::Conflict);
        };
        let owner = record.owner();
        let update = self
            .executor
            .read_session(&owner, id, CommandSessionCursor::default(), Duration::ZERO)
            .map_err(|_| ExecError::Conflict)?;
        if update.status != CommandSessionStatus::Running {
            return Err(ExecError::Conflict);
        }
        operation(&owner, id).map_err(|_| ExecError::Conflict)
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
    fn owner(&self) -> ProcessSessionOwner {
        ProcessSessionOwner::new(self.request.operation_id.clone())
    }
    fn reject(&self, message: String) {
        if let Ok(mut state) = self.state.lock() {
            *state = LaunchState::Rejected(ProcessState::Failed { message });
        }
        self.launched.notify_all();
        self.finish();
    }
    fn finish(&self) {
        if let Ok(mut at) = self.finished.lock() {
            *at = Some(Instant::now());
        }
    }
}
fn run(record: &Record, executor: &ProcessExecutor<SandboxBackends>, policy: SandboxPolicy) {
    let terminal = match record.request.input {
        exec_server_protocol::ProcessInput::Terminal { rows, cols } => {
            Some(CommandTerminalSize { rows, cols })
        }
        _ => None,
    };
    let owner = record.owner();
    let result = executor.start_retained_session(
        CommandRequest {
            program: record.request.program.clone(),
            arguments: record.request.arguments.clone(),
            working_directory: record.request.cwd.clone().into(),
            input: CommandInput::Open,
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
    let id = match result {
        Ok(id) => id,
        Err(error) => {
            let state = match error {
                ExecutionError::CancelledBeforeStart(_)
                | ExecutionError::CancelledAfterStart(_) => ProcessState::Cancelled,
                ExecutionError::TimedOut => ProcessState::TimedOut,
                error => ProcessState::Failed {
                    message: format!("{error:?}"),
                },
            };
            if let Ok(mut launch) = record.state.lock() {
                *launch = LaunchState::Rejected(state);
            }
            record.launched.notify_all();
            record.finish();
            return;
        }
    };
    if matches!(
        record.request.input,
        exec_server_protocol::ProcessInput::Closed
    ) {
        let _ = executor.close_session_input(&owner, &id);
    }
    if let Ok(mut state) = record.state.lock() {
        *state = LaunchState::Session(id.clone());
    }
    record.launched.notify_all();
    // Observe completion without copying output or maintaining a second process state machine.
    let observation = CancellationSource::new();
    let _ = pollster::block_on(executor.wait_session(
        &owner,
        &id,
        CommandSessionCursor::default(),
        Duration::from_secs(12 * 60 * 60 + 60),
        &observation.token(),
    ));
    record.finish();
}
fn output(value: CommandSessionOutput) -> Output {
    Output {
        text: value.text,
        next_cursor: value.next_cursor,
        gap: value.gap,
    }
}
fn process_state(status: CommandSessionStatus) -> ProcessState {
    match status {
        CommandSessionStatus::Running => ProcessState::Running,
        CommandSessionStatus::Exited(status) => ProcessState::Exited {
            code: match status {
                ash_protocol::ProcessExitStatus::Code(code) => Some(code),
                ash_protocol::ProcessExitStatus::Terminated => None,
            },
        },
        CommandSessionStatus::Cancelled | CommandSessionStatus::Terminated => {
            ProcessState::Cancelled
        }
        CommandSessionStatus::TimedOut => ProcessState::TimedOut,
        CommandSessionStatus::SandboxDenied => ProcessState::Failed {
            message: "sandbox denied process".into(),
        },
        CommandSessionStatus::Failed(message) => ProcessState::Failed { message },
    }
}

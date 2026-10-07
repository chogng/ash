use super::CommandExecutionAuthority;
use super::CommandExecutionOutcome;
use super::CommandInput;
use super::CommandOutput;
use super::CommandRequest;
use super::ExecutionError;
use super::ProcessExecutionOutput;
use super::ProcessExecutor;
use super::ProcessExitStatus;
use super::SandboxDenialOutput;
use super::SandboxDenialTiming;
use super::SandboxProcessExitStatus;
use super::SandboxScope;
use super::StartResult;
use super::StartedCommand;
use ash_async_utils::CancellationToken;
use ash_async_utils::Notify;
use ash_async_utils::WaitOutcome;
use ash_async_utils::wait_until;
use ash_sandboxing::SandboxBackend;
use ash_utils_pty::TerminalSize;
use std::collections::HashMap;
use std::collections::VecDeque;
use std::fmt;
use std::io::Read;
use std::io::Write;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicU8;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use std::time::Instant;

const MAX_ACTIVE_SESSIONS: usize = 64;
const CONTROL_NONE: u8 = 0;
const CONTROL_TERMINATE: u8 = 1;

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct CommandSessionId(String);

impl CommandSessionId {
    pub fn new(value: impl Into<String>) -> Result<Self, String> {
        let value = value.into();
        let suffix = value
            .strip_prefix("cmd-")
            .ok_or_else(|| "command session ID must start with 'cmd-'".to_owned())?;
        if suffix.len() != 32 || !suffix.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            return Err("command session ID must contain 32 hexadecimal digits".into());
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for CommandSessionId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProcessSessionOwner(String);

impl ProcessSessionOwner {
    /// An opaque ownership key supplied by the caller; contains no tool or conversation semantics.
    pub fn new(key: impl Into<String>) -> Self {
        Self(key.into())
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CommandSessionCursor {
    pub stdout: u64,
    pub stderr: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandSessionOutput {
    pub text: String,
    pub next_cursor: u64,
    pub gap: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandSessionStatus {
    Running,
    Exited(ProcessExitStatus),
    SandboxDenied,
    Cancelled,
    TimedOut,
    Terminated,
    Failed(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CommandSessionUpdate {
    pub session_id: CommandSessionId,
    pub status: CommandSessionStatus,
    pub stdout: CommandSessionOutput,
    pub stderr: CommandSessionOutput,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum CommandSessionStart {
    Completed(CommandExecutionOutcome),
    Running(CommandSessionUpdate),
}

/// Independent bounds for command lifetime and the initial output observation.
pub struct CommandSessionOptions {
    pub execution_timeout: Duration,
    pub wait_budget: Duration,
    pub terminal: Option<TerminalSize>,
}

#[derive(Default)]
pub(super) struct CommandSessions {
    records: Mutex<HashMap<CommandSessionId, Arc<SessionRecord>>>,
}

impl Drop for CommandSessions {
    fn drop(&mut self) {
        if let Ok(records) = self.records.lock() {
            for record in records.values() {
                record.terminate();
            }
        }
    }
}

struct SessionRecord {
    io: ash_sandboxing::ProcessIo,
    owner: ProcessSessionOwner,
    input: Arc<Mutex<Option<mpsc::SyncSender<InputRequest>>>>,
    process: Arc<Mutex<ash_sandboxing::ProcessHandle>>,
    control: Arc<AtomicU8>,
    data: Arc<(Mutex<SessionData>, Notify)>,
}

struct SessionData {
    stdout: StreamBuffer,
    stderr: StreamBuffer,
    final_state: Option<SessionFinal>,
}

#[derive(Clone)]
enum SessionFinal {
    Outcome(CommandExecutionOutcome),
    Cancelled,
    TimedOut,
    Terminated,
    Failed(String),
}

enum WorkerEnd {
    Exited(SandboxProcessExitStatus),
    Cancelled,
    TimedOut,
    Terminated,
    Failed(String),
}

enum InputRequest {
    Bytes(Vec<u8>),
    Close,
}

struct StreamBuffer {
    start: u64,
    bytes: VecDeque<u8>,
    capacity: usize,
}

impl StreamBuffer {
    fn new(capacity: usize) -> Self {
        Self {
            start: 0,
            bytes: VecDeque::new(),
            capacity: capacity.max(1),
        }
    }

    fn end(&self) -> u64 {
        self.start + self.bytes.len() as u64
    }

    fn append(&mut self, bytes: &[u8]) {
        self.bytes.extend(bytes);
        while self.bytes.len() > self.capacity {
            self.bytes.pop_front();
            self.start += 1;
        }
    }

    fn read(&self, cursor: u64) -> Result<CommandSessionOutput, ExecutionError> {
        let end = self.end();
        if cursor > end {
            return Err(session_error("output cursor is beyond the current stream"));
        }
        let actual = cursor.max(self.start);
        let skip = usize::try_from(actual - self.start).unwrap_or(self.bytes.len());
        let bytes = self.bytes.iter().skip(skip).copied().collect::<Vec<_>>();
        Ok(CommandSessionOutput {
            text: String::from_utf8_lossy(&bytes).into_owned(),
            next_cursor: end,
            gap: cursor < self.start,
        })
    }

    fn retained(&self) -> (Vec<u8>, bool) {
        (self.bytes.iter().copied().collect(), self.start != 0)
    }
}

impl<B: SandboxBackend> ProcessExecutor<B> {
    fn launch_session(
        &self,
        mut request: CommandRequest,
        authority: CommandExecutionAuthority,
        cancellation: &CancellationToken,
        scope: Option<&SandboxScope>,
        network_policy: Option<&network_proxy::NetworkPolicyHandle>,
        owner: ProcessSessionOwner,
        options: CommandSessionOptions,
    ) -> Result<
        Result<(CommandSessionId, Arc<SessionRecord>), CommandExecutionOutcome>,
        ExecutionError,
    > {
        if options.execution_timeout < Duration::from_millis(1)
            || options.execution_timeout > Duration::from_secs(12 * 60 * 60)
        {
            return Err(session_error(
                "command session timeout must be between 1 millisecond and 12 hours",
            ));
        }
        request.input = CommandInput::Open;
        let started = self.start_scoped_with_network(
            request,
            authority,
            cancellation,
            scope,
            network_policy,
            options.terminal.map_or(
                ash_sandboxing::ProcessIo::Pipes,
                ash_sandboxing::ProcessIo::Pty,
            ),
        )?;
        let StartResult::Started(started) = started else {
            let StartResult::Finished(outcome) = started else {
                unreachable!()
            };
            return Ok(Err(outcome));
        };
        let id = new_session_id()?;
        let record = start_record(
            id.clone(),
            owner,
            started,
            cancellation.clone(),
            options.execution_timeout,
            self.limits.max_output_bytes,
            options.terminal.map_or(
                ash_sandboxing::ProcessIo::Pipes,
                ash_sandboxing::ProcessIo::Pty,
            ),
        )?;
        {
            let mut records = self
                .sessions
                .records
                .lock()
                .map_err(|_| session_error("command session registry is unavailable"))?;
            if records
                .values()
                .filter(|record| record.is_running())
                .count()
                >= MAX_ACTIVE_SESSIONS
            {
                record.terminate();
                return Err(session_error("too many active command sessions"));
            }
            records.insert(id.clone(), Arc::clone(&record));
        }
        Ok(Ok((id, record)))
    }
    pub fn start_session_scoped_with_network(
        &self,
        request: CommandRequest,
        authority: CommandExecutionAuthority,
        cancellation: &CancellationToken,
        scope: Option<&SandboxScope>,
        network_policy: Option<&network_proxy::NetworkPolicyHandle>,
        owner: ProcessSessionOwner,
        options: CommandSessionOptions,
    ) -> Result<CommandSessionStart, ExecutionError> {
        // Tool-style observation retires earlier completed sessions when a new command starts.
        // Retained RPC sessions use start_retained_session and are released by their owner.
        self.sessions
            .records
            .lock()
            .map_err(|_| session_error("session registry unavailable"))?
            .retain(|_, record| record.is_running());
        let wait_budget = options.wait_budget;
        let (id, record) = match self.launch_session(
            request,
            authority,
            cancellation,
            scope,
            network_policy,
            owner,
            options,
        )? {
            Ok(id) => id,
            Err(outcome) => return Ok(CommandSessionStart::Completed(outcome)),
        };
        let (update, final_state) =
            record.read(&id, CommandSessionCursor::default(), wait_budget)?;
        match final_state {
            Some(SessionFinal::Outcome(outcome)) => {
                self.remove_record(&id);
                Ok(CommandSessionStart::Completed(outcome))
            }
            Some(SessionFinal::Cancelled) => {
                self.remove_record(&id);
                Err(ExecutionError::CancelledAfterStart(
                    "command session was cancelled".into(),
                ))
            }
            Some(SessionFinal::TimedOut) => {
                self.remove_record(&id);
                Err(ExecutionError::TimedOut)
            }
            Some(SessionFinal::Terminated) => {
                self.remove_record(&id);
                Err(ExecutionError::CancelledAfterStart(
                    "command session was terminated".into(),
                ))
            }
            Some(SessionFinal::Failed(message)) => {
                self.remove_record(&id);
                Err(ExecutionError::Spawn(message))
            }
            None => Ok(CommandSessionStart::Running(update)),
        }
    }

    /// Starts a session whose output and terminal result remain available until explicitly released.
    pub fn start_retained_session(
        &self,
        request: CommandRequest,
        authority: CommandExecutionAuthority,
        cancellation: &CancellationToken,
        scope: Option<&SandboxScope>,
        network_policy: Option<&network_proxy::NetworkPolicyHandle>,
        owner: ProcessSessionOwner,
        options: CommandSessionOptions,
    ) -> Result<CommandSessionId, ExecutionError> {
        match self.launch_session(
            request,
            authority,
            cancellation,
            scope,
            network_policy,
            owner,
            options,
        )? {
            Ok((id, _)) => Ok(id),
            Err(_) => Err(session_error("sandbox denied process before launch")),
        }
    }
    pub fn read_session(
        &self,
        owner: &ProcessSessionOwner,
        id: &CommandSessionId,
        cursor: CommandSessionCursor,
        wait_budget: Duration,
    ) -> Result<CommandSessionUpdate, ExecutionError> {
        let record = self.record(owner, id)?;
        record
            .read(id, cursor, wait_budget)
            .map(|(update, _)| update)
    }

    /// Waits for process completion without returning for intermediate output.
    /// Cancellation/expiry ends this observation, not the owner-bound process.
    pub async fn wait_session(
        &self,
        owner: &ProcessSessionOwner,
        id: &CommandSessionId,
        cursor: CommandSessionCursor,
        wait_budget: Duration,
        cancellation: &CancellationToken,
    ) -> Result<CommandSessionUpdate, ExecutionError> {
        let record = self.record(owner, id)?;
        let deadline = Instant::now() + wait_budget;
        // Validate cursors even when the command remains running for the whole wait.
        record.read(id, cursor, Duration::ZERO)?;
        let completed = async {
            loop {
                let changed = record.data.1.listen();
                let complete = record
                    .data
                    .0
                    .lock()
                    .map_err(|_| session_error("command session output is unavailable"))?
                    .final_state
                    .is_some();
                if complete {
                    return record
                        .read(id, cursor, Duration::ZERO)
                        .map(|(update, _)| update);
                }
                changed.await;
            }
        };
        match wait_until(completed, deadline, cancellation).await {
            Ok(WaitOutcome::Ready(result)) => result,
            Ok(WaitOutcome::TimedOut) => record
                .read(id, cursor, Duration::ZERO)
                .map(|(update, _)| update),
            Err(signal) => Err(ExecutionError::CancelledBeforeStart(
                signal.reason().to_string(),
            )),
        }
    }

    pub fn write_session(
        &self,
        owner: &ProcessSessionOwner,
        id: &CommandSessionId,
        bytes: Vec<u8>,
    ) -> Result<(), ExecutionError> {
        if bytes.is_empty() {
            return Ok(());
        }
        let record = self.record(owner, id)?;
        let input = record
            .input
            .lock()
            .map_err(|_| session_error("command session input is unavailable"))?;
        let sender = input
            .as_ref()
            .ok_or_else(|| session_error("command session input is closed"))?;
        sender
            .try_send(InputRequest::Bytes(bytes))
            .map_err(|_| session_error("command session input is busy or closed"))
    }

    pub fn close_session_input(
        &self,
        owner: &ProcessSessionOwner,
        id: &CommandSessionId,
    ) -> Result<(), ExecutionError> {
        let record = self.record(owner, id)?;
        if matches!(record.io, ash_sandboxing::ProcessIo::Pty(_)) {
            return Err(session_error("terminal input cannot be half-closed"));
        }
        let sender = record
            .input
            .lock()
            .map_err(|_| session_error("command session input is unavailable"))?
            .take();
        if let Some(sender) = sender {
            let _ = sender.try_send(InputRequest::Close);
        }
        Ok(())
    }

    pub fn interrupt_session(
        &self,
        owner: &ProcessSessionOwner,
        id: &CommandSessionId,
    ) -> Result<(), ExecutionError> {
        let record = self.record(owner, id)?;
        record
            .process
            .lock()
            .map_err(|_| session_error("command session process is unavailable"))?
            .interrupt()
            .map_err(|error| session_error(error.to_string()))
    }

    pub fn resize_session(
        &self,
        owner: &ProcessSessionOwner,
        id: &CommandSessionId,
        size: TerminalSize,
    ) -> Result<(), ExecutionError> {
        let record = self.record(owner, id)?;
        record
            .process
            .lock()
            .map_err(|_| session_error("command session process is unavailable"))?
            .resize(size)
            .map_err(|error| session_error(error.to_string()))
    }

    pub fn terminate_session(
        &self,
        owner: &ProcessSessionOwner,
        id: &CommandSessionId,
    ) -> Result<(), ExecutionError> {
        self.record(owner, id)?.terminate();
        Ok(())
    }

    pub fn release_session(
        &self,
        owner: &ProcessSessionOwner,
        id: &CommandSessionId,
    ) -> Result<(), ExecutionError> {
        let record = self.record(owner, id)?;
        record.terminate();
        self.remove_record(id);
        Ok(())
    }

    fn record(
        &self,
        owner: &ProcessSessionOwner,
        id: &CommandSessionId,
    ) -> Result<Arc<SessionRecord>, ExecutionError> {
        let record = self
            .sessions
            .records
            .lock()
            .map_err(|_| session_error("command session registry is unavailable"))?
            .get(id)
            .cloned()
            .ok_or_else(|| session_error("command session was not found"))?;
        if &record.owner != owner {
            return Err(session_error("command session belongs to another caller"));
        }
        Ok(record)
    }

    fn remove_record(&self, id: &CommandSessionId) {
        if let Ok(mut records) = self.sessions.records.lock() {
            records.remove(id);
        }
    }
}

fn start_record(
    _: CommandSessionId,
    owner: ProcessSessionOwner,
    started: StartedCommand,
    cancellation: CancellationToken,
    hard_timeout: Duration,
    output_capacity: usize,
    io: ash_sandboxing::ProcessIo,
) -> Result<Arc<SessionRecord>, ExecutionError> {
    let StartedCommand {
        mut child,
        input: _,
        authority,
        _runtime_dir: runtime_dir,
        _network: network,
    } = started;
    let stdin = child
        .take_stdin()
        .ok_or_else(|| session_error("command session has no stdin stream"))?;
    let stdout = child
        .take_stdout()
        .ok_or_else(|| session_error("command session has no stdout stream"))?;
    let stderr = child
        .take_stderr()
        .ok_or_else(|| session_error("command session has no stderr stream"))?;
    let process = Arc::new(Mutex::new(child));
    let control = Arc::new(AtomicU8::new(CONTROL_NONE));
    let data = Arc::new((
        Mutex::new(SessionData {
            stdout: StreamBuffer::new(output_capacity),
            stderr: StreamBuffer::new(output_capacity),
            final_state: None,
        }),
        Notify::default(),
    ));
    let (input_tx, input_rx) = mpsc::sync_channel(16);
    let input = Arc::new(Mutex::new(Some(input_tx)));
    let record = Arc::new(SessionRecord {
        io,
        owner,
        input: Arc::clone(&input),
        process: Arc::clone(&process),
        control: Arc::clone(&control),
        data: Arc::clone(&data),
    });
    let input_thread = thread::spawn(move || drive_input(stdin, input_rx));
    let stdout_thread = spawn_output_reader(stdout, Arc::clone(&data), OutputStream::Stdout);
    let stderr_thread = spawn_output_reader(stderr, Arc::clone(&data), OutputStream::Stderr);
    thread::spawn(move || {
        let _runtime_dir = runtime_dir;
        let _network = network;
        let started_at = Instant::now();
        let end = loop {
            if control.load(Ordering::Acquire) == CONTROL_TERMINATE {
                break WorkerEnd::Terminated;
            }
            if let Err(reason) = cancellation.check() {
                close_process(&process);
                let _ = reason;
                break WorkerEnd::Cancelled;
            }
            if started_at.elapsed() >= hard_timeout {
                close_process(&process);
                break WorkerEnd::TimedOut;
            }
            match process.lock() {
                Ok(mut process) => match process.try_wait() {
                    Ok(Some(status)) => break WorkerEnd::Exited(status),
                    Ok(None) => {}
                    Err(error) => {
                        break WorkerEnd::Failed(error.to_string());
                    }
                },
                Err(_) => break WorkerEnd::Failed("command session process is unavailable".into()),
            }
            thread::sleep(Duration::from_millis(10));
        };
        if let Ok(mut input) = input.lock() {
            input.take();
        }
        let _ = input_thread.join();
        let _ = stdout_thread.join();
        let _ = stderr_thread.join();
        let final_state = match end {
            WorkerEnd::Exited(status) => finish_outcome(&process, &data, authority, status),
            WorkerEnd::Cancelled => SessionFinal::Cancelled,
            WorkerEnd::TimedOut => SessionFinal::TimedOut,
            WorkerEnd::Terminated => SessionFinal::Terminated,
            WorkerEnd::Failed(message) => SessionFinal::Failed(message),
        };
        let (lock, changed) = &*data;
        if let Ok(mut state) = lock.lock() {
            state.final_state = Some(final_state);
            changed.notify();
        }
    });
    Ok(record)
}

fn finish_outcome(
    process: &Arc<Mutex<ash_sandboxing::ProcessHandle>>,
    data: &Arc<(Mutex<SessionData>, Notify)>,
    authority: CommandExecutionAuthority,
    status: SandboxProcessExitStatus,
) -> SessionFinal {
    let (stdout, stdout_truncated, stderr, stderr_truncated) = {
        let (lock, _) = &**data;
        let Ok(state) = lock.lock() else {
            return SessionFinal::Failed("command session output is unavailable".into());
        };
        let (stdout, stdout_truncated) = state.stdout.retained();
        let (stderr, stderr_truncated) = state.stderr.retained();
        (stdout, stdout_truncated, stderr, stderr_truncated)
    };
    let output = CommandOutput {
        exit_code: status.code(),
        stdout: String::from_utf8_lossy(&stdout).into_owned(),
        stderr: String::from_utf8_lossy(&stderr).into_owned(),
        stdout_truncated,
        stderr_truncated,
    };
    if matches!(authority, CommandExecutionAuthority::Sandboxed(_))
        && let Ok(process) = process.lock()
        && let Some(denial) = process.classify_denial(status, &output.stdout, &output.stderr)
    {
        let captured = ProcessExecutionOutput::from_captured_streams(
            output
                .exit_code
                .map_or(ProcessExitStatus::Terminated, ProcessExitStatus::Code),
            output.stdout,
            output.stderr,
        );
        let denial = match denial.timing() {
            SandboxDenialTiming::BeforeProcessStart => {
                SandboxDenialOutput::safe_to_retry(denial.reason(), captured)
            }
            SandboxDenialTiming::ProcessMayHaveStarted => {
                SandboxDenialOutput::may_have_side_effects(denial.reason(), captured)
            }
        };
        return SessionFinal::Outcome(CommandExecutionOutcome::SandboxDenied(denial));
    }
    SessionFinal::Outcome(CommandExecutionOutcome::Completed(output))
}

impl SessionRecord {
    fn is_running(&self) -> bool {
        self.data
            .0
            .lock()
            .map(|state| state.final_state.is_none())
            .unwrap_or(false)
    }

    fn read(
        &self,
        id: &CommandSessionId,
        cursor: CommandSessionCursor,
        wait_budget: Duration,
    ) -> Result<(CommandSessionUpdate, Option<SessionFinal>), ExecutionError> {
        let cancellation = ash_async_utils::CancellationSource::new();
        let deadline = Instant::now() + wait_budget;
        loop {
            let changed = self.data.1.listen();
            let state = self
                .data
                .0
                .lock()
                .map_err(|_| session_error("command session output is unavailable"))?;
            let ready = state.final_state.is_some()
                || state.stdout.end() != cursor.stdout
                || state.stderr.end() != cursor.stderr;
            drop(state);
            if ready || Instant::now() >= deadline {
                break;
            }
            let _ = pollster::block_on(wait_until(changed, deadline, &cancellation.token()));
        }
        let (lock, _) = &*self.data;
        let state = lock
            .lock()
            .map_err(|_| session_error("command session output is unavailable"))?;
        let final_state = state.final_state.clone();
        let status = match &final_state {
            None => CommandSessionStatus::Running,
            Some(SessionFinal::Outcome(CommandExecutionOutcome::Completed(output))) => {
                CommandSessionStatus::Exited(
                    output
                        .exit_code
                        .map_or(ProcessExitStatus::Terminated, ProcessExitStatus::Code),
                )
            }
            Some(SessionFinal::Outcome(CommandExecutionOutcome::SandboxDenied(_))) => {
                CommandSessionStatus::SandboxDenied
            }
            Some(SessionFinal::Cancelled) => CommandSessionStatus::Cancelled,
            Some(SessionFinal::TimedOut) => CommandSessionStatus::TimedOut,
            Some(SessionFinal::Terminated) => CommandSessionStatus::Terminated,
            Some(SessionFinal::Failed(message)) => CommandSessionStatus::Failed(message.clone()),
        };
        Ok((
            CommandSessionUpdate {
                session_id: id.clone(),
                status,
                stdout: state.stdout.read(cursor.stdout)?,
                stderr: state.stderr.read(cursor.stderr)?,
            },
            final_state,
        ))
    }

    fn terminate(&self) {
        self.control.store(CONTROL_TERMINATE, Ordering::Release);
        close_process(&self.process);
        self.data.1.notify();
    }
}

fn drive_input(mut stdin: Box<dyn Write + Send>, input: mpsc::Receiver<InputRequest>) {
    while let Ok(request) = input.recv() {
        match request {
            InputRequest::Bytes(bytes) => {
                if stdin.write_all(&bytes).and_then(|_| stdin.flush()).is_err() {
                    break;
                }
            }
            InputRequest::Close => break,
        }
    }
}

#[derive(Clone, Copy)]
enum OutputStream {
    Stdout,
    Stderr,
}

fn spawn_output_reader(
    mut reader: Box<dyn Read + Send>,
    data: Arc<(Mutex<SessionData>, Notify)>,
    stream: OutputStream,
) -> thread::JoinHandle<()> {
    thread::spawn(move || {
        let mut chunk = [0u8; 8192];
        loop {
            let count = match reader.read(&mut chunk) {
                Ok(0) => break,
                Ok(count) => count,
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(_) => break,
            };
            let (lock, changed) = &*data;
            let Ok(mut state) = lock.lock() else {
                break;
            };
            match stream {
                OutputStream::Stdout => state.stdout.append(&chunk[..count]),
                OutputStream::Stderr => state.stderr.append(&chunk[..count]),
            }
            changed.notify();
        }
    })
}

fn close_process(process: &Arc<Mutex<ash_sandboxing::ProcessHandle>>) {
    if let Ok(mut process) = process.lock() {
        let _ = process.close();
    }
}

fn new_session_id() -> Result<CommandSessionId, ExecutionError> {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).map_err(|error| session_error(error.to_string()))?;
    CommandSessionId::new(format!(
        "cmd-{}",
        bytes
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    ))
    .map_err(session_error)
}

fn session_error(message: impl Into<String>) -> ExecutionError {
    ExecutionError::Spawn(message.into())
}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;

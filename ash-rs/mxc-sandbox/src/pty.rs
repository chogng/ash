//! A dedicated helper inherits the PTY; the shared host never replaces its own stdio.
use ash_sandboxing::PreparedCommand;
use ash_sandboxing::ProcessHandle;
use ash_sandboxing::SandboxCommand;
use ash_sandboxing::SandboxDenialTiming;
use ash_sandboxing::SandboxError;
use ash_sandboxing::SandboxLaunch;
use ash_sandboxing::SandboxProcess;
use ash_sandboxing::SandboxProcessExitStatus;
use ash_sandboxing::SandboxScope;
use ash_utils_pty::TerminalSize;
use std::collections::HashMap;
use std::io;
use std::io::Read;
use std::io::Write;
use std::path::PathBuf;
use std::time::Duration;

pub const PTY_HELPER_ARGUMENT: &str = "--ash-mxc-pty";
const REQUEST_ENV: &str = "ASH_MXC_PTY_REQUEST";
// Leave space in Windows' environment block for loader-required system variables.
const MAX_REQUEST_BYTES: usize = 16 * 1024;

pub(super) fn prepare(
    command: &SandboxCommand,
    request: mxc_sdk::SandboxRequest,
    scope: &SandboxScope,
    size: TerminalSize,
) -> Result<PreparedCommand, SandboxError> {
    if size.rows == 0 || size.cols == 0 {
        return Err(crate::unavailable("invalid terminal size"));
    }
    let executable = std::env::current_exe()
        .map_err(|_| crate::unavailable("cannot locate PTY helper executable"))?;
    Ok(PreparedCommand::sandboxed(
        command,
        Launch {
            request,
            executable,
            cwd: command.working_directory().to_owned(),
            scope: scope.clone(),
            size,
        },
    ))
}

/// Internal process entrypoint, dispatched by arg0 before product startup.
/// The parent supplies a bounded, prepared request; diagnostics never echo the payload.
pub fn run_pty_helper() -> Result<i32, String> {
    let encoded = std::env::var(REQUEST_ENV).map_err(|_| "missing PTY launch request")?;
    if encoded.len() > MAX_REQUEST_BYTES {
        return Err("PTY launch request exceeds limit".into());
    }
    let mut child =
        mxc_engine::spawn_inherited_launch(&encoded).map_err(|_| "PTY sandbox launch failed")?;
    let status = child.wait().map_err(|_| "PTY sandbox wait failed")?;
    Ok(if status < 0 { 1 } else { status })
}

struct Launch {
    request: mxc_sdk::SandboxRequest,
    executable: PathBuf,
    cwd: PathBuf,
    scope: SandboxScope,
    size: TerminalSize,
}
impl SandboxLaunch for Launch {
    fn spawn(
        mut self: Box<Self>,
        environment: &[(String, String)],
    ) -> Result<ProcessHandle, SandboxError> {
        crate::policy::validate_paths(&self.cwd, &self.scope)?;
        self.request.set_env(environment.iter().cloned());
        let encoded = mxc_engine::encode_inherited_launch(&self.request)
            .map_err(|_| crate::unavailable("cannot encode PTY launch"))?;
        if encoded.len() > MAX_REQUEST_BYTES {
            return Err(crate::unavailable("PTY launch request exceeds limit"));
        }
        let mut helper_env = HashMap::from([(REQUEST_ENV.to_owned(), encoded)]);
        // Only loader-required variables enter the helper. Workload variables are inside the
        // prepared request, and MXC supplies those after applying the sandbox.
        for key in ["SystemRoot", "WINDIR"] {
            if let Ok(value) = std::env::var(key) {
                helper_env.insert(key.into(), value);
            }
        }
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .map_err(start_error)?;
        let (tx, rx) = std::sync::mpsc::sync_channel(1);
        runtime.spawn(async move {
            let result = match self.executable.to_str() {
                Some(program) => ash_utils_pty::spawn_pty_process(
                    program,
                    &[PTY_HELPER_ARGUMENT.into()],
                    &self.cwd,
                    &helper_env,
                    &None,
                    self.size,
                    &[],
                )
                .await
                .map_err(|_| io::Error::other("could not start PTY helper")),
                None => Err(io::Error::other("PTY executable path is not Unicode")),
            };
            let _ = tx.send(result);
        });
        let spawned = rx
            .recv()
            .map_err(|_| start_error(io::Error::other("PTY launcher stopped")))?
            .map_err(start_error)?;
        let writer = Writer(spawned.session.writer_sender());
        Ok(ProcessHandle::new(Process {
            session: spawned.session,
            stdout: Some(Reader {
                receiver: spawned.stdout_rx,
                buffer: io::Cursor::new(Vec::new()),
            }),
            stdin: Some(writer),
            runtime: Some(runtime),
        }))
    }
}
fn start_error(error: io::Error) -> SandboxError {
    SandboxError::StartFailed {
        timing: SandboxDenialTiming::BeforeProcessStart,
        message: error.to_string(),
    }
}
struct Reader {
    receiver: tokio::sync::mpsc::Receiver<Vec<u8>>,
    buffer: io::Cursor<Vec<u8>>,
}
impl Read for Reader {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        if output.is_empty() {
            return Ok(0);
        }
        loop {
            let size = self.buffer.read(output)?;
            if size != 0 {
                return Ok(size);
            }
            match self.receiver.blocking_recv() {
                Some(bytes) => self.buffer = io::Cursor::new(bytes),
                None => return Ok(0),
            }
        }
    }
}
struct Writer(tokio::sync::mpsc::Sender<Vec<u8>>);
impl Write for Writer {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0
            .blocking_send(bytes.to_vec())
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "PTY input closed"))?;
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
struct Process {
    session: ash_utils_pty::ProcessHandle,
    stdin: Option<Writer>,
    stdout: Option<Reader>,
    runtime: Option<tokio::runtime::Runtime>,
}
impl SandboxProcess for Process {
    fn take_stdin(&mut self) -> Option<Box<dyn Write + Send>> {
        self.stdin.take().map(|writer| Box::new(writer) as _)
    }
    fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
        self.stdout.take().map(|reader| Box::new(reader) as _)
    }
    // A terminal merges stderr into stdout; its separate stderr stream is empty.
    fn take_stderr(&mut self) -> Option<Box<dyn Read + Send>> {
        Some(Box::new(io::empty()))
    }
    fn try_wait(&mut self) -> io::Result<Option<SandboxProcessExitStatus>> {
        let code = self.session.exit_code();
        if code.is_some() {
            self.session.request_terminate();
            self.session.release_pty_handles_after_exit();
        }
        Ok(code.map(SandboxProcessExitStatus::Code))
    }
    fn interrupt(&mut self) -> io::Result<()> {
        self.session.signal(ash_utils_pty::ProcessSignal::Interrupt)
    }
    fn resize(&mut self, size: TerminalSize) -> io::Result<()> {
        self.session.resize(size).map_err(io::Error::other)
    }
    fn close(&mut self) -> io::Result<()> {
        self.session.request_terminate();
        self.stdin.take();
        self.session.close_stdin();
        Ok(())
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        let _ = self.close();
        self.session.terminate();
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_timeout(Duration::from_secs(1));
        }
    }
}

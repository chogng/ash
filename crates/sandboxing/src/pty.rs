use crate::ProcessHandle;
use crate::SandboxDenialTiming;
use crate::SandboxError;
use crate::SandboxProcess;
use crate::SandboxProcessExitStatus;
use ash_utils_pty::TerminalSize;
use std::collections::HashMap;
use std::ffi::OsString;
use std::io;
use std::io::Read;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

impl ProcessHandle {
    /// Starts a previously authorized command with the shared platform PTY launcher.
    /// The returned handle owns the PTY and its process tree for the execution worker.
    pub fn spawn_pty(
        program: OsString,
        arguments: Vec<OsString>,
        cwd: PathBuf,
        environment: HashMap<String, String>,
        size: TerminalSize,
    ) -> Result<Self, SandboxError> {
        if size.rows == 0 || size.cols == 0 {
            return Err(SandboxError::UnsupportedPolicy(
                "invalid terminal size".into(),
            ));
        }
        let invalid_argument =
            |_| SandboxError::UnsupportedPolicy("PTY program and arguments must be Unicode".into());
        let program = program.into_string().map_err(invalid_argument)?;
        let arguments = arguments
            .into_iter()
            .map(OsString::into_string)
            .collect::<Result<Vec<_>, _>>()
            .map_err(invalid_argument)?;
        let runtime = tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .enable_all()
            .build()
            .map_err(start_error)?;
        let (send, receive) = std::sync::mpsc::sync_channel(1);
        runtime.spawn(async move {
            let result = ash_utils_pty::spawn_pty_process(
                &program,
                &arguments,
                &cwd,
                &environment,
                &None,
                size,
            )
            .await;
            let _ = send.send(result);
        });
        let spawned = receive
            .recv()
            .map_err(|_| start_error("PTY launcher stopped"))
            .and_then(|result| result.map_err(start_error));
        let spawned = match spawned {
            Ok(spawned) => spawned,
            Err(error) => {
                runtime.shutdown_background();
                return Err(error);
            }
        };
        let session = Arc::new(spawned.session);
        let child = Arc::clone(&session);
        // The execution worker stops polling on cancellation. Release the old
        // Windows console handles once the child exits so output can reach EOF.
        runtime.spawn(async move {
            if spawned.exit_rx.await.is_ok() {
                child.release_pty_handles_after_exit();
            }
        });
        let stdin = Some(Writer(session.writer_sender()));
        Ok(Self::new(PtyProcess {
            session,
            stdout: Some(Reader {
                receiver: spawned.stdout_rx,
                buffer: io::Cursor::new(Vec::new()),
            }),
            stdin,
            runtime: Some(runtime),
        }))
    }
}

fn start_error(error: impl ToString) -> SandboxError {
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

struct PtyProcess {
    session: Arc<ash_utils_pty::ProcessHandle>,
    stdin: Option<Writer>,
    stdout: Option<Reader>,
    runtime: Option<tokio::runtime::Runtime>,
}

impl SandboxProcess for PtyProcess {
    fn take_stdin(&mut self) -> Option<Box<dyn Write + Send>> {
        self.stdin.take().map(|writer| Box::new(writer) as _)
    }

    fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
        self.stdout.take().map(|reader| Box::new(reader) as _)
    }

    fn take_stderr(&mut self) -> Option<Box<dyn Read + Send>> {
        // A terminal merges stderr into stdout.
        Some(Box::new(io::empty()))
    }

    fn try_wait(&mut self) -> io::Result<Option<SandboxProcessExitStatus>> {
        let code = self.session.exit_code();
        if code.is_some() {
            self.session.request_terminate();
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

impl Drop for PtyProcess {
    fn drop(&mut self) {
        let _ = self.close();
        self.session.terminate();
        self.stdout.take();
        if let Some(runtime) = self.runtime.take() {
            runtime.shutdown_timeout(Duration::from_secs(1));
        }
    }
}

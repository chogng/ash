use super::super::ExecutionLimits;
use super::*;
use ash_async_utils::CancellationSource;
use ash_file_access::Dir;
use ash_sandboxing::PreparedCommand;
use ash_sandboxing::ProcessHandle;
use ash_sandboxing::SandboxCommand;
use ash_sandboxing::SandboxError;
use ash_sandboxing::SandboxKind;
use ash_sandboxing::SandboxLaunch;
use ash_sandboxing::SandboxPolicy;
use ash_sandboxing::SandboxProcess;
use exec_server_protocol::ProcessRead;
use exec_server_protocol::ProcessSnapshot;
use exec_server_protocol::ProcessStart;
use exec_server_protocol::ProcessState;
use exec_server_protocol::Request;
use exec_server_protocol::Response;
use std::io;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::AtomicUsize;

#[test]
fn output_buffer_reports_an_explicit_gap_after_tail_truncation() {
    let mut output = StreamBuffer::new(4);
    output.append(b"abcdef");

    let chunk = output.read(0).unwrap();

    assert_eq!(chunk.text, "cdef");
    assert_eq!(chunk.next_cursor, 6);
    assert!(chunk.gap);
    assert_eq!(output.read(2).unwrap().text, "cdef");
    assert!(output.read(7).is_err());
}

#[test]
fn command_session_id_rejects_non_opaque_values() {
    assert!(CommandSessionId::new("session-1").is_err());
    assert!(CommandSessionId::new("cmd-not-hexadecimal-not-hexadecim").is_err());
    assert!(CommandSessionId::new("cmd-0123456789abcdef0123456789abcdef").is_ok());
}

#[test]
fn process_completion_waits_for_both_delayed_output_streams() {
    let (fixture, backend) = StreamsFixture::new();
    let environment = fixture.start_process_with_output(backend);

    fixture.exit();
    assert_eq!(read_process(&environment).state, ProcessState::Running);
    assert!(!fixture.state.closed.load(Ordering::SeqCst));

    fixture.stdout.send(Ok(b"-tail".to_vec())).unwrap();
    fixture.stdout.send(Ok(Vec::new())).unwrap();
    let snapshot = wait_process(&environment, |snapshot| {
        snapshot.stdout.text == "stdout-prefix-tail"
    });
    assert_eq!(snapshot.state, ProcessState::Running);

    fixture.stderr.send(Ok(b"-tail".to_vec())).unwrap();
    fixture.stderr.send(Ok(Vec::new())).unwrap();
    let snapshot = wait_process(&environment, |snapshot| {
        snapshot.state != ProcessState::Running
    });
    assert_eq!(snapshot.state, ProcessState::Exited { code: Some(7) });
    assert_eq!(snapshot.stdout.text, "stdout-prefix-tail");
    assert_eq!(snapshot.stderr.text, "stderr-prefix-tail");
    fixture.assert_closed();
}

fn assert_process_read_failure(stream: OutputStream) {
    for exited in [true, false] {
        let (fixture, backend) = StreamsFixture::new();
        let environment = fixture.start_process_with_output(backend);

        if exited {
            fixture.exit();
            let other = match stream {
                OutputStream::Stdout => &fixture.stderr,
                OutputStream::Stderr => &fixture.stdout,
            };
            other.send(Ok(Vec::new())).unwrap();
        }

        let sender = match stream {
            OutputStream::Stdout => &fixture.stdout,
            OutputStream::Stderr => &fixture.stderr,
        };
        sender
            .send(Err(io::Error::other("output read failed")))
            .unwrap();
        let snapshot = wait_process(&environment, |snapshot| {
            snapshot.state != ProcessState::Running
        });
        let ProcessState::Failed { message } = &snapshot.state else {
            panic!("expected output failure: {snapshot:?}");
        };
        assert!(message.contains("output read failed"), "{message}");
        assert_eq!(snapshot.stdout.text, "stdout-prefix");
        assert_eq!(snapshot.stderr.text, "stderr-prefix");
        fixture.assert_closed();
    }
}

#[test]
fn stdout_read_failure_fails_the_process_and_closes_all_streams() {
    assert_process_read_failure(OutputStream::Stdout);
}

#[test]
fn stderr_read_failure_fails_the_process_and_closes_all_streams() {
    assert_process_read_failure(OutputStream::Stderr);
}

#[test]
fn managed_session_read_failure_releases_its_proxy_before_reporting_failure() {
    let (fixture, backend) = StreamsFixture::new();
    let executor = ProcessExecutor::new(
        Dir::open_local(fixture.root.path()).unwrap(),
        backend,
        ExecutionLimits {
            timeout: Duration::from_secs(10),
            max_output_bytes: 1024,
        },
    );
    let cancellation = CancellationSource::new();
    let policy = network_proxy::NetworkPolicyHandle::new(|_, _| async {
        network_proxy::NetworkDecision::Allow
    });
    let owner = ProcessSessionOwner::new("streams");
    let id = executor
        .start_retained_session(
            CommandRequest {
                program: "controlled-process".into(),
                arguments: Vec::new(),
                working_directory: ".".into(),
                input: CommandInput::Open,
            },
            CommandExecutionAuthority::Sandboxed(SandboxPolicy::new(
                ash_sandboxing::FileSystemAccess::DirectoryWrite,
                ash_sandboxing::NetworkAccess::Managed,
            )),
            &cancellation.token(),
            None,
            Some(&policy),
            owner.clone(),
            CommandSessionOptions {
                execution_timeout: Duration::from_secs(10),
                wait_budget: Duration::ZERO,
                terminal: None,
            },
        )
        .unwrap();
    assert_eq!(fixture.state.proxy_ports.lock().unwrap().len(), 2);
    fixture
        .stdout
        .send(Err(io::Error::other("proxy workload output failed")))
        .unwrap();
    let update = pollster::block_on(executor.wait_session(
        &owner,
        &id,
        CommandSessionCursor::default(),
        Duration::from_secs(2),
        &cancellation.token(),
    ))
    .unwrap();
    let CommandSessionStatus::Failed(message) = &update.status else {
        panic!("expected output failure: {update:?}");
    };
    assert!(
        message.contains("proxy workload output failed"),
        "{message}"
    );
    fixture.assert_closed();
}

// Control streams at the sandbox boundary so exit can precede either stream's EOF.
struct StreamReader {
    chunks: mpsc::Receiver<io::Result<Vec<u8>>>,
    pending: io::Cursor<Vec<u8>>,
    state: Arc<ProcessStateProbe>,
}

impl Read for StreamReader {
    fn read(&mut self, buffer: &mut [u8]) -> io::Result<usize> {
        if self.pending.position() < self.pending.get_ref().len() as u64 {
            return self.pending.read(buffer);
        }
        let chunk = self
            .chunks
            .recv_timeout(Duration::from_secs(5))
            .map_err(io::Error::other)??;
        self.pending = io::Cursor::new(chunk);
        self.pending.read(buffer)
    }
}

impl Drop for StreamReader {
    fn drop(&mut self) {
        self.state.dropped_streams.fetch_add(1, Ordering::SeqCst);
    }
}

struct InputWriter(Arc<ProcessStateProbe>);

impl Write for InputWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl Drop for InputWriter {
    fn drop(&mut self) {
        self.0.dropped_streams.fetch_add(1, Ordering::SeqCst);
    }
}

#[derive(Default)]
struct ProcessStateProbe {
    exited: AtomicBool,
    closed: AtomicBool,
    dropped_streams: AtomicUsize,
    proxy_ports: Mutex<Vec<u16>>,
}

struct StreamProcess {
    state: Arc<ProcessStateProbe>,
    exit_observed: Option<mpsc::Sender<()>>,
    stdout: Option<StreamReader>,
    stderr: Option<StreamReader>,
    stream_senders: [mpsc::Sender<io::Result<Vec<u8>>>; 2],
}

impl SandboxProcess for StreamProcess {
    fn take_stdin(&mut self) -> Option<Box<dyn Write + Send>> {
        Some(Box::new(InputWriter(Arc::clone(&self.state))))
    }

    fn take_stdout(&mut self) -> Option<Box<dyn Read + Send>> {
        self.stdout.take().map(|reader| Box::new(reader) as _)
    }

    fn take_stderr(&mut self) -> Option<Box<dyn Read + Send>> {
        self.stderr.take().map(|reader| Box::new(reader) as _)
    }

    fn try_wait(&mut self) -> io::Result<Option<SandboxProcessExitStatus>> {
        if self.state.exited.load(Ordering::SeqCst) {
            if let Some(sender) = self.exit_observed.take() {
                let _ = sender.send(());
            }
            Ok(Some(SandboxProcessExitStatus::Code(7)))
        } else if self.state.closed.load(Ordering::SeqCst) {
            Ok(Some(SandboxProcessExitStatus::Terminated))
        } else {
            Ok(None)
        }
    }

    fn close(&mut self) -> io::Result<()> {
        if !self.state.closed.swap(true, Ordering::SeqCst) {
            for sender in &self.stream_senders {
                let _ = sender.send(Ok(Vec::new()));
            }
        }
        Ok(())
    }
}

struct StreamBackend(Mutex<Option<StreamProcess>>);

impl SandboxBackend for StreamBackend {
    fn kind(&self) -> SandboxKind {
        SandboxKind::Restricted
    }

    fn prepare(
        &self,
        command: &SandboxCommand,
        _: SandboxPolicy,
        _: &Dir,
    ) -> Result<PreparedCommand, SandboxError> {
        let process = self.0.lock().unwrap().take().unwrap();
        if let Some(proxy) = command.network_proxy() {
            *process.state.proxy_ports.lock().unwrap() = proxy.ports().to_vec();
        }
        Ok(PreparedCommand::sandboxed(command, StreamLaunch(process)))
    }

    fn prepare_scoped(
        &self,
        command: &SandboxCommand,
        policy: SandboxPolicy,
        scope: &SandboxScope,
    ) -> Result<PreparedCommand, SandboxError> {
        self.prepare(command, policy, scope.command_dir())
    }
}

struct StreamLaunch(StreamProcess);

impl SandboxLaunch for StreamLaunch {
    fn spawn(self: Box<Self>, _: &[(String, String)]) -> Result<ProcessHandle, SandboxError> {
        Ok(ProcessHandle::new(self.0))
    }
}

struct StreamsFixture {
    root: tempfile::TempDir,
    state: Arc<ProcessStateProbe>,
    stdout: mpsc::Sender<io::Result<Vec<u8>>>,
    stderr: mpsc::Sender<io::Result<Vec<u8>>>,
    exit_observed: mpsc::Receiver<()>,
}

impl StreamsFixture {
    fn new() -> (Self, StreamBackend) {
        let state = Arc::new(ProcessStateProbe::default());
        let (stdout, stdout_rx) = mpsc::channel();
        let (stderr, stderr_rx) = mpsc::channel();
        let (exit_tx, exit_observed) = mpsc::channel();
        let reader = |chunks| StreamReader {
            chunks,
            pending: io::Cursor::new(Vec::new()),
            state: Arc::clone(&state),
        };
        let process = StreamProcess {
            state: Arc::clone(&state),
            exit_observed: Some(exit_tx),
            stdout: Some(reader(stdout_rx)),
            stderr: Some(reader(stderr_rx)),
            stream_senders: [stdout.clone(), stderr.clone()],
        };
        (
            Self {
                root: tempfile::tempdir().unwrap(),
                state,
                stdout,
                stderr,
                exit_observed,
            },
            StreamBackend(Mutex::new(Some(process))),
        )
    }

    fn exit(&self) {
        self.state.exited.store(true, Ordering::SeqCst);
        self.exit_observed
            .recv_timeout(Duration::from_secs(2))
            .unwrap();
    }

    fn assert_closed(&self) {
        assert!(self.state.closed.load(Ordering::SeqCst));
        assert_eq!(self.state.dropped_streams.load(Ordering::SeqCst), 3);
        for port in self.state.proxy_ports.lock().unwrap().iter() {
            assert!(std::net::TcpStream::connect(("127.0.0.1", *port)).is_err());
        }
    }

    fn start_process_with_output(&self, backend: StreamBackend) -> crate::LocalEnvironment {
        let environment = crate::LocalEnvironment::open(
            "streams".into(),
            self.root.path(),
            exec_server_protocol::FileAccess::ReadWrite,
            exec_server_protocol::NetworkAccess::Denied,
            Arc::new(backend),
        )
        .unwrap();
        assert!(matches!(
            environment.request(Request::ProcessStart(ProcessStart {
                operation_id: "streams".into(),
                program: "controlled-process".into(),
                arguments: Vec::new(),
                cwd: ".".into(),
                input: exec_server_protocol::ProcessInput::Open,
                timeout_millis: 10000,
            })),
            Response::Process(_)
        ));
        self.stdout.send(Ok(b"stdout-prefix".to_vec())).unwrap();
        self.stderr.send(Ok(b"stderr-prefix".to_vec())).unwrap();
        wait_process(&environment, |snapshot| {
            snapshot.stdout.text == "stdout-prefix" && snapshot.stderr.text == "stderr-prefix"
        });
        environment
    }
}

fn read_process(environment: &crate::LocalEnvironment) -> ProcessSnapshot {
    let Response::Process(snapshot) = environment.request(Request::ProcessRead(ProcessRead {
        operation_id: "streams".into(),
        stdout_cursor: 0,
        stderr_cursor: 0,
        wait_millis: 0,
    })) else {
        panic!("expected process snapshot");
    };
    snapshot
}

fn wait_process(
    environment: &crate::LocalEnvironment,
    ready: impl Fn(&ProcessSnapshot) -> bool,
) -> ProcessSnapshot {
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let snapshot = read_process(environment);
        if ready(&snapshot) {
            return snapshot;
        }
        assert!(Instant::now() < deadline, "{snapshot:?}");
        thread::sleep(Duration::from_millis(5));
    }
}

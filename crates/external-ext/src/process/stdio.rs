use std::collections::BTreeMap;
use std::collections::VecDeque;
use std::io::BufReader;
use std::io::BufWriter;
use std::io::Read;
use std::io::Write;
use std::net::Shutdown;
use std::net::TcpStream;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::thread;
use std::thread::JoinHandle;

use super::ExtensionHostProcess;
use super::ExtensionLaunchCommand;
use super::PendingEntry;
use super::PendingFailure;
use super::PendingHostRequest;
use super::PendingMessage;
use super::node::NodeControlBinding;
use super::reserve_pending;
use crate::ExtensionHostError;
use crate::ExtensionHostLimits;
use crate::ExtensionHostOutputEvent;
use crate::ExtensionHostRequest;
use external_ext_protocol::ExtensionHostStdoutFrame;
use external_ext_protocol::read_frame as read_bounded_line;

#[derive(Default)]
struct OutputEventQueue {
    events: VecDeque<ExtensionHostOutputEvent>,
    bytes: usize,
}

#[derive(Default)]
struct BackgroundClientQueue {
    context: Option<external_ext_protocol::HostEventContext>,
    last_call_id: u64,
    queued: VecDeque<external_ext_protocol::ExtensionBackgroundClientRequest>,
    outstanding: BTreeMap<u64, external_ext_protocol::HostEventContext>,
}

pub(super) struct StdioExtensionHostProcess {
    child: Mutex<Option<ash_sandboxing::ProcessHandle>>,
    writer: Mutex<Option<BufWriter<Box<dyn Write + Send>>>>,
    pending: Arc<Mutex<BTreeMap<u64, PendingEntry>>>,
    exited: Arc<AtomicBool>,
    stderr: Arc<Mutex<Vec<u8>>>,
    output_events: Arc<Mutex<OutputEventQueue>>,
    background: Arc<Mutex<BackgroundClientQueue>>,
    stdout_thread: Mutex<Option<JoinHandle<()>>>,
    stderr_thread: Mutex<Option<JoinHandle<()>>>,
    diagnostic_stdout_thread: Mutex<Option<JoinHandle<()>>>,
    control: Option<TcpStream>,
    limits: ExtensionHostLimits,
}

impl StdioExtensionHostProcess {
    pub(super) fn spawn(
        launch: &ExtensionLaunchCommand,
        limits: &ExtensionHostLimits,
    ) -> Result<Self, ExtensionHostError> {
        #[cfg(windows)]
        if matches!(
            limits.isolation,
            crate::ProcessIsolationPolicy::RequireJavaScriptEnforcement(_)
        ) {
            let command = ash_sandboxing::SandboxCommand::new(
                launch.executable(),
                launch.arguments().iter().cloned(),
                launch.working_directory(),
            );
            let child = windows_sandbox::spawn_locked_process(&command)
                .map_err(|_| ExtensionHostError::IsolationUnavailable)?;
            return Self::from_child(child, limits, None);
        }
        let binding = launch
            .is_vscode()
            .then(NodeControlBinding::new)
            .transpose()?;
        let mut arguments = launch.arguments().to_vec();
        if let Some(binding) = &binding {
            arguments.extend(binding.arguments()?);
        }
        let command = ash_sandboxing::SandboxCommand::new(
            launch.executable(),
            arguments,
            launch.working_directory(),
        );
        let environment = launch
            .environment()
            .iter()
            .map(|(key, value)| {
                let key = key.to_str().ok_or(ExtensionHostError::SpawnFailed)?;
                let value = value.to_str().ok_or(ExtensionHostError::SpawnFailed)?;
                Ok((key.to_owned(), value.to_owned()))
            })
            .collect::<Result<Vec<_>, ExtensionHostError>>()?;
        // Confinement is applied inside the product child before extension code. This
        // shared process handle owns the group and also cleans it up on partial startup.
        let child = ash_sandboxing::PreparedCommand::unrestricted(&command)
            .spawn(&environment)
            .map_err(|_| ExtensionHostError::SpawnFailed)?;
        Self::from_child(child, limits, binding)
    }

    fn from_child(
        mut child: ash_sandboxing::ProcessHandle,
        limits: &ExtensionHostLimits,
        binding: Option<NodeControlBinding>,
    ) -> Result<Self, ExtensionHostError> {
        let stdin = child.take_stdin().ok_or(ExtensionHostError::SpawnFailed)?;
        let stdout = child.take_stdout().ok_or(ExtensionHostError::SpawnFailed)?;
        let stderr_pipe = child.take_stderr().ok_or(ExtensionHostError::SpawnFailed)?;
        let pending = Arc::new(Mutex::new(BTreeMap::new()));
        let exited = Arc::new(AtomicBool::new(false));
        let stderr = Arc::new(Mutex::new(Vec::new()));
        let output_events = Arc::new(Mutex::new(OutputEventQueue::default()));
        let background = Arc::new(Mutex::new(BackgroundClientQueue::default()));
        let control = binding
            .map(|binding| binding.accept(&mut child, limits.startup_timeout))
            .transpose()?;
        let node = control.is_some();
        let (stdin, stdout, diagnostic_stdout_thread): (
            Box<dyn Write + Send>,
            Box<dyn Read + Send>,
            Option<JoinHandle<()>>,
        ) = if let Some(control) = &control {
            // Closing the socket wakes the protocol reader even if extension children retain IO.
            control.set_write_timeout(Some(limits.request_timeout))?;
            drop(stdin);
            let writer = Box::new(control.try_clone()?);
            let reader = Box::new(control.try_clone()?);
            let diagnostic =
                spawn_stderr_reader(stdout, Arc::clone(&stderr), limits.maximum_stderr_bytes);
            (writer, reader, Some(diagnostic))
        } else {
            (stdin, stdout, None)
        };
        let stdout_thread = spawn_stdout_reader(
            stdout,
            Arc::clone(&pending),
            Arc::clone(&exited),
            Arc::clone(&output_events),
            Arc::clone(&background),
            node || limits.isolation == crate::ProcessIsolationPolicy::AuthorizedProduct,
            limits.clone(),
        );
        let stderr_thread = spawn_stderr_reader(
            stderr_pipe,
            Arc::clone(&stderr),
            limits.maximum_stderr_bytes,
        );
        Ok(Self {
            child: Mutex::new(Some(child)),
            writer: Mutex::new(Some(BufWriter::new(stdin))),
            pending,
            exited,
            stderr,
            output_events,
            background,
            stdout_thread: Mutex::new(Some(stdout_thread)),
            stderr_thread: Mutex::new(Some(stderr_thread)),
            diagnostic_stdout_thread: Mutex::new(diagnostic_stdout_thread),
            control,
            limits: limits.clone(),
        })
    }

    fn fail_pending(&self, failure: PendingFailure) {
        fail_all_pending(&self.pending, failure);
    }
}

impl ExtensionHostProcess for StdioExtensionHostProcess {
    fn respond_client(
        &self,
        response: external_ext_protocol::ExtensionClientResponse,
    ) -> Result<(), ExtensionHostError> {
        let mut pending = self
            .pending
            .lock()
            .map_err(|_| ExtensionHostError::HostExited)?;
        let entry = pending
            .get_mut(&response.context.request_id)
            .ok_or(ExtensionHostError::HostExited)?;
        if entry.request.context != response.context
            || !entry.client_ids.contains(&response.call_id)
        {
            return Err(ExtensionHostError::InvalidProtocol(
                "unknown invocation client reply".into(),
            ));
        }
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| ExtensionHostError::HostExited)?;
        let writer = writer.as_mut().ok_or(ExtensionHostError::HostExited)?;
        external_ext_protocol::write_frame(writer, &response, self.limits.maximum_frame_bytes)?;
        entry.client_ids.remove(&response.call_id);
        Ok(())
    }
    fn drain_background_client_requests(
        &self,
    ) -> Vec<external_ext_protocol::ExtensionBackgroundClientRequest> {
        self.background
            .lock()
            .map(|mut queue| queue.queued.drain(..).collect())
            .unwrap_or_default()
    }

    fn respond_background_client(
        &self,
        response: external_ext_protocol::ExtensionBackgroundClientResponse,
    ) -> Result<(), ExtensionHostError> {
        let mut queue = self
            .background
            .lock()
            .map_err(|_| ExtensionHostError::HostExited)?;
        if queue.outstanding.get(&response.call_id) != Some(&response.context) {
            return Err(ExtensionHostError::InvalidProtocol(
                "unknown background client reply".into(),
            ));
        }
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| ExtensionHostError::HostExited)?;
        let writer = writer.as_mut().ok_or(ExtensionHostError::HostExited)?;
        external_ext_protocol::write_frame(writer, &response, self.limits.maximum_frame_bytes)?;
        queue.outstanding.remove(&response.call_id);
        Ok(())
    }

    fn dispatch(
        &self,
        request: ExtensionHostRequest,
    ) -> Result<PendingHostRequest, ExtensionHostError> {
        request.validate(&self.limits.protocol_limits())?;
        if matches!(request.request, crate::HostRequestKind::Initialize(_)) {
            let mut queue = self
                .background
                .lock()
                .map_err(|_| ExtensionHostError::HostExited)?;
            if queue.context.is_some() {
                return Err(ExtensionHostError::InvalidProtocol(
                    "process already initialized".into(),
                ));
            }
            queue.context = Some(external_ext_protocol::HostEventContext::new(
                request.context.incarnation,
                request.context.activation_generation,
            ));
        }
        if self.has_exited() {
            return Err(ExtensionHostError::HostExited);
        }
        let bytes = serde_json::to_vec(&request)
            .map_err(|error| ExtensionHostError::InvalidProtocol(error.to_string()))?;
        let (waiter, sender) = PendingHostRequest::channel(request.context.request_id);
        {
            let mut pending = self
                .pending
                .lock()
                .map_err(|_| ExtensionHostError::HostExited)?;
            let control = matches!(
                &request.request,
                crate::HostRequestKind::Cancel(_)
                    | crate::HostRequestKind::Deactivate
                    | crate::HostRequestKind::Shutdown
            );
            reserve_pending(
                &mut pending,
                PendingEntry {
                    client_ids: std::collections::BTreeSet::new(),
                    last_client_id: 0,
                    request,
                    sender,
                    control,
                },
                self.limits.maximum_in_flight_requests,
                self.limits.maximum_in_flight_control_requests,
            )?;
        }
        let write_result = self
            .writer
            .lock()
            .map_err(|_| ExtensionHostError::HostExited)
            .and_then(|mut writer| {
                let writer = writer.as_mut().ok_or(ExtensionHostError::HostExited)?;
                writer.write_all(&bytes)?;
                writer.write_all(b"\n")?;
                writer.flush()?;
                Ok(())
            });
        if write_result.is_err() {
            self.exited.store(true, Ordering::Release);
            self.fail_pending(PendingFailure::Transport);
            return Err(ExtensionHostError::HostExited);
        }
        Ok(waiter)
    }

    fn has_exited(&self) -> bool {
        if self.exited.load(Ordering::Acquire) {
            return true;
        }
        let Ok(mut child) = self.child.lock() else {
            return true;
        };
        let exited = child
            .as_mut()
            .and_then(|child| child.try_wait().ok())
            .flatten()
            .is_some();
        if exited {
            self.exited.store(true, Ordering::Release);
        }
        exited
    }

    fn terminate(&self) -> Result<(), ExtensionHostError> {
        self.exited.store(true, Ordering::Release);
        if let Some(control) = &self.control {
            let _ = control.shutdown(Shutdown::Both);
        }
        self.writer
            .lock()
            .map_err(|_| ExtensionHostError::HostExited)?
            .take();
        let mut child = self
            .child
            .lock()
            .map_err(|_| ExtensionHostError::HostExited)?;
        if let Some(mut child) = child.take() {
            child.close().map_err(|_| ExtensionHostError::HostExited)?;
        }
        self.fail_pending(PendingFailure::Exited);
        join_thread(&self.stdout_thread);
        join_thread(&self.stderr_thread);
        join_thread(&self.diagnostic_stdout_thread);
        Ok(())
    }

    fn stderr(&self) -> String {
        self.stderr
            .lock()
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .unwrap_or_default()
    }

    fn drain_output_events(&self) -> Vec<ExtensionHostOutputEvent> {
        self.output_events
            .lock()
            .map(|mut queue| {
                queue.bytes = 0;
                queue.events.drain(..).collect()
            })
            .unwrap_or_default()
    }
}

impl Drop for StdioExtensionHostProcess {
    fn drop(&mut self) {
        let _ = self.terminate();
    }
}

fn spawn_stdout_reader(
    stdout: Box<dyn Read + Send>,
    pending: Arc<Mutex<BTreeMap<u64, PendingEntry>>>,
    exited: Arc<AtomicBool>,
    output_events: Arc<Mutex<OutputEventQueue>>,
    background: Arc<Mutex<BackgroundClientQueue>>,
    node: bool,
    limits: ExtensionHostLimits,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name("ash-external-ext-stdout".into())
        .spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let bytes = match read_bounded_line(&mut reader, limits.maximum_frame_bytes) {
                    Ok(Some(bytes)) => bytes,
                    Ok(None) => {
                        fail_all_pending(&pending, PendingFailure::Exited);
                        break;
                    }
                    Err(error) => {
                        fail_all_pending(&pending, PendingFailure::Protocol(error));
                        break;
                    }
                };
                let frame = match serde_json::from_slice::<ExtensionHostStdoutFrame>(&bytes) {
                    Ok(frame) => frame,
                    Err(error) => {
                        fail_all_pending(&pending, PendingFailure::Protocol(error.to_string()));
                        break;
                    }
                };
                if let ExtensionHostStdoutFrame::BackgroundClientRequest(request) = frame {
                    let forwarded = (|| {
                        request
                            .validate(&limits.protocol_limits())
                            .map_err(|error| error.to_string())?;
                        let mut queue = background
                            .lock()
                            .map_err(|_| "background queue lock poisoned".to_owned())?;
                        if !node || queue.context != Some(request.context) {
                            return Err(
                                "background call belongs to an unbound activation".to_owned()
                            );
                        }
                        if request.call_id <= queue.last_call_id
                            || queue.outstanding.len() >= limits.maximum_in_flight_requests
                        {
                            return Err("background client quota exceeded or ID reused".to_owned());
                        }
                        queue.last_call_id = request.call_id;
                        queue.outstanding.insert(request.call_id, request.context);
                        queue.queued.push_back(request);
                        Ok(())
                    })();
                    if let Err(error) = forwarded {
                        fail_all_pending(&pending, PendingFailure::Protocol(error));
                        break;
                    }
                    continue;
                }
                if let ExtensionHostStdoutFrame::ClientRequest(request) = frame {
                    let forwarded = (|| {
                        request
                            .validate(&limits.protocol_limits())
                            .map_err(|error| error.to_string())?;
                        let mut requests = pending
                            .lock()
                            .map_err(|_| "pending requests lock poisoned".to_owned())?;
                        let entry = requests
                            .get_mut(&request.context.request_id)
                            .ok_or_else(|| "client call has no pending invocation".to_owned())?;
                        if entry.request.context != request.context
                            || !matches!(entry.request.request, crate::HostRequestKind::Invoke(_))
                        {
                            return Err("client call belongs to a different invocation".to_owned());
                        }
                        if entry.client_ids.len() >= limits.maximum_in_flight_requests
                            || request.call_id <= entry.last_client_id
                        {
                            return Err("client call quota exceeded or ID reused".to_owned());
                        }
                        entry.last_client_id = request.call_id;
                        entry.client_ids.insert(request.call_id);
                        entry
                            .sender
                            .try_send(Ok(PendingMessage::ClientRequest(request)))
                            .map_err(|_| "client call queue exceeded".to_owned())
                    })();
                    if let Err(error) = forwarded {
                        fail_all_pending(&pending, PendingFailure::Protocol(error));
                        break;
                    }
                    continue;
                }
                let ExtensionHostStdoutFrame::Response(response) = frame else {
                    let ExtensionHostStdoutFrame::Output(event) = frame else {
                        unreachable!();
                    };
                    if let Err(error) = event.validate(&limits.protocol_limits()) {
                        fail_all_pending(&pending, PendingFailure::Protocol(error.to_string()));
                        break;
                    }
                    let Ok(mut queue) = output_events.lock() else {
                        fail_all_pending(&pending, PendingFailure::Transport);
                        break;
                    };
                    if queue.events.len() >= limits.maximum_output_event_count
                        || queue.bytes.saturating_add(bytes.len()) > limits.maximum_output_bytes
                    {
                        fail_all_pending(
                            &pending,
                            PendingFailure::Protocol("Output event quota exceeded".into()),
                        );
                        break;
                    }
                    queue.bytes += bytes.len();
                    queue.events.push_back(event);
                    continue;
                };
                let entry = pending
                    .lock()
                    .ok()
                    .and_then(|mut pending| pending.remove(&response.context.request_id));
                let Some(entry) = entry else {
                    fail_all_pending(
                        &pending,
                        PendingFailure::Protocol("response used an unknown request ID".into()),
                    );
                    break;
                };
                let response = response
                    .validate_for(&entry.request, &limits.protocol_limits())
                    .map(|()| PendingMessage::Response(response))
                    .map_err(|error| PendingFailure::Protocol(error.to_string()));
                let invalid = response.is_err();
                let _ = entry.sender.send(response);
                if invalid {
                    fail_all_pending(
                        &pending,
                        PendingFailure::Protocol("invalid response correlation".into()),
                    );
                    break;
                }
            }
            exited.store(true, Ordering::Release);
        })
        .expect("extension host stdout reader thread must start")
}

fn spawn_stderr_reader(
    mut stderr: Box<dyn Read + Send>,
    captured: Arc<Mutex<Vec<u8>>>,
    maximum_bytes: usize,
) -> JoinHandle<()> {
    thread::Builder::new()
        .name("ash-external-ext-stderr".into())
        .spawn(move || {
            let mut buffer = [0_u8; 8192];
            while let Ok(read) = stderr.read(&mut buffer) {
                if read == 0 {
                    break;
                }
                let Ok(mut captured) = captured.lock() else {
                    continue;
                };
                let remaining = maximum_bytes.saturating_sub(captured.len());
                captured.extend_from_slice(&buffer[..read.min(remaining)]);
            }
        })
        .expect("extension host stderr reader thread must start")
}

fn fail_all_pending(pending: &Mutex<BTreeMap<u64, PendingEntry>>, failure: PendingFailure) {
    let Ok(mut pending) = pending.lock() else {
        return;
    };
    for (_, entry) in std::mem::take(&mut *pending) {
        let _ = entry.sender.send(Err(failure.clone()));
    }
}

fn join_thread(thread: &Mutex<Option<JoinHandle<()>>>) {
    if let Ok(mut thread) = thread.lock()
        && let Some(thread) = thread.take()
    {
        let _ = thread.join();
    }
}

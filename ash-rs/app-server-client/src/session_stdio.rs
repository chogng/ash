use std::collections::BTreeMap;
use std::ffi::OsString;
use std::io::BufReader;
use std::path::Path;
use std::path::PathBuf;
use std::process::ChildStdin;
use std::process::ChildStdout;
use std::process::Command;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::sync::mpsc::Receiver;
use std::sync::mpsc::SyncSender;
use std::thread;

use serde_json::Value;
use ash_app_server_protocol::protocol::common::ClientCapabilities;
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_app_server_protocol::protocol::initialize::InitializeParams;
use ash_app_server_protocol::protocol::initialize::REQUIRED_SESSION_CAPABILITIES;
use ash_app_server_protocol::protocol::initialize::ensure_protocol_compatible;
use ash_app_server_protocol::rpc::JsonRpcId;
use ash_app_server_protocol::rpc::JsonRpcRequest;
use ash_app_server_protocol::rpc::JsonRpcResponse;
use ash_app_server_transport::DEFAULT_MAX_MESSAGE_BYTES;
use ash_app_server_transport::JsonlReader;
use ash_app_server_transport::JsonlWriter;

use super::AppServerEvent;
use super::AppServerEvents;
use super::AppServerSession;
use super::ClientError;
use super::ConnectionCloseReason;
use super::DriverCommand;
use super::EVENT_QUEUE_CAPACITY;
use super::REQUEST_QUEUE_CAPACITY;
use super::SessionTransport;
use super::send_event;

type PendingRequests = Arc<Mutex<BTreeMap<u64, SyncSender<Result<String, ClientError>>>>>;

/// Product composition command used to start an App Server over stdin/stdout.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StdioAppServerCommand {
    executable: PathBuf,
    arguments: Vec<OsString>,
    environment: Vec<(OsString, OsString)>,
    removed_environment: Vec<OsString>,
}

impl StdioAppServerCommand {
    /// Creates an App Server process command from a product-selected executable.
    pub fn new(executable: impl Into<PathBuf>) -> Self {
        Self {
            executable: executable.into(),
            arguments: Vec::new(),
            environment: Vec::new(),
            removed_environment: Vec::new(),
        }
    }

    /// Adds one opaque process argument selected by the product host.
    pub fn with_argument(mut self, argument: impl Into<OsString>) -> Self {
        self.arguments.push(argument.into());
        self
    }

    /// Adds one process environment variable selected by the product composition root.
    pub fn with_environment_variable(
        mut self,
        name: impl Into<OsString>,
        value: impl Into<OsString>,
    ) -> Self {
        let name = name.into();
        self.removed_environment
            .retain(|candidate| candidate != &name);
        self.environment.retain(|(candidate, _)| candidate != &name);
        self.environment.push((name, value.into()));
        self
    }

    /// Prevents one inherited environment variable from reaching the App Server process.
    pub fn without_environment_variable(mut self, name: impl Into<OsString>) -> Self {
        let name = name.into();
        self.environment.retain(|(candidate, _)| candidate != &name);
        self.removed_environment
            .retain(|candidate| candidate != &name);
        self.removed_environment.push(name);
        self
    }

    /// Returns the executable launched by this command.
    pub fn executable(&self) -> &Path {
        &self.executable
    }

    /// Returns the opaque arguments passed directly to the executable.
    pub fn arguments(&self) -> &[OsString] {
        &self.arguments
    }

    /// Returns the command arguments as lossy strings for diagnostics and focused tests.
    pub fn arguments_as_strings(&self) -> Vec<String> {
        self.arguments
            .iter()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect()
    }

    fn environment(&self) -> &[(OsString, OsString)] {
        &self.environment
    }

    fn removed_environment(&self) -> &[OsString] {
        &self.removed_environment
    }
}

pub(super) fn start(
    command: StdioAppServerCommand,
    client_info: ClientInfo,
    capabilities: ClientCapabilities,
) -> Result<AppServerSession, ClientError> {
    let mut process_command = Command::new(command.executable());
    process_command
        .args(command.arguments())
        .envs(command.environment().iter().cloned())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit());
    for name in command.removed_environment() {
        process_command.env_remove(name);
    }
    let mut process = process_command
        .spawn()
        .map_err(|error| ClientError::Transport(error.to_string()))?;
    let stdin = process
        .stdin
        .take()
        .ok_or_else(|| ClientError::Transport("App Server process stdin was unavailable".into()))?;
    let stdout = process.stdout.take().ok_or_else(|| {
        ClientError::Transport("App Server process stdout was unavailable".into())
    })?;
    let (commands, requests) = mpsc::sync_channel(REQUEST_QUEUE_CAPACITY);
    let (event_sender, event_receiver) = mpsc::sync_channel(EVENT_QUEUE_CAPACITY);
    let closing = Arc::new(AtomicBool::new(false));
    let pending = Arc::new(Mutex::new(BTreeMap::new()));

    let writer_pending = Arc::clone(&pending);
    let writer = match thread::Builder::new()
        .name("ash-app-server-stdio-writer".into())
        .spawn(move || write_requests(stdin, requests, writer_pending))
    {
        Ok(writer) => writer,
        Err(error) => {
            let _ = process.kill();
            let _ = process.wait();
            return Err(ClientError::Transport(error.to_string()));
        }
    };

    let reader_pending = Arc::clone(&pending);
    let reader_commands = commands.clone();
    let reader_closing = Arc::clone(&closing);
    let event_pump = match thread::Builder::new()
        .name("ash-app-server-stdio-reader".into())
        .spawn(move || {
            read_output(
                stdout,
                reader_pending,
                event_sender,
                reader_commands,
                reader_closing,
            )
        }) {
        Ok(reader) => reader,
        Err(error) => {
            let _ = commands.send(DriverCommand::Shutdown);
            let _ = process.kill();
            let _ = process.wait();
            let _ = writer.join();
            return Err(ClientError::Transport(error.to_string()));
        }
    };

    let mut client = super::AppServerClient::new(SessionTransport {
        in_process: false,
        commands: commands.clone(),
    });
    let initialized = client.initialize(InitializeParams {
        client_info,
        capabilities,
    });
    match initialized {
        Ok(initialized) => {
            if let Err(compatibility_error) =
                ensure_protocol_compatible(&initialized, REQUIRED_SESSION_CAPABILITIES)
            {
                closing.store(true, Ordering::Release);
                let _ = commands.send(DriverCommand::Shutdown);
                let _ = process.kill();
                let _ = process.wait();
                let _ = writer.join();
                let _ = event_pump.join();
                return Err(ClientError::Protocol(compatibility_error.to_string()));
            }
        }
        Err(error) => {
            closing.store(true, Ordering::Release);
            let _ = commands.send(DriverCommand::Shutdown);
            let _ = process.kill();
            let _ = process.wait();
            let _ = writer.join();
            let _ = event_pump.join();
            return Err(error);
        }
    }

    Ok(AppServerSession {
        client,
        events: Some(AppServerEvents {
            receiver: event_receiver,
        }),
        commands,
        notifications: None,
        closing,
        driver: Some(writer),
        event_pump: Some(event_pump),
        process: Some(process),
    })
}

fn write_requests(stdin: ChildStdin, requests: Receiver<DriverCommand>, pending: PendingRequests) {
    let mut writer = JsonlWriter::new(stdin, DEFAULT_MAX_MESSAGE_BYTES);
    while let Ok(command) = requests.recv() {
        let DriverCommand::Request { request, response } = command else {
            break;
        };
        let request_id = match request_id(&request) {
            Ok(request_id) => request_id,
            Err(error) => {
                let _ = response.send(Err(error));
                continue;
            }
        };
        let inserted = pending
            .lock()
            .map(|mut pending| pending.insert(request_id, response).is_none())
            .unwrap_or(false);
        if !inserted {
            fail_pending(
                &pending,
                ClientError::Transport("App Server pending request state was unavailable".into()),
            );
            return;
        }
        if let Err(error) = writer.write_message(&request) {
            if let Some(response) = pending
                .lock()
                .ok()
                .and_then(|mut pending| pending.remove(&request_id))
            {
                let _ = response.send(Err(ClientError::Transport(error.to_string())));
            }
            fail_pending(
                &pending,
                ClientError::Transport("App Server process input closed".into()),
            );
            return;
        }
    }
    fail_pending(
        &pending,
        ClientError::Transport("App Server session is closed".into()),
    );
}

fn read_output(
    stdout: ChildStdout,
    pending: PendingRequests,
    events: SyncSender<AppServerEvent>,
    commands: SyncSender<DriverCommand>,
    closing: Arc<AtomicBool>,
) {
    #[cfg(windows)]
    let stdout = ash_utils_pty::CancellablePipeReader::new(stdout, Arc::clone(&closing));
    let mut reader = JsonlReader::new(BufReader::new(stdout), DEFAULT_MAX_MESSAGE_BYTES);
    loop {
        let raw = match reader.read_message() {
            Ok(Some(raw)) => raw,
            Ok(None) => {
                close_stream(
                    &pending,
                    &events,
                    &commands,
                    &closing,
                    ConnectionEnd::Closed,
                );
                return;
            }
            Err(error) => {
                close_stream(
                    &pending,
                    &events,
                    &commands,
                    &closing,
                    ConnectionEnd::Protocol(error.to_string()),
                );
                return;
            }
        };
        let value: Value = match serde_json::from_str(&raw) {
            Ok(value) => value,
            Err(error) => {
                close_stream(
                    &pending,
                    &events,
                    &commands,
                    &closing,
                    ConnectionEnd::Protocol(error.to_string()),
                );
                return;
            }
        };
        if value.get("method").is_some() {
            if value.get("id").is_some() {
                close_stream(
                    &pending,
                    &events,
                    &commands,
                    &closing,
                    ConnectionEnd::Protocol("App Server sent an unsupported client request".into()),
                );
                return;
            }
            match super::notification::decode(&raw) {
                Ok(notification) => {
                    if !send_event(
                        &events,
                        AppServerEvent::Notification(notification),
                        &closing,
                    ) {
                        let _ = commands.try_send(DriverCommand::Shutdown);
                        return;
                    }
                }
                Err(error) => {
                    close_stream(
                        &pending,
                        &events,
                        &commands,
                        &closing,
                        ConnectionEnd::Protocol(error.to_string()),
                    );
                    return;
                }
            }
            continue;
        }
        let request_id = match response_id(&raw) {
            Ok(request_id) => request_id,
            Err(error) => {
                close_stream(
                    &pending,
                    &events,
                    &commands,
                    &closing,
                    ConnectionEnd::Protocol(error.to_string()),
                );
                return;
            }
        };
        let response = pending
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(&request_id));
        let Some(response) = response else {
            close_stream(
                &pending,
                &events,
                &commands,
                &closing,
                ConnectionEnd::Protocol(
                    "App Server response did not match a pending request".into(),
                ),
            );
            return;
        };
        let _ = response.send(Ok(raw));
    }
}

fn request_id(raw: &str) -> Result<u64, ClientError> {
    let request: JsonRpcRequest<Value> =
        serde_json::from_str(raw).map_err(|error| ClientError::Protocol(error.to_string()))?;
    request
        .id
        .as_u64()
        .filter(|request_id| *request_id > 0)
        .ok_or_else(|| {
            ClientError::Protocol("App Server request ID must be a positive integer".into())
        })
}

fn response_id(raw: &str) -> Result<u64, ClientError> {
    let response: JsonRpcResponse<Value, Value> =
        serde_json::from_str(raw).map_err(|error| ClientError::Protocol(error.to_string()))?;
    let id = match response {
        JsonRpcResponse::Success(response) => response.id,
        JsonRpcResponse::Failure(response) => response.id,
    };
    match id {
        JsonRpcId::Number(request_id) if request_id > 0 => Ok(request_id),
        JsonRpcId::Number(_) | JsonRpcId::String(_) | JsonRpcId::Null(()) => Err(
            ClientError::Protocol("App Server response ID must be a positive integer".into()),
        ),
    }
}

fn close_stream(
    pending: &PendingRequests,
    events: &SyncSender<AppServerEvent>,
    commands: &SyncSender<DriverCommand>,
    closing: &AtomicBool,
    end: ConnectionEnd,
) {
    let reason = match end {
        ConnectionEnd::Closed if closing.load(Ordering::Acquire) => ConnectionCloseReason::Shutdown,
        ConnectionEnd::Closed => ConnectionCloseReason::DriverStopped,
        ConnectionEnd::Protocol(message) => ConnectionCloseReason::ProtocolFailure(message),
    };
    fail_pending(
        pending,
        ClientError::Transport("App Server process output closed".into()),
    );
    let _ = commands.try_send(DriverCommand::Shutdown);
    let _ = send_event(events, AppServerEvent::ConnectionClosed(reason), closing);
}

fn fail_pending(pending: &PendingRequests, error: ClientError) {
    let pending = pending
        .lock()
        .map(|mut pending| std::mem::take(&mut *pending))
        .unwrap_or_default();
    for (_, response) in pending {
        let _ = response.send(Err(error.clone()));
    }
}

enum ConnectionEnd {
    Closed,
    Protocol(String),
}

#[cfg(test)]
#[path = "session_stdio_tests.rs"]
mod tests;

//! Owns DAP clients and transport lifetimes independently of product connections.
//! App Server binds these handles to its authenticated connection and directory.

mod breakpoints;
mod inspection;
mod lifecycle;
mod sessions;
pub use sessions::DebugSessions;
mod workspace;
pub use workspace::DebugWorkspaceError;
pub use workspace::DebugWorkspaceStore;

use ash_debug_contract::DebugBreakpointIntent;
use ash_debug_contract::DebugBreakpointsSnapshot;
use ash_debug_contract::DebugInspection;
use ash_debug_contract::DebugInspectionResult;
use breakpoints::Breakpoints;
use inspection::Inspections;
pub use lifecycle::DebugCapabilities;
pub use lifecycle::DebugExceptionFilter;
pub use lifecycle::DebugExecutionState;
pub use lifecycle::DebugInitializationPhase;
pub use lifecycle::DebugInitialize;
pub use lifecycle::DebugLaunchRequest;
pub use lifecycle::DebugSessionSnapshot;
use lifecycle::Lifecycle;

use std::collections::HashMap;
use std::collections::VecDeque;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::MutexGuard;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;
use std::time::Duration;

use ash_debug_adapter::DebugAdapterCommand;
use ash_debug_adapter::DebugAdapterConnection;
use ash_debug_adapter::DebugAdapterError;
use ash_debug_adapter::DebugAdapterRead;
use ash_debug_adapter::DebugAdapterService;
use ash_debug_adapter::DebugAdapterSessionId;
use ash_debug_client::DebugClient;
pub use ash_debug_client::DebugClientError;
pub use ash_debug_client::DebugResponse;
use ash_file_access::Authorization;
use serde_json::Value;

const MAX_SESSIONS: usize = 8;
const MAX_OBSERVATIONS: usize = 512;
const MAX_OBSERVATION_BYTES: usize = ash_debug_adapter::MAX_MESSAGE_BYTES;
const MAX_STDERR_BYTES: usize = 64 * 1024;

#[derive(Debug, thiserror::Error)]
pub enum DebugManagerError {
    #[error(transparent)]
    Transport(#[from] DebugAdapterError),
    #[error(transparent)]
    Client(#[from] DebugClientError),
    #[error("debug session was not found")]
    NotFound,
    #[error("debug manager is busy")]
    Busy,
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct DebugSessionId(String);

impl DebugSessionId {
    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// Ordered observations are separate from request completion. A tracker may
/// await another request without holding either protocol pairing or transport IO.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DebugMessageDirection {
    Incoming,
    Outgoing,
}

#[derive(Clone, Debug)]
pub struct DebugMessage {
    pub sequence: u64,
    pub direction: DebugMessageDirection,
    pub message: Value,
}

pub struct DebugRead {
    pub session: DebugSessionSnapshot,
    pub breakpoint_revision: u64,
    pub exceptions: ash_debug_contract::DebugExceptionsSnapshot,
    pub console_revision: u64,
    pub messages: Vec<DebugMessage>,
    pub next_sequence: u64,
    pub output_gap: bool,
    pub stderr: String,
    pub exited: bool,
    pub exit_code: Option<i32>,
    pub protocol_error: Option<String>,
}

enum Transport {
    Adapter(DebugAdapterSessionId),
    Client,
}

struct Session {
    lifecycle: Lifecycle,
    breakpoints: Breakpoints,
    inspections: Inspections,
    public_id: String,
    registry: Option<(Arc<DebugSessions>, u64)>,
    repl_requests: HashMap<u64, u64>,
    adapter_type: String,
    no_debug: bool,
    client: DebugClient,
    transport: Transport,
    observations: VecDeque<(DebugMessage, usize)>,
    observation_bytes: usize,
    next_sequence: u64,
    transport_sequence: u64,
    stderr: String,
    exited: bool,
    exit_code: Option<i32>,
    protocol_error: Option<String>,
}

/// A directory-authorized manager. Its clients own request state; the existing
/// transport runtime retains child-process, stream and framing ownership.
pub struct DebugManager {
    runtime: DebugAdapterService,
    configuration: Authorization,
    execution: Authorization,
    sessions: Mutex<HashMap<DebugSessionId, Arc<Mutex<Session>>>>,
    next_session: AtomicU64,
}

impl DebugManager {
    pub fn new(
        configuration: Authorization,
        execution: Authorization,
        environment: HashMap<String, String>,
    ) -> Result<Self, DebugAdapterError> {
        let runtime =
            DebugAdapterService::new(configuration.clone(), execution.clone(), environment)?;
        Ok(Self {
            runtime,
            configuration,
            execution,
            sessions: Mutex::new(HashMap::new()),
            next_session: AtomicU64::new(1),
        })
    }

    pub fn start(&self, command: DebugAdapterCommand) -> Result<DebugSessionId, DebugManagerError> {
        self.insert(Transport::Adapter(self.runtime.start(command)?))
    }

    pub fn connect(
        &self,
        connection: DebugAdapterConnection,
    ) -> Result<DebugSessionId, DebugManagerError> {
        self.insert(Transport::Adapter(self.runtime.connect(connection)?))
    }

    /// Inline implementations keep IO with their admitted extension instance.
    /// They supply messages to this same client, never a second DAP request table.
    pub fn open_client_transport(&self) -> Result<DebugSessionId, DebugManagerError> {
        self.ensure_active()?;
        self.insert(Transport::Client)
    }

    fn insert(&self, transport: Transport) -> Result<DebugSessionId, DebugManagerError> {
        let mut sessions = self.sessions.lock().map_err(|_| DebugManagerError::Busy)?;
        if sessions.len() >= MAX_SESSIONS {
            if let Transport::Adapter(id) = transport {
                self.runtime.close(&id)?;
            }
            return Err(DebugManagerError::Busy);
        }
        let id = DebugSessionId(format!(
            "debug-session-{}",
            self.next_session.fetch_add(1, Ordering::Relaxed)
        ));
        sessions.insert(
            id.clone(),
            Arc::new(Mutex::new(Session {
                lifecycle: Lifecycle::new(),
                breakpoints: Breakpoints::new(),
                inspections: Inspections::new(),
                registry: None,
                repl_requests: Default::default(),
                public_id: id.as_str().to_owned(),
                adapter_type: String::new(),
                no_debug: false,
                client: DebugClient::new(Duration::from_secs(15)),
                transport,
                observations: VecDeque::new(),
                observation_bytes: 0,
                next_sequence: 0,
                transport_sequence: 0,
                stderr: String::new(),
                exited: false,
                exit_code: None,
                protocol_error: None,
            })),
        );
        Ok(id)
    }

    /// Bind a directory-authorized runtime to an already admitted session.
    pub fn attach(
        self: &Arc<Self>,
        id: &DebugSessionId,
        registry: Arc<DebugSessions>,
        owner: u64,
        no_debug: Option<bool>,
    ) -> Result<(), DebugManagerError> {
        let session = self.session(id)?;
        let mut session = lock(&session)?;
        registry.bind(owner, &session.public_id, self, id.clone(), no_debug)?;
        session.registry = Some((registry, owner));
        Ok(())
    }

    fn end_from_parent(&self, id: &DebugSessionId) {
        if let Ok(session) = self.session(id) {
            if let Ok(mut session) = lock(&session) {
                session
                    .lifecycle
                    .end(Some("Parent debug session ended".to_owned()));
                session.client.close("Parent debug session ended");
                session.exited = true;
                if let Transport::Adapter(id) = &session.transport {
                    let _ = self.runtime.close(id);
                }
            }
        }
    }

    /// Binds the Workbench-facing identity without changing the backend handle.
    pub fn set_public_id(
        &self,
        id: &DebugSessionId,
        public_id: String,
    ) -> Result<(), DebugManagerError> {
        if public_id.is_empty() || public_id.len() > 256 || public_id.contains('\0') {
            return Err(DebugClientError::InvalidMessage.into());
        }
        let session = self.session(id)?;
        let mut session = lock(&session)?;
        if session.lifecycle.snapshot.phase != DebugInitializationPhase::Uninitialized {
            return Err(DebugClientError::InvalidMessage.into());
        }
        session.public_id = public_id;
        Ok(())
    }

    pub fn set_breakpoints(
        &self,
        id: &DebugSessionId,
        version: u64,
        intents: Vec<DebugBreakpointIntent>,
    ) -> Result<(), DebugManagerError> {
        let session = self.session(id)?;
        let mut session = lock(&session)?;
        if session.lifecycle.ended() {
            return Err(DebugClientError::Closed.into());
        }
        session.breakpoints.replace(version, intents)?;
        self.progress(&mut session)
    }

    pub fn breakpoints(
        &self,
        id: &DebugSessionId,
    ) -> Result<DebugBreakpointsSnapshot, DebugManagerError> {
        let session = self.session(id)?;
        let mut session = lock(&session)?;
        self.pump(&mut session)?;
        Ok(session.breakpoints.snapshot())
    }

    pub fn inspect(
        &self,
        id: &DebugSessionId,
        query: DebugInspection,
        expected_epoch: u64,
    ) -> Result<Option<u64>, DebugManagerError> {
        let session = self.session(id)?;
        let mut session = lock(&session)?;
        self.pump(&mut session)?;
        if session.lifecycle.snapshot.state != DebugExecutionState::Stopped
            || session.lifecycle.inspection_epoch() != expected_epoch
        {
            return Ok(None);
        }
        let epoch = session.lifecycle.inspection_epoch();
        let Session {
            inspections,
            client,
            ..
        } = &mut *session;
        let (id, message) = inspections.start(client, epoch, query)?;
        self.send(&mut session, message)?;
        Ok(Some(id))
    }

    pub fn inspection(
        &self,
        id: &DebugSessionId,
        inspection_id: u64,
    ) -> Result<DebugInspectionResult, DebugManagerError> {
        let session = self.session(id)?;
        let mut session = lock(&session)?;
        self.pump(&mut session)?;
        let epoch = session.lifecycle.inspection_epoch();
        Ok(session.inspections.read(inspection_id, epoch)?)
    }

    pub fn initialize(
        &self,
        id: &DebugSessionId,
        options: DebugInitialize,
    ) -> Result<(), DebugManagerError> {
        if options.adapter_id.is_empty()
            || options.adapter_id.len() > 256
            || options.adapter_id.contains('\0')
        {
            return Err(DebugClientError::InvalidMessage.into());
        }
        let session = self.session(id)?;
        let mut session = lock(&session)?;
        session.adapter_type = options.adapter_id.clone();
        session.no_debug = options.arguments.get("noDebug") == Some(&Value::Bool(true));
        let Session {
            lifecycle, client, ..
        } = &mut *session;
        let message = lifecycle.begin(client, options)?;
        self.send(&mut session, message)
    }

    pub fn configure(
        &self,
        id: &DebugSessionId,
        filters: impl Into<Option<Vec<String>>>,
    ) -> Result<(), DebugManagerError> {
        let session = self.session(id)?;
        let mut session = lock(&session)?;
        self.pump(&mut session)?;
        let Session {
            lifecycle, client, ..
        } = &mut *session;
        let message = lifecycle.configure(client, filters.into())?;
        self.send(&mut session, message)?;
        self.progress(&mut session)
    }

    pub fn set_exceptions(
        &self,
        id: &DebugSessionId,
        filters: Vec<String>,
    ) -> Result<u64, DebugManagerError> {
        let session = self.session(id)?;
        let mut session = lock(&session)?;
        self.pump(&mut session)?;
        let version = session.lifecycle.set_exceptions(filters)?;
        self.progress(&mut session)?;
        Ok(version)
    }

    fn progress(&self, session: &mut Session) -> Result<(), DebugManagerError> {
        let result = (|| {
            let mut messages = session.lifecycle.progress(&mut session.client)?;
            if !session.lifecycle.ended() {
                let ready = matches!(
                    session.lifecycle.snapshot.phase,
                    DebugInitializationPhase::Configuring
                        | DebugInitializationPhase::Launching
                        | DebugInitializationPhase::Active
                );
                messages.extend(session.breakpoints.progress(
                    &mut session.client,
                    &session.lifecycle.snapshot.capabilities,
                    &session.public_id,
                    &session.adapter_type,
                    session.no_debug,
                    ready,
                )?);
            }
            messages.extend(
                session
                    .inspections
                    .progress(&mut session.client, session.lifecycle.inspection_epoch())?,
            );
            Ok::<_, DebugClientError>(messages)
        })();
        match result {
            Ok(messages) => {
                for message in messages {
                    self.send(session, message)?;
                }
            }
            Err(error) => session.fail(&error.to_string()),
        }
        if session.lifecycle.ended() {
            if let Some((registry, owner)) = &session.registry {
                let _ = registry.end_observed(*owner, &session.public_id);
            }
        }
        Ok(())
    }

    pub fn request(
        &self,
        id: &DebugSessionId,
        command: &str,
        arguments: Option<Value>,
    ) -> Result<u64, DebugManagerError> {
        let session = self.session(id)?;
        let mut session = lock(&session)?;
        self.pump(&mut session)?;
        if !session.lifecycle.allows(command, &arguments) {
            return Err(DebugClientError::InvalidMessage.into());
        }
        let repl = command == "evaluate"
            && arguments
                .as_ref()
                .and_then(|value| value.get("context"))
                .and_then(Value::as_str)
                == Some("repl");
        let expression = arguments
            .as_ref()
            .and_then(|value| value.get("expression"))
            .and_then(Value::as_str)
            .map(str::to_owned);
        let (request_id, message) = session.client.request(command, arguments)?;
        if repl {
            let epoch = session.lifecycle.inspection_epoch();
            session.repl_requests.insert(request_id, epoch);
            session.output(
                ash_debug_contract::DebugConsoleEntryKind::Input,
                &serde_json::json!({"output":format!("> {}\n", expression.unwrap_or_default())}),
            );
        }
        session.lifecycle.requested(request_id, command);
        self.send(&mut session, message)?;
        Ok(request_id)
    }

    pub fn response(
        &self,
        id: &DebugSessionId,
        request_id: u64,
    ) -> Result<DebugResponse, DebugManagerError> {
        let session = self.session(id)?;
        let mut session = lock(&session)?;
        self.pump(&mut session)?;
        let response = session.client.response(request_id)?;
        if let DebugResponse::Failed(message) = &response {
            if let Some(epoch) = session.repl_requests.remove(&request_id) {
                session.output_at(
                    ash_debug_contract::DebugConsoleEntryKind::Evaluation,
                    &serde_json::json!({"output":format!("{message}\n"),"category":"stderr"}),
                    epoch,
                );
            }
        }
        Ok(session.lifecycle.response(request_id, response))
    }

    pub fn reply(&self, id: &DebugSessionId, value: Value) -> Result<(), DebugManagerError> {
        let session = self.session(id)?;
        let mut session = lock(&session)?;
        let message = session.client.reply(value)?;
        self.send(&mut session, message)
    }

    fn send(&self, session: &mut Session, message: Value) -> Result<(), DebugManagerError> {
        if message.to_string().len() > ash_debug_adapter::MAX_MESSAGE_BYTES {
            session.fail("DAP message exceeds the transport limit");
            return Err(DebugClientError::InvalidMessage.into());
        }
        session.observe(DebugMessageDirection::Outgoing, message.clone());
        match &session.transport {
            Transport::Adapter(id) => {
                if let Err(error) = self.runtime.send(id, &message) {
                    session.fail(&error.to_string());
                    return Err(error.into());
                }
            }
            Transport::Client => {}
        }
        Ok(())
    }

    /// Ingest only the bound inline transport's next page. Adapter processes are
    /// read by the manager and cannot be impersonated by a client-supplied page.
    pub fn input(
        &self,
        id: &DebugSessionId,
        input: DebugAdapterRead,
    ) -> Result<(), DebugManagerError> {
        let session = self.session(id)?;
        let mut session = lock(&session)?;
        if !matches!(session.transport, Transport::Client)
            || input.messages.len() > 128
            || input.stderr.len() > MAX_STDERR_BYTES
        {
            return Err(DebugClientError::InvalidMessage.into());
        }
        // Process/network frames are already bounded by the transport owner.
        // Inline input crosses a separate client boundary and needs that limit here.
        if input
            .messages
            .iter()
            .any(|entry| entry.message.to_string().len() > ash_debug_adapter::MAX_MESSAGE_BYTES)
        {
            session.fail("DAP message exceeds the transport limit");
            return Ok(());
        }
        self.accept(&mut session, input)
    }

    pub fn read(
        &self,
        id: &DebugSessionId,
        after_sequence: u64,
        max_messages: usize,
    ) -> Result<DebugRead, DebugManagerError> {
        if !(1..=128).contains(&max_messages) {
            return Err(DebugClientError::InvalidMessage.into());
        }
        let session = self.session(id)?;
        let mut session = lock(&session)?;
        self.pump(&mut session)?;
        let first = session
            .observations
            .front()
            .map(|(entry, _)| entry.sequence);
        let output_gap = first.map_or(after_sequence < session.next_sequence, |first| {
            after_sequence < first
        });
        let messages: Vec<_> = session
            .observations
            .iter()
            .filter(|(entry, _)| entry.sequence >= after_sequence)
            .take(max_messages)
            .map(|(entry, _)| entry.clone())
            .collect();
        let next_sequence = messages
            .last()
            .map_or(after_sequence, |entry| entry.sequence + 1);
        Ok(DebugRead {
            session: session.lifecycle.snapshot.clone(),
            breakpoint_revision: session.breakpoints.revision(),
            exceptions: session.lifecycle.exceptions.clone(),
            console_revision: session
                .registry
                .as_ref()
                .and_then(|(registry, owner)| registry.revision(*owner, &session.public_id).ok())
                .unwrap_or(0),
            messages,
            next_sequence,
            output_gap,
            stderr: std::mem::take(&mut session.stderr),
            exited: session.exited,
            exit_code: session.exit_code,
            protocol_error: session.protocol_error.clone(),
        })
    }

    fn pump(&self, session: &mut Session) -> Result<(), DebugManagerError> {
        if !session.exited {
            if let Transport::Adapter(id) = &session.transport {
                let input = self.runtime.read(id, session.transport_sequence, 128)?;
                self.accept(session, input)?;
            }
        }
        self.progress(session)
    }

    fn accept(
        &self,
        session: &mut Session,
        input: DebugAdapterRead,
    ) -> Result<(), DebugManagerError> {
        if input.output_gap {
            session.fail("Debug Adapter output exceeded the retained buffer");
            return Ok(());
        }
        let count = input.messages.len();
        session.transport_sequence = input.next_sequence;
        for entry in input.messages {
            if let Err(error) = session.client.accept(&entry.message) {
                session.fail(&error.to_string());
                return Ok(());
            }
            if let Err(error) = session.lifecycle.accept(&entry.message) {
                session.fail(&error.to_string());
                return Ok(());
            }
            if let Err(error) = session
                .breakpoints
                .accept(&entry.message, &session.public_id)
            {
                session.fail(&error.to_string());
                return Ok(());
            }
            if entry.message.get("type").and_then(Value::as_str) == Some("event")
                && entry.message.get("event").and_then(Value::as_str) == Some("output")
            {
                session.output(
                    ash_debug_contract::DebugConsoleEntryKind::Output,
                    &entry.message["body"],
                );
            }
            if entry.message.get("type").and_then(Value::as_str) == Some("response") {
                if let Some(id) = entry.message.get("request_seq").and_then(Value::as_u64) {
                    if let Some(epoch) = session.repl_requests.remove(&id) {
                        let mut body = entry
                            .message
                            .get("body")
                            .and_then(Value::as_object)
                            .cloned()
                            .unwrap_or_default();
                        let success = entry.message.get("success") == Some(&Value::Bool(true));
                        let text = if success {
                            body.get("result")
                                .and_then(Value::as_str)
                                .unwrap_or_default()
                        } else {
                            entry
                                .message
                                .get("message")
                                .and_then(Value::as_str)
                                .unwrap_or("Evaluation failed")
                        };
                        let annotation = if success {
                            body.get("type")
                                .and_then(Value::as_str)
                                .map(|value| format!(" : {value}"))
                                .unwrap_or_default()
                        } else {
                            String::new()
                        };
                        body.insert("output".to_owned(), format!("{text}{annotation}\n").into());
                        if !success {
                            body.insert("category".to_owned(), "stderr".into());
                        }
                        session.output_at(
                            ash_debug_contract::DebugConsoleEntryKind::Evaluation,
                            &Value::Object(body),
                            epoch,
                        );
                    }
                }
            }
            let terminated =
                entry.message["type"] == "event" && entry.message["event"] == "terminated";
            session.observe(DebugMessageDirection::Incoming, entry.message);
            if terminated {
                if let Some(message) = session
                    .lifecycle
                    .disconnect_after_termination(&mut session.client)?
                {
                    // Queue the acknowledgement before a view can observe the
                    // ended snapshot and close this transport.
                    self.send(session, message)?;
                }
            }
            self.progress(session)?;
        }
        // Retain stderr even when request polling, rather than the view reader,
        // happened to collect this transport page.
        if !input.stderr.is_empty() {
            session.output(
                ash_debug_contract::DebugConsoleEntryKind::Output,
                &serde_json::json!({"output": input.stderr, "category":"stderr"}),
            );
        }
        for character in input.stderr.chars() {
            if session.stderr.len() + character.len_utf8() > MAX_STDERR_BYTES {
                break;
            }
            session.stderr.push(character);
        }
        if let Some(error) = input.protocol_error {
            session.fail(&error);
        } else if input.exited && count < 128 {
            session.exited = true;
            session.exit_code = input.exit_code;
            session.lifecycle.end(Some(format!(
                "Debug adapter exited{}",
                input
                    .exit_code
                    .map(|code| format!(" with code {code}"))
                    .unwrap_or_default()
            )));
            session.client.close("Debug adapter exited");
        }
        self.progress(session)
    }

    pub fn close(&self, id: &DebugSessionId) -> Result<(), DebugManagerError> {
        let session = self
            .sessions
            .lock()
            .map_err(|_| DebugManagerError::Busy)?
            .remove(id);
        if let Some(session) = session {
            let mut session = lock(&session)?;
            if let Some((registry, owner)) = &session.registry {
                let _ = registry.end_observed(*owner, &session.public_id);
            }
            session.client.close("Debug session closed");
            session.exited = true;
            match &session.transport {
                Transport::Adapter(id) => self.runtime.close(id)?,
                Transport::Client => {}
            }
        }
        Ok(())
    }

    pub fn terminate_all(&self) {
        let sessions = self
            .sessions
            .lock()
            .map(|mut sessions| {
                sessions
                    .drain()
                    .map(|(_, session)| session)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for session in sessions {
            if let Ok(mut session) = session.lock() {
                if let Some((registry, owner)) = &session.registry {
                    let _ = registry.end_observed(*owner, &session.public_id);
                }
                session.client.close("Debug manager stopped");
                session.exited = true;
            }
        }
        self.runtime.terminate_all();
    }

    fn session(&self, id: &DebugSessionId) -> Result<Arc<Mutex<Session>>, DebugManagerError> {
        self.ensure_active()?;
        self.sessions
            .lock()
            .map_err(|_| DebugManagerError::Busy)?
            .get(id)
            .cloned()
            .ok_or(DebugManagerError::NotFound)
    }

    fn ensure_active(&self) -> Result<(), DebugManagerError> {
        self.configuration
            .ensure_active()
            .map_err(|_| DebugAdapterError::OperationFailed)?;
        self.execution
            .ensure_active()
            .map_err(|_| DebugAdapterError::OperationFailed)?;
        Ok(())
    }
}

impl Session {
    fn output(&self, kind: ash_debug_contract::DebugConsoleEntryKind, body: &Value) {
        self.output_at(kind, body, self.lifecycle.inspection_epoch());
    }

    fn output_at(&self, kind: ash_debug_contract::DebugConsoleEntryKind, body: &Value, epoch: u64) {
        if let Some((registry, owner)) = &self.registry {
            let _ = registry.append_output(*owner, &self.public_id, kind, body, epoch);
        }
    }

    fn observe(&mut self, direction: DebugMessageDirection, message: Value) {
        let bytes = message.to_string().len();
        let entry = DebugMessage {
            sequence: self.next_sequence,
            direction,
            message,
        };
        self.next_sequence += 1;
        self.observation_bytes += bytes;
        self.observations.push_back((entry, bytes));
        while self.observations.len() > MAX_OBSERVATIONS
            || self.observation_bytes > MAX_OBSERVATION_BYTES
        {
            if let Some((_, bytes)) = self.observations.pop_front() {
                self.observation_bytes -= bytes;
            }
        }
    }

    fn fail(&mut self, reason: &str) {
        self.lifecycle.fail(reason);
        self.protocol_error = Some(reason.to_owned());
        self.exited = true;
        self.client.close(reason);
    }
}

fn lock(session: &Mutex<Session>) -> Result<MutexGuard<'_, Session>, DebugManagerError> {
    session.lock().map_err(|_| DebugManagerError::Busy)
}

impl Drop for DebugManager {
    fn drop(&mut self) {
        self.terminate_all();
    }
}

#[cfg(test)]
#[path = "manager_tests.rs"]
mod tests;

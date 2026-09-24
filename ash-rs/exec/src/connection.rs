use crate::EmbeddedAppServerOptions;
use ash_app_server_client::AppServerEvent;
use ash_app_server_client::AppServerEvents;
use ash_app_server_client::AppServerRequestHandle;
use ash_app_server_client::AppServerSession;
use ash_app_server_client::InProcessClientOptions;
use ash_app_server_client::ServerNotification;
use ash_app_server_protocol::protocol::common::ClientCapabilities;
use ash_app_server_protocol::protocol::session::SessionCreateParams;
use ash_app_server_protocol::protocol::session::SessionReadParams;
use ash_app_server_protocol::protocol::session::SessionRequest;
use ash_app_server_protocol::protocol::session::SessionRequestParams;
use ash_app_server_protocol::protocol::session::SessionRequestResult;
use ash_app_server_protocol::protocol::session::SessionThreadReadParams;
use ash_app_server_protocol::protocol::session::SessionThreadSubscribeParams;
use ash_app_server_protocol::protocol::session::SessionThreadUnsubscribeParams;
use ash_app_server_protocol::protocol::turn::InputItem;
use ash_app_server_protocol::protocol::turn::TurnStartResult;
use ash_protocol::ApprovalMode;
use ash_protocol::CommandId;
use ash_protocol::Session;
use ash_protocol::SessionId;
use ash_protocol::Thread;
use ash_protocol::ThreadId;
use ash_protocol::ThreadUpdateEnvelope;
use ash_protocol::TurnId;
use std::fmt;
use std::sync::mpsc::RecvTimeoutError;
use std::time::Duration;

pub(crate) struct ThreadSubscription {
    pub thread: Thread,
    pub updates: Vec<ThreadUpdateEnvelope>,
}

pub(crate) enum ConnectionEvent {
    ThreadUpdated(Box<ThreadUpdateEnvelope>),
    Other,
    TimedOut,
    Closed(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ConnectionError {
    message: String,
}

impl ConnectionError {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
        }
    }
}

impl fmt::Display for ConnectionError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

pub(crate) trait ExecConnection {
    fn create_session(
        &mut self,
        command_id: CommandId,
        title: String,
    ) -> Result<Session, ConnectionError>;

    fn read_session(&mut self, session_id: SessionId) -> Result<Session, ConnectionError>;

    fn fork_thread(
        &mut self,
        command_id: CommandId,
        session_id: SessionId,
        parent_thread_id: ThreadId,
        title: String,
    ) -> Result<ThreadId, ConnectionError>;

    fn read_thread(
        &mut self,
        session_id: SessionId,
        thread_id: ThreadId,
    ) -> Result<Thread, ConnectionError>;

    fn subscribe_thread(
        &mut self,
        session_id: SessionId,
        thread_id: ThreadId,
        after_sequence: u64,
    ) -> Result<ThreadSubscription, ConnectionError>;

    fn unsubscribe_thread(
        &mut self,
        session_id: SessionId,
        thread_id: ThreadId,
    ) -> Result<(), ConnectionError>;

    fn start_turn(
        &mut self,
        command_id: CommandId,
        session_id: SessionId,
        thread_id: ThreadId,
        expected_sequence: u64,
        approval_mode: ApprovalMode,
        input: Vec<InputItem>,
    ) -> Result<TurnStartResult, ConnectionError>;

    fn interrupt_turn(
        &mut self,
        command_id: CommandId,
        session_id: SessionId,
        thread_id: ThreadId,
        turn_id: TurnId,
        expected_sequence: u64,
    ) -> Result<(), ConnectionError>;

    fn poll_event(&mut self, timeout: Duration) -> Result<ConnectionEvent, ConnectionError>;

    fn close(&mut self) -> Result<(), ConnectionError>;
}

pub(crate) struct EmbeddedConnection {
    session: Option<AppServerSession>,
    client: AppServerRequestHandle,
    events: AppServerEvents,
}

impl EmbeddedConnection {
    pub fn start(options: &EmbeddedAppServerOptions) -> Result<Self, ConnectionError> {
        let mut client_options =
            InProcessClientOptions::new(options.profile_root(), options.client_info().clone())
                .with_host_grok_auth()
                .with_capabilities(ClientCapabilities {
                    notifications: Some(true),
                    ..ClientCapabilities::default()
                });
        if let Some(dir_root) = options.dir_root() {
            client_options = client_options.with_dir_root(dir_root);
        }
        let mut session = AppServerSession::start_embedded(client_options)
            .map_err(|error| ConnectionError::new(error.to_string()))?;
        let client = session.client();
        let events = match session.take_events() {
            Ok(events) => events,
            Err(error) => {
                let _ = session.shutdown();
                return Err(ConnectionError::new(error.to_string()));
            }
        };
        Ok(Self {
            session: Some(session),
            client,
            events,
        })
    }

    fn request_thread(
        &mut self,
        params: SessionRequestParams,
        operation: &'static str,
    ) -> Result<ThreadId, ConnectionError> {
        match self
            .client
            .request_session(params)
            .map_err(|error| ConnectionError::new(error.to_string()))?
        {
            SessionRequestResult::Thread(result) => Ok(result.thread_id),
            _ => Err(ConnectionError::new(format!(
                "App Server returned an unexpected result for {operation}"
            ))),
        }
    }
}

impl ExecConnection for EmbeddedConnection {
    fn create_session(
        &mut self,
        command_id: CommandId,
        title: String,
    ) -> Result<Session, ConnectionError> {
        self.client
            .create_session(SessionCreateParams {
                agent_id: None,
                agent: ash_protocol::AgentRoleSelection::Default,
                command_id,
                title,
            })
            .map(|result| result.session)
            .map_err(|error| ConnectionError::new(error.to_string()))
    }

    fn read_session(&mut self, session_id: SessionId) -> Result<Session, ConnectionError> {
        self.client
            .read_session(SessionReadParams { session_id })
            .map(|result| result.session)
            .map_err(|error| ConnectionError::new(error.to_string()))
    }

    fn fork_thread(
        &mut self,
        command_id: CommandId,
        session_id: SessionId,
        parent_thread_id: ThreadId,
        title: String,
    ) -> Result<ThreadId, ConnectionError> {
        self.request_thread(
            SessionRequestParams {
                command_id,
                session_id,
                request: SessionRequest::ForkThread {
                    parent_thread_id,
                    title,
                },
            },
            "ForkThread",
        )
    }

    fn read_thread(
        &mut self,
        session_id: SessionId,
        thread_id: ThreadId,
    ) -> Result<Thread, ConnectionError> {
        self.client
            .read_session_thread(SessionThreadReadParams {
                session_id,
                thread_id,
                history: None,
            })
            .map(|result| result.thread)
            .map_err(|error| ConnectionError::new(error.to_string()))
    }

    fn subscribe_thread(
        &mut self,
        session_id: SessionId,
        thread_id: ThreadId,
        after_sequence: u64,
    ) -> Result<ThreadSubscription, ConnectionError> {
        self.client
            .subscribe_session_thread(SessionThreadSubscribeParams {
                session_id,
                thread_id,
                after_sequence,
                history: None,
            })
            .map(|result| ThreadSubscription {
                thread: result.thread,
                updates: result.updates,
            })
            .map_err(|error| ConnectionError::new(error.to_string()))
    }

    fn unsubscribe_thread(
        &mut self,
        session_id: SessionId,
        thread_id: ThreadId,
    ) -> Result<(), ConnectionError> {
        self.client
            .unsubscribe_session_thread(SessionThreadUnsubscribeParams {
                session_id,
                thread_id,
            })
            .map_err(|error| ConnectionError::new(error.to_string()))
    }

    fn start_turn(
        &mut self,
        command_id: CommandId,
        session_id: SessionId,
        thread_id: ThreadId,
        expected_sequence: u64,
        approval_mode: ApprovalMode,
        input: Vec<InputItem>,
    ) -> Result<TurnStartResult, ConnectionError> {
        match self
            .client
            .request_session(SessionRequestParams {
                command_id,
                session_id,
                request: SessionRequest::StartTurn {
                    thread_id,
                    expected_sequence,
                    approval_mode,
                    tool_mode: None,
                    input,
                },
            })
            .map_err(|error| ConnectionError::new(error.to_string()))?
        {
            SessionRequestResult::Turn(result) => Ok(result),
            _ => Err(ConnectionError::new(
                "App Server returned an unexpected result for StartTurn",
            )),
        }
    }

    fn interrupt_turn(
        &mut self,
        command_id: CommandId,
        session_id: SessionId,
        thread_id: ThreadId,
        turn_id: TurnId,
        expected_sequence: u64,
    ) -> Result<(), ConnectionError> {
        match self
            .client
            .request_session(SessionRequestParams {
                command_id,
                session_id,
                request: SessionRequest::InterruptTurn {
                    thread_id,
                    expected_sequence,
                    turn_id,
                },
            })
            .map_err(|error| ConnectionError::new(error.to_string()))?
        {
            SessionRequestResult::TurnInterrupt(_) => Ok(()),
            _ => Err(ConnectionError::new(
                "App Server returned an unexpected result for InterruptTurn",
            )),
        }
    }

    fn poll_event(&mut self, timeout: Duration) -> Result<ConnectionEvent, ConnectionError> {
        match self.events.recv_timeout(timeout) {
            Ok(AppServerEvent::Notification(ServerNotification::SessionThreadUpdate(update))) => {
                Ok(ConnectionEvent::ThreadUpdated(update))
            }
            Ok(AppServerEvent::Notification(_)) => Ok(ConnectionEvent::Other),
            Ok(AppServerEvent::ConnectionClosed(reason)) => {
                Ok(ConnectionEvent::Closed(format!("{reason:?}")))
            }
            Err(RecvTimeoutError::Timeout) => Ok(ConnectionEvent::TimedOut),
            Err(RecvTimeoutError::Disconnected) => {
                Ok(ConnectionEvent::Closed("event channel disconnected".into()))
            }
        }
    }

    fn close(&mut self) -> Result<(), ConnectionError> {
        match self.session.take() {
            Some(session) => session
                .shutdown()
                .map_err(|error| ConnectionError::new(error.to_string())),
            None => Ok(()),
        }
    }
}

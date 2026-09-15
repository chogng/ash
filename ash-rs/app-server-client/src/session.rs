use crate::in_process::{InProcessClientOptions, open_in_process_app_server};
use crate::{AppServerClient, ClientError, JsonRpcTransport, ServerNotification, notification};
use ash_app_server::{AppServer, ConnectionNotifications};
use ash_app_server_protocol::protocol::common::ClientCapabilities;
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_app_server_protocol::protocol::initialize::InitializeParams;
use ash_app_server_protocol::protocol::initialize::REQUIRED_SESSION_CAPABILITIES;
use ash_app_server_protocol::protocol::initialize::ensure_protocol_compatible;
use std::fmt;
use std::process::Child;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::mpsc::Receiver;
use std::sync::mpsc::RecvTimeoutError;
use std::sync::mpsc::SyncSender;
use std::sync::mpsc::TryRecvError;
use std::sync::mpsc::TrySendError;
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Duration;

#[path = "session_stdio.rs"]
mod stdio;

pub use stdio::StdioAppServerCommand;

const REQUEST_QUEUE_CAPACITY: usize = 64;
const EVENT_QUEUE_CAPACITY: usize = 1_024;
const EVENT_SEND_RETRY: Duration = Duration::from_millis(1);

/// A cloneable request transport backed by an owned App Server session driver.
#[derive(Clone)]
pub struct SessionTransport {
    pub(super) in_process: bool,
    commands: SyncSender<DriverCommand>,
}

/// The cloneable typed request handle delivered by [`AppServerSession`].
pub type AppServerRequestHandle = AppServerClient<SessionTransport>;

/// One event emitted independently from request completion.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AppServerEvent {
    Notification(ServerNotification),
    ConnectionClosed(ConnectionCloseReason),
}

/// The reason an App Server event stream reached its terminal boundary.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConnectionCloseReason {
    Shutdown,
    DriverStopped,
    ProtocolFailure(String),
}

/// The single-consumer event endpoint for one App Server session.
pub struct AppServerEvents {
    receiver: Receiver<AppServerEvent>,
}

impl AppServerEvents {
    /// Blocks until the next event arrives or the connection event channel closes.
    pub fn recv(&self) -> Option<AppServerEvent> {
        self.receiver.recv().ok()
    }

    /// Attempts to receive one event without blocking.
    pub fn try_recv(&self) -> Result<AppServerEvent, TryRecvError> {
        self.receiver.try_recv()
    }

    /// Waits up to `timeout` for the next event.
    pub fn recv_timeout(&self, timeout: Duration) -> Result<AppServerEvent, RecvTimeoutError> {
        self.receiver.recv_timeout(timeout)
    }
}

/// Owns one initialized App Server connection and its background drivers.
///
/// A session can either compose the server in-process or bind the same typed client contract to a
/// child process's JSON Lines stdio stream. The latter is used by Remote host connections.
pub struct AppServerSession {
    client: AppServerRequestHandle,
    events: Option<AppServerEvents>,
    commands: SyncSender<DriverCommand>,
    notifications: Option<Arc<ConnectionNotifications>>,
    closing: Arc<AtomicBool>,
    driver: Option<JoinHandle<()>>,
    event_pump: Option<JoinHandle<()>>,
    process: Option<Child>,
}

impl AppServerSession {
    /// Starts an embedded App Server, initializes its connection, and returns a ready session.
    pub fn start_embedded(options: InProcessClientOptions) -> Result<Self, ClientError> {
        let host = open_in_process_app_server(options)?;
        Self::from_embedded_host(
            Arc::clone(&host.server),
            host.client_info.clone(),
            host.capabilities.clone(),
        )
    }

    /// Starts an App Server process over its JSON Lines stdio protocol.
    ///
    /// The caller chooses the child command. This client owns the child lifetime, validates the
    /// normal initialize/schema handshake, and delivers notifications through the same event API
    /// as an embedded session.
    pub fn start_stdio(
        command: StdioAppServerCommand,
        client_info: ClientInfo,
        capabilities: ClientCapabilities,
    ) -> Result<Self, ClientError> {
        stdio::start(command, client_info, capabilities)
    }

    /// Returns a cloneable typed request handle for this initialized connection.
    pub fn client(&self) -> AppServerRequestHandle {
        self.client.clone()
    }

    /// Returns the operating-system process ID when this session owns a stdio App Server child.
    ///
    /// Embedded sessions share the caller process and therefore return `None`.
    pub fn process_id(&self) -> Option<u32> {
        self.process.as_ref().map(Child::id)
    }

    /// Takes the single event stream for this connection.
    pub fn take_events(&mut self) -> Result<AppServerEvents, TakeEventsError> {
        self.events.take().ok_or(TakeEventsError)
    }

    /// Closes the connection, rejects future requests, and joins both background drivers.
    pub fn shutdown(mut self) -> Result<(), ShutdownError> {
        self.close_and_join()
    }

    fn from_embedded_host(
        server: Arc<AppServer>,
        client_info: ClientInfo,
        capabilities: ClientCapabilities,
    ) -> Result<Self, ClientError> {
        let connection = server.connection();
        let notifications = Arc::new(server.connection_notifications(&connection));
        let delivery = Arc::new(Mutex::new(()));
        let (commands, requests) = mpsc::sync_channel(REQUEST_QUEUE_CAPACITY);
        let (event_sender, event_receiver) = mpsc::sync_channel(EVENT_QUEUE_CAPACITY);
        let closing = Arc::new(AtomicBool::new(false));

        let driver_notifications = Arc::clone(&notifications);
        let driver_server = Arc::clone(&server);
        let driver_delivery = Arc::clone(&delivery);
        let driver = thread::Builder::new()
            .name("ash-app-server-driver".into())
            .spawn(move || {
                drive_connection(
                    driver_server,
                    connection,
                    requests,
                    driver_notifications,
                    driver_delivery,
                )
            })
            .map_err(|error| ClientError::Transport(error.to_string()))?;

        let pump_commands = commands.clone();
        let event_notifications = Arc::clone(&notifications);
        let pump_delivery = Arc::clone(&delivery);
        let pump_closing = Arc::clone(&closing);
        let event_pump = match thread::Builder::new()
            .name("ash-app-server-events".into())
            .spawn(move || {
                pump_notifications(
                    event_notifications,
                    pump_delivery,
                    pump_commands,
                    event_sender,
                    pump_closing,
                )
            }) {
            Ok(pump) => pump,
            Err(error) => {
                let _ = commands.send(DriverCommand::Shutdown);
                notifications.close();
                let _ = driver.join();
                return Err(ClientError::Transport(error.to_string()));
            }
        };

        let mut client = AppServerClient::new(SessionTransport {
            in_process: true,
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
                    notifications.close();
                    let _ = driver.join();
                    let _ = event_pump.join();
                    return Err(ClientError::Protocol(compatibility_error.to_string()));
                }
            }
            Err(error) => {
                closing.store(true, Ordering::Release);
                let _ = commands.send(DriverCommand::Shutdown);
                notifications.close();
                let _ = driver.join();
                let _ = event_pump.join();
                return Err(error);
            }
        }

        Ok(Self {
            client,
            events: Some(AppServerEvents {
                receiver: event_receiver,
            }),
            commands,
            notifications: Some(notifications),
            closing,
            driver: Some(driver),
            event_pump: Some(event_pump),
            process: None,
        })
    }

    fn close_and_join(&mut self) -> Result<(), ShutdownError> {
        let was_closing = self.closing.swap(true, Ordering::AcqRel);
        if !was_closing {
            let _ = self.commands.send(DriverCommand::Shutdown);
        }
        if let Some(notifications) = &self.notifications {
            notifications.close();
        }
        if let Some(mut process) = self.process.take() {
            let _ = process.kill();
            let _ = process.wait();
        }

        let driver_panicked = self
            .driver
            .take()
            .map(JoinHandle::join)
            .transpose()
            .is_err();
        let event_pump_panicked = self
            .event_pump
            .take()
            .map(JoinHandle::join)
            .transpose()
            .is_err();
        if driver_panicked {
            Err(ShutdownError::TaskPanicked("connection driver"))
        } else if event_pump_panicked {
            Err(ShutdownError::TaskPanicked("event pump"))
        } else {
            Ok(())
        }
    }
}

impl Drop for AppServerSession {
    fn drop(&mut self) {
        if !self.closing.swap(true, Ordering::AcqRel) {
            let _ = self.commands.try_send(DriverCommand::Shutdown);
            if let Some(notifications) = &self.notifications {
                notifications.close();
            }
            if let Some(process) = self.process.as_mut() {
                let _ = process.kill();
            }
        }
    }
}

impl JsonRpcTransport for SessionTransport {
    fn round_trip(&mut self, request: &str) -> Result<String, ClientError> {
        let (response_sender, response_receiver) = mpsc::sync_channel(1);
        self.commands
            .send(DriverCommand::Request {
                request: request.into(),
                response: response_sender,
            })
            .map_err(|_| ClientError::Transport("App Server session is closed".into()))?;
        response_receiver
            .recv()
            .map_err(|_| ClientError::Transport("App Server request driver stopped".into()))?
    }

    fn drain_notifications(&mut self) -> Result<Vec<String>, ClientError> {
        Err(ClientError::Protocol(
            "session notifications must be consumed through AppServerEvents".into(),
        ))
    }
}

pub(super) enum DriverCommand {
    Request {
        request: String,
        response: SyncSender<Result<String, ClientError>>,
    },
    Shutdown,
}

fn drive_connection(
    server: Arc<AppServer>,
    mut connection: ash_app_server::ConnectionState,
    requests: Receiver<DriverCommand>,
    notifications: Arc<ConnectionNotifications>,
    delivery: Arc<Mutex<()>>,
) {
    while let Ok(command) = requests.recv() {
        match command {
            DriverCommand::Request { request, response } => match delivery.lock() {
                Ok(_delivery) => {
                    let result = server.handle_json(&mut connection, &request);
                    let _ = response.send(Ok(result));
                }
                Err(_) => {
                    let _ = response.send(Err(ClientError::Transport(
                        "notification delivery lock poisoned".into(),
                    )));
                }
            },
            DriverCommand::Shutdown => break,
        }
    }
    server.close_connection(connection);
    notifications.close();
}

fn pump_notifications(
    notifications: Arc<ConnectionNotifications>,
    delivery: Arc<Mutex<()>>,
    commands: SyncSender<DriverCommand>,
    events: mpsc::SyncSender<AppServerEvent>,
    closing: Arc<AtomicBool>,
) {
    while notifications.wait() {
        let raw_notifications = match delivery.lock() {
            Ok(_delivery) => notifications.drain(),
            Err(_) => {
                let reason = ConnectionCloseReason::ProtocolFailure(
                    "notification delivery lock poisoned".into(),
                );
                let _ = send_event(&events, AppServerEvent::ConnectionClosed(reason), &closing);
                let _ = commands.send(DriverCommand::Shutdown);
                notifications.close();
                return;
            }
        };
        for raw in raw_notifications {
            match notification::decode(&raw) {
                Ok(notification) => {
                    if !send_event(
                        &events,
                        AppServerEvent::Notification(notification),
                        &closing,
                    ) {
                        let _ = commands.send(DriverCommand::Shutdown);
                        notifications.close();
                        return;
                    }
                }
                Err(error) => {
                    let reason = ConnectionCloseReason::ProtocolFailure(error.to_string());
                    let _ = send_event(&events, AppServerEvent::ConnectionClosed(reason), &closing);
                    let _ = commands.send(DriverCommand::Shutdown);
                    notifications.close();
                    return;
                }
            }
        }
    }

    let reason = if closing.load(Ordering::Acquire) {
        ConnectionCloseReason::Shutdown
    } else {
        let _ = commands.try_send(DriverCommand::Shutdown);
        ConnectionCloseReason::DriverStopped
    };
    let _ = send_event(&events, AppServerEvent::ConnectionClosed(reason), &closing);
}

pub(super) fn send_event(
    events: &SyncSender<AppServerEvent>,
    mut event: AppServerEvent,
    closing: &AtomicBool,
) -> bool {
    loop {
        match events.try_send(event) {
            Ok(()) => return true,
            Err(TrySendError::Disconnected(_)) => return false,
            Err(TrySendError::Full(_)) if closing.load(Ordering::Acquire) => return false,
            Err(TrySendError::Full(returned)) => {
                event = returned;
                thread::sleep(EVENT_SEND_RETRY);
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TakeEventsError;

impl fmt::Display for TakeEventsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("App Server event stream has already been taken")
    }
}

impl std::error::Error for TakeEventsError {}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ShutdownError {
    TaskPanicked(&'static str),
}

impl fmt::Display for ShutdownError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::TaskPanicked(task) => write!(formatter, "App Server {task} panicked"),
        }
    }
}

impl std::error::Error for ShutdownError {}

#[cfg(test)]
#[path = "session_tests.rs"]
mod tests;

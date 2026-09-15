//! Remote App Server terminal backend.

use std::num::NonZeroU16;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::sync::mpsc::Receiver;
use std::sync::mpsc::SyncSender;
use std::sync::mpsc::TryRecvError;
use std::thread::JoinHandle;
use std::time::Duration;
use std::time::Instant;

use anyhow::Context;
use anyhow::Result;
use anyhow::anyhow;
use ash_app_server_protocol::protocol::common::ClientCapabilities;
use ash_app_server_protocol::protocol::common::ClientInfo;
use ash_app_server_protocol::protocol::terminal::TerminalAttachParams;
use ash_app_server_protocol::protocol::terminal::TerminalCloseParams;
use ash_app_server_protocol::protocol::terminal::TerminalCreateParams;
use ash_app_server_protocol::protocol::terminal::TerminalLifecycle;
use ash_app_server_protocol::protocol::terminal::TerminalProfileSelection;
use ash_app_server_protocol::protocol::terminal::TerminalReadParams;
use ash_app_server_protocol::protocol::terminal::TerminalReconnectLease;
use ash_app_server_protocol::protocol::terminal::TerminalResizeParams;
use ash_app_server_protocol::protocol::terminal::TerminalWriteParams;
use ash_remote_connections::SshAppServerConnectionOptions;
use ash_terminal::GridSize;
use base64::Engine;

use ash_app_server_client::{AppServerRequestHandle, AppServerSession};

use super::TerminalEventSink;
use super::TerminalRuntimeEvent;
use super::TerminalSessionEvent;
use super::TerminalSessionEventEnvelope;
use super::TerminalSessionKey;

const REMOTE_TERMINAL_POLL_INTERVAL: Duration = Duration::from_millis(25);
const REMOTE_TERMINAL_RECONNECT_BACKOFF: Duration = Duration::from_millis(100);
const REMOTE_TERMINAL_RECONNECT_TIMEOUT_SECONDS: NonZeroU16 =
    NonZeroU16::new(3).expect("non-zero reconnect timeout");
const TERMINAL_RESET: &[u8] = b"\x1bc";

/// Host-owned bridge for one App Server terminal created through the Remote SSH connection.
pub(super) struct RemoteTerminalBackend {
    commands: SyncSender<RemoteTerminalCommand>,
    cancelled: Arc<AtomicBool>,
    worker: Option<JoinHandle<()>>,
}

enum RemoteTerminalCommand {
    Write(String),
    Resize(GridSize),
    Shutdown,
}

impl RemoteTerminalBackend {
    pub(super) fn spawn(
        key: TerminalSessionKey,
        size: GridSize,
        event_sink: TerminalEventSink,
        connection: SshAppServerConnectionOptions,
    ) -> Result<Self> {
        let session = connection
            .connect(
                ClientInfo {
                    name: "app-terminal".into(),
                    version: env!("CARGO_PKG_VERSION").into(),
                },
                ClientCapabilities::default(),
            )
            .map_err(|error| anyhow!(error.to_string()))?;
        let mut client = session.client();
        let created = client
            .terminal_create(TerminalCreateParams {
                dir_id: None,
                rows: size.rows(),
                cols: size.cols(),
                profile: TerminalProfileSelection::Default,
                lifecycle: TerminalLifecycle::Reconnectable,
            })
            .map_err(|error| anyhow!(error.to_string()))?;
        let terminal_id = created.terminal_id;
        let reconnect = created
            .reconnect
            .ok_or_else(|| anyhow!("remote terminal did not return a reconnect lease"))?;
        let (commands, command_receiver) = mpsc::sync_channel(64);
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancelled = Arc::clone(&cancelled);
        let worker = std::thread::Builder::new()
            .name("app-remote-terminal".to_owned())
            .spawn(move || {
                run_remote_terminal(
                    key,
                    RemoteTerminalState {
                        connection,
                        session: Some(session),
                        client,
                        terminal_id,
                        reconnect,
                        size,
                        output_sequence: 0,
                        command_sequence: 0,
                    },
                    command_receiver,
                    event_sink,
                    worker_cancelled,
                )
            })
            .context("could not start remote terminal worker")?;
        Ok(Self {
            commands,
            cancelled,
            worker: Some(worker),
        })
    }

    pub(super) fn send_input(&self, input: Vec<u8>) -> Result<()> {
        let input =
            String::from_utf8(input).context("remote terminal input must be valid UTF-8")?;
        self.commands
            .try_send(RemoteTerminalCommand::Write(input))
            .context("remote terminal input queue is unavailable")
    }

    pub(super) fn resize(&self, size: GridSize) -> Result<()> {
        self.commands
            .try_send(RemoteTerminalCommand::Resize(size))
            .context("remote terminal resize queue is unavailable")
    }
}

impl Drop for RemoteTerminalBackend {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Release);
        let _ = self.commands.try_send(RemoteTerminalCommand::Shutdown);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

struct RemoteTerminalState {
    connection: SshAppServerConnectionOptions,
    session: Option<AppServerSession>,
    client: AppServerRequestHandle,
    terminal_id: String,
    reconnect: TerminalReconnectLease,
    size: GridSize,
    output_sequence: u64,
    command_sequence: u64,
}

enum RemoteTerminalControl {
    Continue,
    Stop,
    Failed,
}

fn run_remote_terminal(
    key: TerminalSessionKey,
    mut state: RemoteTerminalState,
    commands: Receiver<RemoteTerminalCommand>,
    event_sink: TerminalEventSink,
    cancelled: Arc<AtomicBool>,
) {
    loop {
        if cancelled.load(Ordering::Acquire) {
            state.close();
            return;
        }
        loop {
            match commands.try_recv() {
                Ok(command) => {
                    match handle_remote_terminal_command(&mut state, command, cancelled.as_ref()) {
                        RemoteTerminalControl::Continue => {}
                        RemoteTerminalControl::Stop => return,
                        RemoteTerminalControl::Failed => {
                            send_remote_terminal_exit(key, &event_sink);
                            return;
                        }
                    }
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => {
                    state.close();
                    return;
                }
            }
        }

        let read = match state.client.terminal_read(TerminalReadParams {
            dir_id: None,
            terminal_id: state.terminal_id.clone(),
            after_sequence: state.output_sequence,
            after_command_sequence: state.command_sequence,
            max_chunks: 128,
        }) {
            Ok(read) => read,
            Err(_) => {
                if state.reconnect(cancelled.as_ref()).is_ok() {
                    continue;
                }
                send_remote_terminal_exit(key, &event_sink);
                return;
            }
        };
        state.output_sequence = read.next_sequence;
        state.command_sequence = read.next_command_sequence;
        if read.output_gap {
            send_remote_terminal_output(key, &event_sink, TERMINAL_RESET.to_vec());
        }
        for chunk in read.chunks {
            let output = match base64::engine::general_purpose::STANDARD.decode(chunk.data_base64) {
                Ok(output) => output,
                Err(_) => {
                    send_remote_terminal_exit(key, &event_sink);
                    state.close();
                    return;
                }
            };
            if !output.is_empty() {
                send_remote_terminal_output(key, &event_sink, output);
            }
        }
        if read.exited {
            let exit_code = read.exit_code.unwrap_or(-1);
            let _ = event_sink(TerminalRuntimeEvent::Session(
                TerminalSessionEventEnvelope::new(key, TerminalSessionEvent::Exited(exit_code)),
            ));
            state.close();
            return;
        }

        match commands.recv_timeout(REMOTE_TERMINAL_POLL_INTERVAL) {
            Ok(command) => {
                match handle_remote_terminal_command(&mut state, command, cancelled.as_ref()) {
                    RemoteTerminalControl::Continue => {}
                    RemoteTerminalControl::Stop => return,
                    RemoteTerminalControl::Failed => {
                        send_remote_terminal_exit(key, &event_sink);
                        return;
                    }
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                state.close();
                return;
            }
        }
    }
}

fn handle_remote_terminal_command(
    state: &mut RemoteTerminalState,
    command: RemoteTerminalCommand,
    cancelled: &AtomicBool,
) -> RemoteTerminalControl {
    match command {
        RemoteTerminalCommand::Write(data) => {
            if state
                .client
                .terminal_write(TerminalWriteParams {
                    dir_id: None,
                    terminal_id: state.terminal_id.clone(),
                    data,
                })
                .is_err()
                && state.reconnect(cancelled).is_err()
            {
                RemoteTerminalControl::Failed
            } else {
                RemoteTerminalControl::Continue
            }
        }
        RemoteTerminalCommand::Resize(size) => {
            state.size = size;
            if state
                .client
                .terminal_resize(TerminalResizeParams {
                    dir_id: None,
                    terminal_id: state.terminal_id.clone(),
                    rows: size.rows(),
                    cols: size.cols(),
                })
                .is_err()
                && state.reconnect(cancelled).is_err()
            {
                RemoteTerminalControl::Failed
            } else {
                RemoteTerminalControl::Continue
            }
        }
        RemoteTerminalCommand::Shutdown => {
            state.close();
            RemoteTerminalControl::Stop
        }
    }
}

impl RemoteTerminalState {
    fn reconnect(&mut self, cancelled: &AtomicBool) -> Result<(), ()> {
        let grace_period = Duration::from_millis(self.reconnect.reconnect_grace_period_millis);
        let deadline = Instant::now() + grace_period;
        if let Some(session) = self.session.take() {
            let _ = session.shutdown();
        }
        let connection = self
            .connection
            .clone()
            .with_connect_timeout_seconds(REMOTE_TERMINAL_RECONNECT_TIMEOUT_SECONDS);
        while !cancelled.load(Ordering::Acquire) && Instant::now() < deadline {
            match connection.connect(remote_terminal_client_info(), ClientCapabilities::default()) {
                Ok(session) => {
                    let mut client = session.client();
                    match client.terminal_attach(TerminalAttachParams {
                        dir_id: None,
                        terminal_id: self.terminal_id.clone(),
                        reconnect_token: self.reconnect.reconnect_token.clone(),
                        rows: self.size.rows(),
                        cols: self.size.cols(),
                    }) {
                        Ok(attached) => {
                            self.session = Some(session);
                            self.client = client;
                            self.reconnect = attached.reconnect;
                            return Ok(());
                        }
                        Err(_) => {
                            let _ = session.shutdown();
                        }
                    }
                }
                Err(_) => {}
            }
            if Instant::now() < deadline {
                std::thread::sleep(REMOTE_TERMINAL_RECONNECT_BACKOFF);
            }
        }
        Err(())
    }

    fn close(&mut self) {
        let _ = self.client.terminal_close(TerminalCloseParams {
            dir_id: None,
            terminal_id: self.terminal_id.clone(),
        });
        if let Some(session) = self.session.take() {
            let _ = session.shutdown();
        }
    }
}

fn remote_terminal_client_info() -> ClientInfo {
    ClientInfo {
        name: "app-terminal".into(),
        version: env!("CARGO_PKG_VERSION").into(),
    }
}

fn send_remote_terminal_output(
    key: TerminalSessionKey,
    event_sink: &TerminalEventSink,
    output: Vec<u8>,
) {
    let _ = event_sink(TerminalRuntimeEvent::Session(
        TerminalSessionEventEnvelope::new(key, TerminalSessionEvent::Output(output)),
    ));
}

fn send_remote_terminal_exit(key: TerminalSessionKey, event_sink: &TerminalEventSink) {
    let _ = event_sink(TerminalRuntimeEvent::Session(
        TerminalSessionEventEnvelope::new(key, TerminalSessionEvent::Exited(-1)),
    ));
}

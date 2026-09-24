//! App Server connection worker for the Session runtime.

use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::AtomicBool;
use std::sync::atomic::Ordering;
use std::sync::mpsc;
use std::sync::mpsc::Receiver;
use std::sync::mpsc::TryRecvError;
use std::time::Duration;
use std::time::Instant;

use anyhow::Result;
use anyhow::anyhow;
use ash_app_server_client::AppServerEvent;
use ash_app_server_client::AppServerEvents;
use ash_app_server_client::AppServerRequestHandle;
use ash_app_server_client::ServerNotification;
use ash_protocol::SessionId;
use ash_protocol::ThreadUpdate;

use crate::RECONNECT_WINDOW;
use crate::SESSION_UNAVAILABLE_COMMAND_ERROR;
use crate::SessionRuntimeCommand;
use crate::SessionRuntimeEvent;
use crate::SessionRuntimeEventSink;
use crate::SessionRuntimeTarget;
use crate::reconnect_delay_within_window;
use crate::reject_disconnected_command;

const EVENT_POLL_INTERVAL: Duration = Duration::from_millis(25);
mod operations;

use operations::*;

pub(crate) fn run_session_runtime(
    event_sink: SessionRuntimeEventSink,
    commands: Receiver<SessionRuntimeCommand>,
    target: Box<dyn SessionRuntimeTarget>,
    available: Arc<AtomicBool>,
) {
    let result = run_with_recovery(&event_sink, &commands, target, &available);
    if let Err(error) = result {
        let _ = send_event(&event_sink, SessionRuntimeEvent::Error(error.to_string()));
    }
    let _ = send_event(&event_sink, SessionRuntimeEvent::Closed);
}

struct SessionRuntimeFailure {
    error: anyhow::Error,
    retryable: bool,
    connection_was_ready: bool,
}

impl SessionRuntimeFailure {
    fn connection(error: anyhow::Error) -> Self {
        Self {
            error,
            retryable: true,
            connection_was_ready: false,
        }
    }

    fn disconnected(error: anyhow::Error) -> Self {
        Self {
            error,
            retryable: true,
            connection_was_ready: true,
        }
    }

    fn fatal(error: anyhow::Error) -> Self {
        Self {
            error,
            retryable: false,
            connection_was_ready: false,
        }
    }
}

#[derive(Debug)]
pub(super) struct ConnectionLost(String);

impl std::fmt::Display for ConnectionLost {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ConnectionLost {}

#[derive(Debug)]
struct ReconnectEnvCwd {
    cwd: PathBuf,
    preferred_session_id: Option<SessionId>,
}

impl std::fmt::Display for ReconnectEnvCwd {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            formatter,
            "reconnect environment with cwd {}",
            self.cwd.display()
        )
    }
}

impl std::error::Error for ReconnectEnvCwd {}

fn run_with_recovery(
    event_sink: &SessionRuntimeEventSink,
    commands: &Receiver<SessionRuntimeCommand>,
    mut target: Box<dyn SessionRuntimeTarget>,
    available: &AtomicBool,
) -> Result<()> {
    let mut preferred_session_id = None;
    let mut attempts = 0;
    let mut recovery_started = None;
    loop {
        match run_connection(
            event_sink,
            commands,
            target.as_ref(),
            preferred_session_id.as_ref(),
            available,
        ) {
            Ok(()) => return Ok(()),
            Err(failure) if failure.error.downcast_ref::<ReconnectEnvCwd>().is_some() => {
                let reconnect = failure
                    .error
                    .downcast_ref::<ReconnectEnvCwd>()
                    .expect("guard verified reconnect marker");
                target = target
                    .with_cwd(&reconnect.cwd)
                    .map_err(anyhow::Error::msg)?;
                preferred_session_id = reconnect.preferred_session_id.clone();
                attempts = 0;
                recovery_started = None;
            }
            Err(failure) if !target.is_remote() || !failure.retryable => {
                return Err(failure.error);
            }
            Err(failure) => {
                if failure.connection_was_ready || recovery_started.is_none() {
                    attempts = 0;
                    recovery_started = Some(Instant::now());
                }
                let started = recovery_started.expect("retryable failure starts recovery");
                let Some(delay) = reconnect_delay_within_window(started.elapsed(), attempts) else {
                    return Err(anyhow!(
                        "Remote App Server did not recover within {} seconds after {attempts} attempts: {}",
                        RECONNECT_WINDOW.as_secs(),
                        failure.error
                    ));
                };
                attempts += 1;
                send_event(
                    event_sink,
                    SessionRuntimeEvent::Error(format!(
                        "Remote App Server disconnected; reconnecting (attempt {attempts}, {} second recovery window)",
                        RECONNECT_WINDOW.as_secs()
                    )),
                )?;
                if !wait_for_reconnect(event_sink, commands, delay)? {
                    return Ok(());
                }
            }
        }
    }
}

fn wait_for_reconnect(
    event_sink: &SessionRuntimeEventSink,
    commands: &Receiver<SessionRuntimeCommand>,
    delay: Duration,
) -> Result<bool> {
    let started = Instant::now();
    loop {
        let Some(remaining) = delay.checked_sub(started.elapsed()) else {
            return Ok(true);
        };
        match commands.recv_timeout(remaining) {
            Ok(command) => {
                if reject_disconnected_command(command) {
                    return Ok(false);
                }
                send_event(
                    event_sink,
                    SessionRuntimeEvent::Error(SESSION_UNAVAILABLE_COMMAND_ERROR.to_owned()),
                )?;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => return Ok(true),
            Err(mpsc::RecvTimeoutError::Disconnected) => return Ok(false),
        }
    }
}

fn run_connection(
    event_sink: &SessionRuntimeEventSink,
    commands: &Receiver<SessionRuntimeCommand>,
    target: &dyn SessionRuntimeTarget,
    preferred_session_id: Option<&SessionId>,
    available: &AtomicBool,
) -> std::result::Result<(), SessionRuntimeFailure> {
    available.store(false, Ordering::Release);
    let cwd = target.cwd();
    let mut session = target
        .start()
        .map_err(anyhow::Error::msg)
        .map_err(SessionRuntimeFailure::connection)?;
    let mut client = session.client();
    let initialization = client
        .initialization()
        .map_err(|error| SessionRuntimeFailure::connection(anyhow!(error.to_string())))?;
    let slash_commands = initialization.slash_commands.clone();
    let events = session
        .take_events()
        .map_err(|error| SessionRuntimeFailure::connection(anyhow!(error.to_string())))?;
    let (sessions, selected) = ensure_session_catalog(&mut client, cwd, preferred_session_id)
        .map_err(SessionRuntimeFailure::connection)?;
    send_event(event_sink, SessionRuntimeEvent::SessionCatalog(sessions))
        .map_err(SessionRuntimeFailure::fatal)?;
    let models = client
        .list_models()
        .map_err(|error| SessionRuntimeFailure::connection(anyhow!(error.to_string())))?
        .models;
    send_event(
        event_sink,
        SessionRuntimeEvent::Catalog {
            slash_commands,
            models,
        },
    )
    .map_err(SessionRuntimeFailure::fatal)?;
    let mut active = initialize_active_session(&mut client, selected, cwd)
        .map_err(SessionRuntimeFailure::connection)?;
    publish_subscription(event_sink, &active.subscription, &active.thread_id)
        .map_err(SessionRuntimeFailure::fatal)?;
    send_event(event_sink, SessionRuntimeEvent::Connected(client.clone()))
        .map_err(SessionRuntimeFailure::fatal)?;
    available.store(true, Ordering::Release);

    let loop_result = drive(
        event_sink,
        commands,
        &events,
        &mut client,
        &mut active,
        cwd,
        target,
    );
    available.store(false, Ordering::Release);
    send_event(event_sink, SessionRuntimeEvent::Disconnected)
        .map_err(SessionRuntimeFailure::fatal)?;
    match loop_result {
        Ok(()) => {
            let _ = session.shutdown();
            Ok(())
        }
        Err(error) => {
            let _ = session.shutdown();
            if error.downcast_ref::<ConnectionLost>().is_some() {
                Err(SessionRuntimeFailure::disconnected(error))
            } else {
                Err(SessionRuntimeFailure::fatal(error))
            }
        }
    }
}

fn drive(
    event_sink: &SessionRuntimeEventSink,
    commands: &Receiver<SessionRuntimeCommand>,
    events: &AppServerEvents,
    client: &mut AppServerRequestHandle,
    active: &mut ActiveSession,
    cwd: &Path,
    target: &dyn SessionRuntimeTarget,
) -> Result<()> {
    loop {
        loop {
            match commands.try_recv() {
                Ok(SessionRuntimeCommand::CreateSession) => {
                    match create_active_session(client, cwd) {
                        Ok(next) => {
                            unsubscribe_active(event_sink, client, active)?;
                            *active = next;
                            publish_subscription(
                                event_sink,
                                &active.subscription,
                                &active.thread_id,
                            )?;
                        }
                        Err(error) => {
                            send_event(event_sink, SessionRuntimeEvent::Error(error.to_string()))?;
                        }
                    }
                }
                Ok(SessionRuntimeCommand::StopSession {
                    session_id,
                    response,
                }) => {
                    let result =
                        stop_session(client, &session_id).map_err(|error| error.to_string());
                    let _ = response.send(result);
                }
                Ok(SessionRuntimeCommand::ArchiveSession {
                    session_id,
                    response,
                }) => {
                    let result =
                        archive_session(client, &session_id).map_err(|error| error.to_string());
                    let _ = response.send(result);
                }
                Ok(SessionRuntimeCommand::DeleteSession {
                    session_id,
                    response,
                }) => {
                    let result =
                        delete_session(client, &session_id).map_err(|error| error.to_string());
                    let _ = response.send(result);
                }
                Ok(SessionRuntimeCommand::ForkSession {
                    session_id,
                    response,
                }) => {
                    let result =
                        fork_session(client, &session_id).map_err(|error| error.to_string());
                    let _ = response.send(result);
                }
                Ok(SessionRuntimeCommand::SubscribeSession {
                    session_id,
                    response,
                }) => match resolve_session_activation(client, session_id, cwd) {
                    Ok(next) => {
                        unsubscribe_active(event_sink, client, active)?;
                        *active = next;
                        publish_subscription(event_sink, &active.subscription, &active.thread_id)?;
                        let _ = response.send(Ok(()));
                    }
                    Err(error) => {
                        let message = error.to_string();
                        let _ = response.send(Err(message.clone()));
                        send_event(event_sink, SessionRuntimeEvent::Error(message))?;
                    }
                },
                Ok(SessionRuntimeCommand::SubmitAgentMessage(text)) => {
                    submit_agent_message(client, active, text)?;
                }
                Ok(SessionRuntimeCommand::RewriteAgentMessage {
                    operation_id,
                    source_thread_id,
                    before_turn_id,
                    text,
                }) => match rewrite_agent_message(
                    client,
                    active,
                    operation_id,
                    source_thread_id,
                    before_turn_id,
                    text,
                ) {
                    Ok(()) => {
                        publish_subscription(event_sink, &active.subscription, &active.thread_id)?
                    }
                    Err(error) => {
                        send_event(event_sink, SessionRuntimeEvent::Error(error.to_string()))?;
                    }
                },
                Ok(SessionRuntimeCommand::SubmitShellCommand(command)) => {
                    submit_shell_command(client, active, command)?;
                }
                Ok(SessionRuntimeCommand::SetModel(model)) => {
                    set_model(client, model)?;
                }
                Ok(SessionRuntimeCommand::SelectNextApprovalMode(approval_mode)) => {
                    select_next_approval_mode(active, approval_mode);
                }
                Ok(SessionRuntimeCommand::Refresh) => {
                    refresh_active_subscription(event_sink, client, active)?;
                }
                Ok(SessionRuntimeCommand::SetEnvCwd { cwd, response }) => {
                    match prepare_cwd_reconnect(target, cwd.clone()) {
                        Ok(prepared) => {
                            let cwd = prepared.cwd.clone();
                            let _ = response.send(Ok(prepared));
                            return Err(anyhow!(ReconnectEnvCwd {
                                cwd,
                                preferred_session_id: None,
                            }));
                        }
                        Err(error) => {
                            let _ = response.send(Err(error.to_string()));
                        }
                    }
                }
                Ok(SessionRuntimeCommand::Shutdown) => return Ok(()),
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return Ok(()),
            }
        }

        match events.recv_timeout(EVENT_POLL_INTERVAL) {
            Ok(AppServerEvent::Notification(ServerNotification::SessionChanged(update))) => {
                if update.session_id == active.session_id {
                    refresh_active_subscription(event_sink, client, active)?;
                }
            }
            Ok(AppServerEvent::Notification(ServerNotification::SessionThreadUpdate(update))) => {
                if update.session_id == active.session_id && update.thread_id == active.thread_id {
                    active.sequence = active.sequence.max(update.durable_sequence);
                    if matches!(&update.update, ThreadUpdate::Committed { .. }) {
                        refresh_active_subscription(event_sink, client, active)?;
                    }
                }
            }
            Ok(AppServerEvent::Notification(
                ServerNotification::SessionThreadTranscriptUpdate(update),
            )) => {
                if update.session_id == active.session_id && update.thread_id == active.thread_id {
                    if update.revision <= active.transcript_revision {
                        continue;
                    }
                    let is_next =
                        active.transcript_revision.checked_add(1) == Some(update.revision);
                    let resets_transient_state = update.changes.iter().any(|change| {
                        matches!(
                            change,
                            ash_app_server_protocol::protocol::transcript::ThreadTranscriptChange::ClearTransient
                        )
                    });
                    if !is_next && !resets_transient_state {
                        refresh_active_subscription(event_sink, client, active)?;
                    } else {
                        active.transcript_revision = update.revision;
                        send_event(
                            event_sink,
                            SessionRuntimeEvent::TranscriptUpdate(Box::new(update)),
                        )?;
                    }
                }
            }
            Ok(AppServerEvent::Notification(notification)) => {
                send_event(event_sink, SessionRuntimeEvent::Notification(notification))?;
            }
            Ok(AppServerEvent::ConnectionClosed(reason)) => {
                return Err(
                    ConnectionLost(format!("App Server connection closed: {reason:?}")).into(),
                );
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                return Err(ConnectionLost("App Server event stream disconnected".into()).into());
            }
        }
    }
}

fn refresh_active_subscription(
    event_sink: &SessionRuntimeEventSink,
    client: &mut AppServerRequestHandle,
    active: &mut ActiveSession,
) -> Result<()> {
    let subscription = subscribe_session(client, &active.session_id)?;
    let thread = active_thread_entry(&subscription, &active.thread_id)?;
    active.sequence = thread.thread.sequence;
    active.transcript_revision = thread.transcript.revision;
    active.subscription = subscription;
    publish_subscription(event_sink, &active.subscription, &active.thread_id)
}

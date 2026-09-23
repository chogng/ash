//! Session and Thread operations executed by the runtime worker.

use std::path::Path;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::atomic::Ordering;

use anyhow::Result;
use anyhow::anyhow;
use ash_app_server_client::AppServerRequestHandle;
use ash_app_server_client::ClientError;
use ash_app_server_protocol::protocol::common::CommandId;
use ash_app_server_protocol::protocol::config::ConfigUpdateParams;
use ash_app_server_protocol::protocol::config::ModelRefDto;
use ash_app_server_protocol::protocol::session::SessionCreateParams;
use ash_app_server_protocol::protocol::session::SessionReadParams;
use ash_app_server_protocol::protocol::session::SessionRequest;
use ash_app_server_protocol::protocol::session::SessionRequestParams;
use ash_app_server_protocol::protocol::session::SessionRequestResult;
use ash_app_server_protocol::protocol::session::SessionSubscribeParams;
use ash_app_server_protocol::protocol::session::SessionSubscribeResult;
use ash_app_server_protocol::protocol::session::SessionThreadProjection;
use ash_app_server_protocol::protocol::session::SessionUnsubscribeParams;
use ash_app_server_protocol::protocol::turn::InputItem;
use ash_protocol::ApprovalMode;
use ash_protocol::ModelRef;
use ash_protocol::Patch;
use ash_protocol::Session;
use ash_protocol::SessionId;
use ash_protocol::SessionStatus;
use ash_protocol::SessionThread;
use ash_protocol::ThreadId;
use ash_protocol::ThreadStatus;
use ash_protocol::TurnId;

use super::ConnectionLost;
use crate::EnvCwdSetResult;
use crate::SessionRuntimeEvent;
use crate::SessionRuntimeEventSink;
use crate::SessionRuntimeTarget;

pub(super) fn unsubscribe_active(
    event_sink: &SessionRuntimeEventSink,
    client: &mut AppServerRequestHandle,
    active: &ActiveSession,
) -> Result<()> {
    if let Err(error) = client.unsubscribe_session(SessionUnsubscribeParams {
        session_id: active.session_id.clone(),
    }) {
        send_event(event_sink, SessionRuntimeEvent::Error(error.to_string()))?;
    }
    Ok(())
}

fn client_error(error: ClientError) -> anyhow::Error {
    match error {
        ClientError::Transport(message) => ConnectionLost(message).into(),
        error => anyhow!(error.to_string()),
    }
}

pub(super) struct ActiveSession {
    pub(super) session_id: SessionId,
    pub(super) thread_id: ThreadId,
    pub(super) sequence: u64,
    pub(super) transcript_revision: u64,
    pub(super) approval_mode: ApprovalMode,
    pub(super) subscription: SessionSubscribeResult,
}

pub(super) fn ensure_session_catalog(
    client: &mut AppServerRequestHandle,
    cwd: &Path,
    preferred_session_id: Option<&SessionId>,
) -> Result<(Vec<Session>, Session)> {
    let mut sessions = client.list_sessions().map_err(client_error)?.sessions;
    sessions.sort_by(|left, right| {
        left.title
            .cmp(&right.title)
            .then_with(|| left.session_id.as_str().cmp(right.session_id.as_str()))
    });
    let session = preferred_session_id
        .and_then(|preferred| {
            sessions.iter().find(|session| {
                &session.session_id == preferred && session.status == SessionStatus::Active
            })
        })
        .or_else(|| {
            sessions
                .iter()
                .find(|session| session.status == SessionStatus::Active)
        })
        .cloned();
    let session = match session {
        Some(session) => session,
        None => {
            let session = create_session(client, cwd)?;
            sessions.push(session.clone());
            session
        }
    };
    sessions.retain(|session| session.status == SessionStatus::Active);
    Ok((sessions, session))
}

pub(super) fn initialize_active_session(
    client: &mut AppServerRequestHandle,
    session: Session,
    cwd: &Path,
) -> Result<ActiveSession> {
    initialize_session(client, session, cwd)
}

pub(super) fn create_active_session(
    client: &mut AppServerRequestHandle,
    cwd: &Path,
) -> Result<ActiveSession> {
    let session = create_session(client, cwd)?;
    initialize_session(client, session, cwd)
}

pub(super) fn resolve_session_activation(
    client: &mut AppServerRequestHandle,
    session_id: SessionId,
    cwd: &Path,
) -> Result<ActiveSession> {
    let session = client
        .read_session(SessionReadParams { session_id })
        .map_err(client_error)?
        .session;
    if session.status != SessionStatus::Active {
        return Err(anyhow!("cannot activate a non-active Session"));
    }
    initialize_session(client, session, cwd)
}

fn initialize_session(
    client: &mut AppServerRequestHandle,
    session: Session,
    cwd: &Path,
) -> Result<ActiveSession> {
    let (session, thread_id) = ensure_session_thread(client, session, cwd)?;
    let subscription = subscribe_session(client, &session.session_id)?;
    let thread = active_thread_entry(&subscription, &thread_id)?;
    let sequence = thread.thread.sequence;
    let transcript_revision = thread.transcript.revision;
    Ok(ActiveSession {
        session_id: subscription.session.session_id.clone(),
        thread_id,
        sequence,
        transcript_revision,
        approval_mode: ApprovalMode::AskPermissions,
        subscription,
    })
}

fn create_session(client: &mut AppServerRequestHandle, cwd: &Path) -> Result<Session> {
    client
        .create_session(SessionCreateParams {
            agent_id: None,
            agent: ash_protocol::AgentRoleSelection::Default,
            command_id: next_command_id("session"),
            title: cwd_title(cwd),
        })
        .map(|result| result.session)
        .map_err(client_error)
}

pub(super) fn stop_session(
    client: &mut AppServerRequestHandle,
    session_id: &SessionId,
) -> Result<()> {
    let session = client
        .read_session(SessionReadParams {
            session_id: session_id.clone(),
        })
        .map_err(client_error)?
        .session;
    if session.status != SessionStatus::Active {
        return Err(anyhow!("Session is not active: {session_id}"));
    }
    let result = client
        .request_session(SessionRequestParams {
            command_id: next_command_id("stop-session"),
            session_id: session.session_id,
            request: SessionRequest::Stop,
        })
        .map_err(client_error)?;
    if !matches!(result, SessionRequestResult::Session(_)) {
        return Err(anyhow!(
            "Session stop request returned an unexpected result"
        ));
    }
    Ok(())
}

pub(super) fn archive_session(
    client: &mut AppServerRequestHandle,
    session_id: &SessionId,
) -> Result<()> {
    let result = client
        .request_session(SessionRequestParams {
            command_id: next_command_id("archive-session"),
            session_id: session_id.clone(),
            request: SessionRequest::Archive,
        })
        .map_err(client_error)?;
    if !matches!(result, SessionRequestResult::Session(_)) {
        return Err(anyhow!(
            "Session archive request returned an unexpected result"
        ));
    }
    Ok(())
}

pub(super) fn delete_session(
    client: &mut AppServerRequestHandle,
    session_id: &SessionId,
) -> Result<()> {
    let result = client
        .request_session(SessionRequestParams {
            command_id: next_command_id("delete-session"),
            session_id: session_id.clone(),
            request: SessionRequest::Delete,
        })
        .map_err(client_error)?;
    match result {
        SessionRequestResult::Deleted(deleted) if &deleted == session_id => Ok(()),
        _ => Err(anyhow!(
            "Session delete request returned an unexpected result"
        )),
    }
}

pub(super) fn fork_session(
    client: &mut AppServerRequestHandle,
    session_id: &SessionId,
) -> Result<()> {
    let session = client
        .read_session(SessionReadParams {
            session_id: session_id.clone(),
        })
        .map_err(client_error)?
        .session;
    if session.status != SessionStatus::Active {
        return Err(anyhow!("Session is not active: {session_id}"));
    }
    let parent = selected_conversation_thread(&session)
        .ok_or_else(|| anyhow!("Session has no conversation to fork: {session_id}"))?;
    let result = client
        .request_session(SessionRequestParams {
            command_id: next_command_id("fork-session"),
            session_id: session_id.clone(),
            request: SessionRequest::ForkThread {
                parent_thread_id: parent.thread_id.clone(),
                title: format!("{} (fork)", parent.title),
            },
        })
        .map_err(client_error)?;
    if !matches!(result, SessionRequestResult::Thread(_)) {
        return Err(anyhow!(
            "Session fork request returned an unexpected result"
        ));
    }
    Ok(())
}

fn ensure_session_thread(
    client: &mut AppServerRequestHandle,
    session: Session,
    cwd: &Path,
) -> Result<(Session, ThreadId)> {
    if let Some(thread) = selected_conversation_thread(&session) {
        return Ok((session.clone(), thread.thread_id.clone()));
    }
    let result = client
        .request_session(SessionRequestParams {
            command_id: next_command_id("thread"),
            session_id: session.session_id,
            request: SessionRequest::CreateThread {
                agent_id: None,
                title: cwd_title(cwd),
            },
        })
        .map_err(client_error)?;
    let SessionRequestResult::Thread(result) = result else {
        return Err(anyhow!(
            "Session request returned an unexpected Thread result"
        ));
    };
    Ok((result.session, result.thread_id))
}

fn selected_conversation_thread<'a>(session: &'a Session) -> Option<&'a SessionThread> {
    session
        .threads
        .iter()
        .find(|thread| thread.status == ThreadStatus::Active && is_root_thread(thread))
        .or_else(|| {
            session.threads.iter().rev().find(|thread| {
                thread.status == ThreadStatus::Active && is_conversation_thread(thread)
            })
        })
}

fn is_root_thread(thread: &SessionThread) -> bool {
    thread.parent_thread_id.is_none() && thread.forked_from_id.is_none()
}

fn is_conversation_thread(thread: &SessionThread) -> bool {
    is_root_thread(thread) || thread.forked_from_id.is_some()
}

pub(super) fn subscribe_session(
    client: &mut AppServerRequestHandle,
    session_id: &SessionId,
) -> Result<SessionSubscribeResult> {
    client
        .subscribe_session(SessionSubscribeParams {
            session_id: session_id.clone(),
        })
        .map_err(client_error)
}

pub(super) fn active_thread_entry<'a>(
    subscription: &'a SessionSubscribeResult,
    thread_id: &ThreadId,
) -> Result<&'a SessionThreadProjection> {
    subscription
        .thread_projections
        .iter()
        .find(|entry| &entry.thread.thread_id == thread_id)
        .ok_or_else(|| anyhow!("Session subscription did not include active Thread"))
}

pub(super) fn publish_subscription(
    event_sink: &SessionRuntimeEventSink,
    subscription: &SessionSubscribeResult,
    thread_id: &ThreadId,
) -> Result<()> {
    let thread = active_thread_entry(subscription, thread_id)?;
    send_event(
        event_sink,
        SessionRuntimeEvent::Snapshot {
            session: subscription.session.clone(),
            thread: thread.thread.clone(),
            transcript: thread.transcript.clone(),
        },
    )
}

pub(super) fn submit_agent_message(
    client: &mut AppServerRequestHandle,
    active: &mut ActiveSession,
    text: String,
) -> Result<()> {
    if text.trim().is_empty() {
        return Ok(());
    }
    let result = client
        .request_session(SessionRequestParams {
            command_id: next_command_id("turn"),
            session_id: active.session_id.clone(),
            request: SessionRequest::StartTurn {
                thread_id: active.thread_id.clone(),
                expected_sequence: active.sequence,
                approval_mode: active.approval_mode,
                tool_mode: None,
                input: vec![InputItem::Text { text }],
            },
        })
        .map_err(client_error)?;
    let SessionRequestResult::Turn(result) = result else {
        return Err(anyhow!(
            "Session request returned an unexpected Turn result"
        ));
    };
    active.sequence = result.sequence;
    Ok(())
}

pub(super) fn rewrite_agent_message(
    client: &mut AppServerRequestHandle,
    active: &mut ActiveSession,
    operation_id: CommandId,
    source_thread_id: ThreadId,
    before_turn_id: TurnId,
    text: String,
) -> Result<()> {
    if text.trim().is_empty() {
        return Err(anyhow!("replacement Agent message must not be empty"));
    }
    let rewritten = client
        .request_session(SessionRequestParams {
            command_id: operation_id,
            session_id: active.session_id.clone(),
            request: SessionRequest::RewriteThread {
                parent_thread_id: source_thread_id,
                before_turn_id,
                title: format!("Rewrite of {}", active.subscription.session.title),
                tool_mode: None,
                input: vec![InputItem::Text { text }],
            },
        })
        .map_err(client_error)?;
    let SessionRequestResult::Rewrite(rewritten) = rewritten else {
        return Err(anyhow!("Session rewrite returned an unexpected result"));
    };
    let session_id = rewritten.session.session_id.clone();
    let thread_id = rewritten.thread_id;
    let subscription = subscribe_session(client, &session_id)?;
    let thread = active_thread_entry(&subscription, &thread_id)?;
    let sequence = thread.thread.sequence;
    let transcript_revision = thread.transcript.revision;
    if sequence < rewritten.turn.sequence {
        return Err(anyhow!(
            "Session rewrite subscription did not include the replacement Turn"
        ));
    }
    *active = ActiveSession {
        session_id,
        thread_id,
        sequence,
        transcript_revision,
        approval_mode: active.approval_mode,
        subscription,
    };
    Ok(())
}

pub(super) fn submit_shell_command(
    client: &mut AppServerRequestHandle,
    active: &mut ActiveSession,
    command: String,
) -> Result<()> {
    if command.trim().is_empty() {
        return Ok(());
    }
    let result = client
        .request_session(SessionRequestParams {
            command_id: next_command_id("shell-turn"),
            session_id: active.session_id.clone(),
            request: SessionRequest::StartShellTurn {
                thread_id: active.thread_id.clone(),
                expected_sequence: active.sequence,
                approval_mode: active.approval_mode,
                command,
                working_directory: ".".into(),
            },
        })
        .map_err(client_error)?;
    let SessionRequestResult::Turn(result) = result else {
        return Err(anyhow!(
            "Session request returned an unexpected Turn result"
        ));
    };
    active.sequence = result.sequence;
    Ok(())
}

pub(super) fn set_model(client: &mut AppServerRequestHandle, model: ModelRef) -> Result<()> {
    let config = client.read_config().map_err(client_error)?;
    client
        .update_config(ConfigUpdateParams {
            advisor: Default::default(),
            time_context: Default::default(),
            features: Default::default(),
            command_id: next_command_id("model"),
            expected_revision: config.revision,
            model: Patch::Value(ModelRefDto {
                provider: model.provider.to_string(),
                model: model.model.to_string(),
            }),
            model_reasoning_effort: Patch::Missing,
            approval_review_model: Patch::Missing,
            commit_message_model: Patch::Missing,
            tool_mode: Patch::Missing,
            grep_backend: Patch::Missing,
            git: Patch::Missing,
            gui: Patch::Missing,
            tui: Patch::Missing,
        })
        .map_err(client_error)?;
    Ok(())
}

pub(super) fn select_next_approval_mode(active: &mut ActiveSession, approval_mode: ApprovalMode) {
    active.approval_mode = approval_mode;
}

pub(super) fn prepare_cwd_reconnect(
    target: &dyn SessionRuntimeTarget,
    cwd: PathBuf,
) -> Result<EnvCwdSetResult> {
    let target = target.with_cwd(&cwd).map_err(anyhow::Error::msg)?;
    let session = target.start().map_err(anyhow::Error::msg)?;
    session
        .shutdown()
        .map_err(|error| anyhow!(error.to_string()))?;
    Ok(EnvCwdSetResult { cwd })
}

pub(super) fn send_event(
    event_sink: &SessionRuntimeEventSink,
    event: SessionRuntimeEvent,
) -> Result<()> {
    event_sink(event).map_err(anyhow::Error::msg)
}

pub(super) fn next_command_id(prefix: &str) -> CommandId {
    static NEXT_COMMAND: AtomicU64 = AtomicU64::new(1);
    let sequence = NEXT_COMMAND.fetch_add(1, Ordering::Relaxed);
    CommandId::new(format!(
        "session-runtime-{prefix}-{}-{sequence}",
        std::process::id()
    ))
    .expect("generated Session runtime command ID is non-empty")
}

fn cwd_title(cwd: &Path) -> String {
    cwd.file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Session")
        .to_owned()
}

#[cfg(test)]
#[path = "operations_tests.rs"]
mod tests;

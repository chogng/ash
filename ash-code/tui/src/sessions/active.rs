use crate::client::new_command_id;
use ash_app_server_client::AppServerClient;
use ash_app_server_client::ClientError;
use ash_app_server_client::JsonRpcTransport;
use ash_app_server_protocol::protocol::session::SessionCreateParams;
use ash_app_server_protocol::protocol::session::SessionReadParams;
use ash_app_server_protocol::protocol::session::SessionRequest;
use ash_app_server_protocol::protocol::session::SessionRequestParams;
use ash_app_server_protocol::protocol::session::SessionRequestResult;
use ash_app_server_protocol::protocol::session::SessionThreadReadParams;
use ash_app_server_protocol::protocol::session::SessionThreadResult;
use ash_protocol::Session;
use ash_protocol::SessionId;
use ash_protocol::Thread;
use ash_protocol::ThreadId;
use ash_protocol::ThreadStatus;
use ash_protocol::TurnId;
use std::fmt;

/// Mutable product Session/Thread selection used by one TUI conversation.
#[derive(Clone)]
pub(crate) struct ActiveConversation {
    session: Session,
    thread_id: ThreadId,
    thread_sequence: u64,
}

/// Keeps the selected conversation and its live subscription under one owner.
#[derive(Clone)]
pub(crate) struct Conversation {
    pub(crate) conversation: ActiveConversation,
    pub(crate) subscription: crate::thread::ThreadSubscription,
}

pub(crate) struct ConversationChange {
    pub(crate) notice: String,
    pub(crate) transcript: ConversationTranscript,
}

pub(crate) enum ConversationTranscript {
    Clear,
    Replace,
}

impl ActiveConversation {
    pub(crate) fn start<T>(
        client: &mut AppServerClient<T>,
        title: String,
    ) -> Result<Self, ClientError>
    where
        T: JsonRpcTransport,
    {
        create_conversation(client, title).map(|(conversation, _)| conversation)
    }

    pub(crate) fn recover<T>(
        client: &mut AppServerClient<T>,
        recovery: crate::TuiRecoveryState,
    ) -> Result<Self, ClientError>
    where
        T: JsonRpcTransport,
    {
        let (session_id, preferred_thread_id) = recovery.into_parts();
        let session = client
            .read_session(SessionReadParams { session_id })?
            .session;
        let thread_id = session
            .threads
            .iter()
            .find(|thread| {
                thread.thread_id == preferred_thread_id
                    && thread.status == ThreadStatus::Active
                    && is_conversation_thread(thread)
            })
            .or_else(|| current_conversation_thread(&session))
            .or_else(|| {
                session.threads.iter().rev().find(|thread| {
                    thread.status == ThreadStatus::Active && is_conversation_thread(thread)
                })
            })
            .map(|thread| thread.thread_id.clone())
            .ok_or_else(|| {
                ClientError::Protocol(format!(
                    "session {} has no active Thread to recover",
                    session.session_id
                ))
            })?;
        let snapshot = client
            .read_session_thread(SessionThreadReadParams {
                session_id: session.session_id.clone(),
                thread_id: thread_id.clone(),
                history: None,
            })?
            .thread;
        Ok(Self {
            session,
            thread_id,
            thread_sequence: snapshot.sequence,
        })
    }

    pub(crate) fn title(&self) -> &str {
        &self.session.title
    }

    pub(crate) fn session_id(&self) -> &SessionId {
        &self.session.session_id
    }

    pub(crate) fn thread_id(&self) -> &ThreadId {
        &self.thread_id
    }

    pub(crate) fn thread_sequence(&self) -> u64 {
        self.thread_sequence
    }

    pub(crate) fn set_thread_sequence(&mut self, sequence: u64) {
        self.thread_sequence = self.thread_sequence.max(sequence);
    }

    pub(crate) fn select_thread<T>(
        &mut self,
        client: &mut AppServerClient<T>,
        thread_id: ThreadId,
    ) -> Result<ConversationChange, SessionsError>
    where
        T: JsonRpcTransport,
    {
        let session = client
            .read_session(SessionReadParams {
                session_id: self.session.session_id.clone(),
            })?
            .session;
        let thread = session
            .threads
            .iter()
            .find(|thread| thread.thread_id == thread_id && thread.status == ThreadStatus::Active)
            .ok_or_else(|| {
                SessionsError(format!(
                    "Thread {thread_id} is not active in Session {}",
                    session.session_id
                ))
            })?;
        if thread.forked_from_id.is_some() {
            return Err(SessionsError(format!(
                "Thread {thread_id} is a fork, not an active Subagent"
            )));
        }
        let snapshot = client
            .read_session_thread(SessionThreadReadParams {
                session_id: session.session_id.clone(),
                thread_id: thread_id.clone(),
                history: None,
            })?
            .thread;
        self.session = session;
        self.thread_id = thread_id;
        self.thread_sequence = snapshot.sequence;
        Ok(ConversationChange {
            notice: format!("Switched to Thread {}.", self.thread_id),
            transcript: ConversationTranscript::Replace,
        })
    }

    pub(crate) fn archive_and_replace<T>(
        &mut self,
        client: &mut AppServerClient<T>,
    ) -> Result<ConversationChange, SessionsError>
    where
        T: JsonRpcTransport,
    {
        self.session = client
            .read_session(SessionReadParams {
                session_id: self.session.session_id.clone(),
            })?
            .session;
        let session_id = self.session.session_id.clone();
        self.session = client
            .request_session(SessionRequestParams {
                command_id: new_command_id("archive"),
                session_id,
                request: SessionRequest::Archive,
            })
            .and_then(expect_session_result)?
            .session;
        let mut change = self.replace_with_new(client, "")?;
        change.notice = "Archived the previous session and started a new session.".into();
        Ok(change)
    }

    pub(crate) fn replace_with_new<T>(
        &mut self,
        client: &mut AppServerClient<T>,
        arguments: &str,
    ) -> Result<ConversationChange, SessionsError>
    where
        T: JsonRpcTransport,
    {
        let title = if arguments.is_empty() {
            "TUI conversation".to_owned()
        } else {
            arguments.to_owned()
        };
        let (conversation, _) = create_conversation(client, title)?;
        *self = conversation;
        Ok(ConversationChange {
            notice: "Started a new session.".into(),
            transcript: ConversationTranscript::Clear,
        })
    }

    pub(crate) fn branch_active_thread<T>(
        &mut self,
        client: &mut AppServerClient<T>,
        arguments: &str,
    ) -> Result<ConversationChange, SessionsError>
    where
        T: JsonRpcTransport,
    {
        let title = if arguments.is_empty() {
            format!("Branch of {}", self.session.title)
        } else {
            arguments.to_owned()
        };
        let result = client
            .request_session(SessionRequestParams {
                command_id: new_command_id("fork"),
                session_id: self.session.session_id.clone(),
                request: SessionRequest::ForkThread {
                    parent_thread_id: self.thread_id.clone(),
                    title,
                },
            })
            .and_then(expect_thread_result)?;
        let snapshot = client
            .read_session_thread(SessionThreadReadParams {
                session_id: result.session.session_id.clone(),
                thread_id: result.thread_id.clone(),
                history: None,
            })?
            .thread;
        self.session = result.session;
        self.thread_id = result.thread_id;
        self.thread_sequence = snapshot.sequence;
        Ok(ConversationChange {
            notice: format!("Switched to branch {}.", self.thread_id),
            transcript: ConversationTranscript::Replace,
        })
    }

    pub(crate) fn rewind_active_thread<T>(
        &mut self,
        client: &mut AppServerClient<T>,
        before_turn_id: TurnId,
        checkpoint_label: &str,
    ) -> Result<ConversationChange, SessionsError>
    where
        T: JsonRpcTransport,
    {
        let title = format!("Rewind of {}", self.session.title);
        let result = client
            .request_session(SessionRequestParams {
                command_id: new_command_id("rewind"),
                session_id: self.session.session_id.clone(),
                request: SessionRequest::RewindThread {
                    parent_thread_id: self.thread_id.clone(),
                    before_turn_id,
                    title,
                },
            })
            .and_then(expect_thread_result)?;
        let snapshot = client
            .read_session_thread(SessionThreadReadParams {
                session_id: result.session.session_id.clone(),
                thread_id: result.thread_id.clone(),
                history: None,
            })?
            .thread;
        self.session = result.session;
        self.thread_id = result.thread_id;
        self.thread_sequence = snapshot.sequence;
        Ok(ConversationChange {
            notice: format!("Rewound before: {checkpoint_label}"),
            transcript: ConversationTranscript::Replace,
        })
    }

    pub(crate) fn restore_message<T>(
        &mut self,
        client: &mut AppServerClient<T>,
        item_id: ash_protocol::ItemId,
        boundary: ash_protocol::MessageBoundary,
        checkpoint_label: &str,
    ) -> Result<ConversationChange, SessionsError>
    where
        T: JsonRpcTransport,
    {
        let title = format!("Rewind of {}", self.session.title);
        let result = client
            .request_session(SessionRequestParams {
                command_id: new_command_id("rewind"),
                session_id: self.session.session_id.clone(),
                request: SessionRequest::RestoreMessage {
                    thread_id: self.thread_id.clone(),
                    item_id,
                    boundary,
                    title,
                },
            })
            .and_then(expect_thread_result)?;
        let snapshot = client
            .read_session_thread(SessionThreadReadParams {
                session_id: result.session.session_id.clone(),
                thread_id: result.thread_id.clone(),
                history: None,
            })?
            .thread;
        self.session = result.session;
        self.thread_id = result.thread_id;
        self.thread_sequence = snapshot.sequence;
        Ok(ConversationChange {
            notice: format!("Restored {boundary:?}: {checkpoint_label}"),
            transcript: ConversationTranscript::Replace,
        })
    }

    pub(crate) fn open<T: JsonRpcTransport>(
        client: &mut AppServerClient<T>,
        arguments: &str,
        preferred_thread_id: Option<&ThreadId>,
    ) -> Result<Self, SessionsError> {
        let session_id = SessionId::new(arguments)
            .map_err(|error| SessionsError(format!("invalid session ID '{arguments}': {error}")))?;
        let session = client
            .read_session(SessionReadParams { session_id })?
            .session;
        let thread_id = preferred_thread_id
            .and_then(|preferred| {
                session.threads.iter().find(|thread| {
                    &thread.thread_id == preferred
                        && thread.status == ThreadStatus::Active
                        && is_conversation_thread(thread)
                })
            })
            .or_else(|| current_conversation_thread(&session))
            .or_else(|| {
                session.threads.iter().rev().find(|thread| {
                    thread.status == ThreadStatus::Active && is_conversation_thread(thread)
                })
            })
            .map(|thread| thread.thread_id.clone())
            .ok_or_else(|| {
                SessionsError(format!(
                    "session {} has no active thread",
                    session.session_id
                ))
            })?;
        let snapshot = client
            .read_session_thread(SessionThreadReadParams {
                session_id: session.session_id.clone(),
                thread_id: thread_id.clone(),
                history: None,
            })?
            .thread;
        Ok(Self {
            session,
            thread_id,
            thread_sequence: snapshot.sequence,
        })
    }
}

fn current_conversation_thread(session: &Session) -> Option<&ash_protocol::SessionThread> {
    session.threads.iter().find(|thread| {
        thread.thread_id.as_str() == session.session_id.as_str()
            && thread.status == ThreadStatus::Active
    })
}

fn is_conversation_thread(thread: &ash_protocol::SessionThread) -> bool {
    thread.parent_thread_id.is_none() || thread.forked_from_id.is_some()
}

fn create_conversation<T>(
    client: &mut AppServerClient<T>,
    title: String,
) -> Result<(ActiveConversation, Thread), ClientError>
where
    T: JsonRpcTransport,
{
    let session = client.create_session(SessionCreateParams {
        agent_id: None,
        agent: ash_protocol::AgentRoleSelection::Default,
        command_id: new_command_id("session"),
        title,
    })?;
    let thread_id = current_conversation_thread(&session.session)
        .map(|thread| thread.thread_id.clone())
        .ok_or_else(|| {
            ClientError::Protocol(format!(
                "created session {} has no active root Thread",
                session.session.session_id
            ))
        })?;
    let snapshot = client
        .read_session_thread(SessionThreadReadParams {
            session_id: session.session.session_id.clone(),
            thread_id: thread_id.clone(),
            history: None,
        })?
        .thread;
    Ok((
        ActiveConversation {
            session: session.session,
            thread_id,
            thread_sequence: snapshot.sequence,
        },
        snapshot,
    ))
}

pub(super) fn expect_thread_result(
    result: SessionRequestResult,
) -> Result<SessionThreadResult, ClientError> {
    match result {
        SessionRequestResult::Thread(result) => Ok(result),
        other => Err(ClientError::Protocol(format!(
            "session request returned {other:?} for a Thread operation"
        ))),
    }
}

pub(super) fn expect_session_result(
    result: SessionRequestResult,
) -> Result<ash_app_server_protocol::protocol::session::SessionResult, ClientError> {
    match result {
        SessionRequestResult::Session(result) => Ok(result),
        other => Err(ClientError::Protocol(format!(
            "session request returned {other:?} for a Session operation"
        ))),
    }
}

#[derive(Debug)]
pub(crate) struct SessionsError(String);

impl fmt::Display for SessionsError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl From<ClientError> for SessionsError {
    fn from(error: ClientError) -> Self {
        Self(error.to_string())
    }
}

#[cfg(test)]
#[path = "active_tests.rs"]
mod tests;

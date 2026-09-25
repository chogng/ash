use super::ActiveConversation;
use super::Command;
use super::Conversation;
use super::ConversationChange;
use super::archive;
use crate::thread::ThreadRequestScope;
use crate::thread::ThreadSubscription;
use crate::thread::ThreadSwitch;
use crate::thread::TurnStartCompletion;
use crate::thread::composer::ChatSubmission;
use crate::thread::start_turn_and_read;
use ash_app_server_client::AppServerRequestHandle;
use ash_app_server_client::ClientError;
use ash_app_server_protocol::protocol::session::SessionThreadReadParams;
use ash_app_server_protocol::protocol::session::SessionThreadReadResult;
use ash_protocol::ApprovalMode;
use ash_protocol::Session;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;

pub(crate) struct ConversationCompletion {
    pub(crate) conversation: ActiveConversation,
    pub(crate) change: ConversationChange,
    pub(crate) subscription: ThreadSubscription,
    pub(crate) switch: ThreadSwitch,
}

pub(crate) struct ManagerSessionCompletion {
    pub(crate) conversation: ConversationCompletion,
    pub(crate) turn: TurnStartCompletion,
}

/// Result of one asynchronous Session or active-conversation operation.
pub(crate) enum SessionCompletion {
    Forked {
        command: String,
        result: Result<ForkCompletion, String>,
    },
    Preview {
        generation: u64,
        result: Result<SessionThreadReadResult, String>,
    },
    Catalog(Result<Vec<Session>, String>),
    Changed {
        command: String,
        result: Result<ConversationCompletion, String>,
    },
    ThreadChanged(Result<ConversationCompletion, String>),
    ManagerCreated(Result<ManagerSessionCompletion, String>),
}

pub(crate) enum CommandRequest {
    Fork {
        prompt: String,
        approval_mode: ApprovalMode,
    },
    Preview {
        generation: u64,
        params: SessionThreadReadParams,
    },
    Restore {
        session_id: SessionId,
    },
    Delete {
        session_id: SessionId,
    },

    Resume {
        session_id: String,
        preferred_thread_id: Option<ThreadId>,
    },
    Archive {
        session_ids: Vec<SessionId>,
    },
    CreateAndEnter {
        submission: ChatSubmission,
        approval_mode: ApprovalMode,
    },
    SwitchThread {
        thread_id: ThreadId,
    },
}

impl Command {
    pub(crate) fn command_line(&self) -> Option<String> {
        match self {
            Self::Fork { prompt } => Some(fork_command(prompt)),
            Self::Resume { session_id, .. } => Some(format!("/resume {session_id}")),
            Self::Preview { .. }
            | Self::Restore { .. }
            | Self::Delete { .. }
            | Self::Archive { .. }
            | Self::CreateAndEnter { .. }
            | Self::SwitchThread { .. } => None,
        }
    }
}

impl CommandRequest {
    pub(crate) const fn name(&self) -> &'static str {
        match self {
            Self::Fork { .. } => "ash-tui-fork-session",
            Self::Preview { .. } => "ash-tui-preview-session",
            Self::Restore { .. } => "ash-tui-restore-session",
            Self::Delete { .. } => "ash-tui-delete-session",
            Self::Resume { .. } => "ash-tui-resume-session",
            Self::Archive { .. } => "ash-tui-archive-sessions",
            Self::CreateAndEnter { .. } => "ash-tui-create-manager-session",
            Self::SwitchThread { .. } => "ash-tui-switch-thread",
        }
    }

    pub(crate) fn execute(
        self,
        mut client: AppServerRequestHandle,
        current: Option<Conversation>,
    ) -> SessionCompletion {
        match self {
            Self::Fork {
                prompt,
                approval_mode,
            } => SessionCompletion::Forked {
                command: fork_command(&prompt),
                result: current
                    .ok_or_else(|| "No active session".to_owned())
                    .and_then(|current| {
                        fork_session(&mut client, &current.conversation, &prompt, approval_mode)
                    }),
            },
            Self::Preview { generation, params } => SessionCompletion::Preview {
                generation,
                result: client
                    .read_session_thread(params)
                    .map_err(|error| error.to_string()),
            },
            Self::Restore { session_id } => SessionCompletion::Catalog(
                super::restore(&mut client, session_id).map_err(|error| error.to_string()),
            ),
            Self::Delete { session_id } => SessionCompletion::Catalog(
                super::delete(&mut client, session_id).map_err(|error| error.to_string()),
            ),
            Self::Resume {
                session_id,
                preferred_thread_id,
            } => {
                let command = format!("/resume {session_id}");
                let result = ActiveConversation::open(
                    &mut client,
                    &session_id,
                    preferred_thread_id.as_ref(),
                )
                .map_err(|error| error.to_string())
                .and_then(|conversation| {
                    let change = super::ConversationChange {
                        notice: format!(
                            "Resumed session {} on thread {}.",
                            conversation.session_id(),
                            conversation.thread_id()
                        ),
                        transcript: super::ConversationTranscript::Replace,
                    };
                    finish_conversation_request(
                        &mut client,
                        conversation,
                        current.map(|c| c.subscription),
                        change,
                    )
                });
                SessionCompletion::Changed { command, result }
            }
            Self::Archive { session_ids } => SessionCompletion::Catalog(
                archive(&mut client, session_ids).map_err(|error| error.to_string()),
            ),
            Self::CreateAndEnter {
                submission,
                approval_mode,
            } => SessionCompletion::ManagerCreated(create_manager_session_and_start(
                client,
                current.map(|c| c.subscription),
                submission,
                approval_mode,
            )),
            Self::SwitchThread { thread_id } => {
                let result = current
                    .ok_or_else(|| "No active session".to_owned())
                    .and_then(|mut current| {
                        let change = current
                            .conversation
                            .select_thread(&mut client, thread_id)
                            .map_err(|error| error.to_string())?;
                        finish_conversation_request(
                            &mut client,
                            current.conversation,
                            Some(current.subscription),
                            change,
                        )
                    });
                SessionCompletion::ThreadChanged(result)
            }
        }
    }
}

pub(crate) fn prepare_command(approval_mode: ApprovalMode, command: Command) -> CommandRequest {
    match command {
        Command::Fork { prompt } => CommandRequest::Fork {
            prompt,
            approval_mode,
        },
        Command::Preview { generation, params } => CommandRequest::Preview { generation, params },
        Command::Restore { session_id } => CommandRequest::Restore { session_id },
        Command::Delete { session_id } => CommandRequest::Delete { session_id },
        Command::Resume {
            session_id,
            preferred_thread_id,
        } => CommandRequest::Resume {
            session_id,
            preferred_thread_id,
        },
        Command::Archive { session_ids } => CommandRequest::Archive { session_ids },
        Command::CreateAndEnter { submission } => CommandRequest::CreateAndEnter {
            submission,
            approval_mode,
        },
        Command::SwitchThread { thread_id } => CommandRequest::SwitchThread { thread_id },
    }
}

pub(crate) fn finish_conversation_request(
    client: &mut AppServerRequestHandle,
    conversation: ActiveConversation,
    subscription: Option<ThreadSubscription>,
    change: ConversationChange,
) -> Result<ConversationCompletion, String> {
    let (subscription, switch) = match subscription {
        Some(mut subscription) => {
            let switch = subscription
                .switch(client, conversation.session_id(), conversation.thread_id())
                .map_err(subscription_error)?;
            (subscription, switch)
        }
        None => {
            let (subscription, snapshot, transcript) = ThreadSubscription::start(
                client,
                conversation.session_id(),
                conversation.thread_id(),
            )
            .map_err(subscription_error)?;
            (
                subscription,
                ThreadSwitch::Complete {
                    snapshot,
                    transcript,
                },
            )
        }
    };
    Ok(ConversationCompletion {
        conversation,
        change,
        subscription,
        switch,
    })
}

pub(crate) fn create_manager_session_and_start(
    mut client: AppServerRequestHandle,
    subscription: Option<ThreadSubscription>,
    submission: ChatSubmission,
    approval_mode: ApprovalMode,
) -> Result<ManagerSessionCompletion, String> {
    let title = submission.display_text.clone();
    let conversation =
        ActiveConversation::start(&mut client, title).map_err(|error| error.to_string())?;
    let change = ConversationChange {
        notice: String::new(),
        transcript: super::ConversationTranscript::Clear,
    };
    let conversation =
        finish_conversation_request(&mut client, conversation, subscription, change)?;
    let scope = ThreadRequestScope::new(
        conversation.conversation.session_id(),
        conversation.conversation.thread_id(),
        conversation.conversation.thread_sequence(),
    );
    let turn = start_turn_and_read(
        client,
        scope,
        submission,
        approval_mode,
        conversation.subscription.history(),
    );
    Ok(ManagerSessionCompletion { conversation, turn })
}

pub(crate) fn subscription_error(error: ClientError) -> String {
    format!("the command changed the conversation, but the TUI could not subscribe to it: {error}")
}

pub(crate) struct ForkCompletion {
    session_id: SessionId,
    status: ForkStatus,
}

enum ForkStatus {
    Waiting,
    Started,
    StartFailed(String),
}

impl ForkCompletion {
    pub(crate) fn into_event(self, command: String) -> crate::thread::Event {
        let session_id = self.session_id;
        let result = match self.status {
            ForkStatus::Waiting => format!(
                "Copied to session {session_id}. Waiting for input. Open with /resume {session_id}."
            ),
            ForkStatus::Started => format!(
                "Started session {session_id} in the background. Results stay there. Open with /resume {session_id}."
            ),
            ForkStatus::StartFailed(error) => {
                return crate::thread::Event::CommandFailed {
                    command,
                    error: format!(
                        "Copied to session {session_id}, but could not start the prompt: {error}. Open with /resume {session_id}."
                    ),
                };
            }
        };
        crate::thread::Event::CommandCompleted { command, result }
    }
}

fn fork_command(prompt: &str) -> String {
    if prompt.is_empty() {
        "/fork".into()
    } else {
        format!("/fork {prompt}")
    }
}

fn fork_session(
    client: &mut AppServerRequestHandle,
    source: &ActiveConversation,
    prompt: &str,
    approval_mode: ApprovalMode,
) -> Result<ForkCompletion, String> {
    use ash_app_server_protocol::protocol::session::SessionRequest;
    use ash_app_server_protocol::protocol::session::SessionRequestParams;
    let result = client
        .request_session(SessionRequestParams {
            command_id: crate::client::new_command_id("fork-session"),
            session_id: source.session_id().clone(),
            request: SessionRequest::ForkSession {
                parent_thread_id: source.thread_id().clone(),
                title: format!("Fork of {}", source.title()),
            },
        })
        .and_then(super::active::expect_thread_result)
        .map_err(|error| error.to_string())?;
    let session_id = result.session.session_id;
    let status = if prompt.is_empty() {
        ForkStatus::Waiting
    } else {
        let start = (|| {
            let thread = client
                .read_session_thread(SessionThreadReadParams {
                    session_id: session_id.clone(),
                    thread_id: result.thread_id.clone(),
                    history: None,
                })?
                .thread;
            crate::thread::submit_prompt(
                client,
                ThreadRequestScope::new(&session_id, &result.thread_id, thread.sequence),
                ChatSubmission {
                    display_text: prompt.into(),
                    input: vec![crate::thread::composer::ChatInputItem::Text(prompt.into())],
                },
                approval_mode,
            )
        })();
        match start {
            Ok(_) => ForkStatus::Started,
            Err(error) => ForkStatus::StartFailed(error.to_string()),
        }
    };
    Ok(ForkCompletion { session_id, status })
}

#[cfg(test)]
#[path = "completion_tests.rs"]
mod tests;

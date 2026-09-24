use super::Command;
use super::Event;
use super::LatestThreadSnapshot;
use super::OlderThreadHistoryPage;
use super::ThreadRequestIdentity;
use super::ThreadRequestResponse;
use super::ThreadRequestScope;
use super::composer::ChatSubmission;
use super::composer::SteerId;
use super::interrupt_turn;
use super::queue::QueueId;
use super::read_older_thread_history;
use super::read_thread_history;
use super::resolve_interaction;
use super::rewind;
use super::steer_prompt;
use super::submit_prompt;
use ash_app_server_client::AppServerRequestHandle;
use ash_app_server_client::ClientError;
use ash_app_server_protocol::protocol::session::ThreadSnapshotHistory;
use ash_app_server_protocol::protocol::turn::TurnStartResult;
use ash_app_server_protocol::protocol::turn::TurnSteerResult;
use ash_protocol::ApprovalMode;
use ash_protocol::TurnId;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum CommandActivity {
    Ready,
    Working,
    Error,
    Other,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CommandState {
    active_turn: Option<TurnId>,
    approval_mode: ApprovalMode,
    activity: CommandActivity,
    steering: bool,
}

impl CommandState {
    pub(crate) fn new(
        active_turn: Option<TurnId>,
        approval_mode: ApprovalMode,
        activity: CommandActivity,
        steering: bool,
    ) -> Self {
        Self {
            active_turn,
            approval_mode,
            activity,
            steering,
        }
    }
}

pub(crate) enum CommandPreparation {
    RestoreMessage {
        item_id: ash_protocol::ItemId,
        boundary: ash_protocol::MessageBoundary,
        checkpoint_label: String,
    },
    ExecuteProductCommand(super::composer::SlashCommandInvocation),
    RewindToCheckpoint {
        before_turn_id: TurnId,
        checkpoint_label: String,
    },
    CycleNextApprovalMode,
    Request(CommandRequest),
    Present(Event),
    Requeue(Command),
    None,
}

pub(crate) enum TurnStartCompletion {
    Rejected(ClientError),
    Accepted {
        start: TurnStartResult,
        snapshot: Box<Result<LatestThreadSnapshot, ClientError>>,
    },
}

/// Result of one asynchronous operation against the active Thread.
pub(crate) enum ThreadCompletion {
    RequestResolved {
        scope: ThreadRequestScope,
        request: ThreadRequestIdentity,
        result: Result<LatestThreadSnapshot, ClientError>,
    },
    Refreshed {
        scope: ThreadRequestScope,
        result: Result<LatestThreadSnapshot, ClientError>,
    },
    HistoryPage {
        scope: ThreadRequestScope,
        result: Result<OlderThreadHistoryPage, ClientError>,
    },
    Interrupted {
        scope: ThreadRequestScope,
        result: Result<LatestThreadSnapshot, ClientError>,
    },
    Steered {
        scope: ThreadRequestScope,
        steer_id: SteerId,
        result: Result<(TurnSteerResult, LatestThreadSnapshot), ClientError>,
    },
    Started {
        scope: ThreadRequestScope,
        result: TurnStartCompletion,
    },
    QueueUpdated {
        scope: ThreadRequestScope,
        queue_id: Option<QueueId>,
        restore: Option<QueueId>,
        result: Result<ash_app_server_protocol::protocol::queue::QueueListResult, ClientError>,
    },
    RewindPickerLoaded {
        scope: ThreadRequestScope,
        result: Result<rewind::RewindChoices, String>,
    },
}

impl ThreadCompletion {
    pub(crate) fn scope(&self) -> &ThreadRequestScope {
        match self {
            Self::RequestResolved { scope, .. }
            | Self::Refreshed { scope, .. }
            | Self::HistoryPage { scope, .. }
            | Self::Interrupted { scope, .. }
            | Self::Steered { scope, .. }
            | Self::Started { scope, .. }
            | Self::QueueUpdated { scope, .. }
            | Self::RewindPickerLoaded { scope, .. } => scope,
        }
    }
}

pub(crate) enum CommandRequest {
    Interrupt {
        turn_id: TurnId,
    },
    LoadOlderHistory {
        before_turn_id: TurnId,
    },
    OpenRewindPicker,
    ResolveRequest {
        request: ThreadRequestIdentity,
        response: ThreadRequestResponse,
    },
    SubmitTurn {
        submission: ChatSubmission,
        approval_mode: ApprovalMode,
    },
    Queue {
        command: Command,
        approval_mode: ApprovalMode,
    },
    SteerTurn {
        turn_id: TurnId,
        steer_id: SteerId,
        submission: ChatSubmission,
    },
}

pub(crate) fn prepare_command(
    older_history: Option<ThreadSnapshotHistory>,
    state: CommandState,
    command: Command,
) -> CommandPreparation {
    match command {
        Command::ExecuteProductCommand(invocation) => {
            CommandPreparation::ExecuteProductCommand(invocation)
        }
        Command::Interrupt => match (state.active_turn, state.activity) {
            (Some(turn_id), activity) if activity != CommandActivity::Error => {
                CommandPreparation::Request(CommandRequest::Interrupt { turn_id })
            }
            (_, CommandActivity::Ready) => CommandPreparation::None,
            _ => CommandPreparation::Present(Event::InterruptFailed(
                "the active turn is not available".into(),
            )),
        },
        Command::LoadOlderHistory => match older_history {
            Some(ThreadSnapshotHistory::Before { turn_id, .. }) => {
                CommandPreparation::Request(CommandRequest::LoadOlderHistory {
                    before_turn_id: turn_id,
                })
            }
            Some(ThreadSnapshotHistory::Latest { .. }) | None => CommandPreparation::None,
        },
        Command::OpenRewindPicker => CommandPreparation::Request(CommandRequest::OpenRewindPicker),
        Command::RestoreMessage {
            item_id,
            boundary,
            checkpoint_label,
        } => CommandPreparation::RestoreMessage {
            item_id,
            boundary,
            checkpoint_label,
        },
        Command::RewindToCheckpoint {
            before_turn_id,
            checkpoint_label,
        } => CommandPreparation::RewindToCheckpoint {
            before_turn_id,
            checkpoint_label,
        },
        Command::ResolveRequest(response) => {
            let request = response.identity();
            CommandPreparation::Request(CommandRequest::ResolveRequest { request, response })
        }
        Command::CycleNextApprovalMode => CommandPreparation::CycleNextApprovalMode,
        Command::SubmitTurn { submission } => {
            CommandPreparation::Request(CommandRequest::SubmitTurn {
                submission,
                approval_mode: state.approval_mode,
            })
        }
        command @ (Command::Enqueue { .. }
        | Command::EditQueue { .. }
        | Command::CancelQueue(_)
        | Command::RefreshQueue) => CommandPreparation::Request(CommandRequest::Queue {
            command,
            approval_mode: state.approval_mode,
        }),
        Command::SteerTurn {
            steer_id,
            submission,
        } => {
            if state.activity == CommandActivity::Working && !state.steering {
                return CommandPreparation::Requeue(Command::SteerTurn {
                    steer_id,
                    submission,
                });
            }
            match state.active_turn {
                Some(turn_id) => CommandPreparation::Request(CommandRequest::SteerTurn {
                    turn_id,
                    steer_id,
                    submission,
                }),
                None => CommandPreparation::Present(Event::SteerSubmissionFailed {
                    steer_id,
                    error: "the active Turn is no longer available".into(),
                }),
            }
        }
    }
}

impl CommandRequest {
    pub(crate) const fn name(&self) -> &'static str {
        match self {
            Self::Interrupt { .. } => "ash-tui-interrupt-turn",
            Self::LoadOlderHistory { .. } => "ash-tui-load-older-history",
            Self::OpenRewindPicker { .. } => "ash-tui-load-rewind",
            Self::ResolveRequest { .. } => "ash-tui-resolve-thread-request",
            Self::SubmitTurn { .. } => "ash-tui-start-turn",
            Self::Queue { .. } => "ash-tui-queue",
            Self::SteerTurn { .. } => "ash-tui-steer-turn",
        }
    }

    pub(crate) fn execute(
        self,
        mut client: AppServerRequestHandle,
        scope: ThreadRequestScope,
        history: ThreadSnapshotHistory,
    ) -> ThreadCompletion {
        match self {
            Self::Interrupt { turn_id } => {
                let completion_scope = scope.clone();
                ThreadCompletion::Interrupted {
                    scope: completion_scope,
                    result: interrupt_and_read(client, scope, turn_id, history),
                }
            }
            Self::LoadOlderHistory { before_turn_id } => {
                let session_id = scope.session_id().clone();
                let thread_id = scope.thread_id().clone();
                let result =
                    read_older_thread_history(&mut client, &session_id, &thread_id, before_turn_id);
                ThreadCompletion::HistoryPage { scope, result }
            }
            Self::OpenRewindPicker => {
                let result =
                    rewind::load_selection(&mut client, scope.session_id(), scope.thread_id())
                        .map_err(|error| error.to_string());
                ThreadCompletion::RewindPickerLoaded { scope, result }
            }
            Self::ResolveRequest { request, response } => {
                let completion_scope = scope.clone();
                ThreadCompletion::RequestResolved {
                    scope: completion_scope,
                    request,
                    result: resolve_request_and_read(client, scope, response, history),
                }
            }
            Self::SubmitTurn {
                submission,
                approval_mode,
            } => {
                let completion_scope = scope.clone();
                ThreadCompletion::Started {
                    scope: completion_scope,
                    result: start_turn_and_read(client, scope, submission, approval_mode, history),
                }
            }
            Self::Queue {
                command,
                approval_mode,
            } => {
                let (queue_id, restore) = match &command {
                    Command::Enqueue { queue_id, .. } => (Some(*queue_id), None),
                    Command::EditQueue { target, action } => (
                        Some(target.queue_id),
                        matches!(action, super::queue::QueueAction::Pause)
                            .then_some(target.queue_id),
                    ),
                    Command::CancelQueue(target) => (Some(target.queue_id), None),
                    _ => (None, None),
                };
                let result = queue_request(&mut client, &scope, command, approval_mode);
                ThreadCompletion::QueueUpdated {
                    scope,
                    queue_id,
                    restore,
                    result,
                }
            }
            Self::SteerTurn {
                turn_id,
                steer_id,
                submission,
            } => {
                let completion_scope = scope.clone();
                ThreadCompletion::Steered {
                    scope: completion_scope,
                    steer_id,
                    result: steer_turn_and_read(client, scope, turn_id, submission, history),
                }
            }
        }
    }
}

pub(crate) fn resolve_request_and_read(
    mut client: AppServerRequestHandle,
    scope: ThreadRequestScope,
    response: ThreadRequestResponse,
    history: ThreadSnapshotHistory,
) -> Result<LatestThreadSnapshot, ClientError> {
    let session_id = scope.session_id().clone();
    let thread_id = scope.thread_id().clone();
    resolve_interaction(
        &mut client,
        scope,
        response.turn_id,
        response.request_id,
        response.response,
    )?;
    read_thread_history(&mut client, &session_id, &thread_id, history)
}

pub(crate) fn interrupt_and_read(
    mut client: AppServerRequestHandle,
    scope: ThreadRequestScope,
    turn_id: TurnId,
    history: ThreadSnapshotHistory,
) -> Result<LatestThreadSnapshot, ClientError> {
    let session_id = scope.session_id().clone();
    let thread_id = scope.thread_id().clone();
    interrupt_turn(&mut client, scope, &turn_id)?;
    read_thread_history(&mut client, &session_id, &thread_id, history)
}

pub(crate) fn start_turn_and_read(
    mut client: AppServerRequestHandle,
    scope: ThreadRequestScope,
    submission: ChatSubmission,
    approval_mode: ApprovalMode,
    history: ThreadSnapshotHistory,
) -> TurnStartCompletion {
    let session_id = scope.session_id().clone();
    let thread_id = scope.thread_id().clone();
    let start = match submit_prompt(&mut client, scope, submission, approval_mode) {
        Ok(start) => start,
        Err(error) => return TurnStartCompletion::Rejected(error),
    };
    let snapshot = read_thread_history(&mut client, &session_id, &thread_id, history);
    TurnStartCompletion::Accepted {
        start,
        snapshot: Box::new(snapshot),
    }
}

pub(crate) fn steer_turn_and_read(
    mut client: AppServerRequestHandle,
    scope: ThreadRequestScope,
    turn_id: TurnId,
    submission: ChatSubmission,
    history: ThreadSnapshotHistory,
) -> Result<(TurnSteerResult, LatestThreadSnapshot), ClientError> {
    let session_id = scope.session_id().clone();
    let thread_id = scope.thread_id().clone();
    let steer = steer_prompt(&mut client, scope, turn_id, submission)?;
    let snapshot = read_thread_history(&mut client, &session_id, &thread_id, history)?;
    Ok((steer, snapshot))
}

#[cfg(test)]
#[path = "completion_tests.rs"]
mod tests;

fn queue_request(
    client: &mut AppServerRequestHandle,
    scope: &ThreadRequestScope,
    command: Command,
    approval_mode: ApprovalMode,
) -> Result<ash_app_server_protocol::protocol::queue::QueueListResult, ClientError> {
    use super::queue::QueueAction;
    use ash_app_server_protocol::protocol::queue::QueueCancelParams;
    use ash_app_server_protocol::protocol::queue::QueueEditAction;
    use ash_app_server_protocol::protocol::queue::QueueEditParams;
    use ash_app_server_protocol::protocol::queue::QueueEnqueueParams;
    use ash_app_server_protocol::protocol::queue::QueueListParams;
    match command {
        Command::Enqueue {
            command_id,
            submission,
            ..
        } => {
            let input = super::request::materialize_submission(client, submission)?;
            let tool_mode = client.read_config()?.tool_mode;
            client.enqueue_message(QueueEnqueueParams {
                command_id,
                session_id: scope.session_id().clone(),
                thread_id: scope.thread_id().clone(),
                input,
                tool_mode,
                approval_mode,
            })?;
        }
        Command::EditQueue { target, action } => {
            let action = match action {
                QueueAction::Pause => QueueEditAction::Pause,
                QueueAction::Replace(submission) => QueueEditAction::Replace {
                    input: super::request::materialize_submission(client, submission)?,
                },
                QueueAction::Move(direction) => QueueEditAction::Move { direction },
                QueueAction::Send(turn_id) => QueueEditAction::Send { turn_id },
            };
            client.edit_queued_message(QueueEditParams {
                session_id: scope.session_id().clone(),
                thread_id: scope.thread_id().clone(),
                command_id: target.command_id,
                expected_revision: target.revision,
                action,
            })?;
        }
        Command::CancelQueue(target) => {
            client.cancel_queued_message(QueueCancelParams {
                session_id: scope.session_id().clone(),
                thread_id: scope.thread_id().clone(),
                command_id: target.command_id,
            })?;
        }
        Command::RefreshQueue => {}
        _ => return Err(ClientError::Protocol("invalid queue command".into())),
    }
    client.list_queued_messages(QueueListParams {
        session_id: scope.session_id().clone(),
        thread_id: scope.thread_id().clone(),
    })
}

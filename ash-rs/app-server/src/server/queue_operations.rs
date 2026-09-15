use super::AppServer;
use super::RpcError;
use super::decode;
use super::operations::ThreadMutation;
use super::operations::TurnToolModeSelection;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::queue::QueueCancelParams;
use ash_app_server_protocol::protocol::queue::QueueEnqueueParams;
use ash_app_server_protocol::protocol::queue::QueueListParams;
use ash_app_server_protocol::protocol::queue::QueueListResult;
use ash_protocol::TurnStatus;
use core_api::AgentRuntime;
use queue::Delivery;
use queue::QueueError;
use queue::QueuedMessage;
use serde_json::Value;
use std::sync::Arc;

impl AppServer {
    pub fn queued_message_ready(&self, message: &QueuedMessage) -> Result<bool, String> {
        let snapshot = self
            .agent_runtime()
            .read_thread(&message.request.thread_id)
            .map_err(|error| error.to_string())?;
        Ok(message.request.steer_turn.is_some()
            || accepted(&self.agent_runtime(), &message.request)
                .map(|result| result.is_some())
                .or_else(|error| match error {
                    core_api::CoreError::CommandConflict => Ok(true),
                    error => Err(error.to_string()),
                })?
            || !snapshot.turns.iter().any(|turn| active(turn.status)))
    }

    pub(super) fn queue_edit(&self, value: &Value) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::queue::QueueEditParams = decode(value)?;
        self.read_session_thread(&params.session_id, &params.thread_id)?;
        let action = match params.action {
            ash_app_server_protocol::protocol::queue::QueueEditAction::Pause => {
                queue::QueueEdit::Pause
            }
            ash_app_server_protocol::protocol::queue::QueueEditAction::Move { direction } => {
                queue::QueueEdit::Move { direction }
            }
            ash_app_server_protocol::protocol::queue::QueueEditAction::Send { turn_id } => {
                queue::QueueEdit::Send { turn_id }
            }
            ash_app_server_protocol::protocol::queue::QueueEditAction::Replace { input } => {
                queue::QueueEdit::Replace {
                    input: self.normalize_input(&params.session_id, input)?,
                }
            }
        };
        let message = self
            .queue_store()?
            .edit(
                &params.session_id,
                &params.thread_id,
                &params.command_id,
                params.expected_revision,
                &action,
            )
            .map_err(error)?;
        self.updates.publish_queue_changed();
        result(&message)
    }

    pub(super) fn extension_items(&self, value: &Value) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::extension_items::ExtensionItemsParams =
            decode(value)?;
        let thread = self.read_session_thread(&params.session_id, &params.thread_id)?;
        let items = self
            .agent_extensions
            .contribute_items(ash_extension_api::ThreadContext {
                session_id: &params.session_id,
                thread_id: &params.thread_id,
                sequence: thread.sequence,
            })
            .map_err(|_| RpcError::new(-32603, AppServerErrorName::InternalError))?;
        result(&ash_app_server_protocol::protocol::extension_items::ExtensionItemsResult { items })
    }

    pub fn start_queue(self: &Arc<Self>) -> Result<Option<queue::QueueRuntime>, String> {
        self.queue
            .as_ref()
            .map(|store| {
                queue::QueueRuntime::start(store.clone(), self.clone())
                    .map_err(|error| error.to_string())
            })
            .transpose()
    }

    pub fn queue_needs_host(&self) -> Result<bool, String> {
        let pending = self
            .queue
            .as_ref()
            .map(|store| store.needs_host())
            .transpose()
            .map_err(|error| error.to_string())?
            .unwrap_or(false);
        let active = self
            .agent_runtime()
            .has_active_turns()
            .map_err(|error| error.to_string())?;
        Ok(pending || active)
    }

    pub(super) fn queue_enqueue(&self, value: &Value) -> Result<Value, RpcError> {
        let params: QueueEnqueueParams = decode(value)?;
        let snapshot = self.read_session_thread(&params.session_id, &params.thread_id)?;
        let store = self.queue_store()?;
        // Retries resolve against the accepted queue request even after a feature is disabled.
        let existing = store.get(&params.command_id).map_err(error)?.is_some();
        if !existing
            && let Some(config) = &self.config
            && !features::Feature::Queue.enabled(
                &config
                    .read_snapshot()
                    .map_err(|_| RpcError::new(-32030, AppServerErrorName::ConfigUnavailable))?
                    .values
                    .features,
            )
        {
            return Err(RpcError::new(-32125, AppServerErrorName::FeatureDisabled));
        }
        if snapshot.status != ash_protocol::ThreadStatus::Active {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let input = self.normalize_input(&params.session_id, params.input)?;
        let directory = self
            .queue_directory
            .clone()
            .ok_or_else(|| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        self.refresh_analytics()?;
        let queued = store
            .enqueue(&queue::QueueInput {
                command_id: params.command_id,
                session_id: params.session_id,
                thread_id: params.thread_id,
                directory,
                input,
                tool_mode: params.tool_mode,
                approval_mode: params.approval_mode,
                steer_turn: None,
            })
            .map_err(error)?;
        if !existing {
            self.analytics.record(analytics::UsageEvent::MessageQueued);
        }
        self.updates.publish_queue_changed();
        result(&queued)
    }

    pub(super) fn queue_list(&self, value: &Value) -> Result<Value, RpcError> {
        let params: QueueListParams = decode(value)?;
        self.read_session_thread(&params.session_id, &params.thread_id)?;
        result(&QueueListResult {
            messages: self
                .queue_store()?
                .list(&params.session_id, &params.thread_id)
                .map_err(error)?,
        })
    }

    pub(super) fn queue_cancel(&self, value: &Value) -> Result<Value, RpcError> {
        let params: QueueCancelParams = decode(value)?;
        self.read_session_thread(&params.session_id, &params.thread_id)?;
        let cancelled = self
            .queue_store()?
            .cancel(&params.session_id, &params.thread_id, &params.command_id)
            .map_err(error)?;
        self.updates.publish_queue_changed();
        result(&cancelled)
    }

    fn queue_store(&self) -> Result<&queue::QueueStore, RpcError> {
        self.queue
            .as_deref()
            .ok_or_else(|| RpcError::new(-32120, AppServerErrorName::QueueUnavailable))
    }

    /// Delivers one durable queue identity through the ordinary Agent Turn entrypoint.
    pub fn deliver_queued_message(&self, message: &QueuedMessage) -> Result<Delivery, String> {
        let request = &message.request;
        if self.queue_directory.as_deref() != Some(request.directory.as_str()) {
            return Err("queue execution directory does not match the selected environment".into());
        }
        let snapshot = self
            .agent_runtime()
            .read_thread(&request.thread_id)
            .map_err(|error| error.to_string())?;
        if snapshot.session_id != request.session_id {
            return Ok(Delivery::Rejected("sessionMismatch".into()));
        }
        match accepted(&self.agent_runtime(), request) {
            Ok(Some(turn)) => return Ok(Delivery::Started(turn)),
            Err(core_api::CoreError::CommandConflict) => {
                return Ok(Delivery::Rejected("commandConflict".into()));
            }
            Err(error) => return Err(error.to_string()),
            Ok(None) => {}
        }
        if snapshot.status != ash_protocol::ThreadStatus::Active {
            return Ok(Delivery::Rejected("threadInactive".into()));
        }
        if let Some(turn_id) = &request.steer_turn {
            let current_turn = snapshot.turns.iter().find(|turn| &turn.turn_id == turn_id);
            if !current_turn.is_some_and(|turn| active(turn.status)) {
                return Ok(Delivery::Rejected("steerTargetFinished".into()));
            }
            let result = self.agent_runtime().steer_turn(
                &request.thread_id,
                core_api::SteerTurnRequest {
                    command_id: request.command_id.clone(),
                    expected_sequence: core_api::SequenceExpectation::Exact(snapshot.sequence),
                    turn_id: turn_id.clone(),
                    input: request.input.clone(),
                },
            );
            if result.is_ok() {
                return Ok(Delivery::Started(turn_id.clone()));
            }
            return Ok(Delivery::Rejected("steeringRejected".into()));
        }
        if snapshot.turns.iter().any(|turn| active(turn.status)) {
            return Ok(Delivery::Waiting);
        }
        self.bind_session_runtime(&snapshot.session_id)
            .map_err(|error| error.to_string())?;
        let mut input = request.input.clone();
        let selection = self.turn_instruction_selection(&mut input);
        let start = self.start_agent_turn_request(
            ThreadMutation {
                command_id: request.command_id.clone(),
                session_id: request.session_id.clone(),
                expected_sequence: snapshot.sequence,
            },
            request.thread_id.clone(),
            request.approval_mode,
            TurnToolModeSelection::Explicit(request.tool_mode),
            input,
            ash_protocol::TurnKind::Coding,
            selection,
        );
        let current = self
            .agent_runtime()
            .read_thread(&request.thread_id)
            .map_err(|error| error.to_string())?;
        match accepted(&self.agent_runtime(), request) {
            Ok(Some(turn)) => return Ok(Delivery::Started(turn)),
            Err(core_api::CoreError::CommandConflict) => {
                return Ok(Delivery::Rejected("commandConflict".into()));
            }
            Err(error) => return Err(error.to_string()),
            Ok(None) => {}
        }
        if current.turns.iter().any(|turn| active(turn.status))
            || current.sequence != snapshot.sequence
        {
            return Ok(Delivery::Waiting);
        }
        match start {
            Err(error) => Ok(Delivery::Rejected(format!("{:?}", error.message))),
            Ok(_) => Err("queue command acceptance is not observable".into()),
        }
    }
}

impl queue::QueueExecutor for AppServer {
    fn accepts(&self, message: &QueuedMessage) -> bool {
        self.queue_directory.as_deref() == Some(message.request.directory.as_str())
    }
    fn ready(&self, message: &QueuedMessage) -> Result<bool, String> {
        self.queued_message_ready(message)
    }
    fn deliver(&self, message: &QueuedMessage) -> Result<Delivery, String> {
        self.deliver_queued_message(message)
    }
    fn changed(&self) {
        self.updates.publish_queue_changed();
    }
    fn report_error(&self, error: &str) {
        log::error!("message queue: {error}");
    }
}
fn active(status: TurnStatus) -> bool {
    !matches!(
        status,
        TurnStatus::Completed | TurnStatus::Failed | TurnStatus::Interrupted
    )
}
fn accepted(
    runtime: &impl AgentRuntime,
    request: &queue::QueueInput,
) -> Result<Option<ash_protocol::TurnId>, core_api::CoreError> {
    let command = match request.steer_turn.as_ref() {
        Some(turn_id) => core_api::AcceptedCommand::Steer {
            input: &request.input,
            turn_id,
        },
        None => core_api::AcceptedCommand::Turn {
            input: &request.input,
            tool_mode: request.tool_mode,
            approval_mode: request.approval_mode,
        },
    };
    runtime.accepted_command(&request.thread_id, &request.command_id, command)
}

fn error(error: QueueError) -> RpcError {
    match error {
        QueueError::Invalid(_) => RpcError::new(-32602, AppServerErrorName::InvalidParams),
        QueueError::NotFound => RpcError::new(-32121, AppServerErrorName::QueueNotFound),
        QueueError::Conflict => RpcError::new(-32122, AppServerErrorName::QueueConflict),
        QueueError::Busy => RpcError::new(-32123, AppServerErrorName::QueueBusy),
        QueueError::Storage(_) => RpcError::new(-32124, AppServerErrorName::QueueOperationFailed),
    }
}

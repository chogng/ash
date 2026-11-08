use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::operations::ThreadMutation;
use super::operations::TurnModelSelection;
use super::operations::TurnToolModeSelection;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::queue::QueueCancelParams;
use ash_app_server_protocol::protocol::queue::QueueEditAction;
use ash_app_server_protocol::protocol::queue::QueueEditParams;
use ash_app_server_protocol::protocol::queue::QueueEnqueueParams;
use ash_app_server_protocol::protocol::queue::QueueListParams;
use ash_app_server_protocol::protocol::queue::QueueListResult;
use ash_protocol::TurnStatus;
use core_api::AgentRuntime;
use queue::Delivery;
use queue::QueueError;
use queue::QueuedMessage;
use queue::ReferenceReadScope;
use serde_json::Value;

/// Coordinates the existing owners needed by the queue adapter.
/// This contract deliberately exposes no server object or unrestricted service registry.
pub(super) trait QueueRequestProcessorContext: Send + Sync {
    fn agent_runtime(&self) -> impl core_api::AgentRuntime + '_;
    fn bind_session_runtime(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<(), core_api::CoreError>;
    fn normalize_input(
        &self,
        owner: Option<u64>,
        session_id: &ash_protocol::SessionId,
        input: Vec<ash_app_server_protocol::protocol::turn::InputItem>,
    ) -> Result<Vec<ash_protocol::UserInput>, super::RpcError>;
    fn read_session_thread(
        &self,
        session_id: &ash_protocol::SessionId,
        thread_id: &ash_protocol::ThreadId,
    ) -> Result<ash_protocol::Thread, super::RpcError>;
    fn refresh_analytics(&self) -> Result<(), super::RpcError>;
    fn resolve_turn_approval_mode(
        &self,
        session_id: &ash_protocol::SessionId,
        requested: Option<ash_protocol::ApprovalMode>,
    ) -> Result<ash_protocol::ApprovalMode, RpcError>;
    fn queue_uses_profile_host(
        &self,
        session_id: &ash_protocol::SessionId,
        thread_id: &ash_protocol::ThreadId,
    ) -> Result<bool, core_api::CoreError>;
    fn start_agent_turn_request(
        &self,
        mutation: super::operations::ThreadMutation,
        thread_id: ash_protocol::ThreadId,
        approval_mode: ash_protocol::ApprovalMode,
        mode: ash_protocol::CollaborationMode,
        tool_mode_selection: super::operations::TurnToolModeSelection,
        input: Vec<ash_protocol::UserInput>,
        kind: ash_protocol::TurnKind,
        selection: super::operations::TurnInstructionSelection,
        model_selection: super::operations::TurnModelSelection,
        reasoning_effort: Option<ash_protocol::ReasoningEffort>,
    ) -> Result<ash_app_server_protocol::protocol::turn::TurnStartResult, super::RpcError>;
    fn turn_instruction_selection(
        &self,
        input: &mut Vec<ash_protocol::UserInput>,
        mode: ash_protocol::CollaborationMode,
        command_interpretation: ash_protocol::CommandInterpretation,
    ) -> Result<super::operations::TurnInstructionSelection, super::RpcError>;
}

pub(super) struct QueueRequestProcessor<'ctx, C: QueueRequestProcessorContext + ?Sized> {
    context: &'ctx C,
    agent_extensions: &'ctx super::Arc<super::ExtensionRegistry>,
    analytics: &'ctx super::Arc<analytics::Analytics>,
    config: &'ctx Option<super::Arc<super::ConfigStore>>,
    queue: &'ctx Option<super::Arc<queue::QueueStore>>,
    queue_directory: &'ctx Option<String>,
    updates: &'ctx super::Arc<super::UpdateBroker>,
}

impl<'ctx, C: QueueRequestProcessorContext + ?Sized> QueueRequestProcessor<'ctx, C> {
    pub(super) fn new(
        context: &'ctx C,
        agent_extensions: &'ctx super::Arc<super::ExtensionRegistry>,
        analytics: &'ctx super::Arc<analytics::Analytics>,
        config: &'ctx Option<super::Arc<super::ConfigStore>>,
        queue: &'ctx Option<super::Arc<queue::QueueStore>>,
        queue_directory: &'ctx Option<String>,
        updates: &'ctx super::Arc<super::UpdateBroker>,
    ) -> Self {
        Self {
            context,
            agent_extensions,
            analytics,
            config,
            queue,
            queue_directory,
            updates,
        }
    }
}

impl<'ctx, C: QueueRequestProcessorContext + ?Sized> QueueRequestProcessor<'ctx, C> {
    pub fn queued_message_ready(&self, message: &QueuedMessage) -> Result<bool, String> {
        let snapshot = self
            .context
            .agent_runtime()
            .read_thread(&message.request.thread_id)
            .map_err(|error| error.to_string())?;
        Ok(message.request.steer_turn.is_some()
            || accepted(&self.context.agent_runtime(), &message.request)
                .map(|result| result.is_some())
                .or_else(|error| match error {
                    core_api::CoreError::CommandConflict => Ok(true),
                    error => Err(error.to_string()),
                })?
            || !snapshot.turns.iter().any(|turn| active(turn.status)))
    }

    pub(super) fn queue_edit(
        &self,
        connection: &ConnectionState,
        value: &Value,
    ) -> Result<Value, RpcError> {
        let QueueEditParams {
            session_id,
            thread_id,
            command_id,
            expected_revision,
            action,
        } = decode(value)?;
        self.context.read_session_thread(&session_id, &thread_id)?;
        let scope = connection.reference_read_scope();
        let message_for_edit = || {
            let message = self
                .queue_store()?
                .get(&command_id)
                .map_err(error)?
                .filter(|message| {
                    message.request.session_id == session_id
                        && message.request.thread_id == thread_id
                })
                .ok_or_else(|| error(QueueError::NotFound))?;
            if message.revision != expected_revision {
                return Err(error(QueueError::Conflict));
            }
            Ok(message)
        };
        if matches!(scope, ReferenceReadScope::CodeOnly)
            && matches!(
                &action,
                QueueEditAction::Resume
                    | QueueEditAction::Send { .. }
                    | QueueEditAction::ReplaceText { .. }
                    | QueueEditAction::ReplaceTextWithDelivery { .. }
            )
        {
            self.check_reference_sources(scope, &message_for_edit()?.request.input)?;
        }
        let action = match action {
            QueueEditAction::Pause => queue::QueueEdit::Pause,
            QueueEditAction::Resume => queue::QueueEdit::Resume,
            QueueEditAction::ReplaceText { text } => queue::QueueEdit::ReplaceText { text },
            QueueEditAction::ReplaceTextWithDelivery { text, delivery } => {
                queue::QueueEdit::ReplaceTextWithDelivery { text, delivery }
            }
            QueueEditAction::Move { direction } => queue::QueueEdit::Move { direction },
            QueueEditAction::Send { turn_id } => queue::QueueEdit::Send { turn_id },
            QueueEditAction::Replace { input } => {
                let existing = message_for_edit()?;
                let mut input = self.context.normalize_input(
                    Some(connection.connection_id),
                    &session_id,
                    input,
                )?;
                self.check_reference_sources(scope, &input)?;
                self.context.turn_instruction_selection(
                    &mut input,
                    existing.request.mode,
                    existing.request.command_interpretation,
                )?;
                queue::QueueEdit::Replace { input }
            }
        };
        let message = self
            .queue_store()?
            .edit_scoped(
                &session_id,
                &thread_id,
                &command_id,
                expected_revision,
                &action,
                scope,
            )
            .map_err(error)?;
        self.updates.publish_queue_changed();
        result(&message)
    }

    fn check_reference_sources(
        &self,
        scope: ReferenceReadScope,
        input: &[ash_protocol::UserInput],
    ) -> Result<(), RpcError> {
        super::check_chat_reference_sources(
            &self.context.agent_runtime(),
            scope,
            input.iter().filter_map(chat_reference_source),
        )
    }

    pub(super) fn extension_items(&self, value: &Value) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::extension_items::ExtensionItemsParams =
            decode(value)?;
        let thread = self
            .context
            .read_session_thread(&params.session_id, &params.thread_id)?;
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

    pub fn queue_needs_host(&self) -> Result<bool, String> {
        let pending = self
            .queue
            .as_ref()
            .map(|store| store.needs_host())
            .transpose()
            .map_err(|error| error.to_string())?
            .unwrap_or(false);
        let active = self
            .context
            .agent_runtime()
            .has_active_turns()
            .map_err(|error| error.to_string())?;
        Ok(pending || active)
    }

    pub(super) fn queue_enqueue(
        &self,
        connection: &ConnectionState,
        value: &Value,
    ) -> Result<Value, RpcError> {
        let params: QueueEnqueueParams = decode(value)?;
        let snapshot = self
            .context
            .read_session_thread(&params.session_id, &params.thread_id)?;
        let store = self.queue_store()?;
        // Retries resolve against the accepted queue request even after a feature is disabled.
        let existing = store.get(&params.command_id).map_err(error)?;
        if existing.is_none()
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
        if self.queue_directory.is_none()
            && !self
                .context
                .queue_uses_profile_host(&params.session_id, &params.thread_id)
                .map_err(super::core_error)?
        {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let mut input = self.context.normalize_input(
            Some(connection.connection_id),
            &params.session_id,
            params.input,
        )?;
        let scope = connection.reference_read_scope();
        self.check_reference_sources(scope, &input)?;
        self.context.turn_instruction_selection(
            &mut input,
            params.mode,
            params.command_interpretation.unwrap_or_default(),
        )?;
        let tool_mode = match (params.tool_mode, existing.as_ref()) {
            (Some(mode), _) => mode,
            (None, Some(message)) => message.request.tool_mode,
            (None, None) => match &self.config {
                Some(config) => {
                    config
                        .read_snapshot()
                        .map_err(|_| RpcError::new(-32030, AppServerErrorName::ConfigUnavailable))?
                        .values
                        .tool_mode
                }
                None => ash_protocol::ToolMode::Direct,
            },
        };
        let approval_mode = match (params.approval_mode, existing.as_ref()) {
            (None, Some(message)) => message.request.approval_mode,
            (requested, _) => self
                .context
                .resolve_turn_approval_mode(&params.session_id, requested)?,
        };
        self.context.refresh_analytics()?;
        let queued = store
            .enqueue_scoped(
                &queue::QueueInput {
                    command_id: params.command_id,
                    session_id: params.session_id,
                    thread_id: params.thread_id,
                    directory: self.queue_directory.clone(),
                    input,
                    mode: params.mode,
                    command_interpretation: params.command_interpretation.unwrap_or_default(),
                    model: params.model,
                    reasoning_effort: params.reasoning_effort,
                    tool_mode,
                    approval_mode,
                    steer_turn: None,
                },
                scope,
            )
            .map_err(error)?;
        if existing.is_none() {
            self.analytics.record(analytics::UsageEvent::MessageQueued);
        }
        self.updates.publish_queue_changed();
        result(&queued)
    }

    pub(super) fn queue_list(&self, value: &Value) -> Result<Value, RpcError> {
        let params: QueueListParams = decode(value)?;
        self.context
            .read_session_thread(&params.session_id, &params.thread_id)?;
        result(&QueueListResult {
            messages: self
                .queue_store()?
                .list(&params.session_id, &params.thread_id)
                .map_err(error)?,
        })
    }

    pub(super) fn queue_cancel(&self, value: &Value) -> Result<Value, RpcError> {
        let params: QueueCancelParams = decode(value)?;
        self.context
            .read_session_thread(&params.session_id, &params.thread_id)?;
        let cancelled = self
            .queue_store()?
            .cancel(
                &params.session_id,
                &params.thread_id,
                &params.command_id,
                params.expected_revision,
            )
            .map_err(error)?;
        self.updates.publish_queue_changed();
        result(&cancelled)
    }

    fn queue_store(&self) -> Result<&'ctx queue::QueueStore, RpcError> {
        self.queue
            .as_deref()
            .ok_or_else(|| RpcError::new(-32120, AppServerErrorName::QueueUnavailable))
    }

    /// Delivers one durable queue identity through the ordinary Agent Turn entrypoint.
    pub fn deliver_queued_message(&self, message: &QueuedMessage) -> Result<Delivery, String> {
        let request = &message.request;
        if self.queue_directory != &request.directory {
            return Err("queue execution directory does not match the selected environment".into());
        }
        let snapshot = self
            .context
            .agent_runtime()
            .read_thread(&request.thread_id)
            .map_err(|error| error.to_string())?;
        if snapshot.session_id != request.session_id {
            return Ok(Delivery::Rejected("sessionMismatch".into()));
        }
        // A Steer receipt has no separate mode. Check the immutable target before replaying it.
        if let Some(turn_id) = &request.steer_turn
            && snapshot
                .turns
                .iter()
                .any(|turn| &turn.turn_id == turn_id && turn.mode != request.mode)
        {
            return Ok(Delivery::Rejected("steerModeMismatch".into()));
        }
        match accepted(&self.context.agent_runtime(), request) {
            Ok(Some(turn)) => return Ok(Delivery::Started(turn)),
            Err(core_api::CoreError::CommandConflict) => {
                return Ok(Delivery::Rejected("commandConflict".into()));
            }
            Err(error) => return Err(error.to_string()),
            Ok(None) => {}
        }
        if request
            .input
            .iter()
            .any(|item| chat_reference_source(item).is_some())
        {
            let scope = self
                .queue_store()
                .map_err(|error| format!("{:?}", error.message))?
                .reference_read_scope(message)
                .map_err(|error| error.to_string())?;
            let Some(scope) = scope else {
                return Ok(Delivery::Waiting);
            };
            if self.check_reference_sources(scope, &request.input).is_err() {
                return Ok(Delivery::Rejected("referenceUnavailable".into()));
            }
        }
        if snapshot.status != ash_protocol::ThreadStatus::Active {
            return Ok(Delivery::Rejected("threadInactive".into()));
        }
        if request.directory.is_none()
            && !self
                .context
                .queue_uses_profile_host(&request.session_id, &request.thread_id)
                .map_err(|error| error.to_string())?
        {
            return Ok(Delivery::Rejected("executionTargetChanged".into()));
        }
        if let Some(turn_id) = &request.steer_turn {
            let current_turn = snapshot.turns.iter().find(|turn| &turn.turn_id == turn_id);
            if !current_turn.is_some_and(|turn| active(turn.status)) {
                return Ok(Delivery::Rejected("steerTargetFinished".into()));
            }
            let result = self.context.agent_runtime().steer_turn(
                &request.thread_id,
                core_api::SteerTurnRequest {
                    command_id: request.command_id.clone(),
                    // Streaming advances the sequence between read and mutation. Core checks
                    // the captured Turn's identity and active state atomically.
                    expected_sequence: core_api::SequenceExpectation::Any,
                    turn_id: turn_id.clone(),
                    input: request.input.clone(),
                },
            );
            return match result {
                Ok(_) => Ok(Delivery::Started(turn_id.clone())),
                Err(error) => {
                    eprintln!("App Server queued steering failed: {error}");
                    Ok(Delivery::Rejected("steeringRejected".into()))
                }
            };
        }
        if snapshot.turns.iter().any(|turn| active(turn.status)) {
            return Ok(Delivery::Waiting);
        }
        self.context
            .bind_session_runtime(&snapshot.session_id)
            .map_err(|error| error.to_string())?;
        let mut input = request.input.clone();
        let selection = self
            .context
            .turn_instruction_selection(&mut input, request.mode, request.command_interpretation)
            .map_err(|error| format!("{:?}", error.message))?;
        let start = self.context.start_agent_turn_request(
            ThreadMutation {
                ide_window_id: None,
                connection_id: None,
                command_id: request.command_id.clone(),
                session_id: request.session_id.clone(),
                expected_sequence: snapshot.sequence,
            },
            request.thread_id.clone(),
            request.approval_mode,
            request.mode,
            TurnToolModeSelection::Explicit(request.tool_mode),
            input,
            ash_protocol::TurnKind::Coding,
            selection,
            request
                .model
                .clone()
                .map(TurnModelSelection::Explicit)
                .unwrap_or(TurnModelSelection::Current),
            request.reasoning_effort,
        );
        let current = self
            .context
            .agent_runtime()
            .read_thread(&request.thread_id)
            .map_err(|error| error.to_string())?;
        match accepted(&self.context.agent_runtime(), request) {
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

fn chat_reference_source(
    input: &ash_protocol::UserInput,
) -> Option<(&ash_protocol::SessionId, &ash_protocol::ThreadId)> {
    if let ash_protocol::UserInput::ChatReference {
        session_id,
        thread_id,
        ..
    } = input
    {
        Some((session_id, thread_id))
    } else {
        None
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
            mode: request.mode,
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

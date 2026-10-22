use ash_app_server_protocol::protocol::debug::DebugAdapterCloseParams;
use ash_app_server_protocol::protocol::debug::DebugAdapterConnectionDto;
use ash_app_server_protocol::protocol::debug::DebugAdapterMessageDto;
use ash_app_server_protocol::protocol::debug::DebugAdapterReadParams;
use ash_app_server_protocol::protocol::debug::DebugAdapterReadResult;
use ash_app_server_protocol::protocol::debug::DebugAdapterSendParams;
use ash_app_server_protocol::protocol::debug::DebugAdapterStartParams;
use ash_app_server_protocol::protocol::debug::DebugAdapterStartResult;
use ash_app_server_protocol::protocol::debug::DebugBreakpointsSetParams;
use ash_app_server_protocol::protocol::debug::DebugExceptionFilterDto;
use ash_app_server_protocol::protocol::debug::DebugExecutionStateDto;
use ash_app_server_protocol::protocol::debug::DebugInitializationPhaseDto;
use ash_app_server_protocol::protocol::debug::DebugInspectionReadParams;
use ash_app_server_protocol::protocol::debug::DebugInspectionStartParams;
use ash_app_server_protocol::protocol::debug::DebugInspectionStartResult;
use ash_app_server_protocol::protocol::debug::DebugLaunchRequestDto;
use ash_app_server_protocol::protocol::debug::DebugMessageDirectionDto;
use ash_app_server_protocol::protocol::debug::DebugSessionCapabilitiesDto;
use ash_app_server_protocol::protocol::debug::DebugSessionConfigureParams;
use ash_app_server_protocol::protocol::debug::DebugSessionInitializeParams;
use ash_app_server_protocol::protocol::debug::DebugSessionInputParams;
use ash_app_server_protocol::protocol::debug::DebugSessionRequestParams;
use ash_app_server_protocol::protocol::debug::DebugSessionRequestResult;
use ash_app_server_protocol::protocol::debug::DebugSessionResponseParams;
use ash_app_server_protocol::protocol::debug::DebugSessionResponseResult;
use ash_app_server_protocol::protocol::debug::DebugSessionSnapshotDto;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_debug_adapter::DebugAdapterCommand;
use ash_debug_adapter::DebugAdapterConnection;
use ash_debug_adapter::DebugAdapterError;
use ash_debug_manager::DebugManagerError;
use ash_debug_manager::DebugMessageDirection;
use ash_debug_manager::DebugResponse;
use serde_json::Value;

use crate::debug_service::DebugAdapterServiceError;

use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;

/// Coordinates the existing owners needed by the debug adapter.
/// This contract deliberately exposes no server object or unrestricted service registry.
pub(super) trait DebugRequestProcessorContext: Send + Sync {
    fn debug_sessions(&self) -> std::sync::Arc<ash_debug_manager::DebugSessions>;

    fn debug_workspace_store(
        &self,
    ) -> Result<std::sync::Arc<ash_debug_manager::DebugWorkspaceStore>, RpcError>;

    fn debug_adapter_service_for(
        &self,
        dir_id: Option<&str>,
    ) -> Result<std::sync::Arc<crate::debug_service::DebugAdapterService>, super::RpcError>;
}

pub(super) struct DebugRequestProcessor<'ctx, C: DebugRequestProcessorContext + ?Sized> {
    context: &'ctx C,
}

impl<'ctx, C: DebugRequestProcessorContext + ?Sized> DebugRequestProcessor<'ctx, C> {
    pub(super) fn new(context: &'ctx C) -> Self {
        Self { context }
    }
}

impl<'ctx, C: DebugRequestProcessorContext + ?Sized> DebugRequestProcessor<'ctx, C> {
    pub(super) fn debug_session_prepare(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::debug::DebugSessionPrepareParams =
            decode(params)?;
        result(
            &self
                .context
                .debug_sessions()
                .prepare(connection.connection_id, &params.id, params.no_debug)
                .map_err(debug_manager_error)?,
        )
    }

    pub(super) fn debug_session_reserve(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let options: ash_debug_contract::DebugSessionAdmission = decode(params)?;
        result(
            &self
                .context
                .debug_sessions()
                .reserve(connection.connection_id, options)
                .map_err(debug_manager_error)?,
        )
    }

    pub(super) fn debug_session_lifecycle(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::debug::DebugSessionLifecycleParams =
            decode(params)?;
        let registry = self.context.debug_sessions();
        let relation = match params.action {
            ash_debug_contract::DebugSessionAction::End => {
                registry.end(connection.connection_id, &params.id)
            }
            ash_debug_contract::DebugSessionAction::Read
            | ash_debug_contract::DebugSessionAction::Route => {
                registry.read(connection.connection_id, &params.id)
            }
        }
        .map_err(debug_manager_error)?;
        result(&relation)
    }

    pub(super) fn debug_console(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::debug::DebugConsoleParams = decode(params)?;
        let registry = self.context.debug_sessions();
        if params.clear {
            registry
                .clear_console(connection.connection_id, &params.id)
                .map_err(debug_manager_error)?;
        }
        if let Some(text) = params.diagnostic {
            if text.len() > 65_536 {
                return Err(debug_manager_error(
                    ash_debug_manager::DebugClientError::InvalidMessage.into(),
                ));
            }
            registry
                .append(
                    connection.connection_id,
                    &params.id,
                    ash_debug_contract::DebugConsoleEntryKind::Output,
                    &serde_json::json!({"output":text,"category":"console"}),
                )
                .map_err(debug_manager_error)?;
        }
        result(
            &registry
                .console(connection.connection_id, &params.id)
                .map_err(debug_manager_error)?,
        )
    }

    pub(super) fn debug_workspace_read(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::debug::DebugWorkspaceReadParams =
            decode(params)?;
        result(
            &self
                .context
                .debug_workspace_store()?
                .read(&params.workspace_id, params.legacy)
                .map_err(workspace_error)?,
        )
    }

    pub(super) fn debug_workspace_write(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::debug::DebugWorkspaceWriteParams =
            decode(params)?;
        result(
            &self
                .context
                .debug_workspace_store()?
                .write(&params.workspace_id, params.revision, params.edits)
                .map_err(workspace_error)?,
        )
    }

    pub(super) fn debug_adapter_start(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: DebugAdapterStartParams = decode(params)?;
        let dir_id = params.dir_id.clone();
        let service = self.context.debug_adapter_service_for(dir_id.as_deref())?;
        let session_id = match (params.program, params.connection) {
            (Some(program), None) => {
                if params.env.as_ref().is_some_and(|environment| {
                    environment
                        .keys()
                        .any(|name| exec_server::terminal::is_private_process_environment_key(name))
                }) {
                    return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
                }
                let command = DebugAdapterCommand::new(program, params.arguments)
                    .and_then(|command| {
                        command.with_options(params.cwd, params.env.unwrap_or_default())
                    })
                    .map_err(debug_runtime_error)?;
                service.start(connection.connection_id, command)
            }
            (None, Some(endpoint))
                if params.arguments.is_empty() && params.cwd.is_none() && params.env.is_none() =>
            {
                match endpoint {
                    DebugAdapterConnectionDto::Client => {
                        service.open_client_transport(connection.connection_id)
                    }
                    DebugAdapterConnectionDto::Server { port, host } => service.connect(
                        connection.connection_id,
                        DebugAdapterConnection::Server { port, host },
                    ),
                    DebugAdapterConnectionDto::NamedPipe { path } => service.connect(
                        connection.connection_id,
                        DebugAdapterConnection::NamedPipe { path },
                    ),
                }
            }
            _ => return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams)),
        }
        .map_err(debug_manager_error)?;
        result(&DebugAdapterStartResult { session_id })
    }

    pub(super) fn debug_adapter_send(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: DebugAdapterSendParams = decode(params)?;
        self.context
            .debug_adapter_service_for(params.dir_id.as_deref())?
            .send(
                connection.connection_id,
                &params.session_id,
                &params.message,
            )
            .map_err(debug_service_error)?;
        result(&())
    }

    pub(super) fn debug_adapter_read(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: DebugAdapterReadParams = decode(params)?;
        let read = self
            .context
            .debug_adapter_service_for(params.dir_id.as_deref())?
            .read(
                connection.connection_id,
                &params.session_id,
                params.after_sequence,
                params.max_messages,
            )
            .map_err(debug_service_error)?;
        result(&DebugAdapterReadResult {
            console_revision: read.console_revision,
            breakpoint_revision: read.breakpoint_revision,
            exceptions: read.exceptions,
            session: session_snapshot(read.session),
            messages: read
                .messages
                .into_iter()
                .map(|message| DebugAdapterMessageDto {
                    sequence: message.sequence,
                    direction: match message.direction {
                        DebugMessageDirection::Incoming => DebugMessageDirectionDto::Incoming,
                        DebugMessageDirection::Outgoing => DebugMessageDirectionDto::Outgoing,
                    },
                    message: message.message,
                })
                .collect(),
            next_sequence: read.next_sequence,
            output_gap: read.output_gap,
            stderr: read.stderr,
            exited: read.exited,
            exit_code: read.exit_code,
            protocol_error: read.protocol_error,
        })
    }

    pub(super) fn debug_adapter_close(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: DebugAdapterCloseParams = decode(params)?;
        self.context
            .debug_adapter_service_for(params.dir_id.as_deref())?
            .close(connection.connection_id, &params.session_id)
            .map_err(debug_service_error)?;
        result(&())
    }

    pub(super) fn debug_breakpoints_set(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: DebugBreakpointsSetParams = decode(params)?;
        self.context
            .debug_adapter_service_for(params.dir_id.as_deref())?
            .set_breakpoints(
                connection.connection_id,
                &params.session_id,
                params.version,
                params.intents,
            )
            .map_err(debug_service_error)?;
        result(&())
    }

    pub(super) fn debug_breakpoints_read(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: DebugAdapterCloseParams = decode(params)?;
        result(
            &self
                .context
                .debug_adapter_service_for(params.dir_id.as_deref())?
                .breakpoints(connection.connection_id, &params.session_id)
                .map_err(debug_service_error)?,
        )
    }

    pub(super) fn debug_inspection_start(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: DebugInspectionStartParams = decode(params)?;
        let inspection_id = self
            .context
            .debug_adapter_service_for(params.dir_id.as_deref())?
            .inspect(
                connection.connection_id,
                &params.session_id,
                params.query,
                params.inspection_revision,
            )
            .map_err(debug_service_error)?;
        result(&match inspection_id {
            Some(inspection_id) => DebugInspectionStartResult::Started { inspection_id },
            None => DebugInspectionStartResult::Invalidated,
        })
    }

    pub(super) fn debug_inspection_read(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: DebugInspectionReadParams = decode(params)?;
        result(
            &self
                .context
                .debug_adapter_service_for(params.dir_id.as_deref())?
                .inspection(
                    connection.connection_id,
                    &params.session_id,
                    params.inspection_id,
                )
                .map_err(debug_service_error)?,
        )
    }

    pub(super) fn debug_session_initialize(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: DebugSessionInitializeParams = decode(params)?;
        self.context
            .debug_adapter_service_for(params.dir_id.as_deref())?
            .initialize(
                connection.connection_id,
                &params.session_id,
                ash_debug_manager::DebugInitialize {
                    adapter_id: params.adapter_id,
                    request: match params.request {
                        DebugLaunchRequestDto::Launch => {
                            ash_debug_manager::DebugLaunchRequest::Launch
                        }
                        DebugLaunchRequestDto::Attach => {
                            ash_debug_manager::DebugLaunchRequest::Attach
                        }
                    },
                    arguments: params.arguments,
                    run_in_terminal: params.run_in_terminal,
                    start_debugging: params.start_debugging,
                },
                params.public_id,
                self.context.debug_sessions(),
            )
            .map_err(debug_service_error)?;
        result(&())
    }

    pub(super) fn debug_exceptions_set(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: DebugSessionConfigureParams = decode(params)?;
        let version = self
            .context
            .debug_adapter_service_for(params.dir_id.as_deref())?
            .set_exceptions(
                connection.connection_id,
                &params.session_id,
                params.exception_filters.unwrap_or_default(),
            )
            .map_err(debug_service_error)?;
        result(&ash_app_server_protocol::protocol::debug::DebugExceptionsSetResult { version })
    }

    pub(super) fn debug_session_configure(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: DebugSessionConfigureParams = decode(params)?;
        self.context
            .debug_adapter_service_for(params.dir_id.as_deref())?
            .configure(
                connection.connection_id,
                &params.session_id,
                params.exception_filters,
            )
            .map_err(debug_service_error)?;
        result(&())
    }

    pub(super) fn debug_session_request(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: DebugSessionRequestParams = decode(params)?;
        let request_id = self
            .context
            .debug_adapter_service_for(params.dir_id.as_deref())?
            .request(
                connection.connection_id,
                &params.session_id,
                &params.command,
                params.arguments,
            )
            .map_err(debug_service_error)?;
        result(&DebugSessionRequestResult { request_id })
    }

    pub(super) fn debug_session_response(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: DebugSessionResponseParams = decode(params)?;
        let response = self
            .context
            .debug_adapter_service_for(params.dir_id.as_deref())?
            .response(
                connection.connection_id,
                &params.session_id,
                params.request_id,
            )
            .map_err(debug_service_error)?;
        result(&match response {
            DebugResponse::Pending => DebugSessionResponseResult::Pending,
            DebugResponse::Complete(response) => DebugSessionResponseResult::Complete { response },
            DebugResponse::Failed(message) => DebugSessionResponseResult::Failed { message },
        })
    }

    pub(super) fn debug_session_input(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: DebugSessionInputParams = decode(params)?;
        self.context
            .debug_adapter_service_for(params.dir_id.as_deref())?
            .input(
                connection.connection_id,
                &params.session_id,
                ash_debug_adapter::DebugAdapterRead {
                    messages: params
                        .messages
                        .into_iter()
                        .enumerate()
                        .map(
                            |(sequence, message)| ash_debug_adapter::DebugAdapterMessage {
                                sequence: sequence as u64,
                                message,
                            },
                        )
                        .collect(),
                    next_sequence: 0,
                    output_gap: params.output_gap,
                    stderr: params.stderr,
                    exited: params.exited,
                    exit_code: params.exit_code,
                    protocol_error: params.protocol_error,
                },
            )
            .map_err(debug_service_error)?;
        result(&())
    }
}

fn debug_service_error(error: DebugAdapterServiceError) -> RpcError {
    match error {
        DebugAdapterServiceError::NotOwner => {
            RpcError::new(-32072, AppServerErrorName::DebugAdapterNotOwner)
        }
        DebugAdapterServiceError::Runtime(error) => debug_manager_error(error),
    }
}

fn debug_manager_error(error: DebugManagerError) -> RpcError {
    match error {
        DebugManagerError::Transport(error) => debug_runtime_error(error),
        DebugManagerError::Client(error) => match error {
            ash_debug_manager::DebugClientError::InvalidMessage => {
                RpcError::new(-32602, AppServerErrorName::InvalidParams)
            }
            ash_debug_manager::DebugClientError::Capacity => {
                RpcError::new(-32073, AppServerErrorName::DebugAdapterBusy)
            }
            ash_debug_manager::DebugClientError::Closed
            | ash_debug_manager::DebugClientError::UnknownRequest => {
                RpcError::new(-32071, AppServerErrorName::DebugAdapterNotFound)
            }
        },
        DebugManagerError::NotFound => {
            RpcError::new(-32071, AppServerErrorName::DebugAdapterNotFound)
        }
        DebugManagerError::Busy => RpcError::new(-32073, AppServerErrorName::DebugAdapterBusy),
    }
}

fn debug_runtime_error(error: DebugAdapterError) -> RpcError {
    match error {
        DebugAdapterError::InvalidCommand
        | DebugAdapterError::InvalidMessage
        | DebugAdapterError::InvalidFrame(_) => {
            RpcError::new(-32602, AppServerErrorName::InvalidParams)
        }
        DebugAdapterError::NotFound => {
            RpcError::new(-32071, AppServerErrorName::DebugAdapterNotFound)
        }
        DebugAdapterError::Busy => RpcError::new(-32073, AppServerErrorName::DebugAdapterBusy),
        DebugAdapterError::OperationFailed
        | DebugAdapterError::Io(_)
        | DebugAdapterError::Json(_) => {
            RpcError::new(-32074, AppServerErrorName::DebugAdapterOperationFailed)
        }
    }
}

fn session_snapshot(snapshot: ash_debug_manager::DebugSessionSnapshot) -> DebugSessionSnapshotDto {
    use ash_debug_manager::DebugExecutionState;
    use ash_debug_manager::DebugInitializationPhase;
    let capabilities = snapshot.capabilities;
    DebugSessionSnapshotDto {
        revision: snapshot.revision,
        execution_revision: snapshot.execution_revision,
        inspection_revision: snapshot.inspection_revision,
        state: match snapshot.state {
            DebugExecutionState::Starting => DebugExecutionStateDto::Starting,
            DebugExecutionState::Running => DebugExecutionStateDto::Running,
            DebugExecutionState::Stopped => DebugExecutionStateDto::Stopped,
            DebugExecutionState::Terminated => DebugExecutionStateDto::Terminated,
            DebugExecutionState::Error => DebugExecutionStateDto::Error,
        },
        phase: match snapshot.phase {
            DebugInitializationPhase::Uninitialized => DebugInitializationPhaseDto::Uninitialized,
            DebugInitializationPhase::Initializing => DebugInitializationPhaseDto::Initializing,
            DebugInitializationPhase::AwaitingInitialized => {
                DebugInitializationPhaseDto::AwaitingInitialized
            }
            DebugInitializationPhase::Configuring => DebugInitializationPhaseDto::Configuring,
            DebugInitializationPhase::Launching => DebugInitializationPhaseDto::Launching,
            DebugInitializationPhase::Active => DebugInitializationPhaseDto::Active,
            DebugInitializationPhase::Ended => DebugInitializationPhaseDto::Ended,
        },
        reason: snapshot.reason,
        stopped_thread_id: snapshot.stopped_thread_id,
        capabilities: DebugSessionCapabilitiesDto {
            supports_restart: capabilities.supports_restart,
            supports_terminate: capabilities.supports_terminate,
            supports_set_variable: capabilities.supports_set_variable,
            supports_conditional_breakpoints: capabilities.supports_conditional_breakpoints,
            supports_hit_conditional_breakpoints: capabilities.supports_hit_conditional_breakpoints,
            supports_log_points: capabilities.supports_log_points,
            supports_function_breakpoints: capabilities.supports_function_breakpoints,
            supports_data_breakpoints: capabilities.supports_data_breakpoints,
            supports_instruction_breakpoints: capabilities.supports_instruction_breakpoints,
            supports_disassemble_request: capabilities.supports_disassemble_request,
            supports_read_memory_request: capabilities.supports_read_memory_request,
            supports_write_memory_request: capabilities.supports_write_memory_request,
            supports_loaded_sources_request: capabilities.supports_loaded_sources_request,
            supports_exception_info_request: capabilities.supports_exception_info_request,
            supports_stepping_granularity: capabilities.supports_stepping_granularity,
            supports_completions_request: capabilities.supports_completions_request,
            supports_cancel_request: capabilities.supports_cancel_request,
            completion_trigger_characters: capabilities.completion_trigger_characters,
            exception_breakpoint_filters: capabilities
                .exception_breakpoint_filters
                .into_iter()
                .map(|filter| DebugExceptionFilterDto {
                    filter: filter.filter,
                    label: filter.label,
                    description: filter.description,
                    default: filter.default,
                })
                .collect(),
        },
    }
}

fn workspace_error(error: ash_debug_manager::DebugWorkspaceError) -> RpcError {
    match error {
        ash_debug_manager::DebugWorkspaceError::Invalid => {
            RpcError::new(-32602, AppServerErrorName::InvalidParams)
        }
        ash_debug_manager::DebugWorkspaceError::Storage(_) => {
            RpcError::new(-32603, AppServerErrorName::InternalError)
        }
    }
}

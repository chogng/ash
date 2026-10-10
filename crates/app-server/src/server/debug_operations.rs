use ash_app_server_protocol::protocol::debug::DebugAdapterCloseParams;
use ash_app_server_protocol::protocol::debug::DebugAdapterConnectionDto;
use ash_app_server_protocol::protocol::debug::DebugAdapterMessageDto;
use ash_app_server_protocol::protocol::debug::DebugAdapterReadParams;
use ash_app_server_protocol::protocol::debug::DebugAdapterReadResult;
use ash_app_server_protocol::protocol::debug::DebugAdapterSendParams;
use ash_app_server_protocol::protocol::debug::DebugAdapterStartParams;
use ash_app_server_protocol::protocol::debug::DebugAdapterStartResult;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_debug_adapter::DebugAdapterCommand;
use ash_debug_adapter::DebugAdapterConnection;
use ash_debug_adapter::DebugAdapterError;
use serde_json::Value;

use crate::debug_service::DebugAdapterServiceError;

use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;

impl AppServer {
    pub(super) fn debug_adapter_start(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: DebugAdapterStartParams = decode(params)?;
        let dir_id = params.dir_id.clone();
        let service = self.debug_adapter_service_for(dir_id.as_deref())?;
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
                let endpoint = match endpoint {
                    DebugAdapterConnectionDto::Server { port, host } => {
                        DebugAdapterConnection::Server { port, host }
                    }
                    DebugAdapterConnectionDto::NamedPipe { path } => {
                        DebugAdapterConnection::NamedPipe { path }
                    }
                };
                service.connect(connection.connection_id, endpoint)
            }
            _ => return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams)),
        }
        .map_err(debug_runtime_error)?;
        result(&DebugAdapterStartResult { session_id })
    }

    pub(super) fn debug_adapter_send(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: DebugAdapterSendParams = decode(params)?;
        self.debug_adapter_service_for(params.dir_id.as_deref())?
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
            .debug_adapter_service_for(params.dir_id.as_deref())?
            .read(
                connection.connection_id,
                &params.session_id,
                params.after_sequence,
                params.max_messages,
            )
            .map_err(debug_service_error)?;
        result(&DebugAdapterReadResult {
            messages: read
                .messages
                .into_iter()
                .map(|message| DebugAdapterMessageDto {
                    sequence: message.sequence,
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
        self.debug_adapter_service_for(params.dir_id.as_deref())?
            .close(connection.connection_id, &params.session_id)
            .map_err(debug_service_error)?;
        result(&())
    }
}

fn debug_service_error(error: DebugAdapterServiceError) -> RpcError {
    match error {
        DebugAdapterServiceError::NotOwner => {
            RpcError::new(-32072, AppServerErrorName::DebugAdapterNotOwner)
        }
        DebugAdapterServiceError::Runtime(error) => debug_runtime_error(error),
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

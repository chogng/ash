use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::common::EmptyParams;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::terminal as wire;
use ash_app_server_protocol::protocol::terminal::TerminalAttachParams;
use ash_app_server_protocol::protocol::terminal::TerminalCloseParams;
use ash_app_server_protocol::protocol::terminal::TerminalCreateInSessionDirectoryParams;
use ash_app_server_protocol::protocol::terminal::TerminalCreateParams;
use ash_app_server_protocol::protocol::terminal::TerminalProfileListResult;
use ash_app_server_protocol::protocol::terminal::TerminalReadParams;
use ash_app_server_protocol::protocol::terminal::TerminalResizeParams;
use ash_app_server_protocol::protocol::terminal::TerminalWriteParams;
use base64::Engine;
use serde_json::Value;

impl AppServer {
    pub(super) fn terminal_profile_list(&self, params: &Value) -> Result<Value, RpcError> {
        let _: EmptyParams = decode(params)?;
        result(&TerminalProfileListResult {
            profiles: self
                .terminal_service()?
                .profiles()
                .into_iter()
                .map(profile_to_dto)
                .collect(),
        })
    }

    pub(super) fn terminal_create(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: TerminalCreateParams = decode(params)?;
        let created = self
            .terminal_service_for(params.dir_id.as_deref())?
            .create(connection.connection_id, create_request(params))
            .map_err(terminal_error)?;
        result(&wire::TerminalCreateResult {
            terminal_id: created.terminal_id,
            profile: profile_to_dto(created.profile),
            reconnect: created.reconnect.map(lease_to_dto),
        })
    }

    pub(super) fn terminal_create_in_session_directory(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: TerminalCreateInSessionDirectoryParams = decode(params)?;
        let authorization = self.session_dir_authorization(
            &params.session_id,
            &params.path,
            ash_file_access::Permission::ExecuteCommands,
        )?;
        let created = self
            .terminal_service()?
            .create_in_dir(
                connection.connection_id,
                exec_server::terminal::TerminalCreateRequest {
                    rows: params.rows,
                    cols: params.cols,
                    profile: profile_selection(params.profile),
                    lifecycle: lifecycle(params.lifecycle),
                },
                authorization,
            )
            .map_err(terminal_error)?;
        result(&wire::TerminalCreateResult {
            terminal_id: created.terminal_id,
            profile: profile_to_dto(created.profile),
            reconnect: created.reconnect.map(lease_to_dto),
        })
    }

    pub(super) fn terminal_write(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: TerminalWriteParams = decode(params)?;
        self.terminal_service_for(params.dir_id.as_deref())?
            .write(
                connection.connection_id,
                exec_server::terminal::TerminalWriteRequest {
                    terminal_id: params.terminal_id,
                    data: params.data,
                },
            )
            .map_err(terminal_error)?;
        result(&())
    }

    pub(super) fn terminal_attach(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: TerminalAttachParams = decode(params)?;
        let attached = self
            .terminal_service_for(params.dir_id.as_deref())?
            .attach(
                connection.connection_id,
                exec_server::terminal::TerminalAttachRequest {
                    terminal_id: params.terminal_id,
                    reconnect_token: params.reconnect_token,
                    rows: params.rows,
                    cols: params.cols,
                },
            )
            .map_err(terminal_error)?;
        result(&wire::TerminalAttachResult {
            terminal_id: attached.terminal_id,
            reconnect: lease_to_dto(attached.reconnect),
        })
    }

    pub(super) fn terminal_resize(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: TerminalResizeParams = decode(params)?;
        self.terminal_service_for(params.dir_id.as_deref())?
            .resize(
                connection.connection_id,
                exec_server::terminal::TerminalResizeRequest {
                    terminal_id: params.terminal_id,
                    rows: params.rows,
                    cols: params.cols,
                },
            )
            .map_err(terminal_error)?;
        result(&())
    }

    pub(super) fn terminal_read(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: TerminalReadParams = decode(params)?;
        let output = self
            .terminal_service_for(params.dir_id.as_deref())?
            .read(
                connection.connection_id,
                exec_server::terminal::TerminalReadRequest {
                    terminal_id: params.terminal_id,
                    after_sequence: params.after_sequence,
                    after_command_sequence: params.after_command_sequence,
                    max_chunks: params.max_chunks,
                },
            )
            .map_err(terminal_error)?;
        result(&read_to_dto(output))
    }

    pub(super) fn terminal_close(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: TerminalCloseParams = decode(params)?;
        self.terminal_service_for(params.dir_id.as_deref())?
            .close(connection.connection_id, &params.terminal_id)
            .map_err(terminal_error)?;
        result(&())
    }
}

fn terminal_error(error: exec_server::terminal::TerminalError) -> RpcError {
    use exec_server::terminal::TerminalError;
    match error {
        TerminalError::InvalidInput => RpcError::new(-32602, AppServerErrorName::InvalidParams),
        TerminalError::NotFound => RpcError::new(-32061, AppServerErrorName::TerminalNotFound),
        TerminalError::NotOwner => RpcError::new(-32062, AppServerErrorName::TerminalNotOwner),
        TerminalError::AttachRejected => {
            RpcError::new(-32065, AppServerErrorName::TerminalAttachRejected)
        }
        TerminalError::Busy => RpcError::new(-32063, AppServerErrorName::TerminalBusy),
        TerminalError::OperationFailed => {
            RpcError::new(-32064, AppServerErrorName::TerminalOperationFailed)
        }
    }
}

fn create_request(params: TerminalCreateParams) -> exec_server::terminal::TerminalCreateRequest {
    exec_server::terminal::TerminalCreateRequest {
        rows: params.rows,
        cols: params.cols,
        profile: profile_selection(params.profile),
        lifecycle: lifecycle(params.lifecycle),
    }
}

fn profile_selection(
    value: wire::TerminalProfileSelection,
) -> exec_server::terminal::TerminalProfileSelection {
    match value {
        wire::TerminalProfileSelection::Default => {
            exec_server::terminal::TerminalProfileSelection::Default
        }
        wire::TerminalProfileSelection::Profile { profile_id } => {
            exec_server::terminal::TerminalProfileSelection::Profile { profile_id }
        }
    }
}

fn lifecycle(value: wire::TerminalLifecycle) -> exec_server::terminal::TerminalLifecycle {
    match value {
        wire::TerminalLifecycle::ConnectionOwned => {
            exec_server::terminal::TerminalLifecycle::ConnectionOwned
        }
        wire::TerminalLifecycle::Reconnectable => {
            exec_server::terminal::TerminalLifecycle::Reconnectable
        }
    }
}

fn profile_to_dto(value: exec_server::terminal::TerminalProfile) -> wire::TerminalProfile {
    wire::TerminalProfile {
        profile_id: value.profile_id,
        title: value.title,
        is_default: value.is_default,
    }
}

fn lease_to_dto(
    value: exec_server::terminal::TerminalReconnectLease,
) -> wire::TerminalReconnectLease {
    wire::TerminalReconnectLease {
        reconnect_token: value.reconnect_token,
        reconnect_grace_period_millis: value.reconnect_grace_period_millis,
    }
}

fn read_to_dto(value: exec_server::terminal::TerminalReadResult) -> wire::TerminalReadResult {
    wire::TerminalReadResult {
        terminal_id: value.terminal_id,
        chunks: value
            .chunks
            .into_iter()
            .map(|chunk| wire::TerminalOutputChunk {
                sequence: chunk.sequence,
                data_base64: base64::engine::general_purpose::STANDARD.encode(chunk.data),
            })
            .collect(),
        next_sequence: value.next_sequence,
        output_gap: value.output_gap,
        command_events: value
            .command_events
            .into_iter()
            .map(|event| wire::TerminalCommandStatusEvent {
                sequence: event.sequence,
                command_id: event.command_id,
                status: match event.status {
                    exec_server::terminal::TerminalCommandStatus::Running => {
                        wire::TerminalCommandStatus::Running
                    }
                    exec_server::terminal::TerminalCommandStatus::Completed => {
                        wire::TerminalCommandStatus::Completed
                    }
                    exec_server::terminal::TerminalCommandStatus::Succeeded => {
                        wire::TerminalCommandStatus::Succeeded
                    }
                    exec_server::terminal::TerminalCommandStatus::Failed => {
                        wire::TerminalCommandStatus::Failed
                    }
                    exec_server::terminal::TerminalCommandStatus::Canceled => {
                        wire::TerminalCommandStatus::Canceled
                    }
                },
                exit_code: event.exit_code,
                after_output_sequence: event.after_output_sequence,
            })
            .collect(),
        next_command_sequence: value.next_command_sequence,
        command_event_gap: value.command_event_gap,
        exited: value.exited,
        exit_code: value.exit_code,
    }
}

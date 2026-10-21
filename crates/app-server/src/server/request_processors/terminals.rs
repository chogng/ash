use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
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

/// Coordinates the existing owners needed by the terminals adapter.
/// This contract deliberately exposes no server object or unrestricted service registry.
pub(super) trait TerminalRequestProcessorContext: Send + Sync {
    fn session_dir_authorization(
        &self,
        session_id: &ash_protocol::SessionId,
        root: &std::path::Path,
        permission: ash_file_access::Permission,
    ) -> Result<ash_file_access::Authorization, super::RpcError>;
    fn session_terminal_service(
        &self,
        session_id: &ash_protocol::SessionId,
        authorization: &ash_file_access::Authorization,
    ) -> Result<std::sync::Arc<exec_server::terminal::TerminalService>, super::RpcError>;
    fn terminal_service_for(
        &self,
        dir_id: Option<&str>,
    ) -> Result<std::sync::Arc<exec_server::terminal::TerminalService>, super::RpcError>;
}

pub(super) struct TerminalRequestProcessor<'ctx, C: TerminalRequestProcessorContext + ?Sized> {
    context: &'ctx C,
}

impl<'ctx, C: TerminalRequestProcessorContext + ?Sized> TerminalRequestProcessor<'ctx, C> {
    pub(super) fn new(context: &'ctx C) -> Self {
        Self { context }
    }
}

impl<'ctx, C: TerminalRequestProcessorContext + ?Sized> TerminalRequestProcessor<'ctx, C> {
    /// Session folder identities route Terminal requests without granting access to the directory.
    pub(crate) fn terminal_session_directory(
        dir_id: Option<&str>,
    ) -> Result<Option<(ash_protocol::SessionId, std::path::PathBuf)>, String> {
        let Some(identity) = dir_id.and_then(|id| id.strip_prefix("session:")) else {
            return Ok(None);
        };
        let (session, path) = identity
            .split_once(':')
            .ok_or("Invalid Session folder identity")?;
        let decode = |value: &str| {
            url::form_urlencoded::parse(value.as_bytes())
                .next()
                .map(|(key, _)| key.into_owned())
                .ok_or("Empty Session folder identity")
        };
        let session =
            ash_protocol::SessionId::new(decode(session)?).map_err(|error| error.to_string())?;
        let path = decode(path)?;
        if (!std::path::Path::new(&path).is_absolute()
            && ash_remote::RemoteDirPath::parse(&path).is_err())
            || path.contains('\0')
        {
            return Err("Session Terminal directory must be absolute".into());
        }
        Ok(Some((session, path.into())))
    }

    pub(super) fn terminal_profile_list(&self, params: &Value) -> Result<Value, RpcError> {
        let params: wire::TerminalProfileListParams = decode(params)?;
        result(&TerminalProfileListResult {
            profiles: self
                .context
                .terminal_service_for(params.dir_id.as_deref())?
                .profiles()
                .into_iter()
                .map(profile_to_dto)
                .collect(),
        })
    }

    pub(super) fn terminal_profile_resolve(&self, params: &Value) -> Result<Value, RpcError> {
        let params: wire::TerminalProfileResolveParams = decode(params)?;
        let resolved = self
            .context
            .terminal_service_for(params.dir_id.as_deref())?
            .resolve_profile(&profile_selection(params.profile))
            .map_err(terminal_error)?;
        result(&wire::TerminalProfileResolveResult {
            profile: profile_to_dto(resolved.profile),
            executable: resolved.executable,
            args: match resolved.args {
                exec_server::terminal::TerminalArguments::Argv(args) => {
                    wire::TerminalArguments::Argv(args)
                }
                exec_server::terminal::TerminalArguments::CommandLine(args) => {
                    wire::TerminalArguments::CommandLine(args)
                }
            },
        })
    }

    pub(super) fn terminal_environment_read(&self, params: &Value) -> Result<Value, RpcError> {
        let params: wire::TerminalEnvironmentReadParams = decode(params)?;
        let service = self
            .context
            .terminal_service_for(params.dir_id.as_deref())?;
        let values = match params.names {
            Some(names) => service.environment(&names),
            None => service.environment_snapshot(),
        }
        .map_err(terminal_error)?;
        result(&wire::TerminalEnvironmentReadResult {
            values: values.into_iter().collect(),
        })
    }

    pub(super) fn terminal_create(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: TerminalCreateParams = decode(params)?;
        let directory = Self::terminal_session_directory(params.dir_id.as_deref())
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        let created = if let Some((session_id, path)) = directory {
            let authorization = self.context.session_dir_authorization(
                &session_id,
                &path,
                ash_file_access::Permission::ExecuteCommands,
            )?;
            self.context
                .session_terminal_service(&session_id, &authorization)?
                .create_in_dir(
                    connection.connection_id,
                    create_request(params),
                    authorization,
                )
        } else {
            self.context
                .terminal_service_for(params.dir_id.as_deref())?
                .create(connection.connection_id, create_request(params))
        }
        .map_err(terminal_error)?;
        result(&wire::TerminalCreateResult {
            ready: ready_to_dto(created.ready),
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
        let authorization = self.context.session_dir_authorization(
            &params.session_id,
            &params.path,
            ash_file_access::Permission::ExecuteCommands,
        )?;
        let created = self
            .context
            .session_terminal_service(&params.session_id, &authorization)?
            .create_in_dir(
                connection.connection_id,
                exec_server::terminal::TerminalCreateRequest {
                    lifetime_token: params.lifetime_token,
                    auto_replies: Vec::new(),
                    rows: params.rows,
                    cols: params.cols,
                    profile: profile_selection(params.profile),
                    lifecycle: lifecycle(params.lifecycle),
                    env: None,
                    strict_env: None,
                    cwd: None,
                    execution: None,
                },
                authorization,
            )
            .map_err(terminal_error)?;
        result(&wire::TerminalCreateResult {
            ready: ready_to_dto(created.ready),
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
        self.context
            .terminal_service_for(params.dir_id.as_deref())?
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

    pub(super) fn terminal_write_binary(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: wire::TerminalWriteBinaryParams = decode(params)?;
        if params.data_base64.len() > 87_384 {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let data = base64::engine::general_purpose::STANDARD
            .decode(params.data_base64)
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        self.context
            .terminal_service_for(params.dir_id.as_deref())?
            .write_binary(
                connection.connection_id,
                exec_server::terminal::TerminalWriteBinaryRequest {
                    terminal_id: params.terminal_id,
                    data,
                },
            )
            .map_err(terminal_error)?;
        result(&())
    }

    pub(super) fn terminal_process_info(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: wire::TerminalProcessInfoParams = decode(params)?;
        let info = self
            .context
            .terminal_service_for(params.dir_id.as_deref())?
            .process_info(connection.connection_id, &params.terminal_id)
            .map_err(terminal_error)?;
        result(&wire::TerminalProcessInfo {
            ready: ready_to_dto(info.ready),
            cwd: info.cwd,
            rows: info.rows,
            cols: info.cols,
            has_child_processes: info.has_child_processes,
        })
    }

    pub(super) fn terminal_send_signal(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: wire::TerminalSendSignalParams = decode(params)?;
        let signal = match params.signal {
            wire::TerminalSignal::Interrupt => exec_server::terminal::TerminalSignal::Interrupt,
            wire::TerminalSignal::Terminate => exec_server::terminal::TerminalSignal::Terminate,
            wire::TerminalSignal::Kill => exec_server::terminal::TerminalSignal::Kill,
            wire::TerminalSignal::Hangup => exec_server::terminal::TerminalSignal::Hangup,
        };
        self.context
            .terminal_service_for(params.dir_id.as_deref())?
            .send_signal(connection.connection_id, &params.terminal_id, signal)
            .map_err(terminal_error)?;
        result(&())
    }

    pub(super) fn terminal_set_auto_replies(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: wire::TerminalSetAutoRepliesParams = decode(params)?;
        self.context
            .terminal_service_for(params.dir_id.as_deref())?
            .set_auto_replies(
                connection.connection_id,
                &params.terminal_id,
                params
                    .rules
                    .into_iter()
                    .map(|rule| exec_server::terminal::TerminalAutoReply {
                        match_text: rule.match_text,
                        reply: rule.reply,
                    })
                    .collect(),
            )
            .map_err(terminal_error)?;
        result(&())
    }

    pub(super) fn terminal_detach(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: TerminalCloseParams = decode(params)?;
        let lease = self
            .context
            .terminal_service_for(params.dir_id.as_deref())?
            .detach(connection.connection_id, &params.terminal_id)
            .map_err(terminal_error)?;
        result(&lease_to_dto(lease))
    }

    pub(super) fn terminal_attach(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: TerminalAttachParams = decode(params)?;
        let directory = Self::terminal_session_directory(params.dir_id.as_deref())
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        let request = exec_server::terminal::TerminalAttachRequest {
            lifetime_token: params.lifetime_token,
            terminal_id: params.terminal_id,
            reconnect_token: params.reconnect_token,
            rows: params.rows,
            cols: params.cols,
        };
        let attached = match directory {
            Some((session_id, path)) => {
                let authorization = self.context.session_dir_authorization(
                    &session_id,
                    &path,
                    ash_file_access::Permission::ExecuteCommands,
                )?;
                self.context
                    .session_terminal_service(&session_id, &authorization)?
                    .attach_in_dir(connection.connection_id, request, authorization)
            }
            None => self
                .context
                .terminal_service_for(params.dir_id.as_deref())?
                .attach(connection.connection_id, request),
        }
        .map_err(terminal_error)?;
        result(&wire::TerminalAttachResult {
            ready: ready_to_dto(attached.ready),
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
        self.context
            .terminal_service_for(params.dir_id.as_deref())?
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
            .context
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
        self.context
            .terminal_service_for(params.dir_id.as_deref())?
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
        TerminalError::Unsupported => {
            RpcError::new(-32066, AppServerErrorName::TerminalUnsupported)
        }
        TerminalError::OperationFailed => {
            RpcError::new(-32064, AppServerErrorName::TerminalOperationFailed)
        }
    }
}

fn create_request(params: TerminalCreateParams) -> exec_server::terminal::TerminalCreateRequest {
    exec_server::terminal::TerminalCreateRequest {
        lifetime_token: params.lifetime_token,
        auto_replies: params
            .auto_replies
            .unwrap_or_default()
            .into_iter()
            .map(|rule| exec_server::terminal::TerminalAutoReply {
                match_text: rule.match_text,
                reply: rule.reply,
            })
            .collect(),
        rows: params.rows,
        cols: params.cols,
        profile: profile_selection(params.profile),
        lifecycle: lifecycle(params.lifecycle),
        env: params.env.map(|values| values.into_iter().collect()),
        strict_env: params.strict_env,
        cwd: params.cwd,
        execution: params.execution.map(|execution| match execution {
            wire::TerminalExecution::Process { program, args } => {
                exec_server::terminal::TerminalExecution::Process {
                    program,
                    args: terminal_arguments(args),
                }
            }
            wire::TerminalExecution::Shell { command_line } => {
                exec_server::terminal::TerminalExecution::Shell { command_line }
            }
        }),
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
        wire::TerminalProfileSelection::Custom { name, path, args } => {
            exec_server::terminal::TerminalProfileSelection::Custom {
                name,
                path,
                args: terminal_arguments(args),
            }
        }
    }
}

fn terminal_arguments(args: wire::TerminalArguments) -> exec_server::terminal::TerminalArguments {
    match args {
        wire::TerminalArguments::Argv(args) => exec_server::terminal::TerminalArguments::Argv(args),
        wire::TerminalArguments::CommandLine(args) => {
            exec_server::terminal::TerminalArguments::CommandLine(args)
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

fn ready_to_dto(value: exec_server::terminal::TerminalProcessReady) -> wire::TerminalProcessReady {
    wire::TerminalProcessReady {
        pid: value.pid,
        cwd: value.cwd,
        shell_type: value.shell_type.map(terminal_shell_type),
    }
}

fn terminal_shell_type(value: exec_server::terminal::TerminalShellType) -> wire::TerminalShellType {
    match value {
        exec_server::terminal::TerminalShellType::Bash => wire::TerminalShellType::Bash,
        exec_server::terminal::TerminalShellType::Zsh => wire::TerminalShellType::Zsh,
        exec_server::terminal::TerminalShellType::PowerShell => wire::TerminalShellType::PowerShell,
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
                shell_integration: chunk.shell_integration.map(shell_boundary),
            })
            .collect(),
        next_sequence: value.next_sequence,
        output_gap: value.output_gap,
        command_events: value
            .command_events
            .into_iter()
            .map(command_status_event)
            .collect(),
        next_command_sequence: value.next_command_sequence,
        command_event_gap: value.command_event_gap,
        exited: value.exited,
        exit_code: value.exit_code,
        shell_integration: value.shell_integration.map(|integration| {
            wire::TerminalShellIntegration {
                command_detection: integration.command_detection,
                cwd_detection: integration.cwd_detection,
                has_rich_command_detection: integration.has_rich_command_detection,
                command_storage_disabled: integration.command_storage_disabled,
                prompt_type: integration.prompt_type,
                commands: integration
                    .commands
                    .into_iter()
                    .map(command_status_event)
                    .collect(),
                after_output_sequence: integration.after_output_sequence,
            }
        }),
        cwd: value.cwd.map(|cwd| wire::TerminalCwd {
            value: cwd.value,
            is_trusted: cwd.is_trusted,
            after_output_sequence: cwd.after_output_sequence,
        }),
    }
}

fn command_status_event(
    event: exec_server::terminal::TerminalCommandStatusEvent,
) -> wire::TerminalCommandStatusEvent {
    wire::TerminalCommandStatusEvent {
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
        cwd: event.cwd,
        command: event.command,
        is_trusted: event.is_trusted,
    }
}

fn shell_boundary(
    event: exec_server::terminal::TerminalShellIntegrationEvent,
) -> wire::TerminalShellIntegrationEvent {
    use exec_server::terminal::TerminalShellIntegrationEvent as Event;
    match event {
        Event::Environment { values, is_trusted } => {
            wire::TerminalShellIntegrationEvent::Environment { values, is_trusted }
        }
        Event::EnvironmentStart { clear, is_trusted } => {
            wire::TerminalShellIntegrationEvent::EnvironmentStart { clear, is_trusted }
        }
        Event::EnvironmentEntry {
            key,
            value,
            is_trusted,
        } => wire::TerminalShellIntegrationEvent::EnvironmentEntry {
            key,
            value,
            is_trusted,
        },
        Event::EnvironmentDelete {
            key,
            value,
            is_trusted,
        } => wire::TerminalShellIntegrationEvent::EnvironmentDelete {
            key,
            value,
            is_trusted,
        },
        Event::EnvironmentEnd { is_trusted } => {
            wire::TerminalShellIntegrationEvent::EnvironmentEnd { is_trusted }
        }
        Event::ProcessReady {
            is_windows_pty,
            shell_type,
        } => wire::TerminalShellIntegrationEvent::ProcessReady {
            is_windows_pty,
            shell_type: shell_type.map(terminal_shell_type),
        },
        Event::Cwd { value, is_trusted } => {
            wire::TerminalShellIntegrationEvent::Cwd { value, is_trusted }
        }
        Event::HasRichCommandDetection { value } => {
            wire::TerminalShellIntegrationEvent::HasRichCommandDetection { value }
        }
        Event::CommandStorageDisabled => {
            wire::TerminalShellIntegrationEvent::CommandStorageDisabled
        }
        Event::PromptType { value } => wire::TerminalShellIntegrationEvent::PromptType { value },
        Event::PromptStart => wire::TerminalShellIntegrationEvent::PromptStart,
        Event::CommandStart => wire::TerminalShellIntegrationEvent::CommandStart,
        Event::CommandExecuted {
            command_id,
            command,
            is_trusted,
            command_storage_disabled,
            cwd,
            timestamp_millis,
        } => wire::TerminalShellIntegrationEvent::CommandExecuted {
            command_id,
            command,
            is_trusted,
            command_storage_disabled,
            cwd,
            timestamp_millis,
        },
        Event::CommandFinished {
            exit_code,
            duration_millis,
        } => wire::TerminalShellIntegrationEvent::CommandFinished {
            exit_code,
            duration_millis,
        },
        Event::CommandLine { value, is_trusted } => {
            wire::TerminalShellIntegrationEvent::CommandLine { value, is_trusted }
        }
        Event::ContinuationStart => wire::TerminalShellIntegrationEvent::ContinuationStart,
        Event::ContinuationEnd => wire::TerminalShellIntegrationEvent::ContinuationEnd,
        Event::RightPromptStart => wire::TerminalShellIntegrationEvent::RightPromptStart,
        Event::RightPromptEnd => wire::TerminalShellIntegrationEvent::RightPromptEnd,
    }
}

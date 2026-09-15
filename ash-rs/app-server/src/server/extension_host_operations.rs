use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostCancellationReasonDto;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostExtensionDto;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostFailureCodeDto;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostFailureDto;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostInvokeCancelDispositionDto;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostInvokeCancelParams;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostInvokeCancelResult;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostInvokeReadParams;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostInvokeReadResult;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostInvokeStartParams;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostInvokeStartResult;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostLanguageProviderOperationDto;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostLifecycleDto;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostOutputChannelKindDto;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostOutputEventDto;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostOutputOperationDto;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostOutputSeverityDto;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostReconcileModeDto;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostReconcileParams;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostRegistrationDescriptorDto;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostRegistrationKindDto;
use ash_app_server_protocol::protocol::extension_host::ExtensionHostSnapshotDto;
use ash_editor_extension_host::CancelReason;
use ash_editor_extension_host::ExtensionHostError;
use ash_editor_extension_host::HostOutputChannelKind;
use ash_editor_extension_host::HostOutputOperation;
use ash_editor_extension_host::HostOutputSeverity;
use ash_editor_extension_host::LanguageProviderOperation;
use ash_editor_extension_host::RegistrationDescriptor;
use ash_editor_extension_host::RegistrationKind;
use ash_editor_extension_host::SequencedExtensionHostOutputEvent;
use serde_json::Value;

use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::extension_host_runtime::ExtensionHostFailureKind;
use super::extension_host_runtime::ExtensionHostFleetSnapshot;
use super::extension_host_runtime::ExtensionHostInvocationCancelDisposition;
use super::extension_host_runtime::ExtensionHostInvocationRead;
use super::extension_host_runtime::ExtensionHostInvocationRequest;
use super::extension_host_runtime::ExtensionHostLifecycle;
use super::extension_host_runtime::ExtensionHostReconcileMode;
use super::extension_host_runtime::ExtensionHostRuntimeError;
use super::extension_host_runtime::ExtensionHostRuntimeFailure;
use super::result;

impl AppServer {
    pub(super) fn extension_host_list(&self) -> Result<Value, RpcError> {
        let runtime = self.extension_host_runtime()?;
        result(&fleet_dto(runtime.snapshot()))
    }

    pub(super) fn extension_host_reconcile(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ExtensionHostReconcileParams = decode(params)?;
        let mode = match params.mode {
            ExtensionHostReconcileModeDto::Refresh => ExtensionHostReconcileMode::Refresh,
            ExtensionHostReconcileModeDto::RestartFailed => {
                ExtensionHostReconcileMode::RestartFailed
            }
        };
        let snapshot = self
            .extension_host_runtime()?
            .reconcile(mode)
            .map_err(runtime_rpc_error)?;
        result(&fleet_dto(snapshot))
    }

    pub(super) fn extension_host_invoke_start(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ExtensionHostInvokeStartParams = decode(params)?;
        let invocation_id = self
            .extension_host_runtime()?
            .start_invocation(
                connection.connection_id,
                ExtensionHostInvocationRequest {
                    extension_id: params.extension_id,
                    registration_id: params.registration_id,
                    activation_generation: params.activation_generation,
                    incarnation: params.incarnation,
                    operation: params.operation,
                    payload: params.payload,
                    deadline_unix_millis: params.deadline_unix_millis,
                },
            )
            .map_err(runtime_rpc_error)?;
        result(&ExtensionHostInvokeStartResult { invocation_id })
    }

    pub(super) fn extension_host_invoke_read(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ExtensionHostInvokeReadParams = decode(params)?;
        let read = self
            .extension_host_runtime()?
            .read_invocation(connection.connection_id, &params.invocation_id)
            .map_err(runtime_rpc_error)?;
        result(&match read {
            ExtensionHostInvocationRead::Pending => ExtensionHostInvokeReadResult::Pending,
            ExtensionHostInvocationRead::Succeeded(payload) => {
                ExtensionHostInvokeReadResult::Succeeded { payload }
            }
            ExtensionHostInvocationRead::Failed(failure) => ExtensionHostInvokeReadResult::Failed {
                code: failure_code(failure.code),
                message: failure.message,
            },
            ExtensionHostInvocationRead::Cancelled(reason) => {
                ExtensionHostInvokeReadResult::Cancelled {
                    reason: cancellation_reason(reason),
                }
            }
        })
    }

    pub(super) fn extension_host_invoke_cancel(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ExtensionHostInvokeCancelParams = decode(params)?;
        let disposition = self
            .extension_host_runtime()?
            .cancel_invocation(connection.connection_id, &params.invocation_id)
            .map_err(runtime_rpc_error)?;
        result(&ExtensionHostInvokeCancelResult {
            disposition: match disposition {
                ExtensionHostInvocationCancelDisposition::Requested => {
                    ExtensionHostInvokeCancelDispositionDto::Requested
                }
                ExtensionHostInvocationCancelDisposition::AlreadyTerminal => {
                    ExtensionHostInvokeCancelDispositionDto::AlreadyTerminal
                }
            },
        })
    }

    fn extension_host_runtime(
        &self,
    ) -> Result<&super::extension_host_runtime::ExtensionHostRuntime, RpcError> {
        self.extension_hosts
            .as_ref()
            .ok_or_else(|| RpcError::new(-32070, AppServerErrorName::ExtensionHostUnavailable))
    }
}

fn fleet_dto(snapshot: ExtensionHostFleetSnapshot) -> ExtensionHostSnapshotDto {
    ExtensionHostSnapshotDto {
        generation: snapshot.generation,
        extensions: snapshot
            .extensions
            .into_iter()
            .map(|extension| ExtensionHostExtensionDto {
                id: extension.id,
                version: extension.version,
                package_digest: extension.package_digest,
                runtime_api_version: extension.runtime_api_version,
                activation_generation: extension.activation_generation,
                incarnation: extension.incarnation,
                lifecycle: match extension.lifecycle {
                    ExtensionHostLifecycle::Stopped => ExtensionHostLifecycleDto::Stopped,
                    ExtensionHostLifecycle::Starting => ExtensionHostLifecycleDto::Starting,
                    ExtensionHostLifecycle::Ready => ExtensionHostLifecycleDto::Ready,
                    ExtensionHostLifecycle::Recovering => ExtensionHostLifecycleDto::Recovering,
                    ExtensionHostLifecycle::CrashLoop => ExtensionHostLifecycleDto::CrashLoop,
                    ExtensionHostLifecycle::Failed => ExtensionHostLifecycleDto::Failed,
                },
                failure: extension.failure.map(failure_dto),
                stderr: extension.stderr,
                output_events: extension
                    .output_events
                    .into_iter()
                    .map(output_event_dto)
                    .collect(),
                registrations: extension
                    .registrations
                    .into_iter()
                    .map(registration_dto)
                    .collect(),
            })
            .collect(),
    }
}

fn output_event_dto(event: SequencedExtensionHostOutputEvent) -> ExtensionHostOutputEventDto {
    ExtensionHostOutputEventDto {
        sequence: event.sequence,
        incarnation: event.event.context.incarnation,
        activation_generation: event.event.context.activation_generation,
        operation: match event.event.operation {
            HostOutputOperation::Create {
                channel_id,
                label,
                kind,
            } => ExtensionHostOutputOperationDto::Create {
                channel_id,
                label,
                kind: match kind {
                    HostOutputChannelKind::Output => ExtensionHostOutputChannelKindDto::Output,
                    HostOutputChannelKind::Log => ExtensionHostOutputChannelKindDto::Log,
                },
            },
            HostOutputOperation::Append {
                channel_id,
                text,
                severity,
                category,
            } => ExtensionHostOutputOperationDto::Append {
                channel_id,
                text,
                severity: output_severity_dto(severity),
                category,
            },
            HostOutputOperation::Replace {
                channel_id,
                text,
                severity,
                category,
            } => ExtensionHostOutputOperationDto::Replace {
                channel_id,
                text,
                severity: output_severity_dto(severity),
                category,
            },
            HostOutputOperation::Clear { channel_id } => {
                ExtensionHostOutputOperationDto::Clear { channel_id }
            }
            HostOutputOperation::Show {
                channel_id,
                preserve_focus,
            } => ExtensionHostOutputOperationDto::Show {
                channel_id,
                preserve_focus,
            },
            HostOutputOperation::Dispose { channel_id } => {
                ExtensionHostOutputOperationDto::Dispose { channel_id }
            }
        },
    }
}

fn output_severity_dto(severity: HostOutputSeverity) -> ExtensionHostOutputSeverityDto {
    match severity {
        HostOutputSeverity::Trace => ExtensionHostOutputSeverityDto::Trace,
        HostOutputSeverity::Debug => ExtensionHostOutputSeverityDto::Debug,
        HostOutputSeverity::Information => ExtensionHostOutputSeverityDto::Information,
        HostOutputSeverity::Warning => ExtensionHostOutputSeverityDto::Warning,
        HostOutputSeverity::Error => ExtensionHostOutputSeverityDto::Error,
        HostOutputSeverity::Log => ExtensionHostOutputSeverityDto::Log,
    }
}

fn failure_dto(failure: ExtensionHostRuntimeFailure) -> ExtensionHostFailureDto {
    ExtensionHostFailureDto {
        code: failure_code(failure.code),
        message: failure.message,
        incarnation: failure.incarnation,
    }
}

fn failure_code(code: ExtensionHostFailureKind) -> ExtensionHostFailureCodeDto {
    match code {
        ExtensionHostFailureKind::AuthorityDenied => ExtensionHostFailureCodeDto::AuthorityDenied,
        ExtensionHostFailureKind::IsolationUnavailable => {
            ExtensionHostFailureCodeDto::IsolationUnavailable
        }
        ExtensionHostFailureKind::LaunchFailed => ExtensionHostFailureCodeDto::LaunchFailed,
        ExtensionHostFailureKind::HandshakeFailed => ExtensionHostFailureCodeDto::HandshakeFailed,
        ExtensionHostFailureKind::ActivationFailed => ExtensionHostFailureCodeDto::ActivationFailed,
        ExtensionHostFailureKind::RegistrationNotFound => {
            ExtensionHostFailureCodeDto::RegistrationNotFound
        }
        ExtensionHostFailureKind::OperationNotSupported => {
            ExtensionHostFailureCodeDto::OperationNotSupported
        }
        ExtensionHostFailureKind::Cancelled => ExtensionHostFailureCodeDto::Cancelled,
        ExtensionHostFailureKind::DeadlineExceeded => ExtensionHostFailureCodeDto::DeadlineExceeded,
        ExtensionHostFailureKind::QuotaExceeded => ExtensionHostFailureCodeDto::QuotaExceeded,
        ExtensionHostFailureKind::HostExited => ExtensionHostFailureCodeDto::HostExited,
        ExtensionHostFailureKind::HostRestarted => ExtensionHostFailureCodeDto::HostRestarted,
        ExtensionHostFailureKind::OutcomeIndeterminate => {
            ExtensionHostFailureCodeDto::OutcomeIndeterminate
        }
        ExtensionHostFailureKind::CrashLoop => ExtensionHostFailureCodeDto::CrashLoop,
        ExtensionHostFailureKind::InvalidProtocol => ExtensionHostFailureCodeDto::InvalidProtocol,
        ExtensionHostFailureKind::Internal => ExtensionHostFailureCodeDto::Internal,
    }
}

fn registration_dto(
    registration: RegistrationDescriptor,
) -> ExtensionHostRegistrationDescriptorDto {
    ExtensionHostRegistrationDescriptorDto {
        registration_id: registration.registration_id,
        kind: match registration.kind {
            RegistrationKind::Command { command, title } => {
                ExtensionHostRegistrationKindDto::Command { command, title }
            }
            RegistrationKind::LanguageProvider {
                language_ids,
                operations,
            } => ExtensionHostRegistrationKindDto::LanguageProvider {
                language_ids,
                operations: operations.into_iter().map(language_operation).collect(),
            },
            RegistrationKind::DebugAdapter { debugger_type } => {
                ExtensionHostRegistrationKindDto::DebugAdapter { debugger_type }
            }
            RegistrationKind::TaskProvider { task_type } => {
                ExtensionHostRegistrationKindDto::TaskProvider { task_type }
            }
            RegistrationKind::TestProfileProvider { provider_id, label } => {
                ExtensionHostRegistrationKindDto::TestProfileProvider { provider_id, label }
            }
        },
    }
}

fn language_operation(
    operation: LanguageProviderOperation,
) -> ExtensionHostLanguageProviderOperationDto {
    match operation {
        LanguageProviderOperation::Completion => {
            ExtensionHostLanguageProviderOperationDto::Completion
        }
        LanguageProviderOperation::ParameterHints => {
            ExtensionHostLanguageProviderOperationDto::ParameterHints
        }
        LanguageProviderOperation::Definition => {
            ExtensionHostLanguageProviderOperationDto::Definition
        }
        LanguageProviderOperation::Hover => ExtensionHostLanguageProviderOperationDto::Hover,
        LanguageProviderOperation::References => {
            ExtensionHostLanguageProviderOperationDto::References
        }
        LanguageProviderOperation::Rename => ExtensionHostLanguageProviderOperationDto::Rename,
        LanguageProviderOperation::Formatting => {
            ExtensionHostLanguageProviderOperationDto::Formatting
        }
        LanguageProviderOperation::CodeAction => {
            ExtensionHostLanguageProviderOperationDto::CodeAction
        }
        LanguageProviderOperation::CodeLens => ExtensionHostLanguageProviderOperationDto::CodeLens,
        LanguageProviderOperation::DocumentSymbols => {
            ExtensionHostLanguageProviderOperationDto::DocumentSymbols
        }
        LanguageProviderOperation::FoldingRanges => {
            ExtensionHostLanguageProviderOperationDto::FoldingRanges
        }
        LanguageProviderOperation::DocumentLinks => {
            ExtensionHostLanguageProviderOperationDto::DocumentLinks
        }
        LanguageProviderOperation::DocumentColors => {
            ExtensionHostLanguageProviderOperationDto::DocumentColors
        }
        LanguageProviderOperation::SemanticTokens => {
            ExtensionHostLanguageProviderOperationDto::SemanticTokens
        }
        LanguageProviderOperation::InlayHints => {
            ExtensionHostLanguageProviderOperationDto::InlayHints
        }
        LanguageProviderOperation::LinkedEditing => {
            ExtensionHostLanguageProviderOperationDto::LinkedEditing
        }
    }
}

fn cancellation_reason(reason: CancelReason) -> ExtensionHostCancellationReasonDto {
    match reason {
        CancelReason::Caller => ExtensionHostCancellationReasonDto::Caller,
        CancelReason::Deadline => ExtensionHostCancellationReasonDto::Deadline,
        CancelReason::AuthorityRevoked => ExtensionHostCancellationReasonDto::AuthorityRevoked,
        CancelReason::Shutdown => ExtensionHostCancellationReasonDto::Shutdown,
    }
}

fn runtime_rpc_error(error: ExtensionHostRuntimeError) -> RpcError {
    let name = match error {
        ExtensionHostRuntimeError::Stale => AppServerErrorName::ExtensionHostStale,
        ExtensionHostRuntimeError::InvocationNotFound => {
            AppServerErrorName::ExtensionHostInvocationNotFound
        }
        ExtensionHostRuntimeError::QuotaExceeded => AppServerErrorName::ExtensionHostQuotaExceeded,
        ExtensionHostRuntimeError::Host(error) => match error {
            ExtensionHostError::QuotaExceeded(_) => AppServerErrorName::ExtensionHostQuotaExceeded,
            ExtensionHostError::AuthorityDenied
            | ExtensionHostError::RegistrationNotFound
            | ExtensionHostError::HostRestarted => AppServerErrorName::ExtensionHostStale,
            _ => AppServerErrorName::ExtensionHostUnavailable,
        },
        ExtensionHostRuntimeError::Internal => AppServerErrorName::ExtensionHostUnavailable,
    };
    RpcError::new(-32070, name)
}

#[cfg(test)]
#[path = "extension_host_operations_tests.rs"]
mod tests;

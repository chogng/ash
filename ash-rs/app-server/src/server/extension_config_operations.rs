use super::AppServer;
use super::RpcError;
use super::config_operations::config_command_result;
use super::config_operations::config_operation_error;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::config::HookActionDto;
use ash_app_server_protocol::protocol::config::HookConfigDto;
use ash_app_server_protocol::protocol::config::HookEnablementDto;
use ash_app_server_protocol::protocol::config::HookEventDto;
use ash_app_server_protocol::protocol::config::HookMatcherDto;
use ash_app_server_protocol::protocol::config::HookRemoveParams;
use ash_app_server_protocol::protocol::config::HookSetEnablementParams;
use ash_app_server_protocol::protocol::config::HookUpsertParams;
use ash_app_server_protocol::protocol::config::PluginRequestDto;
use ash_app_server_protocol::protocol::config::PluginRequestEnablementDto;
use ash_app_server_protocol::protocol::config::PluginRequestRemoveParams;
use ash_app_server_protocol::protocol::config::PluginRequestSetEnablementParams;
use ash_app_server_protocol::protocol::config::PluginRequestUpsertParams;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_config::ConfigCommandRequest;
use ash_config::ConfigRevision;
use ash_config::HookAction;
use ash_config::HookConfig;
use ash_config::HookEnablement;
use ash_config::HookEvent;
use ash_config::HookId;
use ash_config::HookMatcher;
use ash_config::PluginPackageId;
use ash_config::PluginRequest;
use ash_config::PluginRequestEnablement;
use ash_config::PluginVersion;
use ash_config::UserConfigCommand;
use serde_json::Value;

impl AppServer {
    pub(super) fn plugin_request_upsert(&self, params: &Value) -> Result<Value, RpcError> {
        let params: PluginRequestUpsertParams = decode(params)?;
        let request = plugin_request_from_dto(params.request)?;
        let outcome = self
            .config_store()?
            .apply(ConfigCommandRequest {
                command_id: params.command_id,
                expected_revision: ConfigRevision::new(params.expected_revision),
                command: UserConfigCommand::UpsertPluginRequest { request },
            })
            .map_err(config_operation_error)?;
        result(&config_command_result(outcome))
    }

    pub(super) fn plugin_request_remove(&self, params: &Value) -> Result<Value, RpcError> {
        let params: PluginRequestRemoveParams = decode(params)?;
        let plugin_id = PluginPackageId::new(params.plugin_id).map_err(invalid_params)?;
        let outcome = self
            .config_store()?
            .apply(ConfigCommandRequest {
                command_id: params.command_id,
                expected_revision: ConfigRevision::new(params.expected_revision),
                command: UserConfigCommand::RemovePluginRequest { plugin_id },
            })
            .map_err(config_operation_error)?;
        result(&config_command_result(outcome))
    }

    pub(super) fn plugin_request_set_enablement(&self, params: &Value) -> Result<Value, RpcError> {
        let params: PluginRequestSetEnablementParams = decode(params)?;
        let plugin_id = PluginPackageId::new(params.plugin_id).map_err(invalid_params)?;
        let outcome = self
            .config_store()?
            .apply(ConfigCommandRequest {
                command_id: params.command_id,
                expected_revision: ConfigRevision::new(params.expected_revision),
                command: UserConfigCommand::SetPluginRequestEnablement {
                    plugin_id,
                    enablement: plugin_enablement_from_dto(params.enablement),
                },
            })
            .map_err(config_operation_error)?;
        result(&config_command_result(outcome))
    }

    pub(super) fn hook_upsert(&self, params: &Value) -> Result<Value, RpcError> {
        let params: HookUpsertParams = decode(params)?;
        let hook = hook_config_from_dto(params.hook)?;
        let outcome = self
            .config_store()?
            .apply(ConfigCommandRequest {
                command_id: params.command_id,
                expected_revision: ConfigRevision::new(params.expected_revision),
                command: UserConfigCommand::UpsertHook { hook },
            })
            .map_err(config_operation_error)?;
        result(&config_command_result(outcome))
    }

    pub(super) fn hook_remove(&self, params: &Value) -> Result<Value, RpcError> {
        let params: HookRemoveParams = decode(params)?;
        let hook_id = HookId::new(params.hook_id).map_err(invalid_params)?;
        let outcome = self
            .config_store()?
            .apply(ConfigCommandRequest {
                command_id: params.command_id,
                expected_revision: ConfigRevision::new(params.expected_revision),
                command: UserConfigCommand::RemoveHook { hook_id },
            })
            .map_err(config_operation_error)?;
        result(&config_command_result(outcome))
    }

    pub(super) fn hook_set_enablement(&self, params: &Value) -> Result<Value, RpcError> {
        let params: HookSetEnablementParams = decode(params)?;
        let hook_id = HookId::new(params.hook_id).map_err(invalid_params)?;
        let outcome = self
            .config_store()?
            .apply(ConfigCommandRequest {
                command_id: params.command_id,
                expected_revision: ConfigRevision::new(params.expected_revision),
                command: UserConfigCommand::SetHookEnablement {
                    hook_id,
                    enablement: hook_enablement_from_dto(params.enablement),
                },
            })
            .map_err(config_operation_error)?;
        result(&config_command_result(outcome))
    }

    fn config_store(&self) -> Result<std::sync::Arc<ash_config::ConfigStore>, RpcError> {
        self.config
            .clone()
            .ok_or_else(|| RpcError::new(-32030, AppServerErrorName::ConfigUnavailable))
    }
}

pub(super) fn plugin_request_dto(request: PluginRequest) -> PluginRequestDto {
    PluginRequestDto {
        plugin_id: request.plugin_id.to_string(),
        version: request.version.to_string(),
        enablement: plugin_enablement_dto(request.enablement),
    }
}

fn plugin_request_from_dto(request: PluginRequestDto) -> Result<PluginRequest, RpcError> {
    Ok(PluginRequest {
        plugin_id: PluginPackageId::new(request.plugin_id).map_err(invalid_params)?,
        version: PluginVersion::new(request.version).map_err(invalid_params)?,
        enablement: plugin_enablement_from_dto(request.enablement),
    })
}

fn plugin_enablement_dto(enablement: PluginRequestEnablement) -> PluginRequestEnablementDto {
    match enablement {
        PluginRequestEnablement::Disabled => PluginRequestEnablementDto::Disabled,
        PluginRequestEnablement::Enabled => PluginRequestEnablementDto::Enabled,
    }
}

fn plugin_enablement_from_dto(enablement: PluginRequestEnablementDto) -> PluginRequestEnablement {
    match enablement {
        PluginRequestEnablementDto::Disabled => PluginRequestEnablement::Disabled,
        PluginRequestEnablementDto::Enabled => PluginRequestEnablement::Enabled,
    }
}

pub(super) fn hook_config_dto(hook: HookConfig) -> HookConfigDto {
    HookConfigDto {
        id: hook.id.to_string(),
        event: hook_event_dto(hook.event),
        matcher: HookMatcherDto {
            tool_names: hook.matcher.tool_names.into_iter().collect(),
        },
        action: hook_action_dto(hook.action),
        enablement: hook_enablement_dto(hook.enablement),
    }
}

fn hook_config_from_dto(hook: HookConfigDto) -> Result<HookConfig, RpcError> {
    Ok(HookConfig {
        id: HookId::new(hook.id).map_err(invalid_params)?,
        event: hook_event_from_dto(hook.event),
        matcher: HookMatcher {
            tool_names: hook.matcher.tool_names.into_iter().collect(),
        },
        action: hook_action_from_dto(hook.action),
        enablement: hook_enablement_from_dto(hook.enablement),
    })
}

fn hook_event_dto(event: HookEvent) -> HookEventDto {
    match event {
        HookEvent::BeforeTool => HookEventDto::BeforeTool,
        HookEvent::AfterTool => HookEventDto::AfterTool,
        HookEvent::TurnCompleted => HookEventDto::TurnCompleted,
    }
}

fn hook_event_from_dto(event: HookEventDto) -> HookEvent {
    match event {
        HookEventDto::BeforeTool => HookEvent::BeforeTool,
        HookEventDto::AfterTool => HookEvent::AfterTool,
        HookEventDto::TurnCompleted => HookEvent::TurnCompleted,
    }
}

fn hook_action_dto(action: HookAction) -> HookActionDto {
    match action {
        HookAction::Process { program, args } => HookActionDto::Process { program, args },
    }
}

fn hook_action_from_dto(action: HookActionDto) -> HookAction {
    match action {
        HookActionDto::Process { program, args } => HookAction::Process { program, args },
    }
}

fn hook_enablement_dto(enablement: HookEnablement) -> HookEnablementDto {
    match enablement {
        HookEnablement::Disabled => HookEnablementDto::Disabled,
        HookEnablement::Enabled => HookEnablementDto::Enabled,
    }
}

fn hook_enablement_from_dto(enablement: HookEnablementDto) -> HookEnablement {
    match enablement {
        HookEnablementDto::Disabled => HookEnablement::Disabled,
        HookEnablementDto::Enabled => HookEnablement::Enabled,
    }
}

fn invalid_params(_: impl std::fmt::Display) -> RpcError {
    RpcError::new(-32602, AppServerErrorName::InvalidParams)
}

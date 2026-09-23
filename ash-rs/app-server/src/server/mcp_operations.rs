use super::AppServer;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::mcp::McpOAuthMutationParams;
use ash_app_server_protocol::protocol::mcp::McpOAuthMutationResult;
use ash_app_server_protocol::protocol::mcp::McpOAuthStartParams;
use ash_app_server_protocol::protocol::mcp::McpOAuthStartResult;
use ash_app_server_protocol::protocol::mcp::McpSecretDto;
use ash_app_server_protocol::protocol::mcp::McpServerRuntimeIntentDto;
use ash_app_server_protocol::protocol::mcp::McpServerRuntimeIntentParams;
use ash_app_server_protocol::protocol::mcp::McpServerRuntimeIntentResult;
use ash_app_server_protocol::protocol::mcp::McpServerRuntimeStateDto;
use ash_app_server_protocol::protocol::mcp::McpServerStatusDto;
use ash_app_server_protocol::protocol::mcp::McpServerStatusResult;
use ash_config::McpServerConfig;
use ash_config::McpServerEnablement;
use ash_config::McpServerId;
use ash_config::McpTransportConfig;
use ash_mcp_extension::McpOAuthCompleteRequest;
use ash_mcp_extension::McpOAuthError;
use ash_mcp_extension::McpOAuthErrorKind;
use ash_mcp_extension::McpOAuthFlowId;
use ash_mcp_extension::McpOAuthStartRequest;
use ash_mcp_extension::McpOAuthTarget;
use ash_mcp_extension::McpServerRuntimeIntent;
use ash_secrets::SecretValue;
use serde_json::Value;
use std::collections::BTreeMap;
use std::time::Duration;
use std::time::Instant;

const MCP_OAUTH_DISCONNECT_TIMEOUT: Duration = Duration::from_secs(5);
const MCP_OAUTH_DISCONNECT_POLL_INTERVAL: Duration = Duration::from_millis(5);

impl AppServer {
    pub(super) fn mcp_oauth_start(&self, params: &Value) -> Result<Value, RpcError> {
        let params: McpOAuthStartParams = decode(params)?;
        let server_id = parse_server_id(params.server_id)?;
        let target = self.mcp_oauth_target(&server_id)?;
        let authorization = self
            .mcp_oauth_service()?
            .start(McpOAuthStartRequest {
                target,
                redirect_uri: params.redirect_uri,
            })
            .map_err(mcp_oauth_start_error)?;
        result(&McpOAuthStartResult {
            flow_id: authorization.flow_id.as_str().to_owned(),
            authorization_url: authorization.authorization_url,
        })
    }

    pub(super) fn mcp_oauth_complete(&self, params: Value) -> Result<Value, RpcError> {
        let Value::Object(mut params) = params else {
            return Err(invalid_params());
        };
        let state: McpSecretDto =
            serde_json::from_value(params.remove("state").ok_or_else(invalid_params)?)
                .map_err(|_| invalid_params())?;
        let authorization_code: McpSecretDto = serde_json::from_value(
            params
                .remove("authorizationCode")
                .ok_or_else(invalid_params)?,
        )
        .map_err(|_| invalid_params())?;
        let metadata: McpOAuthCompleteMetadata =
            serde_json::from_value(Value::Object(params)).map_err(|_| invalid_params())?;
        let flow_id = McpOAuthFlowId::new(metadata.flow_id).map_err(|_| invalid_params())?;
        let oauth = self.mcp_oauth_service()?;
        let server_id = oauth
            .pending_server_id(&flow_id)
            .ok_or_else(invalid_callback)?;
        let current_target = self.mcp_oauth_target(&server_id)?;
        let server_id = oauth
            .complete(McpOAuthCompleteRequest {
                flow_id,
                state: SecretValue::new(state.into_bytes()),
                authorization_code: SecretValue::new(authorization_code.into_bytes()),
                current_target,
            })
            .map_err(mcp_oauth_callback_error)?;
        self.reconcile_mcp(server_id.clone(), McpServerRuntimeIntent::Connect);
        result(&McpOAuthMutationResult {
            server_id: server_id.to_string(),
        })
    }

    pub(super) fn mcp_oauth_refresh(&self, params: &Value) -> Result<Value, RpcError> {
        let params: McpOAuthMutationParams = decode(params)?;
        let server_id = parse_server_id(params.server_id)?;
        let target = self.mcp_oauth_target(&server_id)?;
        self.mcp_oauth_service()?
            .refresh(&target)
            .map_err(mcp_oauth_operation_error)?;
        self.reconcile_mcp(server_id.clone(), McpServerRuntimeIntent::Connect);
        result(&McpOAuthMutationResult {
            server_id: server_id.to_string(),
        })
    }

    pub(super) fn mcp_oauth_revoke(&self, params: &Value) -> Result<Value, RpcError> {
        let params: McpOAuthMutationParams = decode(params)?;
        let server_id = parse_server_id(params.server_id)?;
        let target = self.mcp_oauth_target(&server_id)?;
        self.disconnect_mcp_before_revoke(&server_id)?;
        self.mcp_oauth_service()?
            .revoke(&target)
            .map_err(mcp_oauth_operation_error)?;
        result(&McpOAuthMutationResult {
            server_id: server_id.to_string(),
        })
    }

    pub(super) fn mcp_server_connect(&self, params: &Value) -> Result<Value, RpcError> {
        self.set_mcp_runtime_intent(params, McpServerRuntimeIntent::Connect)
    }

    pub(super) fn mcp_server_disconnect(&self, params: &Value) -> Result<Value, RpcError> {
        self.set_mcp_runtime_intent(params, McpServerRuntimeIntent::Disconnect)
    }

    fn set_mcp_runtime_intent(
        &self,
        params: &Value,
        intent: McpServerRuntimeIntent,
    ) -> Result<Value, RpcError> {
        let params: McpServerRuntimeIntentParams = super::decode(params)?;
        let server_id = McpServerId::new(params.server_id)
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        let config = self
            .config
            .as_ref()
            .ok_or_else(|| RpcError::new(-32030, AppServerErrorName::ConfigUnavailable))?
            .read_snapshot()
            .map_err(|_| RpcError::new(-32030, AppServerErrorName::ConfigUnavailable))?;
        if !config.values.mcp.servers.contains_key(&server_id) {
            return Err(RpcError::new(-32011, AppServerErrorName::McpServerNotFound));
        }
        if self.local_env_host.is_none() {
            return Err(RpcError::new(
                -32090,
                AppServerErrorName::McpRuntimeUnavailable,
            ));
        }
        self.mcp_runtime_intents.set(server_id.clone(), intent);
        result(&McpServerRuntimeIntentResult {
            server_id: server_id.to_string(),
            intent: match intent {
                McpServerRuntimeIntent::Connect => McpServerRuntimeIntentDto::Connect,
                McpServerRuntimeIntent::Disconnect => McpServerRuntimeIntentDto::Disconnect,
            },
        })
    }

    pub(super) fn mcp_server_status(&self) -> Result<Value, RpcError> {
        let config = self
            .config
            .as_ref()
            .ok_or_else(|| RpcError::new(-32030, AppServerErrorName::ConfigUnavailable))?
            .read_snapshot()
            .map_err(|_| RpcError::new(-32030, AppServerErrorName::ConfigUnavailable))?;
        let runtime = self
            .mcp_status
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        let mut servers = config
            .values
            .mcp
            .servers
            .values()
            .map(|server| {
                let runtime_server = runtime.server(server.id.as_str());
                let runtime_intent = self.mcp_runtime_intents.intent(&server.id);
                let state = match server.enablement {
                    McpServerEnablement::Disabled => match runtime_intent {
                        Some(McpServerRuntimeIntent::Connect) => runtime_server
                            .map(runtime_state)
                            .unwrap_or(McpServerRuntimeStateDto::Unavailable {
                                reason: "MCP server is not present in the active runtime".into(),
                            }),
                        _ => McpServerRuntimeStateDto::Disabled,
                    },
                    McpServerEnablement::Enabled => match runtime_server {
                        Some(status) => runtime_state(status),
                        None => match runtime_intent {
                            Some(McpServerRuntimeIntent::Disconnect) => {
                                McpServerRuntimeStateDto::Disconnected
                            }
                            _ => McpServerRuntimeStateDto::Unavailable {
                                reason: "MCP server is not present in the active runtime".into(),
                            },
                        },
                    },
                };
                McpServerStatusDto {
                    id: server.id.to_string(),
                    display_name: server.display_name.clone(),
                    http_origin: match &server.transport {
                        McpTransportConfig::Stdio { .. } => None,
                        McpTransportConfig::StreamableHttp { url } => url::Url::parse(url)
                            .ok()
                            .filter(|url| matches!(url.scheme(), "http" | "https"))
                            .map(|url| url.origin().ascii_serialization()),
                    },
                    state,
                    catalog_generation: runtime_server
                        .map(|status| status.catalog_generation)
                        .unwrap_or(runtime.catalog_generation),
                    connection_generation: runtime_server
                        .and_then(|status| status.connection_generation),
                    tool_count: runtime_server.map(|status| status.tool_count).unwrap_or(0),
                }
            })
            .map(|server| (server.id.to_string(), server))
            .collect::<BTreeMap<_, _>>();
        for runtime_server in &runtime.servers {
            servers
                .entry(runtime_server.server_id.clone())
                .or_insert_with(|| McpServerStatusDto {
                    id: runtime_server.server_id.clone(),
                    display_name: runtime_server.display_name.clone(),
                    http_origin: runtime_server.http_origin.clone(),
                    state: runtime_state(runtime_server),
                    catalog_generation: runtime_server.catalog_generation,
                    connection_generation: runtime_server.connection_generation,
                    tool_count: runtime_server.tool_count,
                });
        }
        result(&McpServerStatusResult {
            catalog_generation: runtime.catalog_generation,
            servers: servers.into_values().collect(),
        })
    }

    fn mcp_oauth_service(&self) -> Result<&ash_mcp_extension::McpOAuthService, RpcError> {
        self.mcp_oauth
            .as_deref()
            .ok_or_else(|| RpcError::new(-32091, AppServerErrorName::McpOAuthUnavailable))
    }

    fn mcp_oauth_target(&self, server_id: &McpServerId) -> Result<McpOAuthTarget, RpcError> {
        let config = self
            .config
            .as_ref()
            .ok_or_else(|| RpcError::new(-32030, AppServerErrorName::ConfigUnavailable))?
            .read_snapshot()
            .map_err(|_| RpcError::new(-32030, AppServerErrorName::ConfigUnavailable))?;
        let server = config
            .values
            .mcp
            .servers
            .get(server_id)
            .ok_or_else(|| RpcError::new(-32011, AppServerErrorName::McpServerNotFound))?;
        oauth_target(server)
    }

    fn reconcile_mcp(&self, server_id: McpServerId, intent: McpServerRuntimeIntent) {
        self.mcp_runtime_intents.set(server_id, intent);
        self.mcp_runtime_intents.reconcile();
    }

    fn disconnect_mcp_before_revoke(&self, server_id: &McpServerId) -> Result<(), RpcError> {
        self.reconcile_mcp(server_id.clone(), McpServerRuntimeIntent::Disconnect);
        if self._tool_config_watcher.is_none() {
            return Ok(());
        }
        let deadline = Instant::now() + MCP_OAUTH_DISCONNECT_TIMEOUT;
        loop {
            let disconnected = self
                .mcp_status
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .server(server_id.as_str())
                .is_none_or(|status| {
                    status.state == ash_mcp_extension::McpServerRuntimeState::Unavailable
                });
            if disconnected {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err(RpcError::new(
                    -32094,
                    AppServerErrorName::McpOAuthOperationFailed,
                ));
            }
            std::thread::sleep(MCP_OAUTH_DISCONNECT_POLL_INTERVAL);
        }
    }
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct McpOAuthCompleteMetadata {
    flow_id: String,
}

fn parse_server_id(value: String) -> Result<McpServerId, RpcError> {
    McpServerId::new(value).map_err(|_| invalid_params())
}

fn oauth_target(server: &McpServerConfig) -> Result<McpOAuthTarget, RpcError> {
    McpOAuthTarget::from_config(server).map_err(|_| invalid_params())
}

fn mcp_oauth_start_error(error: McpOAuthError) -> RpcError {
    if error.kind() == McpOAuthErrorKind::InvalidRequest {
        return invalid_params();
    }
    mcp_oauth_operation_error(error)
}

fn mcp_oauth_callback_error(error: McpOAuthError) -> RpcError {
    if matches!(
        error.kind(),
        McpOAuthErrorKind::StateMismatch | McpOAuthErrorKind::InvalidRequest
    ) {
        return invalid_callback();
    }
    mcp_oauth_operation_error(error)
}

fn mcp_oauth_operation_error(error: McpOAuthError) -> RpcError {
    match error.kind() {
        McpOAuthErrorKind::ProviderUnavailable => {
            RpcError::new(-32091, AppServerErrorName::McpOAuthUnavailable)
        }
        McpOAuthErrorKind::InvalidRequest => invalid_params(),
        McpOAuthErrorKind::StateMismatch => {
            RpcError::new(-32094, AppServerErrorName::McpOAuthOperationFailed)
        }
        McpOAuthErrorKind::Expired => RpcError::new(-32093, AppServerErrorName::McpOAuthExpired),
        McpOAuthErrorKind::ProviderFailure | McpOAuthErrorKind::Credential => {
            RpcError::new(-32094, AppServerErrorName::McpOAuthOperationFailed)
        }
    }
}

fn invalid_callback() -> RpcError {
    RpcError::new(-32092, AppServerErrorName::McpOAuthInvalidCallback)
}

fn invalid_params() -> RpcError {
    RpcError::new(-32602, AppServerErrorName::InvalidParams)
}

fn runtime_state(status: &ash_mcp_extension::McpServerRuntimeStatus) -> McpServerRuntimeStateDto {
    match status.state {
        ash_mcp_extension::McpServerRuntimeState::Connected => McpServerRuntimeStateDto::Connected,
        ash_mcp_extension::McpServerRuntimeState::Stale => McpServerRuntimeStateDto::Stale,
        ash_mcp_extension::McpServerRuntimeState::Unavailable => {
            McpServerRuntimeStateDto::Unavailable {
                reason: status
                    .diagnostic
                    .clone()
                    .unwrap_or_else(|| "MCP runtime is unavailable".into()),
            }
        }
    }
}

#[cfg(test)]
#[path = "mcp_operations_tests.rs"]
mod tests;

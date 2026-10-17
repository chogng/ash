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

/// Coordinates the existing owners needed by the mcp adapter.
/// This contract deliberately exposes no server object or unrestricted service registry.
pub(super) trait McpRequestProcessorContext: Send + Sync {
    fn agent_runtime(&self) -> impl core_api::AgentRuntime + '_;
    fn read_session_thread(
        &self,
        session_id: &ash_protocol::SessionId,
        thread_id: &ash_protocol::ThreadId,
    ) -> Result<ash_protocol::Thread, super::RpcError>;
    fn list_app_tools(
        &self,
        origin: &ash_protocol::ToolCall,
        binding: &ash_protocol::ToolCallBinding,
    ) -> Result<Vec<Value>, core_api::CoreError>;
    fn resolve_app_tool_call(
        &self,
        origin: &ash_protocol::ToolCall,
        binding: &ash_protocol::ToolCallBinding,
        name: &str,
        arguments: Value,
        id: ash_protocol::ToolCallId,
    ) -> Result<(ash_protocol::ToolCall, ash_protocol::ToolCallBinding), core_api::CoreError>;
    fn read_tool_resource(
        &self,
        call: &ash_protocol::ToolCall,
        binding: &ash_protocol::ToolCallBinding,
        uri: &str,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<ash_protocol::ToolOutputArtifact, core_api::CoreError>;
    fn completed_tool_result(
        &self,
        thread_id: &ash_protocol::ThreadId,
        turn_id: &ash_protocol::TurnId,
        call_id: &ash_protocol::ToolCallId,
    ) -> Result<Option<ash_protocol::ThreadItem>, core_api::CoreError>;
}

pub(super) struct McpRequestProcessor<'ctx, C: McpRequestProcessorContext + ?Sized> {
    context: &'ctx C,
    _tool_config_watcher: &'ctx Option<crate::local::ToolConfigWatcher>,
    config: &'ctx Option<super::Arc<super::ConfigStore>>,
    local_env_host: &'ctx Option<super::LocalEnvHost>,
    mcp_oauth: &'ctx Option<super::Arc<ash_mcp_extension::McpOAuthService>>,
    mcp_runtime_intents: &'ctx super::McpRuntimeIntents,
    mcp_status: &'ctx super::Arc<super::RwLock<ash_mcp_extension::McpRuntimeStatusSnapshot>>,
    request_cancellations: &'ctx super::RequestCancellationRegistry,
    request_scheduler: &'ctx super::RequestScheduler,
    resources: &'ctx super::Arc<super::Mutex<super::ResourceStore>>,
}

impl<'ctx, C: McpRequestProcessorContext + ?Sized> McpRequestProcessor<'ctx, C> {
    pub(super) fn new(
        context: &'ctx C,
        _tool_config_watcher: &'ctx Option<crate::local::ToolConfigWatcher>,
        config: &'ctx Option<super::Arc<super::ConfigStore>>,
        local_env_host: &'ctx Option<super::LocalEnvHost>,
        mcp_oauth: &'ctx Option<super::Arc<ash_mcp_extension::McpOAuthService>>,
        mcp_runtime_intents: &'ctx super::McpRuntimeIntents,
        mcp_status: &'ctx super::Arc<super::RwLock<ash_mcp_extension::McpRuntimeStatusSnapshot>>,
        request_cancellations: &'ctx super::RequestCancellationRegistry,
        request_scheduler: &'ctx super::RequestScheduler,
        resources: &'ctx super::Arc<super::Mutex<super::ResourceStore>>,
    ) -> Self {
        Self {
            context,
            _tool_config_watcher,
            config,
            local_env_host,
            mcp_oauth,
            mcp_runtime_intents,
            mcp_status,
            request_cancellations,
            request_scheduler,
            resources,
        }
    }
}

impl<'ctx, C: McpRequestProcessorContext + ?Sized> McpRequestProcessor<'ctx, C> {
    fn app_tool_origin(
        &self,
        session_id: &ash_protocol::SessionId,
        thread_id: &ash_protocol::ThreadId,
        item_id: &ash_protocol::ItemId,
        content_index: usize,
    ) -> Result<(u64, ash_protocol::ToolCall, ash_protocol::ToolCallBinding), RpcError> {
        use ash_protocol::{ContentPart, ThreadItem, ToolOutputArtifactSource};
        let thread = self.context.read_session_thread(session_id, thread_id)?;
        let (turn, item) = thread
            .turns
            .iter()
            .find_map(|turn| {
                turn.items
                    .iter()
                    .find(|item| item.item_id() == item_id)
                    .map(|item| (turn, item))
            })
            .ok_or_else(invalid_params)?;
        let ThreadItem::ToolResult {
            tool_call_id,
            content: Some(content),
            ..
        } = item
        else {
            return Err(invalid_params());
        };
        if !matches!(content.get(content_index), Some(ContentPart::Artifact { artifact }) if matches!(artifact.source, ToolOutputArtifactSource::McpApp { .. }))
        {
            return Err(invalid_params());
        }
        let (origin, binding) = turn
            .items
            .iter()
            .find_map(|item| match item {
                ThreadItem::ToolCall {
                    tool_call_id: id,
                    name,
                    arguments_json,
                    binding: Some(binding),
                    ..
                } if id == tool_call_id => Some((
                    ash_protocol::ToolCall {
                        id: id.clone(),
                        name: name.clone(),
                        arguments: serde_json::from_str(arguments_json).ok()?,
                    },
                    binding,
                )),
                _ => None,
            })
            .ok_or_else(invalid_params)?;
        Ok((thread.sequence, origin, binding.clone()))
    }

    pub(super) fn tool_app_list(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::mcp::ToolAppListParams = decode(params)?;
        let (_, origin, binding) = self.app_tool_origin(
            &params.session_id,
            &params.thread_id,
            &params.item_id,
            params.content_index,
        )?;
        let tools = self
            .context
            .list_app_tools(&origin, &binding)
            .map_err(super::core_error)?;
        result(&ash_app_server_protocol::protocol::mcp::ToolAppListResult { tools })
    }

    pub(super) fn tool_app_call(
        &self,
        connection: &super::ConnectionState,
        params: &Value,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<Value, RpcError> {
        use core_api::AgentRuntime;
        let params: ash_app_server_protocol::protocol::mcp::ToolAppCallParams = decode(params)?;
        if params.operation_id.is_empty()
            || params.operation_id.len() > 256
            || params.remote_name.is_empty()
            || params.remote_name.len() > 256
            || params.arguments_json.len() > 262_144
        {
            return Err(invalid_params());
        }
        let arguments: Value =
            serde_json::from_str(&params.arguments_json).map_err(|_| invalid_params())?;
        if !arguments.is_object() {
            return Err(invalid_params());
        }
        let (sequence, origin, binding) = self.app_tool_origin(
            &params.session_id,
            &params.thread_id,
            &params.item_id,
            params.content_index,
        )?;
        let id = ash_protocol::ToolCallId::new(format!(
            "app-tool-{}-{}",
            connection.connection_id, params.operation_id
        ))
        .map_err(|_| invalid_params())?;
        let (call, binding) = self
            .context
            .resolve_app_tool_call(
                &origin,
                &binding,
                &params.remote_name,
                arguments,
                id.clone(),
            )
            .map_err(super::core_error)?;
        cancellation
            .check()
            .map_err(|_| RpcError::new(-32800, AppServerErrorName::RequestCancelled))?;
        let receipt = self
            .context
            .agent_runtime()
            .submit_tool(
                &params.thread_id,
                core_api::SubmitToolRequest {
                    command_id: ash_protocol::CommandId::new(format!(
                        "app-tool-{}-{}",
                        connection.connection_id, params.operation_id
                    ))
                    .map_err(|_| invalid_params())?,
                    expected_sequence: core_api::SequenceExpectation::Exact(sequence),
                    call,
                    binding,
                },
            )
            .map_err(super::core_error)?;
        loop {
            if let Some(item) = self
                .context
                .completed_tool_result(&params.thread_id, &receipt.turn_id, &id)
                .map_err(super::core_error)?
            {
                return result(&ash_app_server_protocol::protocol::mcp::ToolAppCallResult { item });
            }
            if cancellation.is_cancelled() {
                let _ = self.context.agent_runtime().interrupt_turn(
                    &params.thread_id,
                    core_api::InterruptTurnRequest {
                        command_id: ash_protocol::CommandId::new(format!(
                            "app-cancel-{}-{}",
                            connection.connection_id, params.operation_id
                        ))
                        .map_err(|_| invalid_params())?,
                        expected_sequence: core_api::SequenceExpectation::Any,
                        turn_id: receipt.turn_id,
                    },
                );
                return Err(RpcError::new(-32800, AppServerErrorName::RequestCancelled));
            }
            // Core owns the operation and approvals. This request holds no Session lock or parallel state.
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    pub(super) fn tool_resource_cancel(
        &self,
        connection: &super::ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::mcp::ToolResourceCancelParams =
            decode(params)?;
        self.context
            .read_session_thread(&params.session_id, &params.thread_id)?;
        if params.operation_id.is_empty() || params.operation_id.len() > 256 {
            return Err(invalid_params());
        }
        self.request_cancellations
            .cancel_operation(connection.connection_id, params.operation_id);
        self.request_scheduler.cancel_waiting_requests();
        result(&())
    }

    pub(super) fn tool_resource_open(
        &self,
        connection: &super::ConnectionState,
        params: &Value,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::mcp::ToolResourceOpenParams =
            decode(params)?;
        self.open_tool_resource(connection, params, None, cancellation)
    }

    pub(super) fn tool_app_resource_open(
        &self,
        connection: &super::ConnectionState,
        params: &Value,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::mcp::ToolAppResourceOpenParams =
            decode(params)?;
        if params.uri.is_empty()
            || params.uri.len() > 4096
            || params.uri.chars().any(char::is_control)
        {
            return Err(invalid_params());
        }
        self.open_tool_resource(
            connection,
            ash_app_server_protocol::protocol::mcp::ToolResourceOpenParams {
                session_id: params.session_id,
                thread_id: params.thread_id,
                item_id: params.item_id,
                content_index: params.content_index,
                operation_id: params.operation_id,
            },
            Some(&params.uri),
            cancellation,
        )
    }

    fn open_tool_resource(
        &self,
        connection: &super::ConnectionState,
        params: ash_app_server_protocol::protocol::mcp::ToolResourceOpenParams,
        app_uri: Option<&str>,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<Value, RpcError> {
        use ash_protocol::ContentPart;
        use ash_protocol::ThreadItem;
        use ash_protocol::ToolOutputArtifactData;
        use ash_protocol::ToolOutputArtifactSource;
        if params.operation_id.is_empty() || params.operation_id.len() > 256 {
            return Err(invalid_params());
        }
        let thread = self
            .context
            .read_session_thread(&params.session_id, &params.thread_id)?;
        let (turn, item) = thread
            .turns
            .iter()
            .find_map(|turn| {
                turn.items
                    .iter()
                    .find(|item| item.item_id() == &params.item_id)
                    .map(|item| (turn, item))
            })
            .ok_or_else(invalid_params)?;
        let ThreadItem::ToolResult {
            tool_call_id,
            content: Some(content),
            ..
        } = item
        else {
            return Err(invalid_params());
        };
        let Some(ContentPart::Artifact { artifact }) = content.get(params.content_index) else {
            return Err(invalid_params());
        };
        let uri = match (&artifact.source, app_uri) {
            (ToolOutputArtifactSource::McpApp { .. }, Some(uri)) => uri,
            (
                ToolOutputArtifactSource::ResourceLink { uri }
                | ToolOutputArtifactSource::McpApp { uri },
                None,
            ) => uri.as_str(),
            (
                ToolOutputArtifactSource::EmbeddedResource { .. }
                | ToolOutputArtifactSource::StructuredResult
                | ToolOutputArtifactSource::ViewMetadata,
                _,
            )
            | (ToolOutputArtifactSource::ResourceLink { .. }, Some(_)) => {
                return Err(invalid_params());
            }
        };
        let (call, binding) = turn
            .items
            .iter()
            .find_map(|item| match item {
                ThreadItem::ToolCall {
                    tool_call_id: id,
                    name,
                    arguments_json,
                    binding: Some(binding),
                    ..
                } if id == tool_call_id => Some((
                    ash_protocol::ToolCall {
                        id: id.clone(),
                        name: name.clone(),
                        arguments: serde_json::from_str(arguments_json).ok()?,
                    },
                    binding,
                )),
                _ => None,
            })
            .ok_or_else(invalid_params)?;
        let resource = self
            .context
            .read_tool_resource(&call, binding, uri, cancellation)
            .map_err(super::core_error)?;
        let app_csp = resource.app_csp;
        let resource_metadata = resource.resource_metadata;
        let encoding = Some(match &resource.data {
            ToolOutputArtifactData::Text { .. } | ToolOutputArtifactData::Json { .. } => {
                ash_app_server_protocol::protocol::mcp::ToolResourceEncoding::Text
            }
            ToolOutputArtifactData::Binary { .. } => {
                ash_app_server_protocol::protocol::mcp::ToolResourceEncoding::Binary
            }
        });
        let bytes = match resource.data {
            ToolOutputArtifactData::Text { text } => text.into_bytes(),
            ToolOutputArtifactData::Binary { bytes } => bytes,
            ToolOutputArtifactData::Json { json } => json.into_bytes(),
        };
        cancellation
            .check()
            .map_err(|_| RpcError::new(-32800, AppServerErrorName::RequestCancelled))?;
        let state = connection
            .state
            .lock()
            .map_err(|_| RpcError::new(-32603, AppServerErrorName::InternalError))?;
        if state.closed {
            return Err(RpcError::new(-32800, AppServerErrorName::RequestCancelled));
        }
        let resource = self
            .resources
            .lock()
            .map_err(|_| RpcError::new(-32603, AppServerErrorName::InternalError))?
            .create_with_limit(
                connection.connection_id,
                resource.mime_type,
                bytes,
                Duration::from_secs(300),
                262_144,
            )
            .map_err(super::resources_processor::resource_rpc_error)?;
        result(
            &ash_app_server_protocol::protocol::mcp::ToolResourceOpenResult {
                resource_id: resource.resource_id,
                mime_type: resource.mime_type,
                size: resource.size,
                sha256: resource.sha256,
                app_csp,
                encoding,
                resource_metadata,
            },
        )
    }

    pub(super) fn mcp_oauth_start(
        &self,
        connection: &super::ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        if self
            .request_scheduler
            .is_connection_cancelled(connection.connection_id)
        {
            return Err(RpcError::new(-32800, AppServerErrorName::RequestCancelled));
        }
        let params: McpOAuthStartParams = decode(params)?;
        let server_id = parse_server_id(params.server_id)?;
        self.ensure_mcp_oauth_binding(&server_id)?;
        let target = self.mcp_oauth_target(&server_id)?;
        let authorization = self
            .mcp_oauth_service()?
            .start(McpOAuthStartRequest {
                owner: connection.connection_id,
                options: ash_mcp_extension::McpOAuthOptions {
                    client_id: params.client_id,
                    client_metadata_url: params.client_metadata_url,
                    scopes: params.scopes,
                },
                target,
                redirect_uri: params.redirect_uri,
            })
            .map_err(mcp_oauth_start_error)?;
        if self
            .request_scheduler
            .is_connection_cancelled(connection.connection_id)
        {
            self.mcp_oauth_service()?
                .cancel_owner(connection.connection_id);
            return Err(RpcError::new(-32800, AppServerErrorName::RequestCancelled));
        }
        result(&McpOAuthStartResult {
            flow_id: authorization.flow_id.as_str().to_owned(),
            authorization_url: authorization.authorization_url,
        })
    }

    pub(super) fn mcp_oauth_complete(
        &self,
        connection: &super::ConnectionState,
        params: Value,
    ) -> Result<Value, RpcError> {
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
                owner: connection.connection_id,
                issuer: metadata.issuer,
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

    pub(super) fn mcp_oauth_cancel(
        &self,
        connection: &super::ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::mcp::McpOAuthCancelParams = decode(params)?;
        let flow = McpOAuthFlowId::new(params.flow_id).map_err(|_| invalid_params())?;
        self.mcp_oauth_service()?
            .cancel(&flow, connection.connection_id);
        result(&())
    }

    pub(super) fn mcp_oauth_logout(&self, params: &Value) -> Result<Value, RpcError> {
        let params: McpOAuthMutationParams = decode(params)?;
        let server_id = parse_server_id(params.server_id)?;
        let target = self.mcp_oauth_target(&server_id)?;
        // Invalidate credentials first: even a transport awaiting reconciliation cannot refresh.
        self.mcp_oauth_service()?
            .logout(&target)
            .map_err(mcp_oauth_operation_error)?;
        self.disconnect_mcp_before_revoke(&server_id)?;
        result(&McpOAuthMutationResult {
            server_id: server_id.to_string(),
        })
    }

    fn ensure_mcp_oauth_binding(&self, server_id: &McpServerId) -> Result<(), RpcError> {
        let store = self
            .config
            .as_ref()
            .ok_or_else(|| RpcError::new(-32030, AppServerErrorName::ConfigUnavailable))?;
        let snapshot = store.read_snapshot().map_err(|_| invalid_params())?;
        let mut server = snapshot
            .values
            .mcp
            .servers
            .get(server_id)
            .cloned()
            .ok_or_else(|| RpcError::new(-32011, AppServerErrorName::McpServerNotFound))?;
        let credential_ref = format!("mcp/oauth/{}", server_id.as_str());
        if !matches!(&server.credential, ash_config::McpCredentialBinding::Reference { credential_ref: key } if *key == credential_ref)
        {
            server.credential = ash_config::McpCredentialBinding::Reference { credential_ref };
            // Validate transport before changing the declaration.
            oauth_target(&server)?;
            let mut nonce = [0_u8; 16];
            getrandom::getrandom(&mut nonce).map_err(|_| invalid_params())?;
            use base64::Engine as _;
            store
                .apply(ash_config::ConfigCommandRequest {
                    command_id: ash_protocol::CommandId::new(format!(
                        "mcp-oauth-{}",
                        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(nonce)
                    ))
                    .map_err(|_| invalid_params())?,
                    expected_revision: snapshot.revision,
                    command: ash_config::UserConfigCommand::UpsertMcpServer { server },
                })
                .map_err(|_| RpcError::new(-32031, AppServerErrorName::ConfigRevisionConflict))?;
        }
        Ok(())
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

    fn mcp_oauth_service(&self) -> Result<&'ctx ash_mcp_extension::McpOAuthService, RpcError> {
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
    #[serde(default)]
    issuer: Option<String>,
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
        McpOAuthErrorKind::RegistrationRequired => {
            RpcError::new(-32096, AppServerErrorName::McpOAuthRegistrationRequired)
        }
        McpOAuthErrorKind::ReauthenticationRequired => {
            RpcError::new(-32095, AppServerErrorName::McpOAuthReauthenticationRequired)
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
#[path = "../mcp_operations_tests.rs"]
mod tests;

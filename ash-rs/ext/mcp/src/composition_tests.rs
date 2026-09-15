use std::collections::BTreeMap;
use std::sync::Arc;

use ash_action_policy::{
    ActionDigest, ActionKind, ActionPolicyRevision, ActionProvenance, ActionReviewRequest,
    ActionSource, CapabilitySet, ExecutionDecision, ResolvedAction, SandboxCompatibility,
};
use ash_async_utils::CancellationSource;
use ash_config::{
    ConfigGeneration, McpConfig, McpCredentialBinding, McpServerConfig, McpServerEnablement,
    McpServerId, McpTransportConfig, ResolvedConfig,
};
use ash_mcp::{
    McpConnectFuture, McpPageCursor, McpServerDefinition, McpServerTransport, McpSession,
    McpSessionError, McpSessionFactory, McpSessionFuture,
};
use ash_protocol::{ToolCall, ToolCallId};
use ash_rmcp_client::{
    CallToolRequestParams, CallToolResult, JsonObject, ListToolsResult, RmcpClientOptions,
    ServerInfo, StdioServerCommand, Tool,
};
use ash_secrets::MemorySecretStore;
use ash_secrets::SecretKey;
use ash_secrets::SecretStore;
use ash_secrets::SecretValue;
use connectors::ConnectorAccountId;
use connectors::ConnectorApiTokenConnectRequest;
use connectors::ConnectorAuthority;
use connectors::ConnectorCommandId;
use connectors::ConnectorConnectionGeneration;
use connectors::ConnectorCredentialService;
use connectors::ConnectorDefinition;
use connectors::ConnectorId;
use connectors::ConnectorRuntimeBinding;

use super::{
    MCP_POLICY_REVISION, McpInvocationAuthority, McpInvocationTransport, compose_mcp_tools,
    materialize_servers, start_mcp_tools,
};
use crate::connector::ConnectorMcpRuntimeError;
use crate::connector::ConnectorMcpRuntimeProvider;
use crate::connector::materialize_connector_servers;
use crate::status::McpServerRuntimeIntent;

struct FakeFactory;

impl McpSessionFactory for FakeFactory {
    fn connect(&self, _: McpServerDefinition, _: RmcpClientOptions) -> McpConnectFuture {
        Box::pin(async { Ok(Box::new(FakeSession) as Box<dyn McpSession>) })
    }
}

struct FakeSession;

struct TokenStdioProvider;

impl ConnectorMcpRuntimeProvider for TokenStdioProvider {
    fn materialize(
        &self,
        _: &ConnectorDefinition,
        credential: SecretValue,
    ) -> Result<McpServerTransport, ConnectorMcpRuntimeError> {
        assert_eq!(credential.expose(), b"secret-token");
        Ok(McpServerTransport::Stdio(StdioServerCommand::new("unused")))
    }
}

impl McpSession for FakeSession {
    fn server_info(&self) -> ServerInfo {
        ServerInfo::default()
    }

    fn list_tools(&self, cursor: McpPageCursor) -> McpSessionFuture<'_, ListToolsResult> {
        Box::pin(async move {
            if cursor != McpPageCursor::First {
                return Err(McpSessionError::Transport("unexpected cursor".into()));
            }
            let mut schema = JsonObject::new();
            schema.insert("type".into(), serde_json::Value::String("object".into()));
            Ok(ListToolsResult {
                tools: vec![Tool::new("write", "Write remotely", Arc::new(schema))],
                ..Default::default()
            })
        })
    }

    fn call_tool(
        &self,
        _: CallToolRequestParams,
        _: &ash_async_utils::CancellationToken,
    ) -> McpSessionFuture<'_, CallToolResult> {
        Box::pin(async { Ok(CallToolResult::success(Vec::new())) })
    }

    fn shutdown(self: Box<Self>) -> McpSessionFuture<'static, ()> {
        Box::pin(async { Ok(()) })
    }
}

#[test]
fn prepares_exact_mcp_provenance_and_requires_user_approval() {
    let server = McpServerId::new("user:mcp:test").unwrap();
    let definition = McpServerDefinition::new(
        server.clone(),
        "Test",
        McpServerTransport::Stdio(StdioServerCommand::new("unused")),
    )
    .unwrap();
    let composition = start_mcp_tools(
        vec![definition],
        BTreeMap::from([(
            server.clone(),
            McpInvocationAuthority {
                display_name: "Test".into(),
                transport: McpInvocationTransport::Stdio {
                    executable: "/test/mcp".into(),
                },
                connector_fence: None,
                runtime_fence: None,
            },
        )]),
        ConfigGeneration::INITIAL.get() + 1,
        Some(Arc::new(FakeFactory)),
    )
    .expect("compose MCP tools");
    let definition = composition.tools.definitions().remove(0);
    let call = ToolCall {
        id: ToolCallId::new("call-1").unwrap(),
        name: definition.name,
        arguments: serde_json::json!({"value": 1}),
    };

    let review = composition.tools.prepare(&call).expect("prepare");
    assert_eq!(review.provenance().source(), &ActionSource::McpServer);
    assert_eq!(review.provenance().source_id(), server.as_str());
    assert!(matches!(
        composition
            .policy
            .decide(&review, &CancellationSource::new().token())
            .expect("policy"),
        ExecutionDecision::AskUser(_)
    ));

    let weaker = ActionReviewRequest::new(
        ResolvedAction::new(
            ActionDigest::from_canonical_bytes(b"weaker"),
            ActionKind::ExternalServiceMutation,
            "weaker",
            CapabilitySet::default(),
        ),
        ActionProvenance::new(ActionSource::McpServer, server.as_str()),
        SandboxCompatibility::NotApplicable {
            reason: "test".into(),
        },
        ActionPolicyRevision::new(MCP_POLICY_REVISION),
    );
    assert!(
        composition
            .policy
            .decide(&weaker, &CancellationSource::new().token())
            .is_err()
    );
}

#[test]
fn rejects_relative_stdio_executable_before_starting_runtime() {
    let server = McpServerId::new("user:mcp:test").unwrap();
    let config = ResolvedConfig {
        mcp: McpConfig {
            servers: BTreeMap::from([(
                server.clone(),
                McpServerConfig {
                    id: server,
                    display_name: "Test".into(),
                    transport: McpTransportConfig::Stdio {
                        command: "npx".into(),
                        args: Vec::new(),
                    },
                    credential: McpCredentialBinding::Unauthenticated,
                    enablement: McpServerEnablement::Enabled,
                },
            )]),
        },
        ..ResolvedConfig::default()
    };

    let error = match compose_mcp_tools(&config, ConfigGeneration::INITIAL) {
        Ok(_) => panic!("relative executable must be rejected"),
        Err(error) => error,
    };
    assert!(error.to_string().contains("absolute executable path"));
}

#[test]
fn materializes_direct_http_credentials_only_from_the_host_secret_store() {
    let server = McpServerId::new("user:mcp:private").unwrap();
    let config = ResolvedConfig {
        mcp: McpConfig {
            servers: BTreeMap::from([(
                server.clone(),
                McpServerConfig {
                    id: server,
                    display_name: "Private".into(),
                    transport: McpTransportConfig::StreamableHttp {
                        url: "https://mcp.example.test".into(),
                    },
                    credential: McpCredentialBinding::Reference {
                        credential_ref: "user:credential:private".into(),
                    },
                    enablement: McpServerEnablement::Enabled,
                },
            )]),
        },
        ..ResolvedConfig::default()
    };
    let secrets = MemorySecretStore::default();
    let key = SecretKey::new("user:credential:private").unwrap();
    secrets
        .store(&key, &SecretValue::new(b"bearer-token".to_vec()))
        .unwrap();

    let (definitions, authorities) =
        materialize_servers(&config, Some(&secrets), &BTreeMap::new()).unwrap();
    assert_eq!(definitions.len(), 1);
    assert_eq!(authorities.len(), 1);
    assert!(matches!(
        definitions[0].transport(),
        McpServerTransport::StreamableHttp(_)
    ));
}

#[test]
fn runtime_intents_override_durable_enablement_without_mutating_config() {
    let server = McpServerId::new("user:mcp:temporary").unwrap();
    let config = ResolvedConfig {
        mcp: McpConfig {
            servers: BTreeMap::from([(
                server.clone(),
                McpServerConfig {
                    id: server.clone(),
                    display_name: "Temporary".into(),
                    transport: McpTransportConfig::StreamableHttp {
                        url: "https://mcp.example.test".into(),
                    },
                    credential: McpCredentialBinding::Unauthenticated,
                    enablement: McpServerEnablement::Disabled,
                },
            )]),
        },
        ..ResolvedConfig::default()
    };
    let connect = BTreeMap::from([(server.clone(), McpServerRuntimeIntent::Connect)]);
    let (definitions, _) = materialize_servers(&config, None, &connect).unwrap();
    assert_eq!(definitions.len(), 1);
    assert_eq!(
        config.mcp.servers[&server].enablement,
        McpServerEnablement::Disabled
    );

    let enabled_config = ResolvedConfig {
        mcp: McpConfig {
            servers: BTreeMap::from([(
                server.clone(),
                McpServerConfig {
                    enablement: McpServerEnablement::Enabled,
                    ..config.mcp.servers[&server].clone()
                },
            )]),
        },
        ..ResolvedConfig::default()
    };
    let disconnect = BTreeMap::from([(server, McpServerRuntimeIntent::Disconnect)]);
    let (definitions, _) = materialize_servers(&enabled_config, None, &disconnect).unwrap();
    assert!(definitions.is_empty());
}

#[test]
fn connector_tool_is_materialized_only_while_exact_connection_is_authorized() {
    let connector = ConnectorDefinition::new(
        ConnectorId::new("acme/github:connector:account").unwrap(),
        "GitHub",
        "GitHub tools",
        ConnectorRuntimeBinding::mcp_server("plugin:acme/github:mcp:github").unwrap(),
    )
    .unwrap();
    let connector_id = connector.id().clone();
    let authority = ConnectorAuthority::in_memory([connector]).unwrap();
    let secrets = Arc::new(MemorySecretStore::default());
    let secret_store: Arc<dyn SecretStore> = secrets.clone();
    let service = ConnectorCredentialService::new(authority.clone(), secret_store);
    service
        .connect_api_token(ConnectorApiTokenConnectRequest {
            command_id: ConnectorCommandId::new("connect-github").unwrap(),
            expected_generation: authority.snapshot().generation(),
            connector_id: connector_id.clone(),
            connection_generation: ConnectorConnectionGeneration::new(1),
            account_id: ConnectorAccountId::new("octocat").unwrap(),
            account_display_name: "Octocat".into(),
            token: SecretValue::new(b"secret-token".to_vec()),
        })
        .unwrap();
    let materialized =
        materialize_connector_servers(authority.clone(), secrets.as_ref(), &TokenStdioProvider)
            .unwrap();
    let composition = start_mcp_tools(
        materialized.definitions,
        materialized.authorities,
        1,
        Some(Arc::new(FakeFactory)),
    )
    .unwrap();
    let tool = composition.tools.definitions().remove(0);
    let call = ToolCall {
        id: ToolCallId::new("connector-call").unwrap(),
        name: tool.name,
        arguments: serde_json::json!({}),
    };
    composition.tools.prepare(&call).unwrap();

    let connected_generation = authority.snapshot().generation();
    service
        .disconnect(
            ConnectorCommandId::new("disconnect-github").unwrap(),
            connected_generation,
            connector_id,
        )
        .unwrap();

    assert!(composition.tools.prepare(&call).is_err());
}

#[test]
fn connected_accounts_bound_to_one_contribution_get_distinct_runtime_servers() {
    let definitions = ["account-one", "account-two"].map(|local_id| {
        ConnectorDefinition::new(
            ConnectorId::new(format!("acme/github:connector:{local_id}")).unwrap(),
            local_id,
            "GitHub tools",
            ConnectorRuntimeBinding::mcp_server("plugin:acme/github:mcp:github").unwrap(),
        )
        .unwrap()
    });
    let authority = ConnectorAuthority::in_memory(definitions.clone()).unwrap();
    let secrets = Arc::new(MemorySecretStore::default());
    let secret_store: Arc<dyn SecretStore> = secrets.clone();
    let service = ConnectorCredentialService::new(authority.clone(), secret_store);
    for (index, definition) in definitions.iter().enumerate() {
        service
            .connect_api_token(ConnectorApiTokenConnectRequest {
                command_id: ConnectorCommandId::new(format!("connect-{index}")).unwrap(),
                expected_generation: authority.snapshot().generation(),
                connector_id: definition.id().clone(),
                connection_generation: ConnectorConnectionGeneration::new(1),
                account_id: ConnectorAccountId::new(format!("account-{index}")).unwrap(),
                account_display_name: format!("Account {index}"),
                token: SecretValue::new(b"secret-token".to_vec()),
            })
            .unwrap();
    }

    let materialized =
        materialize_connector_servers(authority, secrets.as_ref(), &TokenStdioProvider).unwrap();
    assert_eq!(materialized.definitions.len(), 2);
    assert_ne!(
        materialized.definitions[0].id(),
        materialized.definitions[1].id()
    );
}

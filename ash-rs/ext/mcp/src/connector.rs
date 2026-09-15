use ash_config::McpServerId;
use ash_mcp::McpServerDefinition;
use ash_mcp::McpServerTransport;
use ash_secrets::SecretKey;
use ash_secrets::SecretStore;
use ash_secrets::SecretValue;
use connectors::ConnectorAuthority;
use connectors::ConnectorConnectionState;
use connectors::ConnectorDefinition;
use connectors::project_runtime_credential;
use std::collections::BTreeMap;
use std::fmt;
use std::sync::Arc;

use crate::composition::ConnectorInvocationFence;
use crate::composition::McpInvocationAuthority;
use crate::composition::McpInvocationTransport;
use crate::composition::McpToolCompositionError;

/// Product/plugin adapter that turns one authorized Connector credential into a ready MCP transport.
///
/// Implementations are expected to resolve the referenced Plugin MCP declaration, enforce its
/// permission ceiling, consume the credential only into connection-time authorization, and return
/// sanitized errors. They must not persist, log, or place the credential in process arguments.
pub trait ConnectorMcpRuntimeProvider: Send + Sync {
    fn materialize(
        &self,
        definition: &ConnectorDefinition,
        credential: SecretValue,
    ) -> Result<McpServerTransport, ConnectorMcpRuntimeError>;

    /// Materializes active Plugin MCP contributions that do not require a Connector account.
    ///
    /// Providers that only bind Connector-backed servers retain the empty default. Returned
    /// declarations must already satisfy package, permission, credential, and transport policy.
    fn standalone_servers(&self) -> Result<Vec<StandaloneMcpServer>, ConnectorMcpRuntimeError> {
        Ok(Vec::new())
    }

    /// Returns the exact live authority fence for one materialized Connector contribution.
    fn invocation_fence(
        &self,
        _definition: &ConnectorDefinition,
    ) -> Option<Arc<dyn RuntimeInvocationFence>> {
        None
    }
}

/// Runtime-neutral fence checked before review and acquired immediately before MCP dispatch.
pub trait RuntimeInvocationFence: Send + Sync {
    fn authorizes(&self) -> bool;

    fn acquire(&self) -> Option<Box<dyn RuntimeInvocationLease>>;
}

/// Held authority lease whose drop marks one admitted runtime invocation as drained.
pub trait RuntimeInvocationLease: Send {}

/// One runtime-ready standalone Plugin MCP contribution.
pub struct StandaloneMcpServer {
    definition: McpServerDefinition,
    invocation_fence: Option<Arc<dyn RuntimeInvocationFence>>,
}

impl StandaloneMcpServer {
    /// Wraps a host-materialized definition for publication by the shared composition layer.
    pub fn new(definition: McpServerDefinition) -> Self {
        Self {
            definition,
            invocation_fence: None,
        }
    }

    /// Binds the standalone server to exact live contribution authority.
    pub fn with_invocation_fence(mut self, fence: Arc<dyn RuntimeInvocationFence>) -> Self {
        self.invocation_fence = Some(fence);
        self
    }

    pub fn definition(&self) -> &McpServerDefinition {
        &self.definition
    }

    pub(crate) fn into_parts(
        self,
    ) -> (McpServerDefinition, Option<Arc<dyn RuntimeInvocationFence>>) {
        (self.definition, self.invocation_fence)
    }
}

/// Sanitized failure from a product/plugin Connector MCP materializer.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConnectorMcpRuntimeError(String);

impl ConnectorMcpRuntimeError {
    pub fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

impl fmt::Display for ConnectorMcpRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ConnectorMcpRuntimeError {}

pub(crate) struct MaterializedConnectorServers {
    pub definitions: Vec<McpServerDefinition>,
    pub authorities: BTreeMap<McpServerId, McpInvocationAuthority>,
}

pub(crate) fn materialize_connector_servers(
    authority: ConnectorAuthority,
    secrets: &dyn SecretStore,
    provider: &dyn ConnectorMcpRuntimeProvider,
) -> Result<MaterializedConnectorServers, McpToolCompositionError> {
    let snapshot = authority.snapshot();
    let mut definitions = Vec::new();
    let mut authorities = BTreeMap::new();
    for entry in snapshot.ready_entries() {
        let ConnectorConnectionState::Connected(account) = entry.connection().state() else {
            continue;
        };
        let secret_key = SecretKey::new(account.credential_reference().as_str().to_string())
            .map_err(|_| McpToolCompositionError::new("invalid Connector credential reference"))?;
        let credential = secrets
            .load(&secret_key)
            .map_err(|_| McpToolCompositionError::new("Connector credential store unavailable"))?
            .ok_or_else(|| McpToolCompositionError::new("Connector credential is unavailable"))?;
        let credential = project_runtime_credential(credential)
            .map_err(|_| McpToolCompositionError::new("Connector credential is invalid"))?;
        let contribution_server_id = McpServerId::new(
            entry
                .definition()
                .runtime_binding()
                .mcp_server_id()
                .to_string(),
        )
        .map_err(|error| McpToolCompositionError::new(error.to_string()))?;
        let server_id = connector_server_id(&contribution_server_id, entry.definition().id())?;
        let transport = provider
            .materialize(entry.definition(), credential)
            .map_err(|error| McpToolCompositionError::new(error.to_string()))?;
        let runtime_fence = provider.invocation_fence(entry.definition());
        let invocation_transport = match &transport {
            McpServerTransport::Stdio(command) => McpInvocationTransport::Stdio {
                executable: command.program().to_string_lossy().into_owned(),
            },
            McpServerTransport::StreamableHttp(_) => McpInvocationTransport::StreamableHttp,
        };
        let definition = McpServerDefinition::new(
            server_id.clone(),
            entry.definition().display_name(),
            transport,
        )
        .map_err(|error| McpToolCompositionError::new(error.to_string()))?;
        let connector_fence = ConnectorInvocationFence {
            authority: authority.clone(),
            connector_id: entry.definition().id().clone(),
            connection_generation: entry.connection().generation(),
            definition_digest: entry.definition().digest(),
        };
        if authorities
            .insert(
                server_id.clone(),
                McpInvocationAuthority {
                    display_name: entry.definition().display_name().to_string(),
                    transport: invocation_transport,
                    connector_fence: Some(Arc::new(connector_fence)),
                    runtime_fence,
                },
            )
            .is_some()
        {
            return Err(McpToolCompositionError::new(
                "duplicate ready Connector MCP server identity",
            ));
        }
        definitions.push(definition);
    }
    Ok(MaterializedConnectorServers {
        definitions,
        authorities,
    })
}

fn connector_server_id(
    contribution: &McpServerId,
    connector: &connectors::ConnectorId,
) -> Result<McpServerId, McpToolCompositionError> {
    let local = contribution
        .as_str()
        .split_once(":mcp:")
        .map(|(_, local)| local)
        .ok_or_else(|| {
            McpToolCompositionError::new("invalid Connector MCP contribution identity")
        })?;
    McpServerId::new(format!("{}:mcp:{local}", connector.as_str()))
        .map_err(|error| McpToolCompositionError::new(error.to_string()))
}

use ash_config::McpServerId;
use ash_rmcp_client::{StdioServerCommand, StreamableHttpServer};

/// A transport whose process/network authority has already been materialized by the host.
#[derive(Debug)]
pub enum McpServerTransport {
    Stdio(StdioServerCommand),
    StreamableHttp(StreamableHttpServer),
}

/// Runtime-ready declaration for one logical MCP server.
///
/// Configuration parsing, enablement, source verification, executable resolution, and credential lookup must
/// happen before constructing this value. In particular, this type never carries a credential
/// reference that the runtime could resolve by scanning ambient state.
#[derive(Debug)]
pub struct McpServerDefinition {
    id: McpServerId,
    display_name: String,
    transport: McpServerTransport,
}

impl McpServerDefinition {
    pub fn new(
        id: McpServerId,
        display_name: impl Into<String>,
        transport: McpServerTransport,
    ) -> Result<Self, crate::McpRuntimeError> {
        let display_name = display_name.into();
        if display_name.trim().is_empty() {
            return Err(crate::McpRuntimeError::InvalidDefinition {
                server: id,
                message: "display name must not be empty".into(),
            });
        }
        Ok(Self {
            id,
            display_name,
            transport,
        })
    }

    pub fn id(&self) -> &McpServerId {
        &self.id
    }

    pub fn display_name(&self) -> &str {
        &self.display_name
    }

    pub fn transport(&self) -> &McpServerTransport {
        &self.transport
    }

    pub(crate) fn into_parts(self) -> (McpServerId, String, McpServerTransport) {
        (self.id, self.display_name, self.transport)
    }
}

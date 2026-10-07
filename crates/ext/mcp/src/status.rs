/// Runtime lifecycle state of one MCP server after the host's last successful reconcile.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum McpServerRuntimeState {
    Connected,
    Stale,
    Unavailable,
}

/// Redacted runtime projection for one MCP server.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct McpServerRuntimeStatus {
    pub server_id: String,
    pub display_name: String,
    pub state: McpServerRuntimeState,
    pub catalog_generation: u64,
    pub connection_generation: Option<u64>,
    pub tool_count: u64,
    pub diagnostic: Option<String>,
    /// Scheme, host, and port of a Streamable HTTP endpoint; absent for stdio.
    pub http_origin: Option<String>,
}

/// Immutable runtime status published with one MCP catalog generation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct McpRuntimeStatusSnapshot {
    pub catalog_generation: u64,
    pub servers: Vec<McpServerRuntimeStatus>,
}

impl McpRuntimeStatusSnapshot {
    pub fn empty(catalog_generation: u64) -> Self {
        Self {
            catalog_generation,
            servers: Vec::new(),
        }
    }

    pub fn server(&self, server_id: &str) -> Option<&McpServerRuntimeStatus> {
        self.servers
            .iter()
            .find(|status| status.server_id == server_id)
    }
}
/// Process-local lifecycle intent for one configured MCP server.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum McpServerRuntimeIntent {
    Connect,
    Disconnect,
}

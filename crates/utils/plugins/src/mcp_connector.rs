use crate::PluginPackageId;

/// Shared routing identity for an MCP declaration and every Connector referring to it.
///
/// Callers pass a manifest-local contribution ID normalized by the manifest parser. The MCP and
/// Connector consumers still enforce their own runtime identifier limits.
pub fn plugin_mcp_server_id(package: &PluginPackageId, contribution: &str) -> String {
    format!("plugin:{package}:mcp:{contribution}")
}

#[cfg(test)]
#[path = "mcp_connector_tests.rs"]
mod tests;

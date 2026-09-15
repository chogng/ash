use ash_config::McpServerId;
use ash_rmcp_client::Tool;
use ash_tools::DEFAULT_TOOL_OUTPUT_MAX_BYTES;
use ash_tools::{
    McpOutputSchemaProjection, McpToolProjection, ToolDefinition, ToolDefinitionDigest,
    ToolLoading, ToolName, from_mcp_tool_projection, to_protocol_tool_definition,
};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

use crate::{McpPageCursor, McpRuntimeError, McpSession};

/// Limits applied while converting an untrusted paginated MCP tool catalog.
#[derive(Clone, Copy, Debug)]
pub struct McpCatalogLimits {
    pub maximum_pages_per_server: usize,
    pub maximum_tools_per_server: usize,
    pub maximum_catalog_bytes_per_server: usize,
    pub maximum_tool_output_bytes: usize,
}

impl Default for McpCatalogLimits {
    fn default() -> Self {
        Self {
            maximum_pages_per_server: 32,
            maximum_tools_per_server: 512,
            maximum_catalog_bytes_per_server: 2 * 1024 * 1024,
            maximum_tool_output_bytes: DEFAULT_TOOL_OUTPUT_MAX_BYTES,
        }
    }
}

/// Consumer-visible freshness of one connected server's catalog.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum McpCatalogFreshness {
    Fresh,
    Stale,
}

/// Exact identity of one tool within one logical MCP server.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct McpToolRef {
    server: McpServerId,
    remote_name: String,
}

impl McpToolRef {
    pub fn server(&self) -> &McpServerId {
        &self.server
    }

    pub fn remote_name(&self) -> &str {
        &self.remote_name
    }
}

/// Frozen route from one model-visible alias to one exact remote MCP tool.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct McpToolBinding {
    exposed_name: ToolName,
    remote: McpToolRef,
    definition_digest: ToolDefinitionDigest,
    connection_generation: u64,
    catalog_generation: u64,
}

impl McpToolBinding {
    pub fn exposed_name(&self) -> &ToolName {
        &self.exposed_name
    }

    pub fn remote(&self) -> &McpToolRef {
        &self.remote
    }

    pub fn definition_digest(&self) -> &ToolDefinitionDigest {
        &self.definition_digest
    }

    pub fn connection_generation(&self) -> u64 {
        self.connection_generation
    }

    pub fn catalog_generation(&self) -> u64 {
        self.catalog_generation
    }
}

/// Validated host definition and frozen route for one discovered MCP tool.
#[derive(Clone, Debug, PartialEq)]
pub struct McpToolDescriptor {
    binding: McpToolBinding,
    definition: ToolDefinition,
}

impl McpToolDescriptor {
    pub fn binding(&self) -> &McpToolBinding {
        &self.binding
    }

    pub fn definition(&self) -> &ToolDefinition {
        &self.definition
    }
}

/// Immutable cross-server MCP tool catalog used by one runtime safe point.
#[derive(Clone, Debug)]
pub struct McpCatalogSnapshot {
    generation: u64,
    tools: Vec<McpToolDescriptor>,
    by_exposed_name: BTreeMap<ToolName, usize>,
}

impl McpCatalogSnapshot {
    pub(crate) fn new(
        generation: u64,
        tools: Vec<McpToolDescriptor>,
    ) -> Result<Self, McpRuntimeError> {
        let mut by_exposed_name = BTreeMap::new();
        for (index, tool) in tools.iter().enumerate() {
            if by_exposed_name
                .insert(tool.binding.exposed_name.clone(), index)
                .is_some()
            {
                return Err(McpRuntimeError::AliasCollision(
                    tool.binding.exposed_name.to_string(),
                ));
            }
        }
        Ok(Self {
            generation,
            tools,
            by_exposed_name,
        })
    }

    pub fn generation(&self) -> u64 {
        self.generation
    }

    pub fn tools(&self) -> &[McpToolDescriptor] {
        &self.tools
    }

    pub fn resolve(&self, exposed_name: &ToolName) -> Option<&McpToolDescriptor> {
        self.by_exposed_name
            .get(exposed_name)
            .map(|index| &self.tools[*index])
    }

    pub fn model_definitions(&self) -> Result<Vec<ash_protocol::ToolDefinition>, McpRuntimeError> {
        self.tools
            .iter()
            .map(|tool| {
                to_protocol_tool_definition(&tool.definition)
                    .map_err(|error| McpRuntimeError::ModelProjection(error.to_string()))
            })
            .collect()
    }
}

pub(crate) async fn discover_server_tools(
    session: &dyn McpSession,
    server: &McpServerId,
    connection_generation: u64,
    catalog_generation: u64,
    loading: ToolLoading,
    limits: McpCatalogLimits,
) -> Result<Vec<McpToolDescriptor>, McpRuntimeError> {
    let mut cursor = McpPageCursor::First;
    let mut seen_cursors = BTreeSet::new();
    let mut seen_remote_names = BTreeSet::new();
    let mut descriptors = Vec::new();
    let mut catalog_bytes = 0usize;

    for page_index in 0..limits.maximum_pages_per_server {
        let result =
            session
                .list_tools(cursor)
                .await
                .map_err(|error| McpRuntimeError::Catalog {
                    server: server.clone(),
                    message: error.to_string(),
                })?;
        for tool in result.tools {
            if descriptors.len() >= limits.maximum_tools_per_server {
                return Err(catalog_error(server, "tool count limit exceeded"));
            }
            catalog_bytes = catalog_bytes
                .checked_add(
                    serde_json::to_vec(&tool)
                        .map_err(|error| catalog_error(server, error.to_string()))?
                        .len(),
                )
                .ok_or_else(|| catalog_error(server, "catalog byte count overflow"))?;
            if catalog_bytes > limits.maximum_catalog_bytes_per_server {
                return Err(catalog_error(server, "catalog byte limit exceeded"));
            }
            let remote_name = tool.name.to_string();
            if !seen_remote_names.insert(remote_name.clone()) {
                return Err(catalog_error(
                    server,
                    format!("duplicate remote tool name '{remote_name}'"),
                ));
            }
            descriptors.push(project_tool(
                server,
                tool,
                connection_generation,
                catalog_generation,
                loading,
            )?);
        }

        let Some(next_cursor) = result.next_cursor else {
            return Ok(descriptors);
        };
        if next_cursor.trim().is_empty() || !seen_cursors.insert(next_cursor.clone()) {
            return Err(catalog_error(
                server,
                "invalid or repeated pagination cursor",
            ));
        }
        cursor = McpPageCursor::After(next_cursor);
        if page_index + 1 == limits.maximum_pages_per_server {
            return Err(catalog_error(server, "page count limit exceeded"));
        }
    }

    unreachable!("catalog pagination loop returns at its configured bound")
}

fn project_tool(
    server: &McpServerId,
    tool: Tool,
    connection_generation: u64,
    catalog_generation: u64,
    loading: ToolLoading,
) -> Result<McpToolDescriptor, McpRuntimeError> {
    let remote_name = tool.name.into_owned();
    let exposed_name = exposed_name(server, &remote_name)?;
    let description = tool
        .description
        .map(|description| description.into_owned())
        .filter(|description| !description.trim().is_empty())
        .or(tool.title)
        .unwrap_or_else(|| format!("MCP tool {remote_name}"));
    let output_schema = tool
        .output_schema
        .map_or(McpOutputSchemaProjection::Unspecified, |schema| {
            McpOutputSchemaProjection::Schema(serde_json::Value::Object((*schema).clone()))
        });
    let projection = McpToolProjection {
        remote_name: remote_name.clone(),
        description,
        input_schema: serde_json::Value::Object((*tool.input_schema).clone()),
        output_schema,
    };
    let definition = from_mcp_tool_projection(exposed_name.clone(), &projection, loading)
        .map_err(|error| catalog_error(server, error.to_string()))?;
    let binding = McpToolBinding {
        exposed_name,
        remote: McpToolRef {
            server: server.clone(),
            remote_name,
        },
        definition_digest: definition.digest(),
        connection_generation,
        catalog_generation,
    };
    Ok(McpToolDescriptor {
        binding,
        definition,
    })
}

fn exposed_name(server: &McpServerId, remote_name: &str) -> Result<ToolName, McpRuntimeError> {
    let digest =
        Sha256::digest([server.as_str().as_bytes(), &[0], remote_name.as_bytes()].concat());
    let digest = format!("{digest:x}");
    let server_slug = slug(server.as_str(), 40);
    let tool_slug = slug(remote_name, 60);
    ToolName::new(format!("mcp_{server_slug}_{tool_slug}_{}", &digest[..12])).map_err(|error| {
        McpRuntimeError::Catalog {
            server: server.clone(),
            message: error.to_string(),
        }
    })
}

fn slug(value: &str, maximum: usize) -> String {
    let mut slug = String::new();
    let mut previous_separator = false;
    for byte in value.bytes() {
        if slug.len() >= maximum {
            break;
        }
        if byte.is_ascii_alphanumeric() {
            slug.push((byte as char).to_ascii_lowercase());
            previous_separator = false;
        } else if !slug.is_empty() && !previous_separator {
            slug.push('_');
            previous_separator = true;
        }
    }
    while slug.ends_with('_') {
        slug.pop();
    }
    if slug.is_empty() {
        "unnamed".into()
    } else {
        slug
    }
}

fn catalog_error(server: &McpServerId, message: impl Into<String>) -> McpRuntimeError {
    McpRuntimeError::Catalog {
        server: server.clone(),
        message: message.into(),
    }
}

#[cfg(test)]
#[path = "catalog_tests.rs"]
mod tests;

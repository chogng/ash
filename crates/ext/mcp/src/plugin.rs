use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::sync::Arc;

use ash_config::McpServerId;
use ash_core_plugins::InstalledPluginPackage;
use ash_core_plugins::PluginActivationAuthority;
use ash_core_plugins::PluginActivationSnapshot;
use ash_core_plugins::PluginInvocationFence;
use ash_core_plugins::PluginInvocationLease;
use ash_mcp::McpServerDefinition;
use ash_mcp::McpServerTransport;
use ash_plugin::ContributionKind;
use ash_plugin::Permission;
use ash_plugin::PluginPath;
use ash_rmcp_client::BearerToken;
use ash_rmcp_client::StdioServerCommand;
use ash_rmcp_client::StreamableHttpServer;
use ash_secrets::SecretValue;
use connectors::ConnectorDefinition;
use connectors::ConnectorId;
use serde::Deserialize;
use url::Url;

use crate::ConnectorMcpRuntimeError;
use crate::ConnectorMcpRuntimeProvider;
use crate::RuntimeInvocationFence;
use crate::RuntimeInvocationLease;
use crate::StandaloneMcpServer;

const MAX_PLUGIN_MCP_DEFINITION_BYTES: u64 = 64 * 1024;
const MAX_PLUGIN_MCP_ARGUMENTS: usize = 128;
const MAX_PLUGIN_MCP_ARGUMENT_BYTES: usize = 16 * 1024;

/// Package-rooted MCP materializer built from one immutable Plugin activation snapshot.
///
/// Construction parses and validates every Connector-backed MCP definition before publication.
/// Materialization only injects the exact connected credential into the declared environment or
/// HTTP bearer slot; it never searches ambient files, configuration, or process environment.
pub struct PluginConnectorMcpRuntimeProvider {
    servers: BTreeMap<McpServerId, ActivatedPluginMcpServer>,
    standalone: Vec<ActivatedStandaloneMcpServer>,
}

impl PluginConnectorMcpRuntimeProvider {
    pub fn from_activation(
        activation: &PluginActivationSnapshot,
    ) -> Result<Self, ConnectorMcpRuntimeError> {
        Self::from_activation_with_authority(activation, None)
    }

    /// Builds a provider whose contributions remain bound to exact live Plugin authority.
    pub fn from_authority(
        authority: &PluginActivationAuthority,
    ) -> Result<Self, ConnectorMcpRuntimeError> {
        let snapshot = authority.snapshot();
        Self::from_activation_with_authority(snapshot.activation(), Some(authority))
    }

    fn from_activation_with_authority(
        activation: &PluginActivationSnapshot,
        authority: Option<&PluginActivationAuthority>,
    ) -> Result<Self, ConnectorMcpRuntimeError> {
        let mut servers = BTreeMap::new();
        let mut standalone = Vec::new();
        for package in activation.packages() {
            let manifest = package.manifest();
            let invocation_fence = authority
                .and_then(|authority| authority.invocation_fence(package))
                .map(|fence| {
                    Arc::new(PluginRuntimeInvocationFence(fence)) as Arc<dyn RuntimeInvocationFence>
                });
            for contribution in &manifest.contributions.mcp_servers {
                let server_id =
                    McpServerId::new(format!("plugin:{}:mcp:{}", manifest.id, contribution.id))
                        .map_err(|error| runtime_error(error.to_string()))?;
                let definition = parse_definition(package, &contribution.definition)?;
                validate_definition_permissions(package, &definition)?;
                let connectors = manifest
                    .contributions
                    .connectors
                    .iter()
                    .filter(|connector| connector.mcp_server == contribution.id)
                    .collect::<Vec<_>>();
                if connectors.is_empty() {
                    validate_standalone_credentials(
                        package,
                        contribution.id.as_str(),
                        &definition,
                    )?;
                    standalone.push(ActivatedStandaloneMcpServer {
                        server_id,
                        display_name: format!("{}: {}", manifest.display_name, contribution.id),
                        package: package.clone(),
                        definition,
                        invocation_fence: invocation_fence.clone(),
                    });
                    continue;
                }
                let mut connector_ids = BTreeSet::new();
                for connector in connectors {
                    validate_credential_slot(
                        package,
                        connector.id.as_str(),
                        contribution.id.as_str(),
                    )?;
                    connector_ids.insert(
                        ConnectorId::new(format!("{}:connector:{}", manifest.id, connector.id))
                            .map_err(|error| runtime_error(error.to_string()))?,
                    );
                }
                validate_connector_transport(&definition)?;
                if servers
                    .insert(
                        server_id,
                        ActivatedPluginMcpServer {
                            package: package.clone(),
                            connector_ids,
                            definition,
                            invocation_fence: invocation_fence.clone(),
                        },
                    )
                    .is_some()
                {
                    return Err(runtime_error("duplicate active Plugin MCP server identity"));
                }
            }
        }
        Ok(Self {
            servers,
            standalone,
        })
    }
}

impl ConnectorMcpRuntimeProvider for PluginConnectorMcpRuntimeProvider {
    fn materialize(
        &self,
        connector: &ConnectorDefinition,
        credential: SecretValue,
    ) -> Result<McpServerTransport, ConnectorMcpRuntimeError> {
        let server_id = McpServerId::new(connector.runtime_binding().mcp_server_id().to_string())
            .map_err(|error| runtime_error(error.to_string()))?;
        let server = self
            .servers
            .get(&server_id)
            .ok_or_else(|| runtime_error("Plugin MCP contribution is not active"))?;
        if !server.connector_ids.contains(connector.id()) {
            return Err(runtime_error(
                "Connector is not authorized for the active Plugin MCP contribution",
            ));
        }
        let credential = std::str::from_utf8(credential.expose())
            .map_err(|_| runtime_error("Connector credential is not UTF-8 secret text"))?;
        materialize_transport(&server.package, &server.definition, Some(credential))
    }

    fn standalone_servers(&self) -> Result<Vec<StandaloneMcpServer>, ConnectorMcpRuntimeError> {
        self.standalone
            .iter()
            .map(|server| {
                let transport = materialize_transport(&server.package, &server.definition, None)?;
                let invocation_fence = server.invocation_fence.clone();
                let definition = McpServerDefinition::new(
                    server.server_id.clone(),
                    &server.display_name,
                    transport,
                )
                .map_err(|error| runtime_error(error.to_string()))?;
                let standalone = StandaloneMcpServer::new(definition);
                Ok(match invocation_fence {
                    Some(fence) => standalone.with_invocation_fence(fence),
                    None => standalone,
                })
            })
            .collect()
    }

    fn invocation_fence(
        &self,
        connector: &ConnectorDefinition,
    ) -> Option<Arc<dyn RuntimeInvocationFence>> {
        let server_id =
            McpServerId::new(connector.runtime_binding().mcp_server_id().to_string()).ok()?;
        self.servers
            .get(&server_id)
            .and_then(|server| server.invocation_fence.clone())
    }
}

#[derive(Clone)]
struct ActivatedPluginMcpServer {
    package: InstalledPluginPackage,
    connector_ids: BTreeSet<ConnectorId>,
    definition: PluginMcpDefinition,
    invocation_fence: Option<Arc<dyn RuntimeInvocationFence>>,
}

#[derive(Clone)]
struct ActivatedStandaloneMcpServer {
    server_id: McpServerId,
    display_name: String,
    package: InstalledPluginPackage,
    definition: PluginMcpDefinition,
    invocation_fence: Option<Arc<dyn RuntimeInvocationFence>>,
}

struct PluginRuntimeInvocationFence(PluginInvocationFence);

impl RuntimeInvocationFence for PluginRuntimeInvocationFence {
    fn authorizes(&self) -> bool {
        self.0.authorizes()
    }

    fn acquire(&self) -> Option<Box<dyn RuntimeInvocationLease>> {
        self.0
            .acquire()
            .map(|lease| Box::new(lease) as Box<dyn RuntimeInvocationLease>)
    }
}

impl RuntimeInvocationLease for PluginInvocationLease {}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PluginMcpDefinition {
    transport: PluginMcpTransport,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
#[serde(tag = "type", rename_all = "camelCase", deny_unknown_fields)]
enum PluginMcpTransport {
    Stdio {
        executable: PluginPath,
        #[serde(default)]
        args: Vec<String>,
        #[serde(rename = "credentialEnv")]
        credential_env: Option<String>,
    },
    StreamableHttp {
        url: String,
    },
}

fn parse_definition(
    package: &InstalledPluginPackage,
    path: &PluginPath,
) -> Result<PluginMcpDefinition, ConnectorMcpRuntimeError> {
    let contents = package
        .read_utf8_file(path, MAX_PLUGIN_MCP_DEFINITION_BYTES)
        .map_err(|error| runtime_error(error.to_string()))?;
    serde_json::from_str(&contents).map_err(|error| {
        runtime_error(format!(
            "Plugin MCP definition is not valid strict JSON: {error}"
        ))
    })
}

fn validate_credential_slot(
    package: &InstalledPluginPackage,
    connector_id: &str,
    mcp_id: &str,
) -> Result<(), ConnectorMcpRuntimeError> {
    let slots = package
        .manifest()
        .credential_slots
        .iter()
        .filter(|slot| {
            slot.required_for.iter().any(|reference| {
                (reference.kind == ContributionKind::Connector
                    && reference.id.as_str() == connector_id)
                    || (reference.kind == ContributionKind::Mcp && reference.id.as_str() == mcp_id)
            })
        })
        .count();
    if slots != 1 {
        return Err(runtime_error(
            "Connector-backed MCP contribution must declare exactly one secret-text credential slot",
        ));
    }
    Ok(())
}

fn validate_standalone_credentials(
    package: &InstalledPluginPackage,
    mcp_id: &str,
    definition: &PluginMcpDefinition,
) -> Result<(), ConnectorMcpRuntimeError> {
    let declares_credential = package.manifest().credential_slots.iter().any(|slot| {
        slot.required_for.iter().any(|reference| {
            reference.kind == ContributionKind::Mcp && reference.id.as_str() == mcp_id
        })
    });
    if declares_credential
        || matches!(
            definition.transport,
            PluginMcpTransport::Stdio {
                credential_env: Some(_),
                ..
            }
        )
    {
        return Err(runtime_error(
            "credentialed Plugin MCP contributions must be bound through a Connector",
        ));
    }
    Ok(())
}

fn validate_connector_transport(
    definition: &PluginMcpDefinition,
) -> Result<(), ConnectorMcpRuntimeError> {
    if matches!(
        definition.transport,
        PluginMcpTransport::Stdio {
            credential_env: None,
            ..
        }
    ) {
        return Err(runtime_error(
            "Connector-backed stdio MCP contribution must declare credentialEnv",
        ));
    }
    Ok(())
}

fn validate_definition_permissions(
    package: &InstalledPluginPackage,
    definition: &PluginMcpDefinition,
) -> Result<(), ConnectorMcpRuntimeError> {
    match &definition.transport {
        PluginMcpTransport::Stdio {
            executable,
            args,
            credential_env,
        } => {
            if !package
                .manifest()
                .permissions
                .iter()
                .any(|permission| matches!(permission, Permission::Process { executable: allowed } if allowed == executable))
            {
                return Err(runtime_error(
                    "Plugin MCP executable exceeds the declared process permission",
                ));
            }
            if credential_env
                .as_deref()
                .is_some_and(|credential_env| !valid_environment_name(credential_env))
            {
                return Err(runtime_error(
                    "Plugin MCP credential environment name is invalid",
                ));
            }
            if args.len() > MAX_PLUGIN_MCP_ARGUMENTS
                || args.iter().map(String::len).sum::<usize>() > MAX_PLUGIN_MCP_ARGUMENT_BYTES
                || args
                    .iter()
                    .any(|argument| argument.contains('\0') || argument.contains(['\r', '\n']))
            {
                return Err(runtime_error("Plugin MCP arguments exceed safe limits"));
            }
            package
                .resolve_file(executable)
                .map_err(|error| runtime_error(error.to_string()))?;
        }
        PluginMcpTransport::StreamableHttp { url } => {
            let endpoint =
                Url::parse(url).map_err(|_| runtime_error("Plugin MCP endpoint is invalid"))?;
            if endpoint.scheme() != "https"
                || !endpoint.username().is_empty()
                || endpoint.password().is_some()
                || endpoint.fragment().is_some()
            {
                return Err(runtime_error(
                    "Plugin MCP endpoint must be credential-free HTTPS",
                ));
            }
            let host = endpoint
                .host_str()
                .ok_or_else(|| runtime_error("Plugin MCP endpoint has no host"))?;
            if !package.manifest().permissions.iter().any(|permission| {
                matches!(permission, Permission::Network { hosts } if hosts.iter().any(|allowed| allowed.as_str() == host))
            }) {
                return Err(runtime_error(
                    "Plugin MCP endpoint exceeds the declared network permission",
                ));
            }
        }
    }
    Ok(())
}

fn valid_environment_name(value: &str) -> bool {
    let mut bytes = value.bytes();
    bytes
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic() || first == b'_')
        && bytes.all(|byte| byte.is_ascii_alphanumeric() || byte == b'_')
}

fn materialize_transport(
    package: &InstalledPluginPackage,
    definition: &PluginMcpDefinition,
    credential: Option<&str>,
) -> Result<McpServerTransport, ConnectorMcpRuntimeError> {
    match &definition.transport {
        PluginMcpTransport::Stdio {
            executable,
            args,
            credential_env,
        } => {
            let executable = package
                .resolve_file(executable)
                .map_err(|error| runtime_error(error.to_string()))?;
            let command = StdioServerCommand::new(executable).with_args(args);
            let command = match (credential_env, credential) {
                (Some(environment), Some(credential)) => command.with_env(environment, credential),
                (None, None) => command,
                _ => {
                    return Err(runtime_error(
                        "Plugin MCP credential binding is inconsistent",
                    ));
                }
            };
            Ok(McpServerTransport::Stdio(command))
        }
        PluginMcpTransport::StreamableHttp { url } => {
            let server =
                StreamableHttpServer::new(url).map_err(|error| runtime_error(error.to_string()))?;
            let server = if let Some(credential) = credential {
                let token = BearerToken::new(credential.to_string())
                    .map_err(|error| runtime_error(error.to_string()))?;
                server.with_bearer_token(token)
            } else {
                server
            };
            Ok(McpServerTransport::StreamableHttp(server))
        }
    }
}

fn runtime_error(message: impl Into<String>) -> ConnectorMcpRuntimeError {
    ConnectorMcpRuntimeError::new(message)
}

#[cfg(test)]
#[path = "plugin_tests.rs"]
mod tests;

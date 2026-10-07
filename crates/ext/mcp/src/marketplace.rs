use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::sync::Arc;

use crate::ConnectorMcpRuntimeError;
use crate::ConnectorMcpRuntimeProvider;
use crate::RuntimeInvocationFence;
use crate::RuntimeInvocationLease;
use crate::StandaloneMcpServer;
use ash_config::McpServerId;
use ash_core_plugins::AcquireCapabilityRequest;
use ash_core_plugins::ActivationSpec;
use ash_core_plugins::CapabilityKind;
use ash_core_plugins::CapabilityRef;
use ash_core_plugins::InstallationState;
use ash_core_plugins::ListInstalledRequest;
use ash_core_plugins::LocalCapabilitySource;
use ash_core_plugins::PluginPackageService;
use ash_core_plugins::PluginsManager;
use ash_core_plugins::ReleaseCapabilityRequest;
use ash_mcp::McpServerDefinition;
use ash_mcp::McpServerTransport;
use ash_secrets::SecretValue;
use connectors::ConnectorDefinition;
use connectors::ConnectorId;
use connectors::ConnectorRuntimeBinding;

use self::contract::MarketplaceMcpTransport;
use self::contract::parse_transport;

mod contract;

pub struct MarketplaceConnectorCatalog {
    definitions: Vec<ConnectorDefinition>,
    provider: Arc<MarketplaceConnectorMcpRuntimeProvider>,
}

pub fn combined_provider(
    base: Arc<dyn ConnectorMcpRuntimeProvider>,
    marketplace: Arc<dyn ConnectorMcpRuntimeProvider>,
) -> Arc<dyn ConnectorMcpRuntimeProvider> {
    Arc::new(CombinedConnectorMcpRuntimeProvider { base, marketplace })
}

struct CombinedConnectorMcpRuntimeProvider {
    base: Arc<dyn ConnectorMcpRuntimeProvider>,
    marketplace: Arc<dyn ConnectorMcpRuntimeProvider>,
}

impl ConnectorMcpRuntimeProvider for CombinedConnectorMcpRuntimeProvider {
    fn materialize(
        &self,
        connector: &ConnectorDefinition,
        credential: SecretValue,
    ) -> Result<McpServerTransport, ConnectorMcpRuntimeError> {
        if connector.id().as_str().starts_with("marketplace:") {
            self.marketplace.materialize(connector, credential)
        } else {
            self.base.materialize(connector, credential)
        }
    }

    fn standalone_servers(&self) -> Result<Vec<StandaloneMcpServer>, ConnectorMcpRuntimeError> {
        let mut servers = self.base.standalone_servers()?;
        servers.extend(self.marketplace.standalone_servers()?);
        Ok(servers)
    }

    fn invocation_fence(
        &self,
        connector: &ConnectorDefinition,
    ) -> Option<Arc<dyn RuntimeInvocationFence>> {
        if connector.id().as_str().starts_with("marketplace:") {
            self.marketplace.invocation_fence(connector)
        } else {
            self.base.invocation_fence(connector)
        }
    }
}

impl MarketplaceConnectorCatalog {
    pub fn from_manager(manager: Arc<PluginsManager>) -> Result<Self, String> {
        let mcp_sources = manager
            .local_capability_sources(CapabilityKind::Mcp)
            .map_err(|error| error.to_string())?;
        let connector_sources = manager
            .local_capability_sources(CapabilityKind::Connector)
            .map_err(|error| error.to_string())?;
        let mut servers = BTreeMap::new();
        let mut local_servers = BTreeMap::new();
        for source in mcp_sources {
            let id = mcp_server_id(&source)?;
            let transport = parse_transport(&source)?;
            let key = (source.package().digest.clone(), source.id().to_string());
            if local_servers.insert(key, id.clone()).is_some()
                || servers
                    .insert(
                        id,
                        MarketplaceMcpServer {
                            display_name: format!("{}: {}", source.package().id, source.id()),
                            transport,
                            capability: source.capability().clone(),
                        },
                    )
                    .is_some()
            {
                return Err("duplicate Marketplace MCP capability identity".into());
            }
        }

        let mut definitions = Vec::new();
        let mut connector_servers = BTreeMap::new();
        let mut referenced_servers = BTreeSet::new();
        for source in connector_sources {
            let dir = file_access::Dir::open_local(source.package_root())
                .map_err(|error| error.to_string())?;
            let files = file_system::LocalFileSystem::new(file_access::Grant::for_environment(
                dir,
                file_access::GrantSource::HostConfiguration,
                file_access::Permissions::new([file_access::Permission::ReadFiles]),
            ));
            let path = source
                .host_path()
                .strip_prefix(source.package_root())
                .map_err(|_| "Connector declaration escaped its package")?;
            let descriptor = connectors::load_connector_declaration(&files, path)?;
            if descriptor.id != source.id() {
                return Err("Marketplace Connector ID does not match its signed capability".into());
            }
            if descriptor
                .authentication
                .as_deref()
                .is_some_and(|kind| kind != "oauth")
            {
                return Err("Marketplace Connector declares unsupported authentication".into());
            }
            let local_mcp = descriptor
                .mcp_server
                .ok_or_else(|| "Marketplace Connector has no MCP capability binding".to_string())?;
            let server_id = local_servers
                .get(&(source.package().digest.clone(), local_mcp))
                .cloned()
                .ok_or_else(|| {
                    "Marketplace Connector references an unavailable MCP capability".to_string()
                })?;
            let server = servers
                .get(&server_id)
                .expect("local server identity came from the server map");
            if matches!(server.transport, MarketplaceMcpTransport::Stdio { .. }) {
                return Err(
                    "Marketplace Connector cannot inject credentials into stdio MCP".into(),
                );
            }
            let connector_id = connector_id(&source)?;
            let description = descriptor
                .description
                .unwrap_or_else(|| descriptor.display_name.clone());
            let definition = ConnectorDefinition::new(
                connector_id.clone(),
                descriptor.display_name,
                description,
                ConnectorRuntimeBinding::mcp_server(server_id.as_str())
                    .map_err(|error| error.to_string())?,
            )
            .and_then(|definition| {
                definition.with_authorization_revision(source.package().digest.clone())
            })
            .map_err(|error| error.to_string())?;
            if connector_servers
                .insert(connector_id, server_id.clone())
                .is_some()
            {
                return Err("duplicate Marketplace Connector identity".into());
            }
            referenced_servers.insert(server_id);
            definitions.push(definition);
        }
        definitions.sort_by(|left, right| left.id().cmp(right.id()));
        Ok(Self {
            definitions,
            provider: Arc::new(MarketplaceConnectorMcpRuntimeProvider {
                manager,
                servers,
                connector_servers,
                referenced_servers,
            }),
        })
    }

    pub fn definitions(&self) -> &[ConnectorDefinition] {
        &self.definitions
    }

    pub fn provider(&self) -> Arc<dyn ConnectorMcpRuntimeProvider> {
        self.provider.clone()
    }
}

struct MarketplaceConnectorMcpRuntimeProvider {
    manager: Arc<PluginsManager>,
    servers: BTreeMap<McpServerId, MarketplaceMcpServer>,
    connector_servers: BTreeMap<ConnectorId, McpServerId>,
    referenced_servers: BTreeSet<McpServerId>,
}

impl ConnectorMcpRuntimeProvider for MarketplaceConnectorMcpRuntimeProvider {
    fn materialize(
        &self,
        connector: &ConnectorDefinition,
        credential: SecretValue,
    ) -> Result<McpServerTransport, ConnectorMcpRuntimeError> {
        let server_id = self
            .connector_servers
            .get(connector.id())
            .ok_or_else(|| runtime_error("Marketplace Connector is not active"))?;
        let server = self
            .servers
            .get(server_id)
            .ok_or_else(|| runtime_error("Marketplace MCP capability is not active"))?;
        let credential = std::str::from_utf8(credential.expose())
            .map_err(|_| runtime_error("Connector credential is not UTF-8 secret text"))?;
        server.transport.materialize(Some(credential))
    }

    fn standalone_servers(&self) -> Result<Vec<StandaloneMcpServer>, ConnectorMcpRuntimeError> {
        self.servers
            .iter()
            .filter(|(id, _)| !self.referenced_servers.contains(*id))
            .map(|(id, server)| {
                let definition = McpServerDefinition::new(
                    id.clone(),
                    &server.display_name,
                    server.transport.materialize(None)?,
                )
                .map_err(|error| runtime_error(error.to_string()))?;
                Ok(
                    StandaloneMcpServer::new(definition).with_invocation_fence(Arc::new(
                        MarketplaceInvocationFence {
                            manager: Arc::clone(&self.manager),
                            capability: server.capability.clone(),
                        },
                    )),
                )
            })
            .collect()
    }

    fn invocation_fence(
        &self,
        connector: &ConnectorDefinition,
    ) -> Option<Arc<dyn RuntimeInvocationFence>> {
        let server = self
            .servers
            .get(self.connector_servers.get(connector.id())?)?;
        Some(Arc::new(MarketplaceInvocationFence {
            manager: Arc::clone(&self.manager),
            capability: server.capability.clone(),
        }))
    }
}

struct MarketplaceMcpServer {
    display_name: String,
    transport: MarketplaceMcpTransport,
    capability: CapabilityRef,
}

struct MarketplaceInvocationFence {
    manager: Arc<PluginsManager>,
    capability: CapabilityRef,
}

impl RuntimeInvocationFence for MarketplaceInvocationFence {
    fn authorizes(&self) -> bool {
        self.manager
            .list_installed(ListInstalledRequest {})
            .is_ok_and(|installed| {
                installed.iter().any(|package| {
                    package.state == InstallationState::Installed
                        && package.capabilities.iter().any(|capability| {
                            capability.reference == self.capability
                                && capability.kind == CapabilityKind::Mcp
                        })
                })
            })
    }

    fn acquire(&self) -> Option<Box<dyn RuntimeInvocationLease>> {
        let acquired = self
            .manager
            .acquire_capability(AcquireCapabilityRequest {
                capability: self.capability.clone(),
            })
            .ok()?;
        if !matches!(acquired.spec, ActivationSpec::Mcp(_)) {
            let _ = self.manager.release_capability(ReleaseCapabilityRequest {
                lease_id: acquired.lease.id,
            });
            return None;
        }
        Some(Box::new(MarketplaceInvocationLease {
            manager: Arc::clone(&self.manager),
            lease_id: acquired.lease.id,
        }))
    }
}

struct MarketplaceInvocationLease {
    manager: Arc<PluginsManager>,
    lease_id: String,
}

impl RuntimeInvocationLease for MarketplaceInvocationLease {}

impl Drop for MarketplaceInvocationLease {
    fn drop(&mut self) {
        let _ = self.manager.release_capability(ReleaseCapabilityRequest {
            lease_id: self.lease_id.clone(),
        });
    }
}

fn mcp_server_id(source: &LocalCapabilitySource) -> Result<McpServerId, String> {
    McpServerId::new(format!(
        "marketplace:{}:mcp:{}",
        source.package().id,
        source.id()
    ))
    .map_err(|error| error.to_string())
}

fn connector_id(source: &LocalCapabilitySource) -> Result<ConnectorId, String> {
    ConnectorId::new(format!(
        "marketplace:{}:connector:{}",
        source.package().id,
        source.id()
    ))
    .map_err(|error| error.to_string())
}

fn runtime_error(message: impl Into<String>) -> ConnectorMcpRuntimeError {
    ConnectorMcpRuntimeError::new(message)
}

#[cfg(test)]
#[path = "marketplace_tests.rs"]
mod tests;

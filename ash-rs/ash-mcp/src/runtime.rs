use std::collections::{BTreeMap, BTreeSet};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use ash_async_utils::CancellationToken;
use ash_config::McpServerId;
use ash_rmcp_client::{
    CallToolRequestParams, ElicitResult, McpClientEvent, McpClientHost, McpElicitation,
    NoopMcpClientHost, RmcpClientOptions, RmcpTimeouts, ServerInfo,
};
use ash_tools::{ToolLoading, ToolName, ToolOutput};

use crate::catalog::{McpCatalogSnapshot, discover_server_tools};
use crate::output::project_tool_result;
use crate::{
    McpCallError, McpCatalogFreshness, McpCatalogLimits, McpRuntimeError, McpServerDefinition,
    McpSession, McpSessionFactory, McpToolBinding, RmcpSessionFactory,
};

/// Whether startup fails atomically or retains successfully initialized servers.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum McpStartupPolicy {
    RequireAll,
    AllowPartial,
}

/// Runtime construction policy and generation assignment.
#[derive(Clone)]
pub struct McpRuntimeOptions {
    client_name: String,
    client_version: String,
    client_timeouts: RmcpTimeouts,
    client_host: Arc<dyn McpClientHost>,
    form_elicitation: bool,
    startup_policy: McpStartupPolicy,
    catalog_limits: McpCatalogLimits,
    loading: ToolLoading,
    catalog_generation: u64,
    first_connection_generation: u64,
}

impl std::fmt::Debug for McpRuntimeOptions {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("McpRuntimeOptions")
            .field("client_name", &self.client_name)
            .field("client_version", &self.client_version)
            .field("client_timeouts", &self.client_timeouts)
            .field("client_host", &"<dyn McpClientHost>")
            .field("form_elicitation", &self.form_elicitation)
            .field("startup_policy", &self.startup_policy)
            .field("catalog_limits", &self.catalog_limits)
            .field("loading", &self.loading)
            .field("catalog_generation", &self.catalog_generation)
            .field(
                "first_connection_generation",
                &self.first_connection_generation,
            )
            .finish()
    }
}

impl McpRuntimeOptions {
    pub fn new(client_name: impl Into<String>, client_version: impl Into<String>) -> Self {
        Self {
            client_name: client_name.into(),
            client_version: client_version.into(),
            client_timeouts: RmcpTimeouts::default(),
            client_host: Arc::new(NoopMcpClientHost),
            form_elicitation: false,
            startup_policy: McpStartupPolicy::RequireAll,
            catalog_limits: McpCatalogLimits::default(),
            loading: ToolLoading::Eager,
            catalog_generation: 1,
            first_connection_generation: 1,
        }
    }

    pub fn with_client_timeouts(mut self, timeouts: RmcpTimeouts) -> Self {
        self.client_timeouts = timeouts;
        self
    }

    pub fn with_client_host(mut self, host: Arc<dyn McpClientHost>) -> Self {
        self.client_host = host;
        self
    }

    /// Enables form elicitation after the product host installs durable interaction routing.
    pub fn with_form_elicitation(mut self) -> Self {
        self.form_elicitation = true;
        self
    }

    pub fn with_startup_policy(mut self, policy: McpStartupPolicy) -> Self {
        self.startup_policy = policy;
        self
    }

    pub fn with_catalog_limits(mut self, limits: McpCatalogLimits) -> Self {
        self.catalog_limits = limits;
        self
    }

    pub fn with_tool_loading(mut self, loading: ToolLoading) -> Self {
        self.loading = loading;
        self
    }

    pub fn with_catalog_generation(mut self, catalog_generation: u64) -> Self {
        self.catalog_generation = catalog_generation;
        self
    }

    pub fn with_first_connection_generation(mut self, connection_generation: u64) -> Self {
        self.first_connection_generation = connection_generation;
        self
    }
}

/// Redacted startup failure retained when partial startup is allowed.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct McpStartupDiagnostic {
    pub server: McpServerId,
    pub message: String,
}

/// Redacted shutdown failure for one server.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct McpShutdownDiagnostic {
    pub server: McpServerId,
    pub message: String,
}

struct McpConnection {
    display_name: String,
    server_info: ServerInfo,
    session: Box<dyn McpSession>,
    catalog_stale: Arc<AtomicBool>,
}

/// Immutable set of initialized MCP connections and their frozen global tool catalog.
///
/// A runtime never mutates bindings in place. Hosts build a replacement runtime at a model safe
/// point when configuration or a list-changed event requires a new catalog generation.
pub struct McpRuntime {
    connections: BTreeMap<McpServerId, McpConnection>,
    catalog: McpCatalogSnapshot,
    diagnostics: Vec<McpStartupDiagnostic>,
    limits: McpCatalogLimits,
}

impl McpRuntime {
    pub async fn start(
        definitions: Vec<McpServerDefinition>,
        options: McpRuntimeOptions,
    ) -> Result<Self, McpRuntimeError> {
        Self::start_with_factory(definitions, Arc::new(RmcpSessionFactory), options).await
    }

    pub async fn start_with_factory(
        definitions: Vec<McpServerDefinition>,
        factory: Arc<dyn McpSessionFactory>,
        options: McpRuntimeOptions,
    ) -> Result<Self, McpRuntimeError> {
        validate_options(&options)?;
        reject_duplicate_servers(&definitions)?;
        let mut connections = BTreeMap::new();
        let mut tools = Vec::new();
        let mut diagnostics = Vec::new();

        for (offset, definition) in definitions.into_iter().enumerate() {
            let server = definition.id().clone();
            let display_name = definition.display_name().to_owned();
            let Some(connection_generation) = options
                .first_connection_generation
                .checked_add(offset as u64)
            else {
                shutdown_connections(connections).await;
                return Err(McpRuntimeError::InvalidOptions(
                    "connection generation overflow".into(),
                ));
            };
            let catalog_stale = Arc::new(AtomicBool::new(false));
            let host = Arc::new(RuntimeClientHost {
                downstream: Arc::clone(&options.client_host),
                catalog_stale: Arc::clone(&catalog_stale),
            });
            let mut client_options =
                RmcpClientOptions::new(&options.client_name, &options.client_version)
                    .with_timeouts(options.client_timeouts)
                    .with_host(host);
            if options.form_elicitation {
                client_options = client_options.with_form_elicitation();
            }
            let session = match factory.connect(definition, client_options).await {
                Ok(session) => session,
                Err(error) => {
                    let runtime_error = McpRuntimeError::Startup {
                        server: server.clone(),
                        message: error.to_string(),
                    };
                    if options.startup_policy == McpStartupPolicy::RequireAll {
                        shutdown_connections(connections).await;
                        return Err(runtime_error);
                    }
                    diagnostics.push(McpStartupDiagnostic {
                        server,
                        message: error.to_string(),
                    });
                    continue;
                }
            };
            let discovered = discover_server_tools(
                session.as_ref(),
                &server,
                connection_generation,
                options.catalog_generation,
                options.loading,
                options.catalog_limits,
            )
            .await;
            let discovered = match discovered {
                Ok(discovered) => discovered,
                Err(error) => {
                    let message = error.to_string();
                    let _ = session.shutdown().await;
                    if options.startup_policy == McpStartupPolicy::RequireAll {
                        shutdown_connections(connections).await;
                        return Err(error);
                    }
                    diagnostics.push(McpStartupDiagnostic { server, message });
                    continue;
                }
            };
            let server_info = session.server_info();
            tools.extend(discovered);
            connections.insert(
                server,
                McpConnection {
                    display_name,
                    server_info,
                    session,
                    catalog_stale,
                },
            );
        }

        let catalog = match McpCatalogSnapshot::new(options.catalog_generation, tools) {
            Ok(catalog) => catalog,
            Err(error) => {
                shutdown_connections(connections).await;
                return Err(error);
            }
        };
        Ok(Self {
            connections,
            catalog,
            diagnostics,
            limits: options.catalog_limits,
        })
    }

    pub fn catalog(&self) -> &McpCatalogSnapshot {
        &self.catalog
    }

    pub fn diagnostics(&self) -> &[McpStartupDiagnostic] {
        &self.diagnostics
    }

    pub fn connected_server_ids(&self) -> impl Iterator<Item = &McpServerId> {
        self.connections.keys()
    }

    pub fn server_display_name(&self, server: &McpServerId) -> Option<&str> {
        self.connections
            .get(server)
            .map(|connection| connection.display_name.as_str())
    }

    pub fn server_info(&self, server: &McpServerId) -> Option<&ServerInfo> {
        self.connections
            .get(server)
            .map(|connection| &connection.server_info)
    }

    pub fn catalog_freshness(&self, server: &McpServerId) -> Option<McpCatalogFreshness> {
        self.connections.get(server).map(|connection| {
            if connection.catalog_stale.load(Ordering::Acquire) {
                McpCatalogFreshness::Stale
            } else {
                McpCatalogFreshness::Fresh
            }
        })
    }

    pub fn resolve_tool(&self, exposed_name: &ToolName) -> Option<&McpToolBinding> {
        self.catalog
            .resolve(exposed_name)
            .map(|descriptor| descriptor.binding())
    }

    pub async fn call_tool(
        &self,
        binding: &McpToolBinding,
        arguments: serde_json::Value,
        cancellation: &CancellationToken,
    ) -> Result<ToolOutput, McpCallError> {
        if cancellation.is_cancelled() {
            let reason = cancellation
                .cancellation()
                .map(|signal| signal.reason().to_string())
                .unwrap_or_else(|| "cancelled".into());
            return Err(McpCallError::NotStarted(reason));
        }
        let Some(descriptor) = self.catalog.resolve(binding.exposed_name()) else {
            return Err(McpCallError::NotStarted(
                McpRuntimeError::StaleBinding.to_string(),
            ));
        };
        if descriptor.binding() != binding {
            return Err(McpCallError::NotStarted(
                McpRuntimeError::StaleBinding.to_string(),
            ));
        }
        let serde_json::Value::Object(arguments) = arguments else {
            return Err(McpCallError::NotStarted(
                McpRuntimeError::InvalidArguments.to_string(),
            ));
        };
        let Some(connection) = self.connections.get(binding.remote().server()) else {
            return Err(McpCallError::NotStarted(
                McpRuntimeError::StaleBinding.to_string(),
            ));
        };
        if connection.catalog_stale.load(Ordering::Acquire) {
            return Err(McpCallError::NotStarted(
                McpRuntimeError::StaleCatalog.to_string(),
            ));
        }
        let mut request = CallToolRequestParams::new(binding.remote().remote_name().to_owned());
        request.arguments = Some(arguments);
        let result = connection
            .session
            .call_tool(request, cancellation)
            .await
            .map_err(|error| McpCallError::OutcomeUncertain(error.to_string()))?;
        project_tool_result(result, self.limits.maximum_tool_output_bytes)
    }

    pub async fn shutdown(self) -> Vec<McpShutdownDiagnostic> {
        let mut diagnostics = Vec::new();
        for (server, connection) in self.connections {
            if let Err(error) = connection.session.shutdown().await {
                diagnostics.push(McpShutdownDiagnostic {
                    server,
                    message: error.to_string(),
                });
            }
        }
        diagnostics
    }
}

async fn shutdown_connections(connections: BTreeMap<McpServerId, McpConnection>) {
    for (_, connection) in connections {
        let _ = connection.session.shutdown().await;
    }
}

fn reject_duplicate_servers(definitions: &[McpServerDefinition]) -> Result<(), McpRuntimeError> {
    let mut seen = BTreeSet::new();
    for definition in definitions {
        if !seen.insert(definition.id().clone()) {
            return Err(McpRuntimeError::DuplicateServer(definition.id().clone()));
        }
    }
    Ok(())
}

fn validate_options(options: &McpRuntimeOptions) -> Result<(), McpRuntimeError> {
    let limits = options.catalog_limits;
    if limits.maximum_pages_per_server == 0 {
        return Err(McpRuntimeError::InvalidOptions(
            "maximum pages per server must be greater than zero".into(),
        ));
    }
    if limits.maximum_tools_per_server == 0 {
        return Err(McpRuntimeError::InvalidOptions(
            "maximum tools per server must be greater than zero".into(),
        ));
    }
    if limits.maximum_catalog_bytes_per_server == 0 {
        return Err(McpRuntimeError::InvalidOptions(
            "maximum catalog bytes per server must be greater than zero".into(),
        ));
    }
    if limits.maximum_tool_output_bytes == 0 {
        return Err(McpRuntimeError::InvalidOptions(
            "maximum tool output bytes must be greater than zero".into(),
        ));
    }
    Ok(())
}

struct RuntimeClientHost {
    downstream: Arc<dyn McpClientHost>,
    catalog_stale: Arc<AtomicBool>,
}

impl McpClientHost for RuntimeClientHost {
    fn on_event(&self, event: McpClientEvent) {
        if matches!(event, McpClientEvent::ToolListChanged) {
            self.catalog_stale.store(true, Ordering::Release);
        }
        self.downstream.on_event(event);
    }

    fn handle_elicitation(
        &self,
        request: McpElicitation,
    ) -> ash_rmcp_client::HostFuture<Result<ElicitResult, ash_rmcp_client::RmcpErrorData>> {
        self.downstream.handle_elicitation(request)
    }
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;

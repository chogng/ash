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
    mcp_apps: bool,
    startup_policy: McpStartupPolicy,
    catalog_limits: McpCatalogLimits,
    loading: ToolLoading,
    catalog_generation: u64,
    first_connection_generation: u64,
    metrics: diagnostics::Metrics,
    metric_connectors: BTreeMap<McpServerId, String>,
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
            .field("mcp_apps", &self.mcp_apps)
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
            mcp_apps: false,
            startup_policy: McpStartupPolicy::RequireAll,
            catalog_limits: McpCatalogLimits::default(),
            loading: ToolLoading::Eager,
            catalog_generation: 1,
            first_connection_generation: 1,
            metrics: diagnostics::Metrics::default(),
            metric_connectors: BTreeMap::new(),
        }
    }

    /// Uses the host meter so replacing a catalog does not reset cumulative observations.
    pub fn with_metrics(mut self, metrics: diagnostics::Metrics) -> Self {
        self.metrics = metrics;
        self
    }

    /// Attributes connector-backed servers using the host's resolved authority, never tool input.
    pub fn with_metric_connectors(mut self, connectors: BTreeMap<McpServerId, String>) -> Self {
        self.metric_connectors = connectors;
        self
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

    /// Enables UI negotiation for a host with an installed isolated MCP App renderer.
    pub fn with_mcp_apps(mut self) -> Self {
        self.mcp_apps = true;
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
    metrics: diagnostics::Metrics,
    metric_connectors: BTreeMap<McpServerId, String>,
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
            if options.mcp_apps {
                client_options = client_options.with_mcp_apps();
            }
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
            metrics: options.metrics,
            metric_connectors: options.metric_connectors,
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
        let mut tags = vec![
            ("server", binding.remote().server().as_str()),
            ("tool", binding.remote().remote_name()),
        ];
        if let Some(connector) = self.metric_connectors.get(binding.remote().server()) {
            tags.push(("connector_id", connector));
        }
        let timer = self
            .metrics
            .start(diagnostics::MetricOperation::McpCall, &tags);
        let result = self.call_tool_inner(binding, arguments, cancellation).await;
        let (status, error) = match &result {
            Ok(output) => match output.status() {
                ash_tools::ToolOutputStatus::Success => {
                    (diagnostics::MetricOutcome::Succeeded, None)
                }
                ash_tools::ToolOutputStatus::Error => {
                    (diagnostics::MetricOutcome::Failed, Some("tool_result"))
                }
            },
            Err(_) if cancellation.is_cancelled() => {
                (diagnostics::MetricOutcome::Cancelled, Some("cancellation"))
            }
            Err(McpCallError::NotStarted(_)) => {
                (diagnostics::MetricOutcome::Failed, Some("not_started"))
            }
            Err(McpCallError::InvalidResult(_)) => {
                (diagnostics::MetricOutcome::Failed, Some("invalid_result"))
            }
            Err(McpCallError::OutcomeUncertain(_)) => {
                (diagnostics::MetricOutcome::Failed, Some("mcp_request"))
            }
        };
        timer.finish(status, error);
        result
    }

    async fn call_tool_inner(
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
        let app_input = descriptor
            .app_resource_uri
            .as_ref()
            .map(|_| serde_json::Value::Object(arguments.clone()));
        let mut request = CallToolRequestParams::new(binding.remote().remote_name().to_owned());
        request.arguments = Some(arguments);
        let result = connection
            .session
            .call_tool(request, cancellation)
            .await
            .map_err(|error| McpCallError::OutcomeUncertain(error.to_string()))?;
        let app = descriptor.app_resource_uri.as_ref().map(|uri| {
            ash_protocol::ToolOutputArtifact::new(
                ash_protocol::ToolOutputArtifactSource::McpApp { uri: uri.clone() },
                "text/html;profile=mcp-app".into(),
                ash_protocol::ToolOutputArtifactData::Json {
                    json: serde_json::json!({"input": app_input}).to_string(),
                },
            )
        });
        let metadata = result.meta.as_ref().map(|meta| {
            ash_protocol::ToolOutputArtifact::new(
                ash_protocol::ToolOutputArtifactSource::ViewMetadata,
                "application/json".into(),
                ash_protocol::ToolOutputArtifactData::Json {
                    json: serde_json::to_string(meta).expect("MCP metadata is JSON"),
                },
            )
        });
        let metadata_bytes = metadata.as_ref().map_or(0, |artifact| {
            let ash_protocol::ToolOutputArtifactData::Json { json } = &artifact.data else {
                unreachable!()
            };
            json.len() + artifact.mime_type.len()
        });
        let reserved = metadata_bytes.saturating_add(app.as_ref().map_or(0, |app| {
            let ash_protocol::ToolOutputArtifactData::Json { json } = &app.data else {
                unreachable!("App metadata was normalized above")
            };
            json.len()
                + app.mime_type.len()
                + descriptor.app_resource_uri.as_ref().map_or(0, String::len)
        }));
        if reserved > self.limits.maximum_tool_output_bytes {
            return Err(McpCallError::InvalidResult(
                "MCP App metadata byte limit exceeded".into(),
            ));
        }
        let output = project_tool_result(result, self.limits.maximum_tool_output_bytes - reserved)?;
        let status = output.status();
        let mut content = output.content().to_vec();
        if let Some(metadata) = metadata {
            content.push(ash_tools::ToolContent::Artifact(metadata));
        }
        if let Some(app) = app {
            content.push(ash_tools::ToolContent::Artifact(app));
        }
        Ok(match status {
            ash_tools::ToolOutputStatus::Success => ToolOutput::success(content),
            ash_tools::ToolOutputStatus::Error => ToolOutput::error(content),
        })
    }

    /// Reads only through a still-valid tool origin; a URI never chooses a different server.
    pub async fn read_resource(
        &self,
        binding: &McpToolBinding,
        uri: String,
        cancellation: &CancellationToken,
    ) -> Result<ash_protocol::ToolOutputArtifact, McpCallError> {
        cancellation
            .check()
            .map_err(|signal| McpCallError::NotStarted(signal.reason().to_string()))?;
        let descriptor = self
            .catalog
            .resolve(binding.exposed_name())
            .ok_or_else(|| McpCallError::NotStarted(McpRuntimeError::StaleBinding.to_string()))?;
        if descriptor.binding() != binding {
            return Err(McpCallError::NotStarted(
                McpRuntimeError::StaleBinding.to_string(),
            ));
        }
        let connection = self
            .connections
            .get(binding.remote().server())
            .ok_or_else(|| McpCallError::NotStarted(McpRuntimeError::StaleBinding.to_string()))?;
        if connection.catalog_stale.load(Ordering::Acquire) {
            return Err(McpCallError::NotStarted(
                McpRuntimeError::StaleCatalog.to_string(),
            ));
        }
        if connection
            .session
            .server_info()
            .capabilities
            .resources
            .is_none()
        {
            return Err(McpCallError::NotStarted(
                "server does not support resource reading".into(),
            ));
        }
        if uri.is_empty() || uri.len() > 4096 || uri.chars().any(char::is_control) {
            return Err(McpCallError::NotStarted("invalid resource URI".into()));
        }
        let result = connection
            .session
            .read_resource(uri.clone(), cancellation)
            .await
            .map_err(|error| McpCallError::InvalidResult(error.to_string()))?;
        cancellation
            .check()
            .map_err(|signal| McpCallError::NotStarted(signal.reason().to_string()))?;
        if result.contents.len() != 1 {
            return Err(McpCallError::InvalidResult(
                "resource read must return one exact resource".into(),
            ));
        }
        let app_csp = resource_app_csp(&result.contents[0])?;
        let csp_bytes = app_csp.as_ref().map_or(0, |csp| {
            serde_json::to_vec(csp).expect("typed CSP is JSON").len()
        });
        let budget = self.limits.maximum_tool_output_bytes.min(262_144);
        if csp_bytes > budget {
            return Err(McpCallError::InvalidResult(
                "App CSP exceeds resource budget".into(),
            ));
        }
        let output = project_tool_result(
            ash_rmcp_client::CallToolResult::success(
                result
                    .contents
                    .into_iter()
                    .map(ash_rmcp_client::ContentBlock::resource)
                    .collect(),
            ),
            budget - csp_bytes,
        )?;
        let [ash_tools::ToolContent::Artifact(artifact)] = output.content() else {
            return Err(McpCallError::InvalidResult(
                "resource read returned unsupported data".into(),
            ));
        };
        if artifact.source != (ash_protocol::ToolOutputArtifactSource::EmbeddedResource { uri })
            || artifact.truncated
        {
            return Err(McpCallError::InvalidResult(
                "resource identity mismatch or byte limit exceeded".into(),
            ));
        }
        let mut artifact = artifact.clone();
        artifact.app_csp = app_csp;
        Ok(artifact)
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

/// A resource's network declaration is untrusted input to a browser security policy.
/// Keep only complete HTTP(S) origins (and WS(S) for connections), never raw CSP expressions.
fn resource_app_csp(
    resource: &ash_rmcp_client::ResourceContents,
) -> Result<Option<ash_protocol::McpAppResourceCsp>, McpCallError> {
    let (mime, meta) = match resource {
        ash_rmcp_client::ResourceContents::TextResourceContents {
            mime_type, meta, ..
        }
        | ash_rmcp_client::ResourceContents::BlobResourceContents {
            mime_type, meta, ..
        } => (mime_type.as_deref(), meta.as_ref()),
        _ => return Ok(None),
    };
    if !mime.is_some_and(|mime| {
        mime.split(';')
            .next()
            .is_some_and(|part| part.trim().eq_ignore_ascii_case("text/html"))
            && mime.split(';').skip(1).any(|part| {
                part.split_once('=').is_some_and(|(key, value)| {
                    key.trim().eq_ignore_ascii_case("profile")
                        && value.trim().eq_ignore_ascii_case("mcp-app")
                })
            })
    }) {
        return Ok(None);
    }
    let Some(value) = meta
        .and_then(|meta| meta.get("ui"))
        .and_then(|ui| ui.get("csp"))
    else {
        return Ok(None);
    };
    if serde_json::to_vec(value)
        .map_err(|error| McpCallError::InvalidResult(error.to_string()))?
        .len()
        > 16_384
    {
        return Err(McpCallError::InvalidResult(
            "App CSP metadata exceeds byte limit".into(),
        ));
    }
    let mut csp: ash_protocol::McpAppResourceCsp = serde_json::from_value(value.clone())
        .map_err(|_| McpCallError::InvalidResult("invalid App CSP metadata".into()))?;
    for (domains, allow_websocket) in [
        (&mut csp.connect_domains, true),
        (&mut csp.resource_domains, false),
        (&mut csp.frame_domains, false),
        (&mut csp.base_uri_domains, false),
    ] {
        if domains.len() > 32 {
            return Err(McpCallError::InvalidResult(
                "App CSP has too many origins".into(),
            ));
        }
        for domain in domains.iter_mut() {
            if domain.len() > 256
                || !domain.is_ascii()
                || domain.chars().any(|character| {
                    character.is_ascii_whitespace()
                        || character.is_control()
                        || "'\"<>;`\\".contains(character)
                })
            {
                return Err(McpCallError::InvalidResult("invalid App CSP origin".into()));
            }
            let (scheme, host) = domain
                .split_once("://")
                .ok_or_else(|| McpCallError::InvalidResult("App CSP requires an origin".into()))?;
            let wildcard = host.starts_with("*.");
            let normalized = format!("{scheme}://{}", host.strip_prefix("*.").unwrap_or(host));
            let url = url::Url::parse(&normalized)
                .map_err(|_| McpCallError::InvalidResult("invalid App CSP origin".into()))?;
            if !(matches!(url.scheme(), "http" | "https")
                || allow_websocket && matches!(url.scheme(), "ws" | "wss"))
                || !url.username().is_empty()
                || url.password().is_some()
                || url.path() != "/"
                || url.query().is_some()
                || url.fragment().is_some()
                || url.host_str().is_none()
                || url.host_str().is_some_and(|host| host.contains('*'))
                || wildcard && !matches!(url.host(), Some(url::Host::Domain(_)))
                || host.trim_end_matches('/').contains('*') && !wildcard
            {
                return Err(McpCallError::InvalidResult(
                    "App CSP requires a safe origin".into(),
                ));
            }
            let origin = url.origin().ascii_serialization();
            *domain = if wildcard {
                origin.replacen("://", "://*.", 1)
            } else {
                origin
            };
        }
        domains.sort();
        domains.dedup();
    }
    Ok(Some(csp))
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

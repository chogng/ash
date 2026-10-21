use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::common::SchemaHash;
use ash_app_server_protocol::protocol::common::ServerInfo;
use ash_app_server_protocol::protocol::common::ServerOperatingSystem;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::initialize::InitializeParams;
use ash_app_server_protocol::protocol::initialize::InitializeResult;
use ash_app_server_protocol::protocol::initialize::ProtocolVersion;
use ash_app_server_protocol::protocol::initialize::ServerCapabilities;
use ash_app_server_protocol::schema_hash;
use serde_json::Value;

impl AppServer {
    pub(super) fn initialize(
        &self,
        connection: &mut ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let _initialize = ash_app_server_daemon::startup_trace::StartupTrace::span("initialize");
        if connection.is_initialized() {
            return Err(RpcError::new(
                -32002,
                AppServerErrorName::AlreadyInitialized,
            ));
        }
        let params: InitializeParams = decode(params)?;
        if params
            .capabilities
            .app_tools
            .as_ref()
            .is_some_and(|capability| {
                capability.version != 1
                    || !connection.allows_team_capabilities()
                    || capability.desktop && !connection.allows_product_host_capabilities()
            })
        {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        if params.client_info.name.trim().is_empty() || params.client_info.version.trim().is_empty()
        {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        if params
            .capabilities
            .agent_interactions
            .as_ref()
            .is_some_and(|capability| {
                let supports_dynamic = capability
                    .kinds
                    .contains(&ash_protocol::AgentInteractionKind::DynamicTool);
                let dynamic_tools = capability.dynamic_tools.as_deref().unwrap_or_default();
                let unique_dynamic_tools = dynamic_tools
                    .iter()
                    .collect::<std::collections::BTreeSet<_>>()
                    .len()
                    == dynamic_tools.len();
                capability.version != 1
                    || capability.kinds.is_empty()
                    || !unique_dynamic_tools
                    || supports_dynamic != !dynamic_tools.is_empty()
            })
        {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        if params
            .capabilities
            .browser
            .as_ref()
            .is_some_and(|capability| {
                !matches!(capability.version, 3 | 4) || (!capability.observe && !capability.input)
            })
        {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        if params
            .capabilities
            .directory_grants_host
            .as_ref()
            .is_some_and(|capability| capability.version != 1)
        {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        if params.capabilities.directory_grants_host.is_some()
            && !connection.allows_product_host_capabilities()
        {
            return Err(RpcError::new(
                -32073,
                AppServerErrorName::PermissionRequired,
            ));
        }
        connection.set_directory_grants_host(params.capabilities.directory_grants_host.is_some());
        self.updates.set_agent_interaction_capability(
            connection.connection_id,
            params.capabilities.agent_interactions,
        );
        if let Some(capability) = params.capabilities.browser {
            self.browser_host.register(
                connection.connection_id,
                capability,
                connection.outbound_notifications.clone(),
            );
            if self.synchronize_browser_tool_availability().is_err() {
                self.browser_host.unregister(connection.connection_id);
                return Err(RpcError::new(-32603, AppServerErrorName::InternalError));
            }
        }
        if params
            .capabilities
            .text_documents
            .as_ref()
            .is_some_and(|capability| capability.version != 2)
        {
            self.browser_host.unregister(connection.connection_id);
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        self.client_host.register(
            connection.connection_id,
            params.capabilities.text_documents.is_some(),
            connection.outbound_notifications.clone(),
        );
        self.client_host.install_ide_attachment(
            connection.connection_id,
            std::sync::Arc::clone(&connection.ide_attachment),
        );
        self.client_host.register_app_tools(
            connection.connection_id,
            params.capabilities.app_tools.clone(),
        );
        connection.set_initialized();
        let (file_system, git, content_search, codebase, cloud_codebase, terminal, debug_adapter) =
            self.env_features();
        let extensions = self
            .extensions
            .lock()
            .map(|catalog| catalog.is_available())
            .unwrap_or(false);
        let mut capabilities = ServerCapabilities {
            agent_interactions: true,
            document_collaboration: true,
            sessions: true,
            threads: true,
            turns: true,
            projects: self.projects.is_some(),
            memories: self.memories.is_some(),
            approval_environment: self.approval_environment.is_some()
                && matches!(
                    connection.authority,
                    super::ConnectionAuthority::ProductHost | super::ConnectionAuthority::Browser
                ),
            resources: true,
            attachments: true,
            file_system,
            git,
            github: self.github_processor.is_some(),
            content_search,
            codebase,
            cloud_codebase,
            terminal,
            debug_adapter,
            update_replay: true,
            extensions,
            extension_host: self.extension_hosts.is_some(),
            connectors: self.connector_processor.is_available(),
            plugins: self.plugins.is_some(),
            extension_management: self.plugin_package_service.is_some(),
            mcp: self.config.is_some(),
            mcp_oauth: self.mcp_oauth.is_some(),
            contracts: Default::default(),
        };
        capabilities.advertise_contracts();
        if self.task_delivery.is_some() {
            capabilities.contracts.insert(
                "taskDelivery".into(),
                ash_app_server_protocol::protocol::initialize::CapabilityContract { version: 1 },
            );
        }
        if self.issue_reporter.is_some() {
            capabilities.contracts.insert(
                "issueReporter".into(),
                ash_app_server_protocol::protocol::initialize::CapabilityContract { version: 1 },
            );
        }
        capabilities.contracts.insert(
            "memoryDiagnostics".into(),
            ash_app_server_protocol::protocol::initialize::CapabilityContract { version: 1 },
        );
        if self.asset_processor.is_available() {
            capabilities.contracts.insert(
                "assets".into(),
                ash_app_server_protocol::protocol::initialize::CapabilityContract { version: 1 },
            );
        }
        if self.home.is_some()
            && self.provider_runtime.is_some()
            && self.config.is_some()
            && connection.allows_product_host_capabilities()
        {
            capabilities.contracts.insert(
                "voiceConversation".into(),
                ash_app_server_protocol::protocol::initialize::CapabilityContract { version: 2 },
            );
        }
        if self.home.is_some() {
            capabilities.contracts.insert(
                "channels".into(),
                ash_app_server_protocol::protocol::initialize::CapabilityContract { version: 1 },
            );
            capabilities.contracts.insert(
                "calls".into(),
                ash_app_server_protocol::protocol::initialize::CapabilityContract { version: 1 },
            );
        }
        if self.symphony.is_some() {
            capabilities.contracts.insert(
                "symphony".into(),
                ash_app_server_protocol::protocol::initialize::CapabilityContract { version: 1 },
            );
        }
        if self
            .message_history_processor
            .is_available(connection.authority)
        {
            capabilities.contracts.insert(
                "messageHistory".into(),
                ash_app_server_protocol::protocol::initialize::CapabilityContract { version: 1 },
            );
        }
        if self.automation_processor.is_available() {
            capabilities.contracts.insert(
                "automation".into(),
                ash_app_server_protocol::protocol::initialize::CapabilityContract { version: 1 },
            );
        }
        if self.session_runtimes.is_some() {
            capabilities.contracts.insert(
                "sessionRuntimes".into(),
                ash_app_server_protocol::protocol::initialize::CapabilityContract { version: 1 },
            );
        }
        result(&InitializeResult {
            server_info: ServerInfo {
                name: "ash-app-server".into(),
                version: build_info::VERSION.into(),
                user_home: dirs::home_dir()
                    .filter(|path| path.is_absolute())
                    .and_then(|path| path.into_os_string().into_string().ok()),
                operating_system: if cfg!(windows) {
                    Some(ServerOperatingSystem::Windows)
                } else if cfg!(target_os = "macos") {
                    Some(ServerOperatingSystem::Mac)
                } else if cfg!(target_os = "linux") {
                    Some(ServerOperatingSystem::Linux)
                } else {
                    None
                },
            },
            protocol_version: ProtocolVersion::current(),
            schema_hash: SchemaHash(schema_hash()),
            capabilities,
            slash_commands: self.slash_commands.commands().to_vec(),
        })
    }
}

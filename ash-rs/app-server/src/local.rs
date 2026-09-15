use crate::AppServer;
use crate::CodebaseModels;
use crate::SlashCommandCatalog;
use crate::model_catalog::ModelCatalog;
use crate::model_provider_error::map_model_provider_error;
use crate::server::DirGrantPolicy;
use crate::server::EnvToolPorts;
use crate::server::update_broker::UpdateBroker;
use crate::tool_composition::ToolPort;
use ash_async_utils::CancellationToken;
use ash_chatgpt::ChatGptOAuth;
use ash_client::OperationClient;
use ash_cloud_codebase::CloudCodebaseProviderRegistry;
use ash_config::ConfigStore;
use ash_config::DirConfigDocument;
use ash_config::DirConfigInput;
use ash_config::DirConfigRevision;
use ash_config::DirConfigScope;
use ash_config::DirConfigStore;
use ash_config::DirId;
use ash_config::McpServerId;
use ash_config::ResolvedConfig;
use ash_config::ResolvedConfigSnapshot;
use ash_config::resolve_scoped_config;
use ash_core::ContextBudget;
use ash_core::ContextCompactionLimit;
use ash_core::ContextTokenCount;
use ash_core::ContextTokenMeasurementCapability;
use ash_core::ContextTokenMeasurementOutcome;
use core_api::CoreError;
use ash_core::InMemoryThreadStore;
use core_api::ModelImageInputLimits;
use core_api::ModelImageInputPolicy;
use core_api::ModelSelection;
use core_api::ModelService;
use core_api::ModelStreamSink as CoreModelStreamSink;
use ash_core::ResolvedContextBudget;
use ash_core::ThreadController;
use ash_core_plugins::PluginActivationAuthority;
use ash_core_plugins::PluginActivationSnapshot;
use ash_extensions::ExtensionRoot;
use ash_file_access::Dir;
use ash_file_access::Permission as DirPermission;
use ash_install_context::InstallContext;
use ash_kimi::KimiOAuth;
use ash_login::InteractiveLoginDriver;
use ash_login::LoginService;
use ash_lsp_server_provider::ManagedNodeRuntime;
use ash_mcp_extension::ConnectorMcpRuntimeProvider;
use ash_mcp_extension::McpCatalogUpdateSubscription;
use ash_mcp_extension::McpCatalogUpdates;
use ash_mcp_extension::McpOAuthProvider;
use ash_mcp_extension::McpOAuthService;
use ash_mcp_extension::McpRuntimeStatusSnapshot;
use ash_mcp_extension::PluginConnectorMcpRuntimeProvider;
use ash_mcp_extension::compose_mcp_tools_at_generation_with_runtime_intents_and_updates;
use ash_mcp_extension::compose_mcp_tools_with_connectors_and_runtime_intents_and_updates;
use ash_model_provider::HttpTokenizerAssetDownloader;
use ash_model_provider::HuggingFaceTokenizerAssetDiscoverer;
use ash_model_provider::ManagedLocalTokenizerService;
use ash_model_provider::MemoryTokenizerCapacity;
use ash_model_provider::ModelEventSink;
use ash_model_provider::ModelInvoker;
use ash_model_provider::ModelProvider;
use ash_model_provider::ModelProviderRuntime;
use ash_model_provider::ModelRuntimeRequest;
use ash_model_provider::TokenizerAssetCatalog;
use ash_model_provider::UnavailableModel;
use ash_model_provider_config::ModelProviderConfig;
use ash_model_provider_config::ProviderConfigRegistry;
use ash_model_provider_config::StaticModelRuntime;
use ash_model_provider_config::find_static_model;
use ash_models_manager::CatalogQuery;
use ash_models_manager::CatalogScopeKey;
use ash_models_manager::ModelRequirements;
use ash_models_manager::ModelsManager;
use ash_protocol::ContextWindow;
use ash_protocol::ModelAccess;
use ash_protocol::ModelBillingScope;
use ash_rollout::LocalStateRepository;
use ash_secrets::FileSecretStore;
use ash_secrets::SecretStore;
use ash_skills_extension::BuiltInSkillSource;
use ash_skills_extension::SkillConfigSnapshotProvider;
use std::collections::BTreeMap;
use std::fmt;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::thread::JoinHandle;
use std::time::Duration;

const DEFAULT_MODEL_OUTPUT_RESERVATION_TOKENS: u32 = 4_096;
const MODEL_CONTEXT_SAFETY_MARGIN_TOKENS: u32 = 1_024;

/// Filesystem and runtime inputs needed to open one local App Server.
#[derive(Clone)]
pub struct LocalAppServerOptions {
    execution_environments: Vec<exec_server::ExecutionEnvironment>,
    pub profile_root: PathBuf,
    codex_home: Option<PathBuf>,
    pub dir_config: Option<LocalDirConfigOptions>,
    pub slash_commands: SlashCommandCatalog,
    pub dir_root: Option<PathBuf>,
    pub built_in_skills: BuiltInSkillRoot,
    pub session_state_mode: SessionStateMode,
    initial_dir_permissions: InitialDirPermissions,
    agent_model_service: Option<Arc<dyn ModelService>>,
    model_operation_client: Option<Arc<dyn OperationClient>>,
    web_search_backend: Option<Arc<dyn ash_web_search_extension::WebSearchBackend>>,
    image_generation_backend: Option<Arc<dyn image_generation::ImageGenerationBackend>>,
    git_attribution: Option<Arc<dyn git_attribution::GitAttributionPolicySource>>,
    connector_runtime: Option<LocalConnectorRuntime>,
    mcp_oauth_providers: Vec<(McpServerId, Arc<dyn McpOAuthProvider>)>,
    plugin_package_service: Option<Arc<dyn ash_core_plugins::PluginPackageService>>,
    plugins_manager: Option<Arc<ash_core_plugins::PluginsManager>>,
    language_server_providers: ash_lsp_server_provider::LspServerProviders,
    product_services: Option<crate::LocalProductServicesConfig>,
    profile_runtime: Option<Arc<LocalProfileRuntime>>,
    fast_regex_worker_command: Option<ash_fast_regex_search::FastRegexWorkerCommand>,
    pty_helper: Option<std::path::PathBuf>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum InitialDirPermissions {
    #[default]
    HostConfiguration,
    UserConfig,
}

impl LocalAppServerOptions {
    pub fn with_execution_environments(
        mut self,
        environments: Vec<exec_server::ExecutionEnvironment>,
    ) -> Self {
        self.execution_environments = environments;
        self
    }

    pub fn with_image_generation_backend(
        mut self,
        backend: Arc<dyn image_generation::ImageGenerationBackend>,
    ) -> Self {
        self.image_generation_backend = Some(backend);
        self
    }
    pub fn with_git_attribution(
        mut self,
        source: Arc<dyn git_attribution::GitAttributionPolicySource>,
    ) -> Self {
        self.git_attribution = Some(source);
        self
    }

    pub fn new(profile_root: impl Into<PathBuf>) -> Self {
        Self {
            profile_root: profile_root.into(),
            execution_environments: Vec::new(),
            codex_home: None,
            dir_config: None,
            slash_commands: SlashCommandCatalog::default(),
            dir_root: None,
            built_in_skills: BuiltInSkillRoot::AutoDetect,
            session_state_mode: SessionStateMode::Durable,
            initial_dir_permissions: InitialDirPermissions::HostConfiguration,
            agent_model_service: None,
            model_operation_client: None,
            web_search_backend: None,
            image_generation_backend: None,
            git_attribution: None,
            connector_runtime: None,
            mcp_oauth_providers: Vec::new(),
            plugin_package_service: None,
            plugins_manager: None,
            language_server_providers: ash_lsp_server_provider::LspServerProviders::new(),
            product_services: None,
            profile_runtime: None,
            fast_regex_worker_command: None,
            pty_helper: None,
        }
    }

    pub fn with_dir_config(mut self, dir_config: LocalDirConfigOptions) -> Self {
        self.dir_config = Some(dir_config);
        self
    }

    /// Selects the Codex credential home for an isolated host or test environment.
    pub fn with_codex_home(mut self, home: impl Into<PathBuf>) -> Self {
        self.codex_home = Some(home.into());
        self
    }

    pub fn with_slash_command_catalog(mut self, slash_commands: SlashCommandCatalog) -> Self {
        self.slash_commands = slash_commands;
        self
    }

    /// Enables local filesystem and shell tools under one canonical Directory root.
    pub fn with_dir_root(mut self, dir_root: impl Into<PathBuf>) -> Self {
        self.dir_root = Some(dir_root.into());
        self.initial_dir_permissions = InitialDirPermissions::HostConfiguration;
        self
    }

    /// Resolves the initial directory through durable user configuration.
    pub fn with_user_config_dir_root(mut self, dir_root: impl Into<PathBuf>) -> Self {
        self.dir_root = Some(dir_root.into());
        self.initial_dir_permissions = InitialDirPermissions::UserConfig;
        self
    }

    pub fn with_built_in_skill_root(mut self, root: impl Into<PathBuf>) -> Self {
        self.built_in_skills = BuiltInSkillRoot::Explicit(root.into());
        self
    }

    pub fn without_built_in_skills(mut self) -> Self {
        self.built_in_skills = BuiltInSkillRoot::Unavailable;
        self
    }

    /// Selects whether Session and Thread event history is recovered from profile storage.
    pub fn with_session_state_mode(mut self, mode: SessionStateMode) -> Self {
        self.session_state_mode = mode;
        self
    }

    /// Replaces only the model used by Agent Turns while retaining the configured model catalog.
    ///
    /// Embedded hosts can use this boundary to run deterministic or instrumented model subjects
    /// through the complete App Server execution stack. Product hosts normally use the model
    /// resolved from profile configuration.
    pub fn with_agent_model_service(mut self, model: Arc<dyn ModelService>) -> Self {
        self.agent_model_service = Some(model);
        self
    }

    /// Reuses one process-wide profile authority while composing a Directory-scoped runtime.
    pub fn with_profile_runtime(mut self, runtime: Arc<LocalProfileRuntime>) -> Self {
        self.profile_runtime = Some(runtime);
        self
    }

    /// Runs Fast Regex indexing and mmap-backed search in a private long-lived process.
    /// Configures the executable that dispatches the internal sandbox PTY role.
    pub fn with_pty_helper(mut self, executable: std::path::PathBuf) -> Self {
        self.pty_helper = Some(executable);
        self
    }

    pub fn with_fast_regex_worker_command(
        mut self,
        command: ash_fast_regex_search::FastRegexWorkerCommand,
    ) -> Self {
        self.fast_regex_worker_command = Some(command);
        self
    }

    /// Replaces the production model operation client for this composition root.
    ///
    /// Embedded hosts and tests can use this to keep model transport offline while exercising the
    /// complete App Server stack. Product hosts normally leave the lazy production client in use.
    pub fn with_model_operation_client(mut self, client: Arc<dyn OperationClient>) -> Self {
        self.model_operation_client = Some(client);
        self
    }

    /// Installs the opt-in capability-bearing Web Search extension.
    ///
    /// Without an injected backend the `web_search` tool is absent. The backend's network and
    /// credential scopes are still reviewed by the ordinary extension policy before each call.
    pub fn with_web_search_backend(
        mut self,
        backend: Arc<dyn ash_web_search_extension::WebSearchBackend>,
    ) -> Self {
        self.web_search_backend = Some(backend);
        self
    }

    /// Installs product/plugin Connector authority, secret storage, and MCP materialization.
    pub fn with_connector_runtime(mut self, runtime: LocalConnectorRuntime) -> Self {
        self.connector_runtime = Some(runtime);
        self
    }

    /// Installs exact OAuth wire adapters for standalone MCP server declarations.
    pub fn with_mcp_oauth_providers(
        mut self,
        providers: impl IntoIterator<Item = (McpServerId, Arc<dyn McpOAuthProvider>)>,
    ) -> Self {
        self.mcp_oauth_providers = providers.into_iter().collect();
        self
    }

    /// Projects one immutable Plugin activation into durable Connector authority and MCP runtime.
    pub fn with_plugin_activation(
        self,
        activation: &PluginActivationSnapshot,
        secrets: Arc<dyn SecretStore>,
    ) -> Result<Self, OpenAppServerError> {
        let state = ash_state::StateRuntime::open(&self.profile_root).map_err(open_error)?;
        let runtime = LocalConnectorRuntime::from_plugin_activation(&state, activation, secrets)?;
        Ok(self.with_connector_runtime(runtime))
    }

    /// Installs a live Plugin authority whose generations drive Connector and MCP replacement.
    pub fn with_plugin_authority(
        self,
        authority: PluginActivationAuthority,
        secrets: Arc<dyn SecretStore>,
    ) -> Result<Self, OpenAppServerError> {
        let state = ash_state::StateRuntime::open(&self.profile_root).map_err(open_error)?;
        let runtime = LocalConnectorRuntime::from_plugin_authority(&state, authority, secrets)?;
        Ok(self.with_connector_runtime(runtime))
    }

    /// Installs a Plugin package service when no local Plugins Manager is available.
    pub fn with_plugin_package_service(
        mut self,
        service: Arc<dyn ash_core_plugins::PluginPackageService>,
    ) -> Self {
        self.plugins_manager = None;
        self.plugin_package_service = Some(service);
        self
    }

    /// Composes one profile-owned manager with explicitly named source providers.
    pub fn with_plugin_providers(
        self,
        providers: ash_core_plugins::PluginProviders,
    ) -> Result<Self, OpenAppServerError> {
        let manager = Arc::new(
            ash_core_plugins::PluginsManager::open(
                self.profile_root.join("marketplace-manager"),
                providers,
            )
            .map_err(|error| OpenAppServerError(error.to_string()))?,
        );
        let client: Arc<dyn ash_core_plugins::PluginPackageService> = manager.clone();
        Ok(Self {
            plugin_package_service: Some(client),
            plugins_manager: Some(manager),
            ..self
        })
    }

    /// Installs exact, already materialized language-server providers for this App Server.
    pub fn with_language_server_providers(
        mut self,
        providers: ash_lsp_server_provider::LspServerProviders,
    ) -> Self {
        self.language_server_providers = providers;
        self
    }

    /// Installs distribution-pinned Marketplace roots and public OAuth product adapters.
    pub fn with_product_services(mut self, services: crate::LocalProductServicesConfig) -> Self {
        self.product_services = Some(services);
        self
    }
}

impl fmt::Debug for LocalAppServerOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("LocalAppServerOptions")
            .field(
                "execution_environments",
                &self
                    .execution_environments
                    .iter()
                    .map(|environment| environment.info())
                    .collect::<Vec<_>>(),
            )
            .field("profile_root", &self.profile_root)
            .field("codex_home", &self.codex_home)
            .field("dir_config", &self.dir_config)
            .field("slash_commands", &self.slash_commands)
            .field("dir_root", &self.dir_root)
            .field("initial_dir_permissions", &self.initial_dir_permissions)
            .field("built_in_skills", &self.built_in_skills)
            .field("session_state_mode", &self.session_state_mode)
            .field(
                "agent_model_service_injected",
                &self.agent_model_service.is_some(),
            )
            .field(
                "model_operation_client_injected",
                &self.model_operation_client.is_some(),
            )
            .field(
                "web_search_backend_injected",
                &self.web_search_backend.is_some(),
            )
            .field(
                "connector_runtime_injected",
                &self.connector_runtime.is_some(),
            )
            .field(
                "image_generation_backend_injected",
                &self.image_generation_backend.is_some(),
            )
            .field("git_attribution_injected", &self.git_attribution.is_some())
            .field("mcp_oauth_provider_count", &self.mcp_oauth_providers.len())
            .field(
                "plugin_package_service_injected",
                &self.plugin_package_service.is_some(),
            )
            .field("plugins_manager_injected", &self.plugins_manager.is_some())
            .field(
                "language_server_provider_count",
                &self.language_server_providers.len(),
            )
            .field(
                "product_services_injected",
                &self.product_services.is_some(),
            )
            .field(
                "fast_regex_worker_injected",
                &self.fast_regex_worker_command.is_some(),
            )
            .finish()
    }
}

impl PartialEq for LocalAppServerOptions {
    fn eq(&self, other: &Self) -> bool {
        self.execution_environments
            .iter()
            .map(|env| env.info())
            .eq(other.execution_environments.iter().map(|env| env.info()))
            && self.profile_root == other.profile_root
            && self.codex_home == other.codex_home
            && self.dir_config == other.dir_config
            && self.slash_commands == other.slash_commands
            && self.dir_root == other.dir_root
            && self.initial_dir_permissions == other.initial_dir_permissions
            && self.built_in_skills == other.built_in_skills
            && self.session_state_mode == other.session_state_mode
            && match (&self.agent_model_service, &other.agent_model_service) {
                (Some(left), Some(right)) => Arc::ptr_eq(left, right),
                (None, None) => true,
                _ => false,
            }
            && match (&self.model_operation_client, &other.model_operation_client) {
                (Some(left), Some(right)) => Arc::ptr_eq(left, right),
                (None, None) => true,
                _ => false,
            }
            && match (&self.web_search_backend, &other.web_search_backend) {
                (Some(left), Some(right)) => Arc::ptr_eq(left, right),
                (None, None) => true,
                _ => false,
            }
            && match (
                &self.image_generation_backend,
                &other.image_generation_backend,
            ) {
                (Some(a), Some(b)) => Arc::ptr_eq(a, b),
                (None, None) => true,
                _ => false,
            }
            && match (&self.git_attribution, &other.git_attribution) {
                (Some(a), Some(b)) => Arc::ptr_eq(a, b),
                (None, None) => true,
                _ => false,
            }
            && match (&self.connector_runtime, &other.connector_runtime) {
                (Some(left), Some(right)) => left.ptr_eq(right),
                (None, None) => true,
                _ => false,
            }
            && self.mcp_oauth_providers.len() == other.mcp_oauth_providers.len()
            && self
                .mcp_oauth_providers
                .iter()
                .zip(&other.mcp_oauth_providers)
                .all(|((left_id, left), (right_id, right))| {
                    left_id == right_id && Arc::ptr_eq(left, right)
                })
            && match (&self.plugin_package_service, &other.plugin_package_service) {
                (Some(left), Some(right)) => Arc::ptr_eq(left, right),
                (None, None) => true,
                _ => false,
            }
            && match (&self.plugins_manager, &other.plugins_manager) {
                (Some(left), Some(right)) => Arc::ptr_eq(left, right),
                (None, None) => true,
                _ => false,
            }
            && self
                .language_server_providers
                .ptr_eq(&other.language_server_providers)
            && self.product_services == other.product_services
            && self.fast_regex_worker_command == other.fast_regex_worker_command
            && self.pty_helper == other.pty_helper
    }
}

impl Eq for LocalAppServerOptions {}

/// Host-provided Connector runtime ports used by the local App Server composition root.
#[derive(Clone)]
pub struct LocalConnectorRuntime {
    service: Arc<connectors::ConnectorCredentialService>,
    secrets: Arc<dyn SecretStore>,
    mcp: Arc<dyn ConnectorMcpRuntimeProvider>,
    base_definitions: Vec<connectors::ConnectorDefinition>,
    base_mcp: Arc<dyn ConnectorMcpRuntimeProvider>,
    plugin_authority: Option<PluginActivationAuthority>,
    plugins_manager: Option<Arc<ash_core_plugins::PluginsManager>>,
    oauth: Option<Arc<connectors::ConnectorOAuthService>>,
    device_oauth: Option<Arc<connectors::ConnectorDeviceOAuthService>>,
}

impl LocalConnectorRuntime {
    pub fn new(
        service: Arc<connectors::ConnectorCredentialService>,
        secrets: Arc<dyn SecretStore>,
        mcp: Arc<dyn ConnectorMcpRuntimeProvider>,
    ) -> Self {
        let base_definitions = service
            .authority()
            .snapshot()
            .entries()
            .iter()
            .map(|entry| entry.definition().clone())
            .collect();
        Self {
            service,
            secrets,
            mcp: Arc::clone(&mcp),
            base_definitions,
            base_mcp: mcp,
            plugin_authority: None,
            plugins_manager: None,
            oauth: None,
            device_oauth: None,
        }
    }

    /// Installs concrete provider adapters while keeping PKCE and credentials in the shared runtime.
    pub fn with_oauth_providers(
        mut self,
        providers: impl IntoIterator<
            Item = (
                connectors::ConnectorId,
                Arc<dyn connectors::ConnectorOAuthProvider>,
            ),
        >,
    ) -> Self {
        self.oauth = Some(Arc::new(connectors::ConnectorOAuthService::new(
            Arc::clone(&self.service),
            providers,
        )));
        self
    }

    /// Installs public-client device adapters over the canonical Connector authority.
    pub fn with_device_oauth_providers(
        mut self,
        providers: impl IntoIterator<
            Item = (
                connectors::ConnectorId,
                Arc<dyn connectors::ConnectorDeviceOAuthProvider>,
            ),
        >,
    ) -> Self {
        self.device_oauth = Some(Arc::new(connectors::ConnectorDeviceOAuthService::new(
            Arc::clone(&self.service),
            providers,
        )));
        self
    }

    /// Builds the canonical local Connector runtime from an exact Plugin activation snapshot.
    pub fn from_plugin_activation(
        state: &ash_state::StateRuntime,
        activation: &PluginActivationSnapshot,
        secrets: Arc<dyn SecretStore>,
    ) -> Result<Self, OpenAppServerError> {
        let catalog = connectors::ConnectorCatalog::from_activation(activation)
            .map_err(|error| OpenAppServerError(error.to_string()))?;
        let authority = connectors::ConnectorAuthority::open_sqlite(
            state.connectors_database_path(),
            catalog
                .snapshot()
                .entries()
                .iter()
                .map(|entry| entry.definition().clone()),
        )
        .map_err(|error| OpenAppServerError(error.to_string()))?;
        let mcp = PluginConnectorMcpRuntimeProvider::from_activation(activation)
            .map_err(|error| OpenAppServerError(error.to_string()))?;
        let service = Arc::new(connectors::ConnectorCredentialService::new(
            authority,
            Arc::clone(&secrets),
        ));
        Ok(Self::new(service, secrets, Arc::new(mcp)))
    }

    /// Builds a reloadable Connector/MCP projection from one live Plugin authority.
    pub fn from_plugin_authority(
        state: &ash_state::StateRuntime,
        plugin_authority: PluginActivationAuthority,
        secrets: Arc<dyn SecretStore>,
    ) -> Result<Self, OpenAppServerError> {
        let snapshot = plugin_authority.snapshot();
        let catalog = connectors::ConnectorCatalog::from_activation(snapshot.activation())
            .map_err(|error| OpenAppServerError(error.to_string()))?;
        let authority = connectors::ConnectorAuthority::open_sqlite(
            state.connectors_database_path(),
            catalog
                .snapshot()
                .entries()
                .iter()
                .map(|entry| entry.definition().clone()),
        )
        .map_err(|error| OpenAppServerError(error.to_string()))?;
        let mcp: Arc<dyn ConnectorMcpRuntimeProvider> = Arc::new(
            PluginConnectorMcpRuntimeProvider::from_authority(&plugin_authority)
                .map_err(|error| OpenAppServerError(error.to_string()))?,
        );
        let service = Arc::new(connectors::ConnectorCredentialService::new(
            authority,
            Arc::clone(&secrets),
        ));
        Ok(Self {
            service,
            secrets,
            mcp: Arc::clone(&mcp),
            base_definitions: catalog
                .snapshot()
                .entries()
                .iter()
                .map(|entry| entry.definition().clone())
                .collect(),
            base_mcp: mcp,
            plugin_authority: Some(plugin_authority),
            plugins_manager: None,
            oauth: None,
            device_oauth: None,
        })
    }

    fn bind_plugins_manager(
        &mut self,
        manager: Arc<ash_core_plugins::PluginsManager>,
    ) -> Result<(), OpenAppServerError> {
        self.plugins_manager = Some(manager);
        self.reconcile_sources()
    }

    fn reconcile_plugin_activation(&mut self) -> Result<(), OpenAppServerError> {
        let Some(authority) = &self.plugin_authority else {
            return Ok(());
        };
        let snapshot = authority.snapshot();
        let catalog = connectors::ConnectorCatalog::from_activation(snapshot.activation())
            .map_err(|error| OpenAppServerError(error.to_string()))?;
        let mcp = PluginConnectorMcpRuntimeProvider::from_authority(authority)
            .map_err(|error| OpenAppServerError(error.to_string()))?;
        self.base_definitions = catalog
            .snapshot()
            .entries()
            .iter()
            .map(|entry| entry.definition().clone())
            .collect();
        self.base_mcp = Arc::new(mcp);
        self.reconcile_sources()
    }

    fn reconcile_marketplace(&mut self) -> Result<(), OpenAppServerError> {
        self.reconcile_sources()
    }

    fn reconcile_sources(&mut self) -> Result<(), OpenAppServerError> {
        let mut definitions = self.base_definitions.clone();
        self.mcp = Arc::clone(&self.base_mcp);
        if let Some(manager) = &self.plugins_manager {
            let catalog =
                ash_mcp_extension::MarketplaceConnectorCatalog::from_manager(Arc::clone(manager))
                    .map_err(OpenAppServerError)?;
            definitions.extend(catalog.definitions().iter().cloned());
            self.mcp = ash_mcp_extension::combined_provider(
                Arc::clone(&self.base_mcp),
                catalog.provider(),
            );
        }
        self.service
            .authority()
            .reconcile_definitions(definitions)
            .map(|_| ())
            .map_err(|error| OpenAppServerError(error.to_string()))
    }

    fn ptr_eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.service, &other.service)
            && Arc::ptr_eq(&self.secrets, &other.secrets)
            && Arc::ptr_eq(&self.mcp, &other.mcp)
    }
}

/// Selects the lifecycle of Session and Thread state in a local App Server.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum SessionStateMode {
    /// Recover and append Session and Thread event history in profile SQLite storage.
    #[default]
    Durable,
    /// Keep Session and Thread state in memory for this App Server process only.
    Ephemeral,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BuiltInSkillRoot {
    AutoDetect,
    Explicit(PathBuf),
    Unavailable,
}

/// Read-only directory configuration source used by one local App Server composition root.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LocalDirConfigOptions {
    pub config_path: PathBuf,
    pub dir_id: DirId,
}

impl LocalDirConfigOptions {
    pub fn new(config_path: impl Into<PathBuf>, dir_id: DirId) -> Self {
        Self {
            config_path: config_path.into(),
            dir_id,
        }
    }
}

/// Failure to compose or recover a persistent local App Server.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OpenAppServerError(pub String);

impl fmt::Display for OpenAppServerError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for OpenAppServerError {}

/// Process-wide durable authority shared by all Directory runtimes for one profile.
///
/// The profile runtime owns the single recovered Session projection, config store, secret store,
/// Marketplace Manager/change watcher, and live profile notification graph. Directory filesystem,
/// terminal, Git, language, and execution services remain in separately composed [`AppServer`]
/// instances.
pub struct LocalProfileRuntime {
    diagnostics: diagnostics::Diagnostics,
    telemetry: ash_otel::Telemetry,
    analytics: Arc<analytics::Analytics>,
    queue: Arc<queue::QueueStore>,
    automation: Arc<ash_automation::AutomationStore>,
    profile_root: PathBuf,
    state: Arc<ash_state::StateRuntime>,
    threads: Arc<ThreadController>,
    config: Arc<ConfigStore>,
    secrets: Arc<dyn SecretStore>,
    updates: Arc<UpdateBroker>,
    update_scopes: Mutex<BTreeMap<ProfileUpdateScopeKey, Arc<UpdateBroker>>>,
    marketplace: Mutex<Option<ProfileMarketplaceAuthority>>,
}

struct ProfileMarketplaceAuthority {
    config: BTreeMap<ash_plugin::MarketplaceName, ash_core_plugins::RemoteMarketplaceConfig>,
    manager: Arc<ash_core_plugins::PluginsManager>,
    _watcher: Option<crate::server::marketplace_runtime::MarketplaceChangeWatcher>,
}

#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
struct ProfileUpdateScopeKey {
    dir_id: Option<ash_file_access::DirId>,
    path: Option<PathBuf>,
}

impl From<Option<ash_file_access::DirBinding>> for ProfileUpdateScopeKey {
    fn from(dir: Option<ash_file_access::DirBinding>) -> Self {
        match dir {
            Some(dir) => Self {
                dir_id: Some(dir.id),
                path: Some(dir.path),
            },
            None => Self {
                dir_id: None,
                path: None,
            },
        }
    }
}

impl LocalProfileRuntime {
    /// Opens and recovers one durable profile authority.
    pub fn open(profile_root: impl Into<PathBuf>) -> Result<Self, OpenAppServerError> {
        let requested_root = profile_root.into();
        std::fs::create_dir_all(&requested_root).map_err(open_error)?;
        let profile_root = std::fs::canonicalize(&requested_root).map_err(open_error)?;
        let state = Arc::new(ash_state::StateRuntime::open(&profile_root).map_err(open_error)?);
        let image_attachments = open_image_attachments(state.profile_root())?;
        let repository = LocalStateRepository::open(&state).map_err(open_error)?;
        let database_path = state.database_path().to_path_buf();
        let threads = repository
            .recover_threads_with_image_attachments(image_attachments)
            .map_err(open_error)?;
        let config = Arc::new(
            ConfigStore::open_with_paths(database_path.clone(), profile_root.join("config.toml"))
                .map_err(|error| OpenAppServerError(error.0))?,
        );
        threads
            .install_time_context_provider(Arc::new(crate::time_context::ConfigTimeContext::new(
                config.clone(),
            )))
            .map_err(open_error)?;
        let secrets: Arc<dyn SecretStore> = Arc::new(
            FileSecretStore::open(profile_root.join("secrets"))
                .map_err(|error| OpenAppServerError(error.to_string()))?,
        );
        let diagnostics = diagnostics::Diagnostics::default();
        let telemetry = ash_otel::Telemetry::new(diagnostics.clone());
        Ok(Self {
            diagnostics,
            telemetry,
            analytics: Arc::new(analytics::Analytics::default()),
            profile_root,
            automation: Arc::new(
                ash_automation::AutomationStore::open(&database_path).map_err(open_error)?,
            ),
            queue: Arc::new(queue::QueueStore::open(&database_path).map_err(open_error)?),
            state,
            threads,
            config,
            secrets,
            updates: Arc::new(UpdateBroker::default()),
            update_scopes: Mutex::new(BTreeMap::new()),
            marketplace: Mutex::new(None),
        })
    }

    /// Returns the one secret store used by every Directory runtime in this profile authority.
    pub fn secret_store(&self) -> Arc<dyn SecretStore> {
        Arc::clone(&self.secrets)
    }

    /// Shared plan and run store; the profile host owns its single scheduling loop.
    pub fn queue_store(&self) -> Result<Arc<queue::QueueStore>, OpenAppServerError> {
        Ok(self.queue.clone())
    }

    pub fn queue_changed(&self) {
        self.updates.publish_queue_changed();
    }

    pub fn automation_store(&self) -> Arc<ash_automation::AutomationStore> {
        Arc::clone(&self.automation)
    }

    /// Invalidates automation views across all directory connections in this profile.
    pub fn automation_changed(&self) {
        self.updates.publish_automation_changed();
    }

    fn state_runtime(&self) -> Arc<ash_state::StateRuntime> {
        Arc::clone(&self.state)
    }

    /// Explicitly clears all rebuildable local indexes for one inactive Directory.
    pub fn clear_dir_indexes(
        &self,
        dir: &ash_file_access::DirId,
    ) -> std::io::Result<ash_state::ClearOutcome> {
        self.state.clear_dir(dir)
    }

    /// Explicitly clears every rebuildable local Directory index in this profile.
    pub fn clear_all_dir_indexes(&self) -> std::io::Result<ash_state::ClearOutcome> {
        self.state.clear_all()
    }

    fn scoped_updates(
        &self,
        dir: Option<ash_file_access::DirBinding>,
    ) -> Result<Arc<UpdateBroker>, OpenAppServerError> {
        let key = ProfileUpdateScopeKey::from(dir);
        let mut scopes = self
            .update_scopes
            .lock()
            .map_err(|_| OpenAppServerError("profile update-scope lock poisoned".into()))?;
        Ok(Arc::clone(
            scopes
                .entry(key)
                .or_insert_with(|| Arc::new(self.updates.fork_scope())),
        ))
    }

    fn plugins_manager(
        &self,
        config: BTreeMap<ash_plugin::MarketplaceName, ash_core_plugins::RemoteMarketplaceConfig>,
    ) -> Result<Arc<ash_core_plugins::PluginsManager>, OpenAppServerError> {
        let mut marketplace = self
            .marketplace
            .lock()
            .map_err(|_| OpenAppServerError("profile Marketplace lock poisoned".into()))?;
        if let Some(authority) = marketplace.as_ref() {
            if authority.config == config {
                return Ok(Arc::clone(&authority.manager));
            }
            return Err(OpenAppServerError(
                "one profile runtime cannot use multiple Marketplace authorities".into(),
            ));
        }
        let providers = marketplace_providers(&config)?;
        let manager = Arc::new(
            ash_core_plugins::PluginsManager::open(
                self.profile_root.join("marketplace-manager"),
                providers,
            )
            .map_err(|error| OpenAppServerError(error.to_string()))?,
        );
        let watcher = crate::server::marketplace_runtime::MarketplaceChangeWatcher::start(
            &manager,
            Arc::clone(&self.updates),
        );
        *marketplace = Some(ProfileMarketplaceAuthority {
            config,
            manager: Arc::clone(&manager),
            _watcher: watcher,
        });
        Ok(manager)
    }
}

/// Optional codebase adapters installed before the local Directory runtime is activated.
#[derive(Default)]
pub struct LocalCodebaseProviders {
    models: Option<CodebaseModels>,
    cloud: CloudCodebaseProviderRegistry,
}

impl LocalCodebaseProviders {
    pub fn new() -> Self {
        Self::default()
    }

    /// Installs optional device-side models used by Codebase and Tool Search.
    pub fn with_models(mut self, models: CodebaseModels) -> Self {
        self.models = Some(models);
        self
    }

    /// Installs optional remote codebase provider adapters.
    pub fn with_cloud(mut self, cloud: CloudCodebaseProviderRegistry) -> Self {
        self.cloud = cloud;
        self
    }
}

/// Opens the authoritative local composition root used by in-process and stdio clients.
pub fn open_local_app_server(
    options: LocalAppServerOptions,
) -> Result<AppServer, OpenAppServerError> {
    open_local_app_server_with_codebase_providers(options, LocalCodebaseProviders::default())
}

/// Opens a local composition with explicit cloud codebase provider adapters.
pub fn open_local_app_server_with_cloud_providers(
    options: LocalAppServerOptions,
    cloud_codebase_providers: CloudCodebaseProviderRegistry,
) -> Result<AppServer, OpenAppServerError> {
    open_local_app_server_with_codebase_providers(
        options,
        LocalCodebaseProviders::new().with_cloud(cloud_codebase_providers),
    )
}

/// Opens a local composition with semantic model and/or remote index provider adapters.
pub fn open_local_app_server_with_codebase_providers(
    mut options: LocalAppServerOptions,
    providers: LocalCodebaseProviders,
) -> Result<AppServer, OpenAppServerError> {
    let product_services = options.product_services.take();
    let fast_regex_worker_command = options.fast_regex_worker_command.take();
    let pty_helper = options.pty_helper.take();
    if options.plugin_package_service.is_none()
        && let Some(sources) = product_services
            .as_ref()
            .map(crate::LocalProductServicesConfig::marketplaces)
            .cloned()
    {
        if let Some(runtime) = &options.profile_runtime {
            let manager = runtime.plugins_manager(sources)?;
            let client: Arc<dyn ash_core_plugins::PluginPackageService> = manager.clone();
            options.plugin_package_service = Some(client);
            options.plugins_manager = Some(manager);
        } else {
            options = options.with_plugin_providers(marketplace_providers(&sources)?)?;
        }
    }
    let plugin_package_service = options.plugin_package_service.take();
    let plugins_manager = options.plugins_manager.take();
    let mcp_oauth_providers = std::mem::take(&mut options.mcp_oauth_providers);
    let profile_runtime = options.profile_runtime.take();
    if profile_runtime.is_some() && options.session_state_mode != SessionStateMode::Durable {
        return Err(OpenAppServerError(
            "a shared profile runtime requires durable Session state".into(),
        ));
    }
    if let Some(runtime) = &profile_runtime {
        let requested_root = std::fs::canonicalize(&options.profile_root).map_err(open_error)?;
        if requested_root != runtime.profile_root {
            return Err(OpenAppServerError(
                "shared profile runtime does not match the requested profile root".into(),
            ));
        }
    }
    let state_runtime = match &profile_runtime {
        Some(runtime) => runtime.state_runtime(),
        None => Arc::new(ash_state::StateRuntime::open(&options.profile_root).map_err(open_error)?),
    };
    let (database_path, threads, config) = match (&profile_runtime, options.session_state_mode) {
        (Some(runtime), SessionStateMode::Durable) => (
            runtime.state.database_path().to_path_buf(),
            Arc::clone(&runtime.threads),
            Arc::clone(&runtime.config),
        ),
        (Some(_), SessionStateMode::Ephemeral) => unreachable!("validated above"),
        (None, SessionStateMode::Durable) => {
            let image_attachments = open_image_attachments(&options.profile_root)?;
            let repository = LocalStateRepository::open(&state_runtime).map_err(open_error)?;
            let database_path = state_runtime.database_path().to_path_buf();
            let threads = repository
                .recover_threads_with_image_attachments(image_attachments)
                .map_err(open_error)?;
            let config = Arc::new(
                ConfigStore::open_with_paths(
                    database_path.clone(),
                    options.profile_root.join("config.toml"),
                )
                .map_err(|error| OpenAppServerError(error.0))?,
            );
            (database_path, threads, config)
        }
        (None, SessionStateMode::Ephemeral) => {
            let image_attachments = open_image_attachments(&options.profile_root)?;
            let threads = Arc::new(ThreadController::with_store_and_image_attachments(
                Arc::new(InMemoryThreadStore::default()),
                image_attachments,
            ));
            let database_path = state_runtime.database_path().to_path_buf();
            let config = Arc::new(
                ConfigStore::open_with_paths(
                    database_path.clone(),
                    options.profile_root.join("config.toml"),
                )
                .map_err(|error| OpenAppServerError(error.0))?,
            );
            (database_path, threads, config)
        }
    };
    if profile_runtime.is_none() {
        threads
            .install_time_context_provider(Arc::new(crate::time_context::ConfigTimeContext::new(
                config.clone(),
            )))
            .map_err(open_error)?;
    }
    let user_config = config
        .read_snapshot()
        .map_err(|error| OpenAppServerError(error.0))?;
    if options.dir_config.is_none()
        && let Some(dir_root) = &options.dir_root
    {
        let load_dir_config = match options.initial_dir_permissions {
            InitialDirPermissions::HostConfiguration => true,
            InitialDirPermissions::UserConfig => {
                let dir = Dir::open_local(dir_root).map_err(open_error)?;
                user_config
                    .values
                    .dir_permissions
                    .permissions_for(&dir.id())
                    .allows(DirPermission::LoadConfig)
            }
        };
        if load_dir_config {
            options.dir_config = Some(default_dir_config(dir_root)?);
        }
    }
    let profile_secrets = match (&profile_runtime, options.connector_runtime.as_ref()) {
        (Some(runtime), Some(connectors)) => {
            if !Arc::ptr_eq(&runtime.secrets, &connectors.secrets) {
                return Err(OpenAppServerError(
                    "shared profile runtime and Connector runtime use different SecretStore authorities"
                        .into(),
                ));
            }
            Arc::clone(&runtime.secrets)
        }
        (Some(runtime), None) => Arc::clone(&runtime.secrets),
        (None, Some(connectors)) => Arc::clone(&connectors.secrets),
        (None, None) => Arc::new(
            FileSecretStore::open(options.profile_root.join("secrets"))
                .map_err(|error| OpenAppServerError(error.to_string()))?,
        ),
    };
    let mut connector_runtime = match options.connector_runtime.take() {
        Some(runtime) => Some(runtime),
        None => {
            let plugin_authority =
                PluginActivationAuthority::open(options.profile_root.join("plugins"))
                    .map_err(|error| OpenAppServerError(error.to_string()))?;
            Some(LocalConnectorRuntime::from_plugin_authority(
                &state_runtime,
                plugin_authority,
                Arc::clone(&profile_secrets),
            )?)
        }
    };
    if let (Some(runtime), Some(manager)) = (&mut connector_runtime, &plugins_manager) {
        runtime.bind_plugins_manager(Arc::clone(manager))?;
    }
    let managed_node = ManagedNodeRuntime::from_install_context(&InstallContext::current()).ok();
    let marketplace_language_runtime = plugins_manager.as_ref().map(|manager| {
        crate::server::marketplace_language_runtime::MarketplaceLanguageRuntime::new(
            Arc::clone(manager),
            managed_node,
            options.language_server_providers.clone(),
        )
    });
    if let Some(runtime) = &marketplace_language_runtime {
        options.language_server_providers = runtime.providers().map_err(OpenAppServerError)?;
    }
    if let Some(services) = &product_services {
        if let Some(image) = &services.image_generation {
            if options.image_generation_backend.is_some() {
                return Err(OpenAppServerError(
                    "image backend is configured twice".into(),
                ));
            }
            let mut headers = Vec::new();
            if let Some(reference) = &image.credential_reference {
                let key = ash_secrets::SecretKey::new(reference).map_err(open_error)?;
                let secret = profile_secrets
                    .load(&key)
                    .map_err(open_error)?
                    .ok_or_else(|| {
                        OpenAppServerError("configured image service credential is missing".into())
                    })?;
                let token = std::str::from_utf8(secret.expose()).map_err(|_| {
                    OpenAppServerError("image service credential must be UTF-8".into())
                })?;
                if token.is_empty() || token.chars().any(char::is_control) {
                    return Err(OpenAppServerError(
                        "image service credential is invalid".into(),
                    ));
                }
                headers.push(ash_http_client::HttpHeader::new(
                    "authorization",
                    format!("Bearer {token}"),
                ));
            }
            let http = Arc::new(ash_http_client::UreqHttpClient::new().map_err(open_error)?);
            let client = Arc::new(ash_client::AshClient::new(http));
            options.image_generation_backend = Some(Arc::new(
                image_generation::JsonImageGenerationBackend::new(
                    image.service_name.clone(),
                    image.endpoint.clone(),
                    image.credential_reference.clone(),
                    headers,
                    client,
                )
                .map_err(OpenAppServerError)?,
            ));
        }
        if let Some(policy) = &services.git_attribution {
            if options.git_attribution.is_some() {
                return Err(OpenAppServerError(
                    "Git attribution is configured twice".into(),
                ));
            }
            options.git_attribution = Some(Arc::new(policy.policy()));
        }
    }
    if let (Some(runtime), Some(services)) = (&mut connector_runtime, product_services) {
        configure_product_connector_oauth(runtime, services.connector_oauth)?;
    }
    let dir_config = options.dir_config.map(|dir_config| {
        Arc::new(DirConfigTracker::new(DirConfigStore::open(
            dir_config.config_path,
            DirConfigScope::new(dir_config.dir_id),
        )))
    });
    if let Some(dir_config) = &dir_config {
        dir_config
            .read()
            .map_err(|error| OpenAppServerError(error.0))?;
    }
    let tokenizer_downloader = Arc::new(HttpTokenizerAssetDownloader::production());
    let local_tokenizers = Arc::new(
        ManagedLocalTokenizerService::new(
            options.profile_root.join("cache/model-tokenizers"),
            TokenizerAssetCatalog::new(),
            tokenizer_downloader.clone(),
            MemoryTokenizerCapacity::default(),
        )
        .map(|service| {
            service.with_discoverer(Arc::new(HuggingFaceTokenizerAssetDiscoverer::new(
                tokenizer_downloader,
            )))
        })
        .map_err(|error| OpenAppServerError(error.to_string()))?,
    );
    let provider_configs = ProviderConfigRegistry::builtin();
    let (diagnostics, telemetry, analytics) = match &profile_runtime {
        Some(runtime) => (
            runtime.diagnostics.clone(),
            runtime.telemetry.clone(),
            runtime.analytics.clone(),
        ),
        None => {
            let diagnostics = diagnostics::Diagnostics::default();
            let telemetry = ash_otel::Telemetry::new(diagnostics.clone());
            (
                diagnostics,
                telemetry,
                Arc::new(analytics::Analytics::default()),
            )
        }
    };
    let model_client = match options.model_operation_client.take() {
        Some(client) => client,
        None => {
            let http = ash_http_client::UreqHttpClient::new().map_err(open_error)?;
            Arc::new(ash_client::AshClient::new(
                telemetry.instrument_http(Arc::new(http)),
            ))
        }
    };
    let model_operation_client = Some(model_client);
    let codex_home = match options.codex_home.take() {
        Some(home) => home,
        None => ash_chatgpt::codex_home().map_err(|error| OpenAppServerError(error.to_string()))?,
    };
    let chatgpt_oauth = match &model_operation_client {
        Some(client) => ChatGptOAuth::with_client(
            codex_home,
            Arc::clone(&profile_secrets),
            Arc::clone(client),
            ash_chatgpt::ChatGptAuthManagement::Automatic,
        ),
        None => ChatGptOAuth::production(codex_home, Arc::clone(&profile_secrets))
            .map_err(|error| OpenAppServerError(error.to_string()))?,
    };
    let kimi_oauth = match &model_operation_client {
        Some(client) => KimiOAuth::with_client(Arc::clone(&profile_secrets), Arc::clone(client)),
        None => KimiOAuth::production(Arc::clone(&profile_secrets))
            .map_err(|error| OpenAppServerError(error.to_string()))?,
    };
    let model_provider = match model_operation_client {
        Some(client) => ModelProviderRuntime::with_client_and_secrets(
            provider_configs.clone(),
            telemetry.instrument_model(client),
            Arc::clone(&profile_secrets),
        ),
        None => ModelProviderRuntime::with_secrets(
            provider_configs.clone(),
            Arc::clone(&profile_secrets),
        ),
    }
    .with_local_tokenizers(local_tokenizers)
    .with_chatgpt_oauth(Arc::clone(&chatgpt_oauth))
    .with_kimi_oauth(Arc::clone(&kimi_oauth));
    let models_manager = model_provider.models_manager();
    let model_provider = Arc::new(model_provider);
    let catalog_runtime = Arc::new(
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(1)
            .thread_name("ash-model-catalog")
            .build()
            .map_err(|error| OpenAppServerError(error.to_string()))?,
    );
    let configured_model = Arc::new(ConfigBackedModelService {
        config: config.clone(),
        dir_config: dir_config.clone(),
        provider_configs: provider_configs.clone(),
        models_manager,
        catalog_provider: model_provider.clone(),
        catalog_runtime,
        resolver: Arc::new(ModelProviderSnapshotResolver {
            model_provider: model_provider.clone(),
        }),
    });
    let runtime_config = configured_model
        .resolve_config(&user_config)
        .map_err(|error| OpenAppServerError(error.to_string()))?;
    let approval_model_provider: Arc<dyn ModelProvider> = model_provider.clone();
    let approval_review_model =
        crate::ReviewModelResolver::new(provider_configs.clone(), approval_model_provider)
            .resolve(&runtime_config)
            .ok();
    let skill_config = Arc::new(LocalSkillConfigProvider {
        config: Arc::clone(&config),
    });
    let built_in_skill_root = resolve_built_in_skill_root(options.built_in_skills);
    let extension_roots = resolve_extension_roots(&options.profile_root);
    let login_drivers: Vec<Arc<dyn InteractiveLoginDriver>> =
        vec![chatgpt_oauth.clone(), kimi_oauth.clone()];
    let login_service = Arc::new(
        LoginService::deferred_with_drivers(login_drivers)
            .map_err(|error| OpenAppServerError(error.to_string()))?,
    );
    chatgpt_oauth
        .install_login_service(&login_service)
        .map_err(|error| OpenAppServerError(error.to_string()))?;
    kimi_oauth
        .install_login_service(&login_service)
        .map_err(|error| OpenAppServerError(error.to_string()))?;
    let direct_catalog: Arc<dyn ModelCatalog> = configured_model.clone();
    let agent_model: Arc<dyn ModelService> = options
        .agent_model_service
        .take()
        .unwrap_or_else(|| configured_model.clone());
    let update_dir = if dir_config.is_some() {
        options
            .dir_root
            .as_deref()
            .map(Dir::open_local)
            .transpose()
            .map_err(open_error)?
            .as_ref()
            .map(ash_file_access::DirBinding::from_dir)
    } else {
        None
    };
    let cloud_codebase_root = state_runtime.cloud_codebase_root().to_path_buf();
    let home = Arc::new(ash_home::AshHome::new(
        ash_utils_absolute_path::AbsolutePathBuf::from_absolute(state_runtime.profile_root())
            .map_err(open_error)?,
    ));
    let state_runtime = Arc::clone(&state_runtime);
    let mut server = match &profile_runtime {
        Some(runtime) => AppServer::new_with_updates(
            threads,
            agent_model.clone(),
            runtime.scoped_updates(update_dir)?,
        ),
        None => AppServer::new(threads, agent_model),
    }
    .with_home(home)
    .with_telemetry(diagnostics, telemetry, analytics)
    .with_model_catalog(direct_catalog)
    .with_provider_credentials(Arc::new(
        ash_model_provider::ProviderCredentialService::new(
            provider_configs.clone(),
            Arc::clone(&profile_secrets),
        ),
    ))
    .with_approval_review_model(approval_review_model)
    .with_config_store(Arc::clone(&config))
    .with_login_service(login_service)
    .with_language_server_providers(options.language_server_providers)
    .with_slash_command_catalog(options.slash_commands)
    .with_state_runtime(state_runtime)
    .with_provider_runtime(model_provider.clone())
    .with_semantic_model_provider(model_provider)
    .with_cloud_codebase_storage_root(cloud_codebase_root)
    .with_cloud_codebase_providers(providers.cloud)
    .with_extension_roots(extension_roots);
    if options.session_state_mode == SessionStateMode::Durable {
        let directory = options
            .dir_root
            .as_ref()
            .map(std::fs::canonicalize)
            .transpose()
            .map_err(open_error)?
            .map(|directory| {
                directory
                    .into_os_string()
                    .into_string()
                    .map_err(|_| OpenAppServerError("queue directory must be UTF-8".into()))
            })
            .transpose()?;
        let queue = match &profile_runtime {
            Some(runtime) => runtime.queue_store()?,
            None => Arc::new(queue::QueueStore::open(&database_path).map_err(open_error)?),
        };
        server = server
            .with_queue_store(queue, directory)
            .map_err(OpenAppServerError)?;
    }
    server = server
        .with_skill_runtime(
            built_in_skill_root,
            skill_config,
            options.web_search_backend.take(),
        )
        .map_err(OpenAppServerError)?;
    server = server
        .with_agent_capabilities(
            Arc::new(
                match options.session_state_mode {
                    SessionStateMode::Durable => history_notes::NotesStore::open(&database_path),
                    SessionStateMode::Ephemeral => history_notes::NotesStore::in_memory(),
                }
                .map_err(OpenAppServerError)?,
            ),
            options.image_generation_backend.take(),
            &options.profile_root.join("generated-images"),
            options
                .git_attribution
                .clone()
                .unwrap_or_else(|| Arc::new(git_attribution::GitAttributionPolicy::Disabled)),
        )
        .map_err(OpenAppServerError)?;
    server = server
        .with_local_projects(&database_path)
        .map_err(OpenAppServerError)?;
    server = server
        .with_local_memories(&database_path)
        .map_err(OpenAppServerError)?;
    if let Some(profile) = &profile_runtime {
        server = server.with_automation_store(profile.automation_store());
    }
    if let Some(executable) = pty_helper {
        server = server.with_pty_helper(executable);
    }
    if let Some(command) = fast_regex_worker_command {
        server = server.with_fast_regex_worker_command(command);
    }
    if let Some(models) = providers.models {
        server = server.with_codebase_models(models);
    }
    if let Some(runtime) = marketplace_language_runtime {
        server = server
            .with_marketplace_language_runtime(runtime)
            .map_err(OpenAppServerError)?;
    }
    if let Some(manager) = plugins_manager {
        server = if profile_runtime.is_some() {
            server.with_profile_plugins_manager(manager)
        } else {
            server.with_plugins_manager(manager)
        };
    } else if let Some(client) = plugin_package_service {
        server = server.with_plugin_package_service(client);
    }
    let mcp_updates = McpCatalogUpdates::default();
    mcp_updates.bind_extensions(server.agent_extension_registry());
    let mcp_changes = mcp_updates.subscribe();
    let mcp_runtime_intents = server.mcp_runtime_intents.clone();
    let mcp_runtime_intent_changes = mcp_runtime_intents.subscribe();
    let mcp_runtime_intent_snapshot = mcp_runtime_intents.snapshot();
    let mcp = match &connector_runtime {
        Some(connectors) => compose_mcp_tools_with_connectors_and_runtime_intents_and_updates(
            &runtime_config,
            1,
            &mcp_runtime_intent_snapshot,
            connectors.service.authority().clone(),
            Arc::clone(&connectors.secrets),
            Arc::clone(&connectors.mcp),
            mcp_updates.clone(),
        ),
        None => compose_mcp_tools_at_generation_with_runtime_intents_and_updates(
            &runtime_config,
            1,
            &mcp_runtime_intent_snapshot,
            mcp_updates.clone(),
        ),
    }
    .map_err(|error| OpenAppServerError(error.to_string()))?;
    let mcp_status = mcp
        .as_ref()
        .map(|mcp| mcp.status.clone())
        .unwrap_or_else(|| McpRuntimeStatusSnapshot::empty(1));
    let mcp = mcp.map(|mcp| ToolPort::mcp(mcp.tools, mcp.policy));
    server = server.with_mcp_status_snapshot(mcp_status);
    if let Some(connectors) = &connector_runtime {
        server = server.with_connector_service(Arc::clone(&connectors.service));
        if !mcp_oauth_providers.is_empty() {
            server = server.with_mcp_oauth_service(Arc::new(McpOAuthService::new(
                Arc::clone(&connectors.secrets),
                mcp_oauth_providers,
            )));
        }
        if let Some(authority) = &connectors.plugin_authority {
            server = server.with_plugin_authority(authority.clone());
        }
        if let Some(oauth) = &connectors.oauth {
            server = server.with_connector_oauth_service(Arc::clone(oauth));
        }
        if let Some(oauth) = &connectors.device_oauth {
            server = server.with_connector_device_oauth_service(Arc::clone(oauth));
        }
    }
    server = server
        .with_execution_environments(options.execution_environments)
        .map_err(OpenAppServerError)?;
    server = server
        .with_local_tool_config(crate::local_tools::LocalToolConfig::from_resolved(
            &runtime_config,
        ))
        .with_local_env_host(mcp, DirGrantPolicy::UserConfig(Arc::clone(&config)))
        .map_err(|error| OpenAppServerError(error.to_string()))?;
    let local_dir_root = options.dir_root.clone();
    if let Some(dir_root) = options.dir_root {
        server
            .set_env_cwd(dir_root.clone())
            .map_err(|error| OpenAppServerError(error.to_string()))?;
        match options.initial_dir_permissions {
            InitialDirPermissions::HostConfiguration => server
                .activate_host_configured_dir_root(dir_root)
                .map_err(|error| OpenAppServerError(error.to_string()))?,
            InitialDirPermissions::UserConfig => server
                .switch_local_dir_root(dir_root)
                .map_err(|error| OpenAppServerError(error.to_string()))?,
        };
    }
    if let Some(dir_root) = local_dir_root {
        server = server
            .with_local_dir_services(&database_path, &options.profile_root, &dir_root)
            .map_err(OpenAppServerError)?;
    }
    server.bind_session_extensions().map_err(open_error)?;
    server
        .resume_recovered_agent_coordinations()
        .map_err(open_error)?;
    server
        .resume_recovered_tool_continuations()
        .map_err(open_error)?;
    server
        .resume_recovered_extension_turns()
        .map_err(open_error)?;
    let env_tools = server
        .local_env_tool_ports()
        .ok_or_else(|| OpenAppServerError("local Directory tools are unavailable".into()))?;
    let env_runtime = server
        .env_runtime_control()
        .ok_or_else(|| OpenAppServerError("local Directory runtime is unavailable".into()))?;
    server = server.with_tool_config_watcher(ToolConfigWatcher::start(ToolConfigWatcherInputs {
        config,
        dir_config,
        env_tools,
        env_runtime,
        connector_runtime,
        mcp_runtime_intents,
        mcp_updates,
        mcp_changes,
        mcp_runtime_intent_changes,
    }));
    Ok(server)
}

fn default_dir_config(
    dir_root: &std::path::Path,
) -> Result<LocalDirConfigOptions, OpenAppServerError> {
    let dir = Dir::open_local(dir_root).map_err(open_error)?;
    Ok(LocalDirConfigOptions::new(
        dir.canonical_path().join(".ash/config.toml"),
        dir.id(),
    ))
}

fn open_image_attachments(
    profile_root: &Path,
) -> Result<Arc<ash_attachments::ImageAttachments>, OpenAppServerError> {
    let image_store =
        ash_attachments::FileImageAttachmentStore::open(profile_root.join("attachments"))
            .map_err(|error| OpenAppServerError(error.to_string()))?;
    let remote_images = ash_attachments::SafeRemoteImageFetcher::production()
        .map_err(|error| OpenAppServerError(error.to_string()))?;
    Ok(Arc::new(
        ash_attachments::ImageAttachments::new(Arc::new(image_store))
            .with_remote_fetcher(Arc::new(remote_images)),
    ))
}

pub(crate) struct ToolConfigWatcher {
    shutdown: Option<std::sync::mpsc::Sender<()>>,
    thread: Option<JoinHandle<()>>,
}

struct ToolConfigWatcherInputs {
    config: Arc<ConfigStore>,
    dir_config: Option<Arc<DirConfigTracker>>,
    env_tools: Arc<EnvToolPorts>,
    env_runtime: crate::server::EnvRuntimeControl,
    connector_runtime: Option<LocalConnectorRuntime>,
    mcp_runtime_intents: crate::mcp_runtime::McpRuntimeIntents,
    mcp_updates: McpCatalogUpdates,
    mcp_changes: McpCatalogUpdateSubscription,
    mcp_runtime_intent_changes: std::sync::mpsc::Receiver<()>,
}

impl ToolConfigWatcher {
    fn start(inputs: ToolConfigWatcherInputs) -> Self {
        let ToolConfigWatcherInputs {
            config,
            dir_config,
            env_tools,
            env_runtime,
            mut connector_runtime,
            mcp_runtime_intents,
            mcp_updates,
            mcp_changes,
            mcp_runtime_intent_changes,
        } = inputs;
        let mut semantic_binding = config
            .read_snapshot()
            .ok()
            .map(|snapshot| (snapshot.values.codebase, snapshot.values.providers));
        let changes = config.subscribe_changes();
        let connector_changes = connector_runtime
            .as_ref()
            .map(|runtime| runtime.service.authority().subscribe());
        let plugin_changes = connector_runtime
            .as_ref()
            .and_then(|runtime| runtime.plugin_authority.as_ref())
            .map(PluginActivationAuthority::subscribe);
        let marketplace_changes = connector_runtime
            .as_ref()
            .and_then(|runtime| runtime.plugins_manager.as_ref())
            .and_then(|manager| manager.subscribe().ok());
        let mut plugin_activation_generation = connector_runtime
            .as_ref()
            .and_then(|runtime| runtime.plugin_authority.as_ref())
            .map(|authority| authority.snapshot().activation().generation());
        let (shutdown, shutdown_receiver) = std::sync::mpsc::channel();
        let thread = std::thread::Builder::new()
            .name("ash-tool-config".into())
            .spawn(move || {
                let mut catalog_generation = 1_u64;
                let mut dir_revision = dir_config
                    .as_ref()
                    .and_then(|dir| dir.read().ok().map(|(_, revision)| revision));
                let mut config_dirty = false;
                let mut connector_dirty = false;
                let mut mcp_dirty = false;
                let mut mcp_runtime_intent_dirty = false;
                let mut plugin_dirty = false;
                let mut marketplace_dirty = false;
                loop {
                    if shutdown_receiver.try_recv().is_ok() {
                        break;
                    }
                    config_dirty |= match changes.recv_timeout(Duration::from_millis(100)) {
                        Ok(_) => {
                            while changes.try_recv().is_ok() {}
                            true
                        }
                        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => false,
                        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => break,
                    };
                    if let Some(dir_config) = &dir_config {
                        match dir_config.read() {
                            Ok((_, revision)) if dir_revision != Some(revision) => {
                                dir_revision = Some(revision);
                                config_dirty = true;
                            }
                            Ok(_) => {}
                            Err(error) => {
                                env_tools.record_reconcile_failure(error.to_string());
                                continue;
                            }
                        }
                    }
                    if let Some(connector_changes) = &connector_changes {
                        while connector_changes.try_recv().is_ok() {
                            connector_dirty = true;
                        }
                    }
                    while mcp_changes.try_recv().is_ok() {
                        mcp_dirty = true;
                    }
                    while mcp_runtime_intent_changes.try_recv().is_ok() {
                        mcp_runtime_intent_dirty = true;
                    }
                    if let Some(plugin_changes) = &plugin_changes {
                        while let Ok(change) = plugin_changes.try_recv() {
                            if plugin_activation_generation != Some(change.activation_generation) {
                                plugin_activation_generation = Some(change.activation_generation);
                                plugin_dirty = true;
                            }
                        }
                    }
                    if let Some(marketplace_changes) = &marketplace_changes {
                        while marketplace_changes.try_recv().is_ok() {
                            marketplace_dirty = true;
                        }
                    }
                    if !config_dirty
                        && !connector_dirty
                        && !mcp_dirty
                        && !plugin_dirty
                        && !marketplace_dirty
                        && !mcp_runtime_intent_dirty
                    {
                        continue;
                    }
                    let snapshot = match config.read_snapshot() {
                        Ok(snapshot) => snapshot,
                        Err(error) => {
                            env_tools.record_reconcile_failure(error.to_string());
                            continue;
                        }
                    };
                    if config_dirty {
                        if let Err(error) =
                            env_runtime.reconcile_user_dir_permissions(&snapshot.values)
                        {
                            env_tools.record_reconcile_failure(error.to_string());
                            continue;
                        }
                        if let Err(error) = env_runtime.reconcile_hooks(&snapshot.values.hooks) {
                            env_tools.record_reconcile_failure(error.to_string());
                            continue;
                        }
                        let next_semantic_binding = (
                            snapshot.values.codebase.clone(),
                            snapshot.values.providers.clone(),
                        );
                        if semantic_binding.as_ref() != Some(&next_semantic_binding) {
                            if let Err(error) = env_runtime.reconcile_codebase_runtime() {
                                env_tools.record_reconcile_failure(error.to_string());
                                continue;
                            }
                            semantic_binding = Some(next_semantic_binding);
                        }
                        let runtime_config =
                            match resolve_local_config(&snapshot, dir_config.as_deref()) {
                                Ok(config) => config,
                                Err(error) => {
                                    env_tools.record_reconcile_failure(error.to_string());
                                    continue;
                                }
                            };
                        if let Err(error) = env_runtime.reconcile_local_tool_config(&runtime_config)
                        {
                            env_tools.record_reconcile_failure(error.to_string());
                            continue;
                        }
                    }
                    if plugin_dirty
                        && let Some(connectors) = connector_runtime.as_mut()
                        && let Err(error) = connectors.reconcile_plugin_activation()
                    {
                        env_tools.record_reconcile_failure(error.to_string());
                        continue;
                    }
                    if marketplace_dirty
                        && let Some(connectors) = connector_runtime.as_mut()
                        && let Err(error) = connectors.reconcile_marketplace()
                    {
                        env_tools.record_reconcile_failure(error.to_string());
                        continue;
                    }
                    catalog_generation = match catalog_generation.checked_add(1) {
                        Some(generation) => generation,
                        None => {
                            env_tools.record_reconcile_failure("MCP catalog generation overflow");
                            continue;
                        }
                    };
                    let composition = match &connector_runtime {
                        Some(connectors) => {
                            let runtime_intents = mcp_runtime_intents.snapshot();
                            compose_mcp_tools_with_connectors_and_runtime_intents_and_updates(
                                &snapshot.values,
                                catalog_generation,
                                &runtime_intents,
                                connectors.service.authority().clone(),
                                Arc::clone(&connectors.secrets),
                                Arc::clone(&connectors.mcp),
                                mcp_updates.clone(),
                            )
                        }
                        None => {
                            let runtime_intents = mcp_runtime_intents.snapshot();
                            compose_mcp_tools_at_generation_with_runtime_intents_and_updates(
                                &snapshot.values,
                                catalog_generation,
                                &runtime_intents,
                                mcp_updates.clone(),
                            )
                        }
                    };
                    let (mcp, mcp_status) = match composition {
                        Ok(Some(mcp)) => {
                            let status = mcp.status.clone();
                            (Some(ToolPort::mcp(mcp.tools, mcp.policy)), status)
                        }
                        Ok(None) => (None, McpRuntimeStatusSnapshot::empty(catalog_generation)),
                        Err(error) => {
                            env_tools.record_reconcile_failure(error.to_string());
                            continue;
                        }
                    };
                    if let Err(error) = env_tools.reconcile_user_config(
                        mcp,
                        &snapshot.values.tool_search,
                        &snapshot.values.providers,
                    ) {
                        log::error!("requested tool-search configuration is unavailable: {error}");
                        env_tools.record_reconcile_failure(error.to_string());
                        continue;
                    }
                    env_runtime.replace_mcp_status(mcp_status);
                    config_dirty = false;
                    connector_dirty = false;
                    mcp_dirty = false;
                    mcp_runtime_intent_dirty = false;
                    plugin_dirty = false;
                    marketplace_dirty = false;
                }
            })
            .ok();
        Self {
            shutdown: Some(shutdown),
            thread,
        }
    }
}

impl Drop for ToolConfigWatcher {
    fn drop(&mut self) {
        if let Some(shutdown) = self.shutdown.take() {
            let _ = shutdown.send(());
        }
        if let Some(thread) = self.thread.take() {
            let _ = thread.join();
        }
    }
}

struct LocalSkillConfigProvider {
    config: Arc<ConfigStore>,
}

impl SkillConfigSnapshotProvider for LocalSkillConfigProvider {
    fn snapshot(&self) -> Result<ash_config::SkillsConfig, String> {
        self.config
            .read_snapshot()
            .map(|snapshot| snapshot.values.skills)
            .map_err(|error| error.0)
    }

    fn config_changes(&self) -> Option<std::sync::mpsc::Receiver<ash_config::ConfigChange>> {
        Some(self.config.subscribe_changes())
    }
}

fn resolve_built_in_skill_root(selection: BuiltInSkillRoot) -> BuiltInSkillSource {
    match selection {
        BuiltInSkillRoot::Explicit(root) => BuiltInSkillSource::Root(root),
        BuiltInSkillRoot::Unavailable => BuiltInSkillSource::Omitted,
        BuiltInSkillRoot::AutoDetect => InstallContext::current()
            .bundled_resource_directory("skills")
            .or_else(development_built_in_skill_root)
            .map(BuiltInSkillSource::Root)
            .unwrap_or(BuiltInSkillSource::Missing),
    }
}

fn resolve_extension_roots(profile_root: &std::path::Path) -> Vec<ExtensionRoot> {
    let mut roots = Vec::new();
    if let Some(root) = InstallContext::current()
        .bundled_resource_directory("extensions")
        .or_else(development_extension_root)
    {
        roots.push(ExtensionRoot::built_in(root));
    }
    roots.push(ExtensionRoot::user(profile_root.join("extensions")));
    roots
}

fn development_extension_root() -> Option<PathBuf> {
    let candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../extensions");
    candidate.is_dir().then_some(candidate)
}

fn development_built_in_skill_root() -> Option<PathBuf> {
    let candidate = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../skills/assets");
    candidate.is_dir().then_some(candidate)
}

/// Resolves an immutable model runtime from one persisted configuration snapshot.
///
/// Implementations must not retain a mutable view of `config`: one resolved model belongs to one
/// invocation, so configuration changes can affect later invocations without changing one already
/// in progress.
trait ModelSnapshotResolver: Send + Sync {
    fn resolve(&self, config: &ResolvedConfig) -> Arc<dyn ModelInvoker>;
}

struct ModelProviderSnapshotResolver {
    model_provider: Arc<dyn ModelProvider>,
}

impl ModelSnapshotResolver for ModelProviderSnapshotResolver {
    fn resolve(&self, config: &ResolvedConfig) -> Arc<dyn ModelInvoker> {
        let Some(model_ref) = config.model.as_ref() else {
            return Arc::new(UnavailableModel::from_error(
                ash_model_provider::ModelProviderError::ConfigurationMissing,
            ));
        };
        let provider = config.selected_provider().cloned().or_else(|| {
            let model = config.model.as_ref()?;
            let runtime = find_static_model(model)?.runtime;
            (runtime != StaticModelRuntime::ProviderApi)
                .then(|| ModelProviderConfig::new(model.provider.clone()))
        });
        let Some(provider) = provider else {
            return Arc::new(UnavailableModel::from_error(
                ash_model_provider::ModelProviderError::ConfigurationMissing,
            ));
        };
        self.model_provider
            .runtime(ModelRuntimeRequest::new(model_ref.clone(), provider))
            .unwrap_or_else(|error| Arc::new(UnavailableModel::from_error(error)))
    }
}

struct ConfigBackedModelService {
    config: Arc<ConfigStore>,
    dir_config: Option<Arc<DirConfigTracker>>,
    provider_configs: ProviderConfigRegistry,
    models_manager: ModelsManager,
    catalog_provider: Arc<ModelProviderRuntime>,
    catalog_runtime: Arc<tokio::runtime::Runtime>,
    resolver: Arc<dyn ModelSnapshotResolver>,
}

impl ModelService for ConfigBackedModelService {
    fn billing_scope(&self, selection: ModelSelection<'_>) -> Result<ModelBillingScope, CoreError> {
        let config = self.config_for_selection(selection)?;
        let Some(model) = config.model.as_ref() else {
            return Ok(ModelBillingScope::Unavailable);
        };
        let access = find_static_model(model)
            .map(|definition| definition.access)
            .unwrap_or(ModelAccess::ApiKey);
        if access == ModelAccess::Subscription {
            return Ok(ModelBillingScope::SubscriptionPlan);
        }
        if access != ModelAccess::ApiKey {
            return Ok(ModelBillingScope::Unavailable);
        }
        let uses_provider_endpoint =
            config
                .providers
                .get(&model.provider)
                .is_some_and(|provider| {
                    provider
                        .base_url
                        .as_deref()
                        .is_none_or(|base_url| base_url.trim().is_empty())
                });
        Ok(if uses_provider_endpoint {
            ModelBillingScope::PublicApi
        } else {
            ModelBillingScope::Unavailable
        })
    }

    fn context_budget(&self, selection: ModelSelection<'_>) -> Result<ContextBudget, CoreError> {
        context_budget_for_config(
            &self.config_for_selection(selection)?,
            &self.provider_configs,
            &self.models_manager,
        )
    }

    fn image_input_policy(
        &self,
        selection: ModelSelection<'_>,
    ) -> Result<ModelImageInputPolicy, CoreError> {
        let config = self.config_for_selection(selection)?;
        Ok(image_input_policy_for_config(
            &config,
            &self.provider_configs,
        ))
    }

    fn reasoning_config(
        &self,
        selection: ModelSelection<'_>,
    ) -> Result<Option<ash_protocol::ReasoningConfig>, CoreError> {
        let config = self.config_for_selection(selection)?;
        let Some(model) = config.model.as_ref() else {
            return Ok(None);
        };
        let static_model = find_static_model(model);
        let effort = config
            .model_reasoning_effort
            .or_else(|| static_model.and_then(|m| m.model_reasoning_effort));
        Ok(effort.map(|effort| ash_protocol::ReasoningConfig {
            effort,
            summary: false,
        }))
    }

    fn input_token_measurement_capability(
        &self,
        selection: ModelSelection<'_>,
    ) -> Result<ContextTokenMeasurementCapability, CoreError> {
        let config = self.config_for_selection(selection)?;
        ProviderModelService::new(self.resolver.resolve(&config))
            .input_token_measurement_capability(ModelSelection::ConfiguredDefault)
    }

    fn measure_input(
        &self,
        selection: ModelSelection<'_>,
        request: &ash_protocol::ModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<ContextTokenMeasurementOutcome, CoreError> {
        let config = self.config_for_selection(selection)?;
        ProviderModelService::new(self.resolver.resolve(&config)).measure_input(
            ModelSelection::ConfiguredDefault,
            request,
            cancellation,
        )
    }

    fn invoke(
        &self,
        selection: ModelSelection<'_>,
        request: &ash_protocol::ModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<ash_protocol::ModelResponse, CoreError> {
        let config = self.config_for_selection(selection)?;
        ProviderModelService::new(self.resolver.resolve(&config)).invoke(
            ModelSelection::ConfiguredDefault,
            request,
            cancellation,
        )
    }

    fn stream(
        &self,
        selection: ModelSelection<'_>,
        request: &ash_protocol::ModelRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn CoreModelStreamSink,
    ) -> Result<ash_protocol::ModelResponse, CoreError> {
        let config = self.config_for_selection(selection)?;
        ProviderModelService::new(self.resolver.resolve(&config)).stream(
            ModelSelection::ConfiguredDefault,
            request,
            cancellation,
            sink,
        )
    }
}

impl ModelCatalog for ConfigBackedModelService {
    fn refresh(
        &self,
        provider: &ash_protocol::ProviderId,
    ) -> Result<
        Vec<ash_app_server_protocol::protocol::model::ModelCatalogEntry>,
        crate::model_catalog::ModelCatalogRefreshError,
    > {
        use crate::model_catalog::ModelCatalogRefreshError;
        let config = self
            .resolved_config()
            .map_err(|_| ModelCatalogRefreshError::InvalidConfiguration)?;
        let connection = config.providers.get(provider).cloned().unwrap_or_else(|| {
            ash_model_provider_config::ModelProviderConfig::new(provider.clone())
        });
        let registry = self
            .provider_configs
            .with_configs(config.providers.values())
            .map_err(|_| ModelCatalogRefreshError::InvalidConfiguration)?;
        let manager = self.models_manager.with_registry(registry.clone());
        let binding = self
            .catalog_provider
            .catalog_binding(&connection)
            .map_err(|error| match error {
                ash_model_provider::ModelProviderError::Credential(_) => {
                    ModelCatalogRefreshError::Authentication
                }
                _ => ModelCatalogRefreshError::InvalidConfiguration,
            })?
            .ok_or(ModelCatalogRefreshError::Unsupported)?;
        self.catalog_runtime
            .block_on(manager.refresh(binding.scope().clone(), binding.source()))
            .map_err(ModelCatalogRefreshError::from)?;
        manager
            .list(&[binding.scope().clone()], &CatalogQuery::all())
            .map_err(ModelCatalogRefreshError::from)?
            .into_iter()
            .filter(|entry| entry.availability() == ash_protocol::ModelAvailability::Available)
            .map(|entry| {
                runtime_catalog_entry(&entry, &config, &registry)
                    .map_err(|_| ModelCatalogRefreshError::InvalidConfiguration)
            })
            .collect()
    }
    fn list(
        &self,
    ) -> Result<Vec<ash_app_server_protocol::protocol::model::ModelCatalogEntry>, CoreError> {
        let config = self.resolved_config()?;
        let registry = self
            .provider_configs
            .with_configs(config.providers.values())
            .map_err(|error| CoreError::Model(error.to_string()))?;
        let manager = self.models_manager.with_registry(registry.clone());
        let mut scopes = registry
            .providers()
            .map(|provider| CatalogScopeKey::provider_seed(provider.id.clone()))
            .collect::<Vec<_>>();
        for provider in config
            .providers
            .values()
            .filter(|provider| provider.custom.is_none())
        {
            let binding = match self.catalog_provider.catalog_binding(provider) {
                Ok(Some(binding)) => binding,
                Ok(None) => continue,
                Err(error) => {
                    log::warn!(
                        "could not bind dynamic model catalog for {}: {error}",
                        provider.provider
                    );
                    continue;
                }
            };
            let scope = binding.scope().clone();
            if let Err(error) = self.catalog_runtime.block_on(manager.read(
                scope.clone(),
                if provider.provider.as_str() == "ollama" {
                    ash_models_manager::CatalogReadPolicy::CachePreferred
                } else {
                    ash_models_manager::CatalogReadPolicy::CacheOnly
                },
                ash_models_manager::CatalogReadSource::dynamic(binding.source()),
            )) {
                log::warn!(
                    "could not refresh dynamic model catalog for {}: {error}",
                    provider.provider
                );
            }
            if let Some(seed) = scopes
                .iter_mut()
                .find(|candidate| candidate.provider() == &provider.provider)
            {
                *seed = scope;
            } else {
                scopes.push(scope);
            }
        }
        let mut models = manager
            .list(&scopes, &CatalogQuery::all())
            .map_err(|error| CoreError::Model(error.to_string()))?
            .into_iter()
            .map(|entry| runtime_catalog_entry(&entry, &config, &registry))
            .collect::<Result<Vec<_>, CoreError>>()?;
        for provider in config
            .providers
            .values()
            .filter(|provider| provider.custom.is_some())
        {
            if let Some(id) = provider
                .custom
                .as_ref()
                .and_then(|custom| custom.model.as_ref())
            {
                let model = ash_protocol::ModelRef::new(provider.provider.clone(), id.clone());
                if models.iter().any(|entry| entry.model == model) {
                    continue;
                }
                let resolved = manager
                    .resolve_static(&model, &ModelRequirements::agent())
                    .map_err(|error| CoreError::Model(error.to_string()))?;
                models.push(runtime_catalog_entry(resolved.entry(), &config, &registry)?);
            }
        }
        if let Some(model) = config.model.clone()
            && config
                .providers
                .get(&model.provider)
                .is_none_or(|provider| provider.custom.is_none())
            && !models.iter().any(|entry| entry.model == model)
        {
            let resolved = manager
                .resolve_static(&model, &ModelRequirements::agent())
                .map_err(|error| CoreError::Model(error.to_string()))?;
            models.push(runtime_catalog_entry(resolved.entry(), &config, &registry)?);
        }
        models.sort_by(|left, right| {
            let catalog_position = |model: &ash_protocol::ModelRef| {
                ash_model_provider_config::STATIC_MODEL_CATALOG
                    .iter()
                    .position(|entry| {
                        entry.provider_id == model.provider.as_str()
                            && entry.model_id == model.model.as_str()
                    })
                    .unwrap_or(usize::MAX)
            };
            left.model
                .provider
                .cmp(&right.model.provider)
                .then_with(|| catalog_position(&left.model).cmp(&catalog_position(&right.model)))
                .then_with(|| left.model.model.cmp(&right.model.model))
        });
        Ok(models)
    }

    fn configured_default(&self) -> Result<Option<ash_protocol::ModelRef>, CoreError> {
        Ok(self.resolved_config()?.model)
    }
}

impl ConfigBackedModelService {
    fn config_for_selection(
        &self,
        selection: ModelSelection<'_>,
    ) -> Result<ResolvedConfig, CoreError> {
        let user = self.config.read_snapshot().map_err(|error| {
            CoreError::Model(format!("failed to read model config: {}", error.0))
        })?;
        let mut config = self.resolve_config(&user)?;
        if let ModelSelection::Session(model) = selection {
            config.model = Some(model.clone());
        }
        Ok(config)
    }

    fn resolved_config(&self) -> Result<ResolvedConfig, CoreError> {
        let user = self.config.read_snapshot().map_err(|error| {
            CoreError::Model(format!("failed to read model config: {}", error.0))
        })?;
        self.resolve_config(&user)
    }

    fn resolve_config(&self, user: &ResolvedConfigSnapshot) -> Result<ResolvedConfig, CoreError> {
        resolve_local_config(user, self.dir_config.as_deref()).map_err(|error| {
            CoreError::Model(format!("failed to resolve directory config: {}", error.0))
        })
    }
}

fn resolve_local_config(
    user: &ResolvedConfigSnapshot,
    dir_config: Option<&DirConfigTracker>,
) -> Result<ResolvedConfig, ash_config::ConfigError> {
    let Some(dir_config) = dir_config else {
        return Ok(user.values.clone());
    };
    let (document, revision) = dir_config.read()?;
    resolve_scoped_config(
        user,
        Some(DirConfigInput::new(dir_config.scope(), revision, &document)),
    )
    .map(|resolved| resolved.values)
}

fn context_budget_for_config(
    config: &ResolvedConfig,
    providers: &ProviderConfigRegistry,
    manager: &ModelsManager,
) -> Result<ContextBudget, CoreError> {
    let Some(model_ref) = config.model.as_ref() else {
        return Ok(ContextBudget::provider_managed());
    };
    let Some(provider_config) = config.providers.get(&model_ref.provider) else {
        return Ok(ContextBudget::provider_managed());
    };
    let registry = providers
        .with_configs(config.providers.values())
        .map_err(|error| CoreError::Model(error.to_string()))?;
    let resolved = manager
        .with_registry(registry.clone())
        .resolve_static(model_ref, &ModelRequirements::agent())
        .map_err(|error| CoreError::Model(error.to_string()))?;
    let info = resolved
        .entry()
        .model_info(provider_config)
        .map_err(|error| CoreError::Model(error.to_string()))?;
    context_budget_for_model(&info, provider_config, &registry)
}

fn context_budget_for_model(
    info: &ash_protocol::ModelInfo,
    config: &ModelProviderConfig,
    registry: &ProviderConfigRegistry,
) -> Result<ContextBudget, CoreError> {
    let ContextWindow::Known(context_window) = info.context_window else {
        return Ok(ContextBudget::provider_managed());
    };
    let normalized = registry
        .normalize(config)
        .map_err(|error| CoreError::Model(error.to_string()))?;
    let reserved_output = normalized
        .max_output_tokens
        .unwrap_or(DEFAULT_MODEL_OUTPUT_RESERVATION_TOKENS);
    let compaction_limit = info
        .auto_compact_token_limit
        .map_or(ContextCompactionLimit::ContextWindow, |tokens| {
            ContextCompactionLimit::Tokens(ContextTokenCount::new(tokens))
        });
    Ok(ContextBudget::core_managed(
        ContextTokenCount::new(context_window),
        ContextTokenCount::new(reserved_output),
        ContextTokenCount::new(MODEL_CONTEXT_SAFETY_MARGIN_TOKENS),
        compaction_limit,
    ))
}

fn runtime_catalog_entry(
    entry: &ash_models_manager::ModelCatalogEntry,
    config: &ResolvedConfig,
    registry: &ProviderConfigRegistry,
) -> Result<ash_app_server_protocol::protocol::model::ModelCatalogEntry, CoreError> {
    let definition = registry
        .get(&entry.model().provider)
        .expect("catalog entry belongs to the same provider registry");
    let default_config = ModelProviderConfig::new(entry.model().provider.clone());
    let provider_config = config
        .providers
        .get(&entry.model().provider)
        .unwrap_or(&default_config);
    let info = entry
        .model_info(provider_config)
        .map_err(|error| CoreError::Model(error.to_string()))?;
    let mut result = ash_app_server_protocol::protocol::model::ModelCatalogEntry::from_info(
        entry.model().clone(),
        &info,
        definition.output_transport,
    );
    if config.providers.contains_key(&entry.model().provider) {
        match context_budget_for_model(&info, provider_config, registry)?
            .resolve()
            .map_err(|error| CoreError::Context(error.to_string()))?
        {
            ResolvedContextBudget::ProviderManaged => {}
            ResolvedContextBudget::CoreManaged(limits) => {
                result.available_context_window = Some(limits.maximum_input().get());
            }
        }
    }
    Ok(result)
}

fn image_input_policy_for_config(
    config: &ResolvedConfig,
    providers: &ProviderConfigRegistry,
) -> ModelImageInputPolicy {
    // Conservative local resize budgets reviewed against provider guidance on 2026-08-23.
    // Model capabilities decide whether OpenAI Auto/Original may use its larger original-detail
    // envelope; unknown and compatible adapters intentionally keep Core's smaller default.
    const LOW: ModelImageInputLimits = ModelImageInputLimits::new(512, 256);
    const OPENAI_HIGH: ModelImageInputLimits = ModelImageInputLimits::new(2_048, 2_440);
    const OPENAI_ORIGINAL: ModelImageInputLimits = ModelImageInputLimits::new(6_000, 10_000);
    const ANTHROPIC: ModelImageInputLimits = ModelImageInputLimits::new(1_568, 1_120);
    const GOOGLE: ModelImageInputLimits = ModelImageInputLimits::new(3_072, 9_216);

    let Some(model_ref) = config.model.as_ref() else {
        return ModelImageInputPolicy::default();
    };
    let Some(provider) = providers.get(&model_ref.provider) else {
        return ModelImageInputPolicy::default();
    };
    match provider.adapter {
        ash_model_provider_config::ProviderAdapter::Anthropic => {
            ModelImageInputPolicy::new(ANTHROPIC, LOW, ANTHROPIC, ANTHROPIC)
        }
        ash_model_provider_config::ProviderAdapter::Google => {
            ModelImageInputPolicy::new(GOOGLE, LOW, GOOGLE, GOOGLE)
        }
        ash_model_provider_config::ProviderAdapter::OpenAi => {
            let supports_original = provider.models.iter().any(|model| {
                model.id == model_ref.model
                    && model.capabilities.image_detail_original
                        == ash_protocol::CapabilitySupport::Supported
            });
            if supports_original {
                ModelImageInputPolicy::new(OPENAI_ORIGINAL, LOW, OPENAI_HIGH, OPENAI_ORIGINAL)
            } else {
                ModelImageInputPolicy::new(OPENAI_HIGH, LOW, OPENAI_HIGH, OPENAI_HIGH)
            }
        }
        _ => ModelImageInputPolicy::default(),
    }
}

struct DirConfigTracker {
    store: DirConfigStore,
    observed: Mutex<Option<DirConfigObservation>>,
}

struct DirConfigObservation {
    document: DirConfigDocument,
    revision: DirConfigRevision,
}

impl DirConfigTracker {
    fn new(store: DirConfigStore) -> Self {
        Self {
            store,
            observed: Mutex::new(None),
        }
    }

    fn read(&self) -> Result<(DirConfigDocument, DirConfigRevision), ash_config::ConfigError> {
        let document = self.store.read_document()?;
        let mut observed = self.observed.lock().map_err(|_| {
            ash_config::ConfigError("directory config tracker lock poisoned".into())
        })?;
        if let Some(previous) = observed.as_ref()
            && previous.document == document
        {
            return Ok((previous.document.clone(), previous.revision));
        }
        let revision = observed
            .as_ref()
            .map_or(DirConfigRevision::INITIAL, |previous| {
                previous.revision.next()
            });
        *observed = Some(DirConfigObservation {
            document: document.clone(),
            revision,
        });
        Ok((document, revision))
    }

    fn scope(&self) -> &DirConfigScope {
        self.store.scope()
    }
}

pub(crate) struct ProviderModelService {
    invoker: Arc<dyn ModelInvoker>,
}

impl ProviderModelService {
    pub(crate) fn new(invoker: Arc<dyn ModelInvoker>) -> Self {
        Self { invoker }
    }
}

impl ModelService for ProviderModelService {
    fn input_token_measurement_capability(
        &self,
        _: ModelSelection<'_>,
    ) -> Result<ContextTokenMeasurementCapability, CoreError> {
        Ok(self.invoker.input_token_measurement_capability())
    }

    fn measure_input(
        &self,
        _: ModelSelection<'_>,
        request: &ash_protocol::ModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<ContextTokenMeasurementOutcome, CoreError> {
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        let outcome = self
            .invoker
            .measure_input_with_cancellation(request, cancellation)
            .map_err(map_model_provider_error)?;
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        Ok(outcome)
    }

    fn invoke(
        &self,
        _: ModelSelection<'_>,
        request: &ash_protocol::ModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<ash_protocol::ModelResponse, CoreError> {
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        let response = self
            .invoker
            .invoke_with_cancellation(request, cancellation)
            .map_err(map_model_provider_error)?;
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        Ok(response)
    }

    fn stream(
        &self,
        selection: ModelSelection<'_>,
        request: &ash_protocol::ModelRequest,
        cancellation: &CancellationToken,
        sink: &mut dyn CoreModelStreamSink,
    ) -> Result<ash_protocol::ModelResponse, CoreError> {
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        if self.invoker.output_transport() == ash_protocol::ModelOutputTransport::Unary {
            return self.invoke(selection, request, cancellation);
        }
        let mut adapter = CoreProviderStreamSink {
            inner: sink,
            failure: None,
        };
        let response = self
            .invoker
            .stream_with_cancellation(request, cancellation, &mut adapter);
        if let Some(error) = adapter.failure {
            return Err(error);
        }
        let response = response.map_err(map_model_provider_error)?;
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        Ok(response)
    }
}

struct CoreProviderStreamSink<'a> {
    inner: &'a mut dyn CoreModelStreamSink,
    failure: Option<CoreError>,
}

impl ModelEventSink for CoreProviderStreamSink<'_> {
    fn emit(
        &mut self,
        event: ash_protocol::ModelStreamEvent,
    ) -> Result<(), ash_model_provider::ModelProviderError> {
        if let Err(error) = self.inner.emit(event) {
            self.failure = Some(error);
            return Err(ash_model_provider::ModelProviderError::Unavailable(
                "model stream consumer rejected an event".into(),
            ));
        }
        Ok(())
    }
}

fn configure_product_connector_oauth(
    runtime: &mut LocalConnectorRuntime,
    configurations: Vec<crate::product_services::ProductConnectorOAuthConfig>,
) -> Result<(), OpenAppServerError> {
    let http: Arc<dyn ash_http_client::HttpClient> = Arc::new(
        ash_http_client::UreqHttpClient::new()
            .map_err(|error| OpenAppServerError(error.to_string()))?,
    );
    let mut browser = Vec::new();
    let mut device = Vec::new();
    for configuration in configurations {
        match configuration {
            crate::product_services::ProductConnectorOAuthConfig::GitHubBrokered {
                connector_id,
                config,
            } => {
                let provider =
                    connectors::GitHubBrokeredOAuthProvider::new(config, Arc::clone(&http))
                        .map_err(|error| OpenAppServerError(error.to_string()))?;
                browser.push((
                    connector_id,
                    Arc::new(provider) as Arc<dyn connectors::ConnectorOAuthProvider>,
                ));
            }
            crate::product_services::ProductConnectorOAuthConfig::GitHubDevice {
                connector_id,
                config,
            } => {
                let provider =
                    connectors::GitHubDeviceOAuthProvider::new(config, Arc::clone(&http))
                        .map_err(|error| OpenAppServerError(error.to_string()))?;
                device.push((
                    connector_id,
                    Arc::new(provider) as Arc<dyn connectors::ConnectorDeviceOAuthProvider>,
                ));
            }
        }
    }
    if !browser.is_empty() {
        runtime.oauth = Some(Arc::new(connectors::ConnectorOAuthService::new(
            Arc::clone(&runtime.service),
            browser,
        )));
    }
    if !device.is_empty() {
        runtime.device_oauth = Some(Arc::new(connectors::ConnectorDeviceOAuthService::new(
            Arc::clone(&runtime.service),
            device,
        )));
    }
    Ok(())
}

fn open_error(error: impl fmt::Display) -> OpenAppServerError {
    OpenAppServerError(error.to_string())
}

fn marketplace_providers(
    sources: &BTreeMap<ash_plugin::MarketplaceName, ash_core_plugins::RemoteMarketplaceConfig>,
) -> Result<ash_core_plugins::PluginProviders, OpenAppServerError> {
    let providers = sources.iter().map(|(name, config)| {
        let provider = ash_core_plugins::MarketplaceRemoteClient::new(config.clone());
        (
            name.clone(),
            Arc::new(provider) as Arc<dyn ash_core_plugins::PluginProvider>,
        )
    });
    ash_core_plugins::PluginProviders::new(providers)
        .map_err(|error| OpenAppServerError(error.to_string()))
}

#[cfg(test)]
#[path = "local_tests.rs"]
mod tests;

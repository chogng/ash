use crate::SlashCommandCatalog;
use crate::attachment_upload_store::AttachmentUploadStore;
use crate::browser_host::BrowserHost;
use crate::browser_tool::BrowserToolPolicy;
use crate::browser_tool::BrowserToolService;
use crate::model_catalog::ModelCatalog;
use crate::model_catalog::unavailable_model_catalog;
use crate::resource_store::ResourceError;
use crate::resource_store::ResourceStore;
use guardian_v2::ProviderReviewModel;
use serde::Deserialize;
use serde_json::Value;
use std::collections::BTreeSet;
use std::io::BufRead;
use std::io::BufReader;
use std::io::Write;
use std::sync::Arc;
use std::sync::Condvar;
use std::sync::Mutex;
use std::sync::RwLock;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;
use zeroize::Zeroize;
use ash_app_server_protocol::protocol::error::AppServerError;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::registry::ClientMethod;
use ash_app_server_protocol::protocol::registry::client_method;
use ash_app_server_protocol::protocol::registry::client_method_definition;
use ash_app_server_protocol::rpc::JsonRpcFailure;
use ash_app_server_protocol::rpc::JsonRpcId;
use ash_app_server_protocol::rpc::JsonRpcRequest;
use ash_app_server_protocol::rpc::JsonRpcSuccess;
use ash_app_server_protocol::rpc::JsonRpcVersion;
use ash_app_server_transport::DEFAULT_MAX_MESSAGE_BYTES;
use ash_app_server_transport::JsonlReader;
use ash_app_server_transport::JsonlWriter;
use ash_async_utils::CancellationToken;
use ash_config::ConfigStore;
use ash_core::ActionPolicyService;
use ash_core::AgentTreeLimits;
use ash_core::ApprovalModeActionPolicyService;
use ash_core::CancelTurnInteractionRequest;
use ash_core::CoreError;
use ash_core::ModelService;
use ash_core::MultiAgentCoordinator;
use ash_core::ThreadController;
use ash_core::ThreadUpdateSink;
use ash_core::ToolService;
use ash_core::TurnExecutionBackend;
use ash_core::TurnExecutor;
use ash_extension_api::ExtensionRegistry;
use ash_extensions::ExtensionCatalog;
use ash_extensions::ExtensionRoot;
use ash_file_system::FileSystem;
use ash_model_provider::ProviderCredentialService;
use ash_protocol::InteractionCancelReason;
use ash_protocol::ThreadUpdateEnvelope;
use ash_skills_extension::SkillConfigSnapshotProvider;
use ash_skills_extension::SkillRuntime;
use ash_skills_extension::SkillWatcher;
use ash_typst::TypstCompiler;

mod account_operations;
mod agent_environment_source;
#[cfg(test)]
mod agent_runtime_tests;
mod agent_selection;
mod attachment_operations;
mod automation_execution;
mod automation_operations;
mod cloud_codebase_operations;
mod codebase_operations;
mod codebase_retrieval_operations;
mod codebase_runtime;
mod collaboration_operations;
mod collaboration_runtime;
mod config_operations;
mod config_runtime;
mod connector_operations;
mod connector_runtime;
mod debug_operations;
mod diagnostics_operations;
mod diff_operations;
mod dir_contributions;
mod environment_operations;
mod environment_runtime;
mod extension_config_operations;
mod extension_host_operations;
pub(crate) mod extension_host_runtime;
mod extension_operations;
mod fs_operations;
mod fs_watcher;
mod git_operations;
mod git_runtime;
mod git_turn_changes_commit;
mod git_turn_changes_message;
mod git_turn_changes_observer;
mod git_turn_changes_operations;
mod git_turn_changes_runtime;
mod interaction_runtime;
mod issue_operations;
mod issue_runtime;
mod language_document_features;
mod language_operations;
mod language_runtime;
mod marketplace_extension_sources;
pub(crate) mod marketplace_language_runtime;
#[cfg(test)]
#[path = "server/marketplace_language_runtime_tests.rs"]
mod marketplace_language_runtime_tests;
mod marketplace_operations;
#[cfg(test)]
#[path = "server/marketplace_operations_tests.rs"]
mod marketplace_operations_tests;
mod marketplace_projection;
pub(crate) mod marketplace_runtime;
mod marketplace_skill_sources;
mod mcp_operations;
mod memories_context;
mod memories_operations;
mod memory_operations;
mod message_checkpoints;
pub(crate) mod notification_queue;
mod operations;
mod plugin_extension_sources;
mod plugin_operations;
mod plugin_runtime;
mod plugin_skill_sources;
mod project_operations;
#[cfg(test)]
#[path = "server/project_operations_tests.rs"]
mod project_operations_tests;
mod project_projection;
mod provider_operations;
mod queue_operations;
mod request_serialization;
mod runtime_extensions;
mod search_operations;
mod semantic_index_job;
mod session_operations;
mod skill_operations;
mod start_turn;
mod symbol_index_operations;
mod symbol_index_runtime;
mod syntax_operations;
mod terminal_operations;
mod thread_dir_binding;
mod thread_dirs;
mod turn_backend_router;
pub(crate) mod update_broker;
pub(crate) mod update_plan_tool;

const OUTBOUND_MESSAGE_QUEUE_CAPACITY: usize = 256;
const INBOUND_REQUEST_QUEUE_CAPACITY: usize = 64;
const CONNECTION_REQUEST_WORKERS: usize = 4;

use crate::mcp_runtime::McpRuntimeIntents;
pub(crate) use environment_runtime::DirGrantPolicy;
use environment_runtime::EnvRuntime;
pub(crate) use environment_runtime::EnvRuntimeControl;
pub(crate) use environment_runtime::EnvToolPorts;
use environment_runtime::LocalEnvHost;
use notification_queue::NotificationListener;
use notification_queue::NotificationQueue;
use request_serialization::RequestCancellationRegistry;
use request_serialization::RequestScheduler;
use update_broker::UpdateBroker;

pub use ash_codebase::CodebaseModels;

pub struct AppServer {
    queue: Option<Arc<queue::QueueStore>>,
    queue_directory: Option<String>,
    diagnostics: diagnostics::Diagnostics,
    telemetry: ash_otel::Telemetry,
    analytics: Arc<analytics::Analytics>,
    feedback: feedback::Feedback,
    pub(super) threads: Arc<ThreadController>,
    thread_worktree_binder: Arc<dyn ash_core::ThreadWorktreeBinder>,
    pub(super) multi_agent: Arc<MultiAgentCoordinator>,
    model: Arc<dyn ModelService>,
    model_catalog: Arc<dyn ModelCatalog>,
    model_instructions: Arc<ash_models_manager::ModelInstructionCatalog>,
    request_scheduler: RequestScheduler,
    request_cancellations: RequestCancellationRegistry,
    pub(super) resources: Arc<Mutex<ResourceStore>>,
    memory_diagnostics: ash_memory_diagnostics::MemoryDiagnostics,
    memories: Option<Arc<memories::Memories>>,
    pub(super) attachment_uploads: Mutex<AttachmentUploadStore>,
    pub(super) collaboration: Mutex<collaboration_runtime::DocumentCollaborationStore>,
    pub(super) extensions: Mutex<ExtensionCatalog>,
    pub(super) config: Option<Arc<ConfigStore>>,
    pub(super) provider_credentials: Option<Arc<ProviderCredentialService>>,
    pub(super) local_tool_config: Arc<RwLock<crate::local_tools::LocalToolConfig>>,
    pub(super) connectors: Option<Arc<connectors::ConnectorCredentialService>>,
    pub(super) connector_oauth: Option<Arc<connectors::ConnectorOAuthService>>,
    pub(super) connector_device_oauth: Option<Arc<connectors::ConnectorDeviceOAuthService>>,
    pub(super) mcp_oauth: Option<Arc<ash_mcp_extension::McpOAuthService>>,
    pub(super) plugins: Option<ash_core_plugins::PluginActivationAuthority>,
    extension_hosts: Option<extension_host_runtime::ExtensionHostRuntime>,
    pub(super) plugin_package_service: Option<Arc<dyn ash_core_plugins::PluginPackageService>>,
    plugins_manager: Option<Arc<ash_core_plugins::PluginsManager>>,
    marketplace_editor_extension_admission:
        Option<Arc<dyn crate::MarketplaceEditorExtensionAdmission>>,
    marketplace_language_runtime: Option<marketplace_language_runtime::MarketplaceLanguageRuntime>,
    plugin_skill_sources: Option<Arc<dyn ash_skills_extension::DynamicSkillSourceProvider>>,
    marketplace_skill_sources: Option<Arc<dyn ash_skills_extension::DynamicSkillSourceProvider>>,
    plugin_extension_sources: Option<Arc<dyn ash_extensions::DynamicExtensionSourceProvider>>,
    marketplace_extension_sources: Option<Arc<dyn ash_extensions::DynamicExtensionSourceProvider>>,
    pub(super) mcp_runtime_intents: McpRuntimeIntents,
    pub(super) mcp_status: Arc<RwLock<ash_mcp_extension::McpRuntimeStatusSnapshot>>,
    language: Mutex<language_runtime::AppServerLanguageRuntime>,
    approval_review_model: Option<ProviderReviewModel>,
    login: Option<Arc<ash_login::LoginService>>,
    pub(super) env_runtime_gate: Arc<Mutex<()>>,
    env_runtime: Arc<RwLock<EnvRuntime>>,
    turn_backend: Arc<turn_backend_router::TurnBackendHandle>,
    local_env_host: Option<LocalEnvHost>,
    dynamic_tool_port: Option<crate::tool_composition::ToolPort>,
    extension_tool_port: Option<crate::tool_composition::ToolPort>,
    browser_host: Arc<BrowserHost>,
    browser_tool_port: crate::tool_composition::ToolPort,
    env_state: EnvStateMode,
    fast_regex_worker_command: Option<ash_fast_regex_search::FastRegexWorkerCommand>,
    codebase_models: Option<CodebaseModels>,
    provider_runtime: Option<Arc<ash_model_provider::ModelProviderRuntime>>,
    semantic_model_provider: Option<Arc<dyn ash_model_provider::SemanticModelProvider>>,
    cloud_codebase_storage_root: Option<std::path::PathBuf>,
    cloud_codebase_providers: ash_cloud_codebase::CloudCodebaseProviderRegistry,
    pub(super) typst: TypstCompiler,
    pub(super) slash_commands: SlashCommandCatalog,
    agent_extensions: Arc<ExtensionRegistry>,
    notes: Option<Arc<history_notes::NotesStore>>,
    pub(super) skills: Option<Arc<SkillRuntime>>,
    _skill_watcher: Option<SkillWatcher>,
    _config_watcher: Option<config_runtime::ConfigWatcher>,
    _connector_watcher: Option<connector_runtime::ConnectorWatcher>,
    _plugin_watcher: Option<plugin_runtime::PluginWatcher>,
    _marketplace_watcher: Option<marketplace_runtime::MarketplaceChangeWatcher>,
    _tool_config_watcher: Option<crate::local::ToolConfigWatcher>,
    _interaction_deadline_watcher: interaction_runtime::InteractionDeadlineWatcher,
    git_turn_changes: Option<Arc<git_turn_changes_runtime::GitTurnChangesRuntime>>,
    issue_runtime: Option<Arc<issue_runtime::IssueRuntime>>,
    issue_cache: Option<Arc<Mutex<ash_state::SqliteIssueCache>>>,
    projects: Option<Arc<ash_projects::ProjectCoordinator>>,
    automation: Option<Arc<ash_automation::AutomationStore>>,
    updates: Arc<UpdateBroker>,
}

#[derive(Clone, Default)]
enum EnvStateMode {
    #[default]
    Unconfigured,
    Ephemeral,
    Persistent(std::sync::Arc<ash_state::StateRuntime>),
}

impl EnvStateMode {
    fn runtime(&self) -> Option<std::sync::Arc<ash_state::StateRuntime>> {
        match self {
            Self::Persistent(runtime) => Some(std::sync::Arc::clone(runtime)),
            Self::Unconfigured | Self::Ephemeral => None,
        }
    }
}

#[derive(Clone, Debug, Default)]
pub struct ConnectionState {
    pub(super) connection_id: u64,
    authority: ConnectionAuthority,
    state: Arc<Mutex<ConnectionMutableState>>,
    outbound_notifications: NotificationQueue,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
enum ConnectionAuthority {
    #[default]
    Client,
    ProductHost,
}

#[derive(Debug, Default)]
struct ConnectionMutableState {
    closed: bool,
    initialized: bool,
    request_ids: BTreeSet<u64>,
    marketplace_leases: BTreeSet<String>,
    dir_permissions_host: bool,
}

impl ConnectionState {
    fn is_closed(&self) -> bool {
        connection_state(self).closed
    }

    fn mark_closed(&self) -> bool {
        let mut state = connection_state(self);
        let was_open = !state.closed;
        state.closed = true;
        was_open
    }

    fn is_initialized(&self) -> bool {
        connection_state(self).initialized
    }

    fn set_initialized(&self) {
        connection_state(self).initialized = true;
    }

    fn record_request_id(&self, request_id: u64) -> bool {
        connection_state(self).request_ids.insert(request_id)
    }

    fn set_dir_permissions_host(&self, supported: bool) {
        connection_state(self).dir_permissions_host = supported;
    }

    fn allows_product_host_capabilities(&self) -> bool {
        self.authority == ConnectionAuthority::ProductHost
    }

    pub(super) fn supports_dir_permissions_host(&self) -> bool {
        connection_state(self).dir_permissions_host
    }

    fn marketplace_leases(&self) -> Vec<String> {
        connection_state(self)
            .marketplace_leases
            .iter()
            .cloned()
            .collect()
    }

    pub(super) fn add_marketplace_lease(&self, lease_id: String) {
        connection_state(self).marketplace_leases.insert(lease_id);
    }

    pub(super) fn remove_marketplace_lease(&self, lease_id: &str) {
        connection_state(self).marketplace_leases.remove(lease_id);
    }

    pub(super) fn owns_marketplace_lease(&self, lease_id: &str) -> bool {
        connection_state(self).marketplace_leases.contains(lease_id)
    }
}

fn connection_state(
    connection: &ConnectionState,
) -> std::sync::MutexGuard<'_, ConnectionMutableState> {
    connection
        .state
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

/// A wakeable source for outbound notifications owned by one App Server connection.
///
/// Connection hosts wait on this source independently from request dispatch, then drain the
/// pending protocol notifications. Closing the connection wakes any blocked listener.
pub struct ConnectionNotifications {
    listener: NotificationListener,
}

#[derive(Default)]
struct ConnectionDispatchActivity {
    active: Mutex<usize>,
    idle: Condvar,
}

impl ConnectionDispatchActivity {
    fn enter(self: &Arc<Self>) -> ConnectionDispatchGuard {
        *self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) += 1;
        ConnectionDispatchGuard {
            activity: Arc::clone(self),
        }
    }

    fn while_idle<T>(&self, operation: impl FnOnce() -> T) -> T {
        let mut active = self
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        while *active != 0 {
            active = self
                .idle
                .wait(active)
                .unwrap_or_else(std::sync::PoisonError::into_inner);
        }
        operation()
    }
}

struct ConnectionDispatchGuard {
    activity: Arc<ConnectionDispatchActivity>,
}

impl Drop for ConnectionDispatchGuard {
    fn drop(&mut self) {
        let mut active = self
            .activity
            .active
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        *active -= 1;
        if *active == 0 {
            self.activity.idle.notify_all();
        }
    }
}

impl ConnectionNotifications {
    /// Blocks until notifications are available or the connection closes.
    pub fn wait(&self) -> bool {
        self.listener.wait()
    }

    /// Drains all currently queued notifications as JSON-RPC messages.
    pub fn drain(&self) -> Vec<String> {
        self.listener
            .drain()
            .into_iter()
            .map(serialize_response)
            .collect()
    }

    /// Closes this notification source and wakes blocked listeners.
    pub fn close(&self) {
        self.listener.close();
    }
}

impl AppServer {
    pub(crate) fn agent_extension_registry(&self) -> Arc<ExtensionRegistry> {
        self.agent_extensions.clone()
    }

    /// Returns the number of live PTYs, including terminals waiting for a reconnect lease.
    ///
    /// Long-lived process hosts use this signal to avoid stopping while a detached terminal can
    /// still be recovered. A poisoned terminal registry is conservatively treated as non-empty.
    pub fn active_terminal_count(&self) -> usize {
        self.configured_terminal_services()
            .into_iter()
            .map(|terminals| terminals.active_count())
            .sum()
    }

    pub fn new(threads: Arc<ThreadController>, model: Arc<dyn ModelService>) -> Self {
        let updates = Arc::new(UpdateBroker::default());
        Self::new_with_updates(threads, model, updates)
    }

    pub(crate) fn new_with_updates(
        threads: Arc<ThreadController>,
        model: Arc<dyn ModelService>,
        updates: Arc<UpdateBroker>,
    ) -> Self {
        let mut builder = ash_extension_api::ExtensionRegistryBuilder::new();
        goal::install(&mut builder, &threads);
        let agent_extensions = Arc::new(builder.build());
        threads
            .install_extensions(Arc::clone(&agent_extensions))
            .expect("a new Thread controller accepts its initial extension registry");
        let env_runtime_gate = Arc::new(Mutex::new(()));
        let interaction_deadline_watcher = interaction_runtime::InteractionDeadlineWatcher::start(
            threads.clone(),
            updates.clone(),
            env_runtime_gate.clone(),
        );
        let resources = Arc::new(Mutex::new(ResourceStore::default()));
        let browser_host = Arc::new(BrowserHost::new(Arc::clone(&resources)));
        let browser_tool_port = crate::tool_composition::ToolPort::host(
            Arc::new(BrowserToolService::new(Arc::clone(&browser_host))),
            Arc::new(BrowserToolPolicy),
        );
        let turn_executor = TurnExecutor::without_tools(threads.clone(), model.clone())
            .with_thread_updates(Arc::new(AppServerThreadUpdates {
                threads: Arc::clone(&threads),
                updates: updates.clone(),
            }))
            .with_extensions(Arc::clone(&agent_extensions));
        let multi_agent = Arc::new(MultiAgentCoordinator::new(
            Arc::clone(&threads),
            AgentTreeLimits::default(),
        ));
        let turn_backend = Arc::new(turn_backend_router::TurnBackendHandle::new(
            turn_executor.clone(),
        ));
        let env_runtime = Arc::new(RwLock::new(EnvRuntime::empty(turn_executor)));
        let diagnostics = diagnostics::Diagnostics::default();
        let telemetry = ash_otel::Telemetry::new(diagnostics.clone());
        Self {
            queue: None,
            queue_directory: None,
            diagnostics,
            telemetry,
            analytics: Arc::new(analytics::Analytics::default()),
            feedback: feedback::Feedback::default(),
            threads,
            thread_worktree_binder: Arc::new(ash_core::NoThreadWorktreeBinder),
            multi_agent,
            model,
            model_catalog: unavailable_model_catalog(),
            model_instructions: ash_models_manager::ModelInstructionCatalog::built_in(),
            request_scheduler: RequestScheduler::default(),
            request_cancellations: RequestCancellationRegistry::default(),
            resources,
            memory_diagnostics: ash_memory_diagnostics::MemoryDiagnostics::default(),
            memories: None,
            attachment_uploads: Mutex::new(AttachmentUploadStore::default()),
            collaboration: Mutex::new(collaboration_runtime::DocumentCollaborationStore::default()),
            extensions: Mutex::new(ExtensionCatalog::default()),
            config: None,
            provider_credentials: None,
            local_tool_config: Arc::new(
                RwLock::new(crate::local_tools::LocalToolConfig::default()),
            ),
            connectors: None,
            connector_oauth: None,
            connector_device_oauth: None,
            mcp_oauth: None,
            plugins: None,
            extension_hosts: None,
            plugin_package_service: None,
            plugins_manager: None,
            marketplace_editor_extension_admission: None,
            marketplace_language_runtime: None,
            plugin_skill_sources: None,
            marketplace_skill_sources: None,
            plugin_extension_sources: None,
            marketplace_extension_sources: None,
            mcp_runtime_intents: McpRuntimeIntents::default(),
            mcp_status: Arc::new(RwLock::new(
                ash_mcp_extension::McpRuntimeStatusSnapshot::empty(1),
            )),
            language: Mutex::new(language_runtime::AppServerLanguageRuntime::new(
                updates.clone(),
            )),
            approval_review_model: None,
            login: None,
            env_runtime_gate,
            env_runtime,
            turn_backend,
            local_env_host: None,
            dynamic_tool_port: None,
            extension_tool_port: None,
            browser_host,
            browser_tool_port,
            env_state: EnvStateMode::Unconfigured,
            fast_regex_worker_command: None,
            codebase_models: None,
            provider_runtime: None,
            semantic_model_provider: None,
            cloud_codebase_storage_root: None,
            cloud_codebase_providers: ash_cloud_codebase::CloudCodebaseProviderRegistry::default(),
            typst: TypstCompiler::new(),
            slash_commands: SlashCommandCatalog::default(),
            agent_extensions,
            notes: None,
            skills: None,
            _skill_watcher: None,
            _config_watcher: None,
            _connector_watcher: None,
            _plugin_watcher: None,
            _marketplace_watcher: None,
            _tool_config_watcher: None,
            _interaction_deadline_watcher: interaction_deadline_watcher,
            git_turn_changes: None,
            issue_runtime: None,
            issue_cache: None,
            projects: None,
            automation: None,
            updates,
        }
    }

    fn with_git_turn_changes_runtime(
        mut self,
        runtime: Arc<git_turn_changes_runtime::GitTurnChangesRuntime>,
    ) -> Result<Self, String> {
        self.thread_worktree_binder = runtime.clone();
        if let Err(error) = self.threads.collect_message_checkpoints(runtime.as_ref()) {
            log::warn!("message checkpoint cleanup remains pending: {error}");
        }
        self.multi_agent
            .install_thread_worktree_binder(runtime.clone())
            .map_err(|error| error.to_string())?;
        let observer: Arc<dyn ash_core::TurnExecutionObserver> = runtime.clone();
        let executor = self
            .env_runtime
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .turn_executor
            .clone()
            .with_execution_observer(observer);
        self.turn_backend.install_executor(executor.clone());
        self.env_runtime
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .turn_executor = executor;
        self.git_turn_changes = Some(runtime);
        Ok(self)
    }

    pub(crate) fn with_local_dir_services(
        mut self,
        database_path: &std::path::Path,
        profile_root: &std::path::Path,
        dir_root: &std::path::Path,
    ) -> Result<Self, String> {
        let config = self
            .config
            .as_ref()
            .cloned()
            .ok_or_else(|| "local directory services require the ConfigStore".to_string())?;
        let file_access = Arc::clone(
            &self
                .env_runtime
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .dir_grants,
        );
        let hooks = self
            .local_hook_runtime()
            .ok_or_else(|| "local directory services require the Hook runtime".to_string())?;
        self.issue_runtime = Some(issue_runtime::IssueRuntime::open(dir_root)?);
        let dirs = thread_dirs::ThreadDirs::open(
            profile_root,
            dir_root,
            config.as_ref(),
            file_access,
            hooks,
        )?;
        let runtime = git_turn_changes_runtime::GitTurnChangesRuntime::open(
            database_path,
            config,
            Arc::clone(&self.threads),
            Arc::clone(&self.model),
            dirs,
            Arc::clone(&self.updates),
        )?;
        let mut server = self.with_git_turn_changes_runtime(runtime)?;
        server.issue_cache = Some(Arc::new(Mutex::new(ash_state::SqliteIssueCache::open(
            database_path,
        )?)));
        Ok(server)
    }

    pub(crate) fn with_local_projects(
        mut self,
        database_path: &std::path::Path,
    ) -> Result<Self, String> {
        let store: Arc<dyn ash_projects::ProjectStore> = Arc::new(
            ash_state::SqliteProjectStore::open(database_path)
                .map_err(|error| error.to_string())?,
        );
        self.projects = Some(Arc::new(ash_projects::ProjectCoordinator::new(store)));
        self.with_memory_extension()
    }

    pub(crate) fn with_local_memories(
        mut self,
        database_path: &std::path::Path,
    ) -> Result<Self, String> {
        let store: Arc<dyn memories::MemoryStore> = Arc::new(
            ash_state::SqliteMemoryStore::open(database_path)
                .map_err(|error| error.to_string())?,
        );
        self.memories = Some(Arc::new(memories::Memories::new(store)));
        self.with_memory_extension()
    }

    pub fn connection(&self) -> ConnectionState {
        self.open_connection(ConnectionAuthority::Client)
    }

    /// Creates a connection whose host-only capabilities may be enabled during initialization.
    ///
    /// Only a product composition root may hand this connection to a client. Wire clients cannot
    /// promote a regular connection by declaring a capability in their initialize payload.
    pub fn product_host_connection(&self) -> ConnectionState {
        self.open_connection(ConnectionAuthority::ProductHost)
    }

    fn open_connection(&self, authority: ConnectionAuthority) -> ConnectionState {
        let connection = ConnectionState {
            connection_id: self.updates.allocate_connection_id(),
            authority,
            ..ConnectionState::default()
        };
        self.updates.register(
            connection.connection_id,
            authority == ConnectionAuthority::ProductHost,
            &connection.outbound_notifications,
        );
        connection
    }

    /// Installs immutable language-server providers prepared by the product composition root.
    pub fn with_language_server_providers(
        mut self,
        providers: ash_lsp_server_provider::LspServerProviders,
    ) -> Self {
        self.language
            .get_mut()
            .expect("new App Server language runtime mutex is not poisoned")
            .set_server_providers(providers);
        self
    }

    pub(crate) fn with_marketplace_language_runtime(
        mut self,
        runtime: marketplace_language_runtime::MarketplaceLanguageRuntime,
    ) -> Result<Self, String> {
        let providers = runtime.providers()?;
        self.language
            .get_mut()
            .map_err(|_| "new App Server language runtime mutex is poisoned".to_string())?
            .set_server_providers(providers);
        self.marketplace_language_runtime = Some(runtime);
        Ok(self)
    }

    /// Installs a Plugin package service when no local Plugins Manager is available.
    pub fn with_plugin_package_service(
        mut self,
        service: Arc<dyn ash_core_plugins::PluginPackageService>,
    ) -> Self {
        self._marketplace_watcher = None;
        self.plugins_manager = None;
        self.plugin_package_service = Some(service);
        self
    }

    /// Installs the local Plugins Manager and its trusted capability sources.
    pub fn with_plugins_manager(self, manager: Arc<ash_core_plugins::PluginsManager>) -> Self {
        let watcher = marketplace_runtime::MarketplaceChangeWatcher::start(
            &manager,
            Arc::clone(&self.updates),
        );
        self.bind_plugins_manager(manager, watcher)
    }

    pub(crate) fn with_profile_plugins_manager(
        self,
        manager: Arc<ash_core_plugins::PluginsManager>,
    ) -> Self {
        self.bind_plugins_manager(manager, None)
    }

    fn bind_plugins_manager(
        mut self,
        manager: Arc<ash_core_plugins::PluginsManager>,
        watcher: Option<marketplace_runtime::MarketplaceChangeWatcher>,
    ) -> Self {
        self._marketplace_watcher = watcher;
        let source: Arc<dyn ash_skills_extension::DynamicSkillSourceProvider> = Arc::new(
            marketplace_skill_sources::MarketplaceSkillSourceProvider::new(Arc::clone(&manager)),
        );
        self.marketplace_skill_sources = Some(source);
        let extension_source: Arc<dyn ash_extensions::DynamicExtensionSourceProvider> = Arc::new(
            marketplace_extension_sources::MarketplaceExtensionSourceProvider::new(Arc::clone(
                &manager,
            )),
        );
        self.marketplace_extension_sources = Some(extension_source);
        self.plugin_package_service = Some(manager.clone());
        self.plugins_manager = Some(manager);
        self.rebind_dynamic_skill_sources();
        self.rebind_dynamic_extension_sources();
        self
    }

    /// Opens a wakeable outbound-notification source for `connection`.
    pub fn connection_notifications(
        &self,
        connection: &ConnectionState,
    ) -> ConnectionNotifications {
        ConnectionNotifications {
            listener: connection.outbound_notifications.listener(),
        }
    }

    /// Releases connection-scoped subscriptions and runtime resources.
    pub fn close_connection(&self, connection: ConnectionState) {
        if !connection.mark_closed() {
            return;
        }
        self.memory_diagnostics
            .close_owner(connection.connection_id);
        self.feedback.close(connection.connection_id);
        self.request_scheduler
            .cancel_connection(connection.connection_id);
        self.request_cancellations
            .cancel_connection(connection.connection_id);
        if let Ok(git) = self.git_runtime_service() {
            git.close_connection(connection.connection_id);
        }
        if let Some(marketplace) = &self.plugin_package_service {
            let _change = self.updates.lock_marketplace_change();
            for lease_id in connection.marketplace_leases() {
                match marketplace
                    .release_capability(ash_core_plugins::ReleaseCapabilityRequest { lease_id })
                {
                    Ok(outcome) => {
                        self.reconcile_released_marketplace_capability(outcome.installation_changed)
                    }
                    Err(error) => {
                        log::warn!(
                            "failed to release Marketplace capability on disconnect: {error}"
                        );
                    }
                }
            }
        }
        self.browser_host.unregister(connection.connection_id);
        if let Err(error) = self.synchronize_browser_tool_availability()
            && let Some(host) = &self.local_env_host
        {
            host.record_tool_reconcile_failure(error);
        }
        let lost_dynamic_tools = self.updates.unregister(connection.connection_id);
        self.cancel_lost_dynamic_tool_owners(lost_dynamic_tools);
        connection.outbound_notifications.close();
        if let Ok(mut resources) = self.resources.lock() {
            resources.release_owner(connection.connection_id);
        }
        if let Ok(mut uploads) = self.attachment_uploads.lock() {
            uploads.release_owner(connection.connection_id);
        }
        for terminals in self.configured_terminal_services() {
            terminals.close_owner(connection.connection_id);
        }
        for debug_adapters in self.configured_debug_adapter_services() {
            debug_adapters.close_owner(connection.connection_id);
        }
        if let Some(extension_hosts) = &self.extension_hosts {
            extension_hosts.close_owner(connection.connection_id);
        }
        self.request_scheduler
            .finish_connection(connection.connection_id);
    }

    fn synchronize_browser_tool_availability(&self) -> Result<(), String> {
        let Some(host) = &self.local_env_host else {
            return Ok(());
        };
        loop {
            let (revision, available) = self.browser_host.owner_availability();
            host.replace_browser_host_available(available)
                .map_err(|error| error.to_string())?;
            if self.browser_host.owner_availability().0 == revision {
                return Ok(());
            }
        }
    }

    fn cancel_lost_dynamic_tool_owners(&self, requests: Vec<ash_protocol::AgentRequestEnvelope>) {
        for request in requests {
            let Ok(_mutation) = self.env_runtime_gate.lock() else {
                return;
            };
            let Ok(snapshot) = self.threads.read_thread(&request.thread_id) else {
                continue;
            };
            let still_pending = snapshot
                .turns
                .iter()
                .find(|turn| turn.turn_id == request.turn_id)
                .and_then(|turn| turn.pending_interaction.as_ref())
                .is_some_and(|interaction| {
                    interaction.request_id == request.interaction.request_id
                });
            if !still_pending {
                continue;
            }
            let before_sequence = snapshot.sequence;
            let cancelled = if let Ok(cancelled) = self.threads.cancel_turn_interaction(
                &request.thread_id,
                CancelTurnInteractionRequest {
                    turn_id: request.turn_id.clone(),
                    request_id: request.interaction.request_id.clone(),
                    reason: InteractionCancelReason::OwnerDisconnected,
                },
            ) {
                cancelled
            } else {
                continue;
            };
            if let Ok(updates) = self
                .threads
                .thread_updates_after(&request.thread_id, before_sequence)
            {
                self.updates.publish_thread(&request.thread_id, &updates);
            }
            if !cancelled.live_execution_woken {
                let _ = self
                    .turn_backend
                    .resume(&request.thread_id, &request.turn_id);
            }
        }
    }

    pub(crate) fn with_telemetry(
        mut self,
        diagnostics: diagnostics::Diagnostics,
        telemetry: ash_otel::Telemetry,
        analytics: Arc<analytics::Analytics>,
    ) -> Self {
        self.diagnostics = diagnostics;
        self.telemetry = telemetry;
        self.analytics = analytics;
        self
    }

    fn restart_extension_config_watcher(&mut self) {
        if let Some(config) = &self.config {
            self._config_watcher = Some(config_runtime::ConfigWatcher::start(
                config,
                self.updates.clone(),
                self.agent_extensions.clone(),
            ));
        }
    }

    pub fn with_config_store(mut self, config: Arc<ConfigStore>) -> Self {
        let mut builder =
            ash_extension_api::ExtensionRegistryBuilder::from_registry(&self.agent_extensions);
        builder.lifecycle_observer(
            "analytics",
            Arc::new(runtime_extensions::UsageObserver {
                analytics: self.analytics.clone(),
                config: config.clone(),
            }),
        );
        self.agent_extensions = Arc::new(builder.build());
        self.threads
            .install_extensions(self.agent_extensions.clone())
            .expect("new extension registry");
        self.agent_extensions.config_changed(0);
        self._config_watcher = Some(config_runtime::ConfigWatcher::start(
            &config,
            Arc::clone(&self.updates),
            Arc::clone(&self.agent_extensions),
        ));
        self.config = Some(config);
        self
    }

    /// Installs the redacted interactive-account control plane.
    pub fn with_login_service(mut self, login: Arc<ash_login::LoginService>) -> Self {
        login
            .install_events(Arc::new(account_operations::AppServerLoginEvents::new(
                Arc::clone(&self.updates),
            )))
            .expect("a newly composed login service accepts its App Server event sink");
        self.login = Some(login);
        self
    }

    /// Installs the product-owned Connector credential service and change notifications.
    pub fn with_connector_service(
        mut self,
        connectors: Arc<connectors::ConnectorCredentialService>,
    ) -> Self {
        self._connector_watcher = Some(connector_runtime::ConnectorWatcher::start(
            connectors.authority(),
            Arc::clone(&self.updates),
        ));
        self.connectors = Some(connectors);
        self
    }

    /// Installs product-owned OAuth provider adapters over the configured Connector authority.
    pub fn with_connector_oauth_service(
        mut self,
        oauth: Arc<connectors::ConnectorOAuthService>,
    ) -> Self {
        self.connector_oauth = Some(oauth);
        self
    }

    /// Installs product-owned OAuth device provider adapters over Connector authority.
    pub fn with_connector_device_oauth_service(
        mut self,
        oauth: Arc<connectors::ConnectorDeviceOAuthService>,
    ) -> Self {
        self.connector_device_oauth = Some(oauth);
        self
    }

    /// Installs product-owned OAuth provider adapters for standalone MCP servers.
    pub fn with_mcp_oauth_service(
        mut self,
        oauth: Arc<ash_mcp_extension::McpOAuthService>,
    ) -> Self {
        self.mcp_oauth = Some(oauth);
        self
    }

    /// Installs live Plugin lifecycle authority and product notifications.
    pub fn with_plugin_authority(
        mut self,
        plugins: ash_core_plugins::PluginActivationAuthority,
    ) -> Self {
        self._plugin_watcher = Some(plugin_runtime::PluginWatcher::start(
            &plugins,
            Arc::clone(&self.updates),
            self.skills.clone(),
        ));
        let skill_sources: Arc<dyn ash_skills_extension::DynamicSkillSourceProvider> = Arc::new(
            plugin_skill_sources::PluginSkillSourceProvider::new(plugins.clone()),
        );
        self.plugin_skill_sources = Some(skill_sources);
        self.rebind_dynamic_skill_sources();
        let extension_sources: Arc<dyn ash_extensions::DynamicExtensionSourceProvider> =
            Arc::new(plugin_extension_sources::PluginExtensionSourceProvider::new(plugins.clone()));
        self.plugin_extension_sources = Some(extension_sources);
        self.rebind_dynamic_extension_sources();
        self.plugins = Some(plugins);
        self
    }

    fn rebind_dynamic_skill_sources(&self) {
        let Some(combined) = self.combined_dynamic_skill_sources() else {
            return;
        };
        if let Some(runtime) = &self.skills
            && let Err(error) = runtime.bind_dynamic_sources(combined)
        {
            log::error!("failed to bind dynamic Skill sources: {error}");
        }
    }

    fn combined_dynamic_skill_sources(
        &self,
    ) -> Option<Arc<dyn ash_skills_extension::DynamicSkillSourceProvider>> {
        let providers = [
            self.plugin_skill_sources.clone(),
            self.marketplace_skill_sources.clone(),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
        (!providers.is_empty()).then(|| {
            Arc::new(marketplace_skill_sources::CombinedSkillSourceProvider::new(
                providers,
            )) as Arc<dyn ash_skills_extension::DynamicSkillSourceProvider>
        })
    }

    fn rebind_dynamic_extension_sources(&self) {
        let Some(provider) = self.combined_dynamic_extension_sources() else {
            return;
        };
        if let Ok(mut catalog) = self.extensions.lock() {
            catalog.bind_dynamic_sources(provider);
        }
    }

    fn combined_dynamic_extension_sources(
        &self,
    ) -> Option<Arc<dyn ash_extensions::DynamicExtensionSourceProvider>> {
        let providers = [
            self.plugin_extension_sources.clone(),
            self.marketplace_extension_sources.clone(),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
        (!providers.is_empty()).then(|| {
            Arc::new(marketplace_extension_sources::CombinedExtensionSourceProvider::new(providers))
                as Arc<dyn ash_extensions::DynamicExtensionSourceProvider>
        })
    }

    /// Enables executable Editor Extensions over one explicitly injected process launcher.
    ///
    /// At least one executable Extension source must be installed first: legacy Plugin authority,
    /// or a local Marketplace Manager paired with product admission policy. Without this opt-in,
    /// App Server advertises no executable Extension Host capability and never starts package code.
    pub fn with_extension_host_runtime(
        mut self,
        launcher: Arc<dyn ash_editor_extension_host::ExtensionHostLauncher>,
        limits: ash_editor_extension_host::ExtensionHostLimits,
        restart_policy: ash_editor_extension_host::RestartPolicy,
    ) -> Result<Self, String> {
        let marketplace_source =
            self.plugins_manager.is_some() && self.marketplace_editor_extension_admission.is_some();
        if self.plugins.is_none() && !marketplace_source {
            return Err(
                "Plugin authority or Marketplace Editor Extension admission must be installed before Extension Host runtime"
                    .to_string(),
            );
        }
        let runtime = extension_host_runtime::ExtensionHostRuntime::start(
            self.plugins.clone(),
            self.plugins_manager.clone(),
            self.marketplace_editor_extension_admission.clone(),
            launcher,
            limits,
            restart_policy,
            Arc::clone(&self.updates),
        )
        .map_err(|error| error.to_string())?;
        if let Some(authorization) = self.extension_dir_authorization() {
            runtime
                .bind_dir(authorization)
                .map_err(|_| "failed to bind Extension Host directory authority".to_string())?;
        }
        self.extension_hosts = Some(runtime);
        Ok(self)
    }

    /// Installs product-local enable and grant authority for Marketplace Editor Extensions.
    ///
    /// This policy does not install packages and does not launch processes. It is consulted only
    /// when an explicitly configured Extension Host runtime consumes signed product sidecars.
    pub fn with_marketplace_editor_extension_admission(
        mut self,
        admission: Arc<dyn crate::MarketplaceEditorExtensionAdmission>,
    ) -> Self {
        self.marketplace_editor_extension_admission = Some(admission);
        self
    }

    pub(crate) fn with_mcp_status_snapshot(
        self,
        snapshot: ash_mcp_extension::McpRuntimeStatusSnapshot,
    ) -> Self {
        *self
            .mcp_status
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = snapshot;
        self
    }

    pub(crate) fn with_approval_review_model(
        mut self,
        review_model: Option<ProviderReviewModel>,
    ) -> Self {
        self.approval_review_model = review_model;
        self
    }

    pub fn with_agent_capabilities(
        mut self,
        notes: Arc<history_notes::NotesStore>,
        image_backend: Option<Arc<dyn image_generation::ImageGenerationBackend>>,
        artifact_root: &std::path::Path,
        attribution: Arc<dyn git_attribution::GitAttributionPolicySource>,
    ) -> Result<Self, String> {
        let mut builder =
            ash_extension_api::ExtensionRegistryBuilder::from_registry(&self.agent_extensions);
        let items = Arc::new(ash_extension_api::ExtensionItemStore::new(builder.state()));
        builder.item_contributor("results", items.clone());
        sleep::install(&mut builder, items.clone());
        history_notes::install(&mut builder, &self.threads, notes.clone());
        git_attribution::install(&mut builder, attribution);
        if let Some(backend) = image_backend {
            image_generation::install(
                &mut builder,
                backend,
                artifact_root,
                items,
                Arc::new(crate::image_references::ThreadImageReferences::new(
                    &self.threads,
                )),
            )?;
        }
        let registry = Arc::new(builder.build());
        let port = crate::extension_tools::compose_extension_tools(&registry)
            .map_err(|e| e.to_string())?;
        self.threads
            .install_extensions(registry.clone())
            .map_err(|e| e.to_string())?;
        let executor = self
            .env_runtime_mut()
            .turn_executor
            .clone()
            .with_extensions(registry.clone());
        self.turn_backend.install_executor(executor.clone());
        self.env_runtime_mut().turn_executor = executor;
        self.agent_extensions = registry;
        self.notes = Some(notes);
        self.restart_extension_config_watcher();
        self.with_extension_tool_port(port)
            .map_err(|e| e.to_string())
    }

    pub fn with_slash_command_catalog(mut self, slash_commands: SlashCommandCatalog) -> Self {
        self.slash_commands = slash_commands;
        self
    }

    pub(crate) fn with_skill_runtime(
        mut self,
        built_in_source: ash_skills_extension::BuiltInSkillSource,
        config: Arc<dyn SkillConfigSnapshotProvider>,
        web_search_backend: Option<Arc<dyn ash_web_search_extension::WebSearchBackend>>,
    ) -> Result<Self, String> {
        let runtime = SkillRuntime::with_dynamic_sources(
            built_in_source,
            config,
            self.updates.clone(),
            self.combined_dynamic_skill_sources(),
        )?;
        let session_sources: Arc<dyn ash_skills_extension::SessionSkillSourceProvider> =
            Arc::clone(&self.env_runtime_mut().dir_grants)
                as Arc<dyn ash_skills_extension::SessionSkillSourceProvider>;
        runtime.bind_session_sources(session_sources)?;
        let mut builder =
            ash_extension_api::ExtensionRegistryBuilder::from_registry(&self.agent_extensions);
        ash_skills_extension::install(&mut builder, Arc::clone(&runtime));
        if let Some(backend) = web_search_backend {
            ash_web_search_extension::install(&mut builder, backend);
        }
        let agent_extensions = Arc::new(builder.build());
        let extension_tool_port =
            crate::extension_tools::compose_extension_tools(agent_extensions.as_ref())
                .map_err(|error| error.to_string())?;
        self.threads
            .install_extensions(Arc::clone(&agent_extensions))
            .map_err(|error| error.to_string())?;
        self._skill_watcher = Some(runtime.start_watching());
        let executor = self
            .env_runtime_mut()
            .turn_executor
            .clone()
            .with_extensions(Arc::clone(&agent_extensions));
        self.turn_backend.install_executor(executor.clone());
        self.env_runtime_mut().turn_executor = executor;
        self.agent_extensions = agent_extensions;
        self.restart_extension_config_watcher();
        self = self
            .with_extension_tool_port(extension_tool_port)
            .map_err(|error| error.to_string())?;
        self.skills = Some(runtime);
        Ok(self)
    }

    pub fn with_file_system(mut self, file_system: Arc<dyn FileSystem>) -> Self {
        self.env_runtime_mut().selected_file_system = Some(file_system);
        self
    }

    pub fn with_extension_roots(mut self, roots: Vec<ExtensionRoot>) -> Self {
        let mut catalog = ExtensionCatalog::new(roots);
        if let Some(provider) = self.combined_dynamic_extension_sources() {
            catalog.bind_dynamic_sources(provider);
        }
        self.extensions = Mutex::new(catalog);
        self
    }

    pub(crate) fn with_state_runtime(
        mut self,
        storage: std::sync::Arc<ash_state::StateRuntime>,
    ) -> Self {
        self.env_state = EnvStateMode::Persistent(storage);
        self
    }

    /// Selects process-local directory indexes for hosts that intentionally do not persist them.
    pub fn with_ephemeral_env_state(mut self) -> Self {
        self.env_state = EnvStateMode::Ephemeral;
        self
    }

    pub(crate) fn with_fast_regex_worker_command(
        mut self,
        command: ash_fast_regex_search::FastRegexWorkerCommand,
    ) -> Self {
        self.fast_regex_worker_command = Some(command);
        self
    }

    /// Installs immutable embedding/rerank adapters for local semantic indexing.
    pub(crate) fn with_codebase_models(mut self, models: CodebaseModels) -> Self {
        self.codebase_models = Some(models);
        self
    }

    pub(crate) fn with_provider_runtime(
        mut self,
        runtime: Arc<ash_model_provider::ModelProviderRuntime>,
    ) -> Self {
        self.provider_runtime = Some(runtime);
        self
    }

    pub(crate) fn with_semantic_model_provider(
        mut self,
        provider: Arc<dyn ash_model_provider::SemanticModelProvider>,
    ) -> Self {
        self.semantic_model_provider = Some(provider);
        self
    }

    pub(crate) fn with_cloud_codebase_storage_root(
        mut self,
        storage_root: impl Into<std::path::PathBuf>,
    ) -> Self {
        self.cloud_codebase_storage_root = Some(storage_root.into());
        self
    }

    /// Installs policy- and credential-bound cloud codebase provider adapters for this host.
    pub fn with_cloud_codebase_providers(
        mut self,
        providers: ash_cloud_codebase::CloudCodebaseProviderRegistry,
    ) -> Self {
        self.cloud_codebase_providers = providers;
        self
    }

    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn with_file_system_watcher(
        mut self,
        dir: ash_file_access::Dir,
    ) -> Result<Self, fs_watcher::FileSystemWatcherError> {
        let watcher = fs_watcher::FileSystemWatcher::start(dir, Arc::clone(&self.updates))?;
        self.env_runtime_mut()._file_system_watcher = Some(watcher);
        Ok(self)
    }

    pub(crate) fn with_model_catalog(mut self, model_catalog: Arc<dyn ModelCatalog>) -> Self {
        self.model_catalog = model_catalog;
        self
    }

    pub(crate) fn with_provider_credentials(
        mut self,
        provider_credentials: Arc<ProviderCredentialService>,
    ) -> Self {
        self.provider_credentials = Some(provider_credentials);
        self
    }

    /// Installs a synthetic backend for App Server unit tests.
    #[cfg(test)]
    pub(crate) fn with_turn_backend(self, backend: Arc<dyn TurnExecutionBackend>) -> Self {
        self.turn_backend.replace_for_test(backend);
        self
    }

    pub(super) fn use_current_env_turn_backend(&self) {
        self.turn_backend
            .install_current_environment(&self.env_runtime);
    }

    #[cfg(test)]
    pub(crate) fn turn_executor_backend(&self) -> Arc<dyn TurnExecutionBackend> {
        Arc::new(
            self.env_runtime
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .turn_executor
                .clone(),
        )
    }

    /// Enables directory-scoped Git queries without exposing arbitrary host paths to clients.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn with_git_root(
        mut self,
        authorization: ash_file_access::Authorization,
    ) -> Result<Self, git_runtime::GitRuntimeError> {
        let runtime = git_runtime::GitRuntime::new(authorization, Arc::clone(&self.updates))?;
        let state = self.env_runtime_mut();
        state._git_watcher = Some(runtime.start_watching());
        state.git = Some(runtime);
        Ok(self)
    }

    /// Enables connection-owned directory content search using one frozen ripgrep executable.
    pub fn with_content_search(
        mut self,
        dir: ash_file_access::Dir,
        ripgrep: ash_shell_command::RipgrepExecutable,
    ) -> Self {
        let search = Arc::new(ash_content_search::ContentSearchService::new(dir, ripgrep));
        self.env_runtime_mut().content_search = Some(search);
        self
    }

    /// Enables connection-owned and leased interactive terminals under one execution authorization.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn with_terminal_root(
        mut self,
        authorization: ash_file_access::Authorization,
    ) -> Result<Self, crate::terminal_service::TerminalError> {
        let terminals = Arc::new(crate::terminal_service::TerminalService::new(
            authorization,
        )?);
        self.env_runtime_mut().terminals = Some(terminals);
        Ok(self)
    }

    /// Enables connection-owned debug adapters under explicit config and execution authorizations.
    #[cfg_attr(not(test), allow(dead_code))]
    pub(crate) fn with_debug_adapter_root(
        mut self,
        executable_configuration: ash_file_access::Authorization,
        process_execution: ash_file_access::Authorization,
    ) -> Result<Self, ash_debug_adapter::DebugAdapterError> {
        let service = Arc::new(crate::debug_service::DebugAdapterService::new(
            executable_configuration,
            process_execution,
            crate::terminal_environment::safe_process_environment(),
        )?);
        self.env_runtime_mut().debug_adapters = Some(service);
        Ok(self)
    }

    /// Installs the tool registry and policy used by every Turn executed by this server.
    pub fn with_tool_service(
        mut self,
        tools: Arc<dyn ToolService>,
        policy: Arc<dyn ActionPolicyService>,
    ) -> Self {
        let policy = Arc::new(ApprovalModeActionPolicyService::new(
            policy,
            self.approval_review_model
                .clone()
                .map(guardian_v2::reviewer)
                .unwrap_or(ash_extension_api::ApprovalReviewer::Unavailable),
        ));
        let mut executor = self
            .env_runtime_mut()
            .turn_executor
            .clone()
            .with_tool_service(tools, policy)
            .with_thread_updates(Arc::new(AppServerThreadUpdates {
                threads: Arc::clone(&self.threads),
                updates: self.updates.clone(),
            }));
        executor = executor.with_extensions(Arc::clone(&self.agent_extensions));
        self.turn_backend.install_executor(executor.clone());
        self.env_runtime_mut().turn_executor = executor;
        self
    }

    pub(crate) fn with_tool_config_watcher(
        mut self,
        watcher: crate::local::ToolConfigWatcher,
    ) -> Self {
        self._tool_config_watcher = Some(watcher);
        self
    }

    fn env_runtime_mut(&mut self) -> &mut EnvRuntime {
        Arc::get_mut(&mut self.env_runtime)
            .expect("environment runtime cannot be mutated through a builder after it is shared")
            .get_mut()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Creates a root Thread using this environment's directory authority.
    /// The profile-wide Thread controller must not retain a mutable environment binder.
    pub fn start_thread(
        &self,
        request: ash_core::StartThreadRequest,
    ) -> Result<ash_core::ThreadSnapshot, ash_core::CoreError> {
        self.threads
            .start_thread(self.thread_worktree_binder.as_ref(), request)
    }

    /// Installs validated model guidance before environment tools are composed.
    pub fn with_model_instructions(
        mut self,
        catalog: ash_models_manager::ModelInstructionCatalog,
    ) -> Result<Self, CoreError> {
        if self.local_env_host.is_some() {
            return Err(CoreError::InvalidInput(
                "Model instructions must be installed before the environment runtime".into(),
            ));
        }
        self.model_instructions = Arc::new(catalog);
        Ok(self)
    }

    pub fn threads(&self) -> &Arc<ThreadController> {
        &self.threads
    }

    pub(crate) fn bind_session_extensions(&self) -> Result<(), CoreError> {
        for session_id in self.session_ids()? {
            self.updates.bind_session_scope(session_id.clone());
            self.threads
                .install_session_extensions(session_id, Arc::clone(&self.agent_extensions))?;
        }
        Ok(())
    }

    /// Reconciles durable Agent spawn/delivery sagas and starts newly materialized child Turns.
    pub fn resume_recovered_agent_coordinations(&self) -> Result<usize, CoreError> {
        agent::recover(
            &self.multi_agent,
            &self.threads,
            self.turn_backend.as_ref(),
            &self.loaded_session_ids()?,
        )
    }

    /// Re-enqueues durable running Tool continuations after host services are installed.
    pub fn resume_recovered_tool_continuations(&self) -> Result<usize, CoreError> {
        let session_ids = self.loaded_session_ids()?;
        self.turn_executor_snapshot()
            .resume_recovered_tool_continuations_in_sessions(&session_ids)
    }

    /// Restarts extension-owned work after the local runtime has been restored.
    pub fn resume_recovered_extension_turns(&self) -> Result<usize, CoreError> {
        let session_ids = self.loaded_session_ids()?;
        self.turn_executor_snapshot()
            .resume_recovered_extension_turns_in_sessions(&session_ids)
    }

    fn session_ids(&self) -> Result<BTreeSet<ash_protocol::SessionId>, CoreError> {
        Ok(self
            .threads
            .list_thread_catalog()?
            .into_iter()
            .map(|record| record.session_id)
            .collect())
    }

    fn loaded_session_ids(&self) -> Result<BTreeSet<ash_protocol::SessionId>, CoreError> {
        Ok(self
            .threads
            .list_loaded_threads()?
            .into_iter()
            .map(|thread| thread.session_id)
            .collect())
    }

    pub fn drain_notifications(&self, connection: &mut ConnectionState) -> Vec<String> {
        connection
            .outbound_notifications
            .drain()
            .into_iter()
            .map(serialize_response)
            .collect()
    }

    #[cfg(test)]
    pub(crate) fn publish_fs_changed_for_test(
        &self,
        changed: ash_app_server_protocol::protocol::fs::FsChanged,
    ) {
        self.updates.publish_fs_changed(changed);
    }

    pub fn create_resource(
        &self,
        connection: &ConnectionState,
        mime_type: String,
        bytes: Vec<u8>,
    ) -> Result<String, String> {
        self.resources
            .lock()
            .map_err(|_| "resource lock poisoned".to_string())?
            .create(
                connection.connection_id,
                mime_type,
                bytes,
                Duration::from_secs(300),
            )
            .map(|resource| resource.resource_id)
            .map_err(resource_error)
    }

    pub fn handle_json(&self, connection: &mut ConnectionState, raw: &str) -> String {
        let raw_request: Value = match serde_json::from_str(raw) {
            Ok(request) => request,
            Err(_) => {
                return serialize_response(error_response(
                    JsonRpcId::Null(()),
                    -32700,
                    AppServerErrorName::ParseError,
                ));
            }
        };
        let mut request = match serde_json::from_value::<JsonRpcRequest<Value>>(raw_request) {
            Ok(request)
                if request.jsonrpc == JsonRpcVersion::V2
                    && request.id.as_u64().is_some_and(|request_id| request_id > 0) =>
            {
                request
            }
            _ => {
                return serialize_response(error_response(
                    JsonRpcId::Null(()),
                    -32600,
                    AppServerErrorName::InvalidRequest,
                ));
            }
        };
        let request_id = request.id.as_u64().expect("validated request ID");
        if connection.is_closed()
            || self
                .request_scheduler
                .is_connection_cancelled(connection.connection_id)
        {
            return serialize_response(error_response(
                request.id,
                -32800,
                AppServerErrorName::RequestCancelled,
            ));
        }
        if !connection.record_request_id(request_id) {
            return serialize_response(error_response(
                request.id,
                -32600,
                AppServerErrorName::InvalidRequest,
            ));
        }
        let operation_id = match client_method_definition(&request.method)
            .map(|definition| definition.cancellation_operation_id(&request.params))
            .transpose()
        {
            Ok(operation_id) => operation_id.flatten(),
            Err(_) => {
                return serialize_response(error_response(
                    request.id,
                    -32602,
                    AppServerErrorName::InvalidParams,
                ));
            }
        };
        let serialization_scope = if client_method(&request.method)
            != Some(ClientMethod::Initialize)
            && !connection.is_initialized()
        {
            None
        } else {
            match client_method_definition(&request.method)
                .map(|definition| definition.serialization_scope(&request.params))
                .transpose()
            {
                Ok(scope) => scope.flatten(),
                Err(_) => {
                    return serialize_response(error_response(
                        request.id,
                        -32602,
                        AppServerErrorName::InvalidParams,
                    ));
                }
            }
        };
        let cancellation = match self.request_cancellations.start(
            connection.connection_id,
            request_id,
            operation_id,
        ) {
            Ok(cancellation) => cancellation,
            Err(_) => {
                return serialize_response(error_response(
                    request.id,
                    -32602,
                    AppServerErrorName::InvalidParams,
                ));
            }
        };
        let _permit = match serialization_scope {
            Some(scope) => match self.request_scheduler.acquire_with_cancellation(
                connection.connection_id,
                scope,
                &cancellation,
            ) {
                Ok(authorization) => Some(authorization),
                Err(_) => {
                    self.request_cancellations
                        .finish(connection.connection_id, request_id);
                    return serialize_response(error_response(
                        request.id,
                        -32800,
                        AppServerErrorName::RequestCancelled,
                    ));
                }
            },
            None => None,
        };
        let request_started = std::time::Instant::now();
        let response = if cancellation.is_cancelled() {
            error_response(request.id, -32800, AppServerErrorName::RequestCancelled)
        } else {
            let response = match self.dispatch(connection, &mut request, &cancellation) {
                Ok(result) => serde_json::to_value(JsonRpcSuccess::new(request.id.clone(), result))
                    .expect("JSON-RPC success response must serialize"),
                Err(error) => {
                    let mut response = AppServerError::new(error.code, error.message);
                    if let Some(detail) = error.detail {
                        response.message.push_str(&format!(": {detail}"));
                    }
                    serde_json::to_value(JsonRpcFailure::new(request.id.clone(), response))
                        .expect("error response must serialize")
                }
            };
            if cancellation.is_cancelled() {
                error_response(
                    request.id.clone(),
                    -32800,
                    AppServerErrorName::RequestCancelled,
                )
            } else {
                response
            }
        };
        self.request_cancellations
            .finish(connection.connection_id, request_id);
        self.telemetry.record(
            diagnostics::Activity::Rpc,
            if cancellation.is_cancelled() {
                diagnostics::Outcome::Cancelled
            } else if response.get("error").is_some() {
                diagnostics::Outcome::Failed
            } else {
                diagnostics::Outcome::Succeeded
            },
            request_started.elapsed(),
        );
        serialize_response(response)
    }

    pub fn serve_stdio(&self) -> Result<(), std::io::Error> {
        self.serve_product_host_jsonl(BufReader::new(std::io::stdin()), std::io::stdout())
    }

    pub fn serve_jsonl<R: BufRead, W: Write + Send>(
        &self,
        reader: R,
        writer: W,
    ) -> Result<(), std::io::Error> {
        self.serve_jsonl_connection(reader, writer, self.connection())
    }

    /// Serves a product-owned transport that may negotiate host-only capabilities.
    ///
    /// The caller must restrict the transport to the product's own process boundary, such as
    /// process stdio or a user-private local socket. Arbitrary JSONL peers must use `serve_jsonl`.
    pub fn serve_product_host_jsonl<R: BufRead, W: Write + Send>(
        &self,
        reader: R,
        writer: W,
    ) -> Result<(), std::io::Error> {
        self.serve_jsonl_connection(reader, writer, self.product_host_connection())
    }

    fn serve_jsonl_connection<R: BufRead, W: Write + Send>(
        &self,
        reader: R,
        writer: W,
        mut connection: ConnectionState,
    ) -> Result<(), std::io::Error> {
        let mut reader = JsonlReader::new(reader, DEFAULT_MAX_MESSAGE_BYTES);
        let notifications = self.connection_notifications(&connection);
        let activity = Arc::new(ConnectionDispatchActivity::default());
        let (inbound_tx, inbound_rx) = mpsc::sync_channel::<String>(INBOUND_REQUEST_QUEUE_CAPACITY);
        let inbound_rx = Arc::new(Mutex::new(inbound_rx));
        let (outbound_tx, outbound_rx) =
            mpsc::sync_channel::<String>(OUTBOUND_MESSAGE_QUEUE_CAPACITY);
        thread::scope(|scope| {
            let writer_handle = scope.spawn(move || {
                let mut writer = JsonlWriter::new(writer, DEFAULT_MAX_MESSAGE_BYTES);
                while let Ok(message) = outbound_rx.recv() {
                    writer.write_message(&message)?;
                }
                Ok::<(), std::io::Error>(())
            });
            let notification_tx = outbound_tx.clone();
            let notification_activity = Arc::clone(&activity);
            let notification_handle = scope.spawn(move || {
                while notifications.wait() {
                    let delivered = notification_activity.while_idle(|| {
                        for notification in notifications.drain() {
                            if notification_tx.send(notification).is_err() {
                                return false;
                            }
                        }
                        true
                    });
                    if !delivered {
                        return Ok(());
                    }
                }
                Ok::<(), std::io::Error>(())
            });
            let mut request_handles = Vec::with_capacity(CONNECTION_REQUEST_WORKERS);
            for worker_index in 0..CONNECTION_REQUEST_WORKERS {
                let worker_rx = Arc::clone(&inbound_rx);
                let worker_tx = outbound_tx.clone();
                let worker_activity = Arc::clone(&activity);
                let mut worker_connection = connection.clone();
                request_handles.push(
                    thread::Builder::new()
                        .name(format!("ash-app-server-request-{worker_index}"))
                        .spawn_scoped(scope, move || {
                            loop {
                                let line = worker_rx
                                    .lock()
                                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                                    .recv();
                                let Ok(mut line) = line else {
                                    return Ok::<(), std::io::Error>(());
                                };
                                let _dispatch = worker_activity.enter();
                                let response = self.handle_json(&mut worker_connection, &line);
                                line.zeroize();
                                if !response.is_empty() {
                                    worker_tx.send(response).map_err(|_| {
                                        std::io::Error::new(
                                            std::io::ErrorKind::BrokenPipe,
                                            "App Server outbound writer closed",
                                        )
                                    })?;
                                }
                            }
                        })?,
                );
            }
            let read_result = (|| {
                while let Some(mut line) = reader.read_message()? {
                    let envelope = serde_json::from_str::<Value>(&line).map_err(|error| {
                        std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            format!("invalid App Server inbound JSON: {error}"),
                        )
                    })?;
                    if envelope.get("method").is_none() {
                        let handled = self
                            .browser_host
                            .handle_response(connection.connection_id, envelope)
                            .map_err(|error| {
                                std::io::Error::new(std::io::ErrorKind::InvalidData, error)
                            })?;
                        line.zeroize();
                        if handled {
                            continue;
                        }
                        return Err(std::io::Error::new(
                            std::io::ErrorKind::InvalidData,
                            "App Server received an unknown JSON-RPC response",
                        ));
                    }
                    if connection.is_initialized() {
                        inbound_tx.send(line).map_err(|_| {
                            std::io::Error::new(
                                std::io::ErrorKind::BrokenPipe,
                                "App Server request workers closed",
                            )
                        })?;
                    } else {
                        let _dispatch = activity.enter();
                        let response = self.handle_json(&mut connection, &line);
                        line.zeroize();
                        if !response.is_empty() {
                            outbound_tx.send(response).map_err(|_| {
                                std::io::Error::new(
                                    std::io::ErrorKind::BrokenPipe,
                                    "App Server outbound writer closed",
                                )
                            })?;
                        }
                    }
                }
                Ok::<(), std::io::Error>(())
            })();
            if read_result.is_err() {
                self.request_scheduler
                    .cancel_connection(connection.connection_id);
            }
            drop(inbound_tx);
            let mut request_result = Ok(());
            for request_handle in request_handles {
                match request_handle.join() {
                    Ok(Ok(())) => {}
                    Ok(Err(error)) if request_result.is_ok() => request_result = Err(error),
                    Ok(Err(_)) => {}
                    Err(_) if request_result.is_ok() => {
                        request_result =
                            Err(std::io::Error::other("App Server request worker panicked"));
                    }
                    Err(_) => {}
                }
            }
            self.close_connection(connection);
            drop(outbound_tx);
            let notification_result = notification_handle
                .join()
                .map_err(|_| std::io::Error::other("App Server notification thread panicked"))?;
            let writer_result = writer_handle
                .join()
                .map_err(|_| std::io::Error::other("App Server writer thread panicked"))?;
            read_result?;
            request_result?;
            notification_result?;
            writer_result
        })
    }

    fn dispatch(
        &self,
        connection: &mut ConnectionState,
        request: &mut JsonRpcRequest<Value>,
        cancellation: &CancellationToken,
    ) -> Result<Value, RpcError> {
        if client_method(&request.method) == Some(ClientMethod::Initialize) {
            return self.initialize(connection, &request.params);
        }
        if !connection.is_initialized() {
            return Err(RpcError::new(-32001, AppServerErrorName::NotInitialized));
        }
        match client_method(&request.method) {
            Some(ClientMethod::Initialize) => unreachable!("initialize handled before gate"),
            Some(ClientMethod::EnvCwdSet) => self.env_cwd_set(connection, &request.params),
            Some(ClientMethod::EnvDirsSet) => self.env_dirs_set(connection, &request.params),
            Some(ClientMethod::SessionDirList) => {
                self.session_dir_list(connection, &request.params)
            }
            Some(ClientMethod::SessionDirAdd) => self.session_dir_add(connection, &request.params),
            Some(ClientMethod::SessionDirRemove) => {
                self.session_dir_remove(connection, &request.params)
            }
            Some(ClientMethod::SessionDirPermissionsSet) => {
                self.session_dir_permissions_set(connection, &request.params)
            }
            Some(ClientMethod::DirPermissionsRead) => {
                self.dir_permissions_read(connection, &request.params)
            }
            Some(ClientMethod::DirPermissionsList) => self.dir_permissions_list(connection),
            Some(ClientMethod::DirPermissionsSet) => {
                self.dir_permissions_set(connection, &request.params)
            }
            Some(ClientMethod::DirPermissionsForget) => {
                self.dir_permissions_forget(connection, &request.params)
            }
            Some(ClientMethod::DocumentCollaborationOpen) => {
                self.document_collaboration_open(connection, &request.params)
            }
            Some(ClientMethod::DocumentCollaborationSubmit) => {
                self.document_collaboration_submit(&request.params)
            }
            Some(ClientMethod::DocumentCollaborationPresencePublish) => {
                self.document_collaboration_presence_publish(&request.params)
            }
            Some(ClientMethod::DocumentCollaborationPresenceRead) => {
                self.document_collaboration_presence_read(&request.params)
            }
            Some(ClientMethod::IssueConfigure) => self.issue_configure(&request.params),
            Some(ClientMethod::IssueList) => self.issue_list(&request.params),
            Some(ClientMethod::IssueRead) => self.issue_read(&request.params),
            Some(ClientMethod::SessionCreate) => self.session_create(connection, &request.params),
            Some(ClientMethod::SessionRead) => self.session_read(&request.params),
            Some(ClientMethod::MessageCheckpoints) => self.message_checkpoints(&request.params),
            Some(ClientMethod::AgentRead) => self.agent_read(&request.params),
            Some(ClientMethod::SessionList) => self.session_list(),
            Some(ClientMethod::SessionSubscribe) => {
                self.session_subscribe(connection, &request.params)
            }
            Some(ClientMethod::SessionRequest) => self.session_request(connection, &request.params),
            Some(ClientMethod::SessionUnsubscribe) => {
                self.session_unsubscribe(connection, &request.params)
            }
            Some(ClientMethod::SessionThreadRead) => self.session_thread_read(&request.params),
            Some(ClientMethod::ThreadGoalGet) => self.thread_goal_get(&request.params),
            Some(ClientMethod::ThreadGoalSet) => self.thread_goal_set(&request.params),
            Some(ClientMethod::ThreadGoalClear) => self.thread_goal_clear(&request.params),
            Some(ClientMethod::SessionThreadSubscribe) => {
                self.session_thread_subscribe(connection, &request.params)
            }
            Some(ClientMethod::SessionThreadUnsubscribe) => {
                self.session_thread_unsubscribe(connection, &request.params)
            }
            Some(ClientMethod::TurnChangesList) => self.turn_changes_list(&request.params),
            Some(ClientMethod::TurnChangesRead) => self.turn_changes_read(&request.params),
            Some(ClientMethod::TurnChangesReadFile) => self.turn_changes_read_file(&request.params),
            Some(ClientMethod::TurnChangesGenerateMessage) => {
                self.turn_changes_generate_message(&request.params)
            }
            Some(ClientMethod::TurnChangesUpdateDraft) => {
                self.turn_changes_update_draft(&request.params)
            }
            Some(ClientMethod::TurnChangesCommit) => self.turn_changes_commit(&request.params),
            Some(ClientMethod::TurnChangesDiscardThread) => {
                self.turn_changes_discard_thread(&request.params)
            }
            Some(ClientMethod::ProjectList) => self.project_list(connection, &request.params),
            Some(ClientMethod::ExtensionItems) => self.extension_items(&request.params),
            Some(ClientMethod::QueueEdit) => self.queue_edit(&request.params),
            Some(ClientMethod::QueueEnqueue) => self.queue_enqueue(&request.params),
            Some(ClientMethod::QueueList) => self.queue_list(&request.params),
            Some(ClientMethod::QueueCancel) => self.queue_cancel(&request.params),
            Some(ClientMethod::DiagnosticsRead) => self.diagnostics_read(),
            Some(ClientMethod::FeedbackPrepare) => {
                self.feedback_prepare(connection, &request.params)
            }
            Some(ClientMethod::FeedbackUpload) => {
                self.feedback_upload(connection, &request.params, cancellation)
            }
            Some(ClientMethod::MemoryDiagnosticsStart) => {
                self.memory_diagnostics_start(connection, &request.params)
            }
            Some(ClientMethod::MemoryDiagnosticsRead) => {
                self.memory_diagnostics_read(connection, &request.params)
            }
            Some(ClientMethod::MemoryDiagnosticsStop) => {
                self.memory_diagnostics_stop(connection, &request.params)
            }
            Some(ClientMethod::MemoryDiagnosticsSubmit) => {
                self.memory_diagnostics_submit(connection, &request.params)
            }
            Some(ClientMethod::MemoryDiagnosticsExport) => {
                self.memory_diagnostics_export(connection, &request.params)
            }
            Some(ClientMethod::MemoryCitationRead) => {
                self.memory_citation_read(connection, &request.params)
            }
            Some(ClientMethod::MemoryPolicyRead) => {
                self.memory_policy_read(connection, &request.params)
            }
            Some(ClientMethod::MemoryPolicyUpdate) => {
                self.memory_policy_update(connection, &request.params)
            }
            Some(ClientMethod::MemoryScopes) => self.memory_scopes(connection, &request.params),
            Some(ClientMethod::MemoryUpdate) => {
                self.memory_update(connection, &request.params, cancellation)
            }
            Some(ClientMethod::MemoryAdd) => {
                self.memory_add(connection, &request.params, cancellation)
            }
            Some(ClientMethod::MemoryList) => self.memory_list(connection, &request.params),
            Some(ClientMethod::MemoryRead) => self.memory_read(connection, &request.params),
            Some(ClientMethod::MemorySearch) => self.memory_search(connection, &request.params),
            Some(ClientMethod::MemoryDelete) => self.memory_delete(connection, &request.params),
            Some(ClientMethod::AutomationList) => self.automation_list(),
            Some(ClientMethod::AutomationWrite) => self.automation_write(&request.params),
            Some(ClientMethod::AutomationDelete) => self.automation_delete(&request.params),
            Some(ClientMethod::AutomationRun) => self.automation_run(&request.params),
            Some(ClientMethod::AutomationRuns) => self.automation_runs(&request.params),
            Some(ClientMethod::AutomationStop) => self.automation_stop(&request.params),
            Some(ClientMethod::ProjectRead) => self.project_read(connection, &request.params),
            Some(ClientMethod::ProjectCreate) => self.project_create(connection, &request.params),
            Some(ClientMethod::ProjectDetailsUpdate) => {
                self.project_details_update(connection, &request.params)
            }
            Some(ClientMethod::ProjectRootAdd) => {
                self.project_root_add(connection, &request.params)
            }
            Some(ClientMethod::ProjectRootUpdate) => {
                self.project_root_update(connection, &request.params)
            }
            Some(ClientMethod::ProjectRootRemove) => {
                self.project_root_remove(connection, &request.params)
            }
            Some(ClientMethod::ProjectSessionLink) => {
                self.project_session_link(connection, &request.params)
            }
            Some(ClientMethod::ProjectSessionUnlink) => {
                self.project_session_unlink(connection, &request.params)
            }
            Some(ClientMethod::ProjectArchive) => self.project_archive(connection, &request.params),
            Some(ClientMethod::ProjectRestore) => self.project_restore(connection, &request.params),
            Some(ClientMethod::TypstCompile) => self.typst_compile(connection, &request.params),
            Some(ClientMethod::ConfigRead) => self.config_read(),
            Some(ClientMethod::AccountRead) => self.account_read(),
            Some(ClientMethod::AccountLoginStart) => self.account_login_start(&request.params),
            Some(ClientMethod::AccountLoginCancel) => self.account_login_cancel(&request.params),
            Some(ClientMethod::AccountLogout) => self.account_logout(&request.params),
            Some(ClientMethod::ConnectorList) => self.connector_list(),
            Some(ClientMethod::ConnectorApiTokenConnect) => {
                self.connector_api_token_connect(std::mem::take(&mut request.params))
            }
            Some(ClientMethod::ConnectorOAuthStart) => self.connector_oauth_start(&request.params),
            Some(ClientMethod::ConnectorOAuthComplete) => {
                self.connector_oauth_complete(std::mem::take(&mut request.params))
            }
            Some(ClientMethod::ConnectorOAuthCancel) => {
                self.connector_oauth_cancel(&request.params)
            }
            Some(ClientMethod::ConnectorDeviceOAuthStart) => {
                self.connector_device_oauth_start(&request.params)
            }
            Some(ClientMethod::ConnectorDeviceOAuthPoll) => {
                self.connector_device_oauth_poll(&request.params)
            }
            Some(ClientMethod::ConnectorDeviceOAuthCancel) => {
                self.connector_device_oauth_cancel(&request.params)
            }
            Some(ClientMethod::ConnectorOAuthRefresh) => {
                self.connector_oauth_refresh(&request.params)
            }
            Some(ClientMethod::ConnectorOAuthRevoke) => {
                self.connector_oauth_revoke(&request.params)
            }
            Some(ClientMethod::ConnectorDisconnect) => self.connector_disconnect(&request.params),
            Some(ClientMethod::ConnectorCredentialCleanupRetry) => {
                self.connector_credential_cleanup_retry(&request.params)
            }
            Some(ClientMethod::PluginList) => self.plugin_list(),
            Some(ClientMethod::MarketplaceSearch) => self.marketplace_search(&request.params),
            Some(ClientMethod::MarketplaceGet) => self.marketplace_get(&request.params),
            Some(ClientMethod::MarketplaceDownload) => self.marketplace_download(&request.params),
            Some(ClientMethod::MarketplaceInstall) => self.marketplace_install(&request.params),
            Some(ClientMethod::MarketplaceUpdate) => self.marketplace_update(&request.params),
            Some(ClientMethod::MarketplaceUninstall) => self.marketplace_uninstall(&request.params),
            Some(ClientMethod::MarketplaceListInstalled) => {
                self.marketplace_list_installed(&request.params)
            }
            Some(ClientMethod::MarketplaceAcquireCapability) => {
                self.marketplace_acquire_capability(connection, &request.params)
            }
            Some(ClientMethod::MarketplaceReleaseCapability) => {
                self.marketplace_release_capability(connection, &request.params)
            }
            Some(ClientMethod::MarketplaceOpenResource) => {
                self.marketplace_open_resource(connection, &request.params)
            }
            Some(ClientMethod::PluginEnable) => self.plugin_enable(&request.params),
            Some(ClientMethod::PluginDisable) => self.plugin_disable(&request.params),
            Some(ClientMethod::PluginGrant) => self.plugin_grant(&request.params),
            Some(ClientMethod::PluginRevokeGrant) => self.plugin_revoke_grant(&request.params),
            Some(ClientMethod::PluginUninstall) => self.plugin_uninstall(&request.params),
            Some(ClientMethod::ModelList) => self.model_list(),
            Some(ClientMethod::ProviderModelsList) => self.provider_models_list(&request.params),
            Some(ClientMethod::ProviderProbe) => {
                self.provider_probe(std::mem::take(&mut request.params))
            }
            Some(ClientMethod::ProviderList) => self.provider_list(),
            Some(ClientMethod::ProviderApiKeySet) => {
                self.provider_api_key_set(std::mem::take(&mut request.params))
            }
            Some(ClientMethod::ConfigUpdate) => self.config_update(&request.params),
            Some(ClientMethod::ExecPolicyRuleUpsert) => {
                self.exec_policy_rule_upsert(&request.params)
            }
            Some(ClientMethod::ExecPolicyRuleRemove) => {
                self.exec_policy_rule_remove(&request.params)
            }
            Some(ClientMethod::ToolSearchConfigure) => self.tool_search_configure(&request.params),
            Some(ClientMethod::CodebaseConfigure) => self.codebase_configure(&request.params),
            Some(ClientMethod::CommitMessageAuthorize) => {
                self.commit_message_authorize(&request.params)
            }
            Some(ClientMethod::CommitMessageRevoke) => self.commit_message_revoke(&request.params),
            Some(ClientMethod::LanguageServerConfigure) => {
                self.language_server_configure(&request.params)
            }
            Some(ClientMethod::LanguageServerRemove) => {
                self.language_server_remove(&request.params)
            }
            Some(ClientMethod::ProviderConfigure) => self.provider_configure(&request.params),
            Some(ClientMethod::ProviderRemove) => self.provider_remove(&request.params),
            Some(ClientMethod::McpServerUpsert) => self.mcp_server_upsert(&request.params),
            Some(ClientMethod::McpServerRemove) => self.mcp_server_remove(&request.params),
            Some(ClientMethod::McpServerSetEnablement) => {
                self.mcp_server_set_enablement(&request.params)
            }
            Some(ClientMethod::McpServerStatus) => self.mcp_server_status(),
            Some(ClientMethod::McpServerConnect) => self.mcp_server_connect(&request.params),
            Some(ClientMethod::McpServerDisconnect) => self.mcp_server_disconnect(&request.params),
            Some(ClientMethod::McpOAuthStart) => self.mcp_oauth_start(&request.params),
            Some(ClientMethod::McpOAuthComplete) => {
                self.mcp_oauth_complete(std::mem::take(&mut request.params))
            }
            Some(ClientMethod::McpOAuthRefresh) => self.mcp_oauth_refresh(&request.params),
            Some(ClientMethod::McpOAuthRevoke) => self.mcp_oauth_revoke(&request.params),
            Some(ClientMethod::SkillSourceAdd) => self.skill_source_add(&request.params),
            Some(ClientMethod::SkillSourceRemove) => self.skill_source_remove(&request.params),
            Some(ClientMethod::SkillSourceSetEnablement) => {
                self.skill_source_set_enablement(&request.params)
            }
            Some(ClientMethod::PluginRequestUpsert) => self.plugin_request_upsert(&request.params),
            Some(ClientMethod::PluginRequestRemove) => self.plugin_request_remove(&request.params),
            Some(ClientMethod::PluginRequestSetEnablement) => {
                self.plugin_request_set_enablement(&request.params)
            }
            Some(ClientMethod::HookUpsert) => self.hook_upsert(&request.params),
            Some(ClientMethod::HookRemove) => self.hook_remove(&request.params),
            Some(ClientMethod::HookSetEnablement) => self.hook_set_enablement(&request.params),
            Some(ClientMethod::SkillList) => self.skill_list(&request.params),
            Some(ClientMethod::SkillSetEnablement) => self.skill_set_enablement(&request.params),
            Some(ClientMethod::SkillResourceOpen) => {
                self.skill_resource_open(connection, &request.params)
            }
            Some(ClientMethod::ExtensionList) => self.extension_list(&request.params),
            Some(ClientMethod::ExtensionResourceOpen) => {
                self.extension_resource_open(connection, &request.params)
            }
            Some(ClientMethod::ExtensionHostList) => self.extension_host_list(),
            Some(ClientMethod::ExtensionHostReconcile) => {
                self.extension_host_reconcile(&request.params)
            }
            Some(ClientMethod::ExtensionHostInvokeStart) => {
                self.extension_host_invoke_start(connection, &request.params)
            }
            Some(ClientMethod::ExtensionHostInvokeRead) => {
                self.extension_host_invoke_read(connection, &request.params)
            }
            Some(ClientMethod::ExtensionHostInvokeCancel) => {
                self.extension_host_invoke_cancel(connection, &request.params)
            }
            Some(ClientMethod::ResourceMetadata) => {
                self.resource_metadata(connection, &request.params)
            }
            Some(ClientMethod::ResourceRead) => self.resource_read(connection, &request.params),
            Some(ClientMethod::ResourceRelease) => {
                self.resource_release(connection, &request.params)
            }
            Some(ClientMethod::AttachmentUploadStart) => {
                self.attachment_upload_start(connection, &request.params)
            }
            Some(ClientMethod::AttachmentUploadWrite) => {
                self.attachment_upload_write(connection, &request.params)
            }
            Some(ClientMethod::AttachmentUploadFinish) => {
                self.attachment_upload_finish(connection, &request.params)
            }
            Some(ClientMethod::AttachmentUploadCancel) => {
                self.attachment_upload_cancel(connection, &request.params)
            }
            Some(ClientMethod::AttachmentImportRemote) => {
                self.attachment_import_remote(&request.params)
            }
            Some(ClientMethod::FsGetMetadata) => self.fs_get_metadata(&request.params),
            Some(ClientMethod::FsReadDirectory) => self.fs_read_directory(&request.params),
            Some(ClientMethod::FsReadFile) => self.fs_read_file(&request.params),
            Some(ClientMethod::FsReadBinaryFile) => {
                self.fs_read_binary_file(connection, &request.params)
            }
            Some(ClientMethod::DiffCompute) => self.diff_compute(&request.params),
            Some(ClientMethod::SyntaxAnalyze) => self.syntax_analyze(&request.params),
            Some(ClientMethod::SyntaxSelectionRanges) => {
                self.syntax_selection_ranges(&request.params)
            }
            Some(ClientMethod::LanguageSynchronize) => {
                self.language_synchronize(&request.params, cancellation)
            }
            Some(ClientMethod::LanguageClose) => self.language_close(&request.params, cancellation),
            Some(ClientMethod::LanguageCancel) => self.language_cancel(connection, &request.params),
            Some(ClientMethod::LanguageHover) => self.language_hover(&request.params, cancellation),
            Some(ClientMethod::LanguageCompletions) => {
                self.language_completions(&request.params, cancellation)
            }
            Some(ClientMethod::LanguageResolveCompletion) => {
                self.language_resolve_completion(&request.params, cancellation)
            }
            Some(ClientMethod::LanguageExecuteCommand) => {
                self.language_execute_command(&request.params, cancellation)
            }
            Some(ClientMethod::LanguageDocumentDiagnostics) => {
                self.language_document_diagnostics(&request.params, cancellation)
            }
            Some(ClientMethod::LanguageDirectoryDiagnostics) => {
                self.language_directory_diagnostics(&request.params, cancellation)
            }
            Some(ClientMethod::LanguageDocumentFormatting) => {
                self.language_document_formatting(&request.params, cancellation)
            }
            Some(ClientMethod::LanguageRangeFormatting) => {
                self.language_range_formatting(&request.params, cancellation)
            }
            Some(ClientMethod::LanguageSignatureHelp) => {
                self.language_signature_help(&request.params, cancellation)
            }
            Some(ClientMethod::LanguageInlayHints) => {
                self.language_inlay_hints(&request.params, cancellation)
            }
            Some(ClientMethod::LanguageLinkedEditingRanges) => {
                self.language_linked_editing_ranges(&request.params, cancellation)
            }
            Some(ClientMethod::LanguageSemanticTokens) => {
                self.language_semantic_tokens(&request.params, cancellation)
            }
            Some(ClientMethod::LanguageDocumentSymbols) => {
                self.language_document_symbols(&request.params, cancellation)
            }
            Some(ClientMethod::LanguageCodeLenses) => {
                self.language_code_lenses(&request.params, cancellation)
            }
            Some(ClientMethod::LanguageResolveCodeLens) => {
                self.language_resolve_code_lens(&request.params, cancellation)
            }
            Some(ClientMethod::LanguageDocumentLinks) => {
                self.language_document_links(&request.params, cancellation)
            }
            Some(ClientMethod::LanguageResolveDocumentLink) => {
                self.language_resolve_document_link(&request.params, cancellation)
            }
            Some(ClientMethod::LanguageDocumentColors) => {
                self.language_document_colors(&request.params, cancellation)
            }
            Some(ClientMethod::LanguageColorPresentations) => {
                self.language_color_presentations(&request.params, cancellation)
            }
            Some(ClientMethod::LanguageFoldingRanges) => {
                self.language_folding_ranges(&request.params, cancellation)
            }
            Some(ClientMethod::LanguageLocations) => {
                self.language_locations(&request.params, cancellation)
            }
            Some(ClientMethod::LanguageHierarchy) => {
                self.language_hierarchy(&request.params, cancellation)
            }
            Some(ClientMethod::LanguageDirectorySymbols) => {
                self.language_directory_symbols(&request.params, cancellation)
            }
            Some(ClientMethod::LanguagePrepareRename) => {
                self.language_prepare_rename(&request.params, cancellation)
            }
            Some(ClientMethod::LanguageRename) => {
                self.language_rename(&request.params, cancellation)
            }
            Some(ClientMethod::LanguageCodeActions) => {
                self.language_code_actions(&request.params, cancellation)
            }
            Some(ClientMethod::LanguageResolveCodeAction) => {
                self.language_resolve_code_action(&request.params, cancellation)
            }
            Some(ClientMethod::FsWriteFile) => self.fs_write_file(&request.params),
            Some(ClientMethod::FsCreateFile) => self.fs_create_file(&request.params),
            Some(ClientMethod::FsRename) => self.fs_rename(&request.params),
            Some(ClientMethod::FsDelete) => self.fs_delete(&request.params),
            Some(ClientMethod::GitRepositories) => self.git_repositories(),
            Some(ClientMethod::GitStatus) => self.git_status(&request.params),
            Some(ClientMethod::GitTextDiff) => self.git_text_diff(&request.params),
            Some(ClientMethod::GitBranchList) => self.git_branch_list(&request.params),
            Some(ClientMethod::GitHistory) => self.git_history(&request.params),
            Some(ClientMethod::GitGraph) => {
                self.git_graph(connection.connection_id, &request.params)
            }
            Some(ClientMethod::GitCommitChanges) => self.git_commit_changes(&request.params),
            Some(ClientMethod::GitCommitFile) => self.git_commit_file(&request.params),
            Some(ClientMethod::GitChangeFile) => self.git_change_file(&request.params),
            Some(ClientMethod::GitBranchSwitch) => self.git_branch_switch(&request.params),
            Some(ClientMethod::GitStage) => self.git_stage(&request.params),
            Some(ClientMethod::GitUnstage) => self.git_unstage(&request.params),
            Some(ClientMethod::GitDiscardWorktree) => self.git_discard_worktree(&request.params),
            Some(ClientMethod::GitCommit) => self.git_commit(&request.params),
            Some(ClientMethod::GitFetch) => self.git_fetch(&request.params),
            Some(ClientMethod::GitPull) => self.git_pull(&request.params),
            Some(ClientMethod::GitPush) => self.git_push(&request.params),
            Some(ClientMethod::ContentSearchStart) => {
                self.content_search_start(connection, &request.params)
            }
            Some(ClientMethod::ContentSearchRead) => {
                self.content_search_read(connection, &request.params)
            }
            Some(ClientMethod::ContentSearchCancel) => {
                self.content_search_cancel(connection, &request.params)
            }
            Some(ClientMethod::CodebaseStatus) => self.codebase_status(&request.params),
            Some(ClientMethod::CodebaseSearch) => self.codebase_search(&request.params),
            Some(ClientMethod::CodebaseSymbolsStatus) => self.symbol_index_status(&request.params),
            Some(ClientMethod::CodebaseSymbolsSearch) => self.symbol_index_search(&request.params),
            Some(ClientMethod::DocumentOverlaySynchronize) => {
                self.document_overlay_synchronize(&request.params)
            }
            Some(ClientMethod::DocumentOverlayClose) => {
                self.document_overlay_close(&request.params)
            }
            Some(ClientMethod::CodebaseRetrieve) => self.code_retrieve(&request.params),
            Some(ClientMethod::CodebaseRebuild) => self.codebase_rebuild(&request.params),
            Some(ClientMethod::FastRegexIndexStatus) => {
                self.fast_regex_index_status(&request.params)
            }
            Some(ClientMethod::FastRegexIndexRebuild) => {
                self.fast_regex_index_rebuild(&request.params)
            }
            Some(ClientMethod::FastRegexDisableAndDelete) => {
                self.fast_regex_disable_and_delete(&request.params)
            }
            Some(ClientMethod::CloudCodebaseStatus) => self.cloud_codebase_status(&request.params),
            Some(ClientMethod::CloudCodebasePreview) => {
                self.cloud_codebase_preview(&request.params)
            }
            Some(ClientMethod::CloudCodebaseAuthorize) => {
                self.cloud_codebase_authorize(&request.params)
            }
            Some(ClientMethod::CloudCodebaseSync) => self.cloud_codebase_sync(&request.params),
            Some(ClientMethod::CloudCodebaseRevoke) => self.cloud_codebase_revoke(&request.params),
            Some(ClientMethod::TerminalProfileList) => self.terminal_profile_list(&request.params),
            Some(ClientMethod::TerminalCreate) => self.terminal_create(connection, &request.params),
            Some(ClientMethod::TerminalCreateInSessionDirectory) => {
                self.terminal_create_in_session_directory(connection, &request.params)
            }
            Some(ClientMethod::TerminalAttach) => self.terminal_attach(connection, &request.params),
            Some(ClientMethod::TerminalWrite) => self.terminal_write(connection, &request.params),
            Some(ClientMethod::TerminalResize) => self.terminal_resize(connection, &request.params),
            Some(ClientMethod::TerminalRead) => self.terminal_read(connection, &request.params),
            Some(ClientMethod::TerminalClose) => self.terminal_close(connection, &request.params),
            Some(ClientMethod::DebugAdapterStart) => {
                self.debug_adapter_start(connection, &request.params)
            }
            Some(ClientMethod::DebugAdapterSend) => {
                self.debug_adapter_send(connection, &request.params)
            }
            Some(ClientMethod::DebugAdapterRead) => {
                self.debug_adapter_read(connection, &request.params)
            }
            Some(ClientMethod::DebugAdapterClose) => {
                self.debug_adapter_close(connection, &request.params)
            }
            None => Err(RpcError::new(-32601, AppServerErrorName::MethodNotFound)),
        }
    }
}

struct AppServerThreadUpdates {
    threads: Arc<ThreadController>,
    updates: Arc<UpdateBroker>,
}

impl ThreadUpdateSink for AppServerThreadUpdates {
    fn publish(&self, update: ThreadUpdateEnvelope) {
        enum GoalNotification {
            Updated(ash_app_server_protocol::protocol::goal::ThreadGoalUpdatedNotification),
            Cleared(ash_app_server_protocol::protocol::goal::ThreadGoalClearedNotification),
        }

        let goal_notification = match &update.update {
            ash_protocol::ThreadUpdate::Committed { event } => match event {
                ash_protocol::ThreadEvent::GoalCreated { goal, .. }
                | ash_protocol::ThreadEvent::GoalUpdated { goal, .. } => Some(
                    GoalNotification::Updated(
                        ash_app_server_protocol::protocol::goal::ThreadGoalUpdatedNotification {
                            thread_id: update.thread_id.clone(),
                            turn_id: None,
                            goal: goal.clone(),
                        },
                    ),
                ),
                ash_protocol::ThreadEvent::GoalCleared { .. } => Some(
                    GoalNotification::Cleared(
                        ash_app_server_protocol::protocol::goal::ThreadGoalClearedNotification {
                            thread_id: update.thread_id.clone(),
                        },
                    ),
                ),
                ash_protocol::ThreadEvent::ModelUsageRecorded { turn_id, .. }
                | ash_protocol::ThreadEvent::ModelInvocationRecorded { turn_id, .. }
                | ash_protocol::ThreadEvent::TurnFailed { turn_id, .. } => self
                    .threads
                    .get_goal(&update.thread_id)
                    .ok()
                    .flatten()
                    .map(|goal| {
                        GoalNotification::Updated(
                            ash_app_server_protocol::protocol::goal::ThreadGoalUpdatedNotification {
                                thread_id: update.thread_id.clone(),
                                turn_id: Some(turn_id.clone()),
                                goal,
                            },
                        )
                    }),
                _ => None,
            },
            _ => None,
        };
        self.updates.publish_thread_update(update);
        match goal_notification {
            Some(GoalNotification::Updated(updated)) => {
                self.updates.publish_thread_goal_updated(updated)
            }
            Some(GoalNotification::Cleared(cleared)) => {
                self.updates.publish_thread_goal_cleared(cleared)
            }
            None => {}
        }
    }
}

#[derive(Debug)]
pub(super) struct RpcError {
    code: i64,
    message: AppServerErrorName,
    detail: Option<String>,
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match &self.detail {
            Some(detail) => formatter.write_str(detail),
            None => write!(formatter, "{:?}", self.message),
        }
    }
}

impl RpcError {
    pub(super) fn new(code: i64, message: AppServerErrorName) -> Self {
        Self {
            code,
            message,
            detail: None,
        }
    }
}

pub(super) fn decode<T: for<'a> Deserialize<'a>>(params: &Value) -> Result<T, RpcError> {
    serde_json::from_value(params.clone())
        .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))
}

pub(super) fn result<T: serde::Serialize>(value: &T) -> Result<Value, RpcError> {
    serde_json::to_value(value)
        .map_err(|_| RpcError::new(-32000, AppServerErrorName::InternalError))
}

pub(super) fn core_error(error: CoreError) -> RpcError {
    match error {
        CoreError::CommandConflict => RpcError::new(-32004, AppServerErrorName::CommandConflict),
        CoreError::NotFound(_) => RpcError::new(-32011, AppServerErrorName::CoreOperationFailed),
        _ => RpcError::new(-32010, AppServerErrorName::CoreOperationFailed),
    }
}

fn serialize_response(value: Value) -> String {
    serde_json::to_string(&value).expect("JSON-RPC response must serialize")
}

fn error_response(id: JsonRpcId, code: i64, message: AppServerErrorName) -> Value {
    serde_json::to_value(JsonRpcFailure::new(id, AppServerError::new(code, message)))
        .expect("JSON-RPC error response must serialize")
}

fn resource_error(error: ResourceError) -> String {
    match error {
        ResourceError::NotFound => "ResourceNotFound",
        ResourceError::NotOwner => "ResourceNotOwner",
        ResourceError::TooLarge => "ResourceTooLarge",
        ResourceError::InvalidChunkSize => "InvalidResourceChunkSize",
        ResourceError::InvalidOffset => "InvalidResourceOffset",
    }
    .into()
}

#[cfg(test)]
#[path = "server/agent_session_tests.rs"]
mod agent_session_tests;

#[cfg(test)]
#[path = "server/agent_benchmarks.rs"]
mod agent_benchmarks;

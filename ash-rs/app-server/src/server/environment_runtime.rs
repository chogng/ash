use super::AppServer;
use super::AppServerThreadUpdates;
use super::CodebaseModels;
use super::EnvStateMode;
use super::RpcError;
use super::codebase_runtime::CodebaseRuntime;
use super::dir_contributions::DirContributions;
use super::fs_watcher::FileSystemWatcher;
use super::git_runtime::GitRuntime;
use super::git_runtime::GitWatcher;
use super::home_context::HomeContext;
use super::semantic_index_job::AppServerSemanticIndexMetrics;
use super::semantic_index_job::SemanticIndexJobController;
use super::symbol_index_runtime::SymbolIndexRuntime;
use super::update_plan_tool::UpdatePlanToolService;
use crate::codebase_retrieval_context::CodebaseRetrievalContextSource;
use crate::codebase_retrieval_tool::CodebaseRetrievalTool;
use crate::dir_grants::DirGrants;
use crate::dynamic_tools::DynamicToolCompositionError;
use crate::dynamic_tools::compose_dynamic_tools;
use crate::local_tools::AgentGrepService;
use crate::local_tools::LocalToolConfig;
use crate::local_tools::append_local_tool;
use crate::local_tools::compose_local_tools_with_config;
use crate::tool_composition::ReloadableToolPorts;
use crate::tool_composition::ToolPort;
use crate::tool_composition::ToolSearchOptions;
use crate::tool_composition::combine_tool_ports_at_generation_with_search;
use crate::tool_search_models::ToolSearchEmbeddingStatus;
use crate::tool_search_models::resolve_tool_search;
use agent::MultiAgentToolService;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_cloud_codebase::CloudCodebaseController;
use ash_cloud_codebase::CloudCodebaseStorage;
use ash_codebase::CodebaseSemanticService;
use ash_codebase::CodebaseVectorStore;
use ash_codebase::EmbeddingIndexKey;
use ash_codebase_store::CodebaseStore;
use ash_config::CodebaseModelSelection;
use ash_config::ConfigStore;
use ash_config::DirConfigScope;
use ash_config::DirConfigStore;
use ash_config::ToolSearchConfig;
use ash_content_search::ContentSearchService;
use ash_core::ApprovalModeActionPolicyService;
use ash_core::InterruptTurnRequest;
use ash_core::MultiAgentCoordinator;
use ash_core::SequenceExpectation;
use ash_core::ThreadController;
use ash_core::TurnExecutor;
use ash_file_access::Dir;
use ash_file_access::Grant;
use ash_file_access::GrantSource;
use ash_file_access::Mutation;
use ash_file_access::Permission;
use ash_file_access::Permissions;
use ash_file_system::FileSystem;
use ash_file_system::LocalFileSystem;
use ash_hooks::DeclarativeHookRuntime;
use ash_model_provider::EmbeddingInvoker;
use ash_model_provider::EmbeddingRuntimeIdentity;
use ash_model_provider::EmbeddingRuntimeRequest;
use ash_model_provider::ModelProviderError;
use ash_model_provider::RerankInvoker;
use ash_model_provider::RerankRuntimeRequest;
use ash_model_provider::SemanticModelProvider;
use ash_model_provider::SemanticRuntimeLocation;
use ash_model_provider_config::ModelProviderConfig;
use ash_protocol::CommandId;
use ash_protocol::ProviderId;
use ash_protocol::SessionId;
use ash_protocol::TurnStatus;
use ash_shell_command::RipgrepExecutable;
use ash_tools::ToolRegistryGeneration;
use goal::GoalToolService;
use std::collections::BTreeMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::RwLock;

pub(super) struct EnvRuntime {
    pub(super) cwd: Option<PathBuf>,
    pub(super) selected_grant: Option<Grant>,
    pub(super) selected_file_system: Option<Arc<dyn FileSystem>>,
    pub(super) dirs: BTreeMap<String, Grant>,
    pub(super) dir_file_systems: BTreeMap<String, Arc<dyn FileSystem>>,
    pub(super) _file_system_watcher: Option<FileSystemWatcher>,
    pub(super) _dir_file_system_watchers: Vec<FileSystemWatcher>,
    pub(super) session_dir_watchers: BTreeMap<(SessionId, PathBuf), SessionDirEntryWatcher>,
    pub(super) _git_watcher: Option<GitWatcher>,
    pub(super) git: Option<Arc<GitRuntime>>,
    pub(super) content_search: Option<Arc<ContentSearchService>>,
    pub(super) dir_content_search: BTreeMap<String, Arc<ContentSearchService>>,
    pub(super) session_dir_search: BTreeMap<(SessionId, PathBuf), Arc<ContentSearchService>>,
    pub(super) ripgrep: Option<RipgrepExecutable>,
    pub(super) agent_grep: Option<Arc<AgentGrepService>>,
    pub(super) codebase: Option<Arc<CodebaseRuntime>>,
    pub(super) symbol_index: Option<Arc<SymbolIndexRuntime>>,
    pub(super) codebase_semantic: Option<Arc<CodebaseSemanticService>>,
    pub(super) codebase_semantic_job: Option<Arc<SemanticIndexJobController>>,
    pub(super) cloud_codebase: Option<Arc<CloudCodebaseController>>,
    pub(super) _dir_contributions: Option<Arc<DirContributions>>,
    pub(super) terminals: Option<Arc<crate::terminal_service::TerminalService>>,
    pub(super) dir_terminals: BTreeMap<String, Arc<crate::terminal_service::TerminalService>>,
    pub(super) debug_adapters: Option<Arc<crate::debug_service::DebugAdapterService>>,
    pub(super) dir_debug_adapters: BTreeMap<String, Arc<crate::debug_service::DebugAdapterService>>,
    pub(super) dir_grants: Arc<DirGrants>,
    pub(super) turn_executor: TurnExecutor,
}

pub(super) struct SessionDirEntryWatcher {
    authorization: ash_file_access::Authorization,
    _watcher: FileSystemWatcher,
}

pub(super) struct SessionDirEntrySnapshot {
    pub(super) path: PathBuf,
    pub(super) permissions: ash_file_access::Permissions,
}

pub(super) struct SessionDirEntrySnapshotSet {
    pub(super) revision: u64,
    pub(super) dirs: Vec<SessionDirEntrySnapshot>,
}

impl EnvRuntime {
    pub(super) fn empty(turn_executor: TurnExecutor) -> Self {
        Self {
            cwd: None,
            selected_grant: None,
            selected_file_system: None,
            dirs: BTreeMap::new(),
            dir_file_systems: BTreeMap::new(),
            _file_system_watcher: None,
            _dir_file_system_watchers: Vec::new(),
            session_dir_watchers: BTreeMap::new(),
            _git_watcher: None,
            git: None,
            content_search: None,
            dir_content_search: BTreeMap::new(),
            session_dir_search: BTreeMap::new(),
            ripgrep: None,
            agent_grep: None,
            codebase: None,
            symbol_index: None,
            codebase_semantic: None,
            codebase_semantic_job: None,
            cloud_codebase: None,
            _dir_contributions: None,
            terminals: None,
            dir_terminals: BTreeMap::new(),
            debug_adapters: None,
            dir_debug_adapters: BTreeMap::new(),
            dir_grants: Arc::new(DirGrants::default()),
            turn_executor,
        }
    }
}

pub(super) struct LocalEnvHost {
    tools: Arc<EnvToolPorts>,
    hooks: Arc<DeclarativeHookRuntime>,
    grants: DirGrantPolicy,
}

impl LocalEnvHost {
    pub(super) fn replace_browser_host_available(
        &self,
        available: bool,
    ) -> Result<(), EnvRuntimeError> {
        self.tools.replace_host_available(available)
    }

    pub(super) fn record_tool_reconcile_failure(&self, error: impl Into<String>) {
        self.tools.record_reconcile_failure(error);
    }
}

#[derive(Clone)]
pub(crate) struct EnvRuntimeControl {
    authority_gate: Arc<Mutex<()>>,
    runtime: Arc<RwLock<EnvRuntime>>,
    tools: Arc<EnvToolPorts>,
    threads: Arc<ThreadController>,
    multi_agent: Arc<MultiAgentCoordinator>,
    model_instructions: Arc<ash_models_manager::ModelInstructionCatalog>,
    turn_backend: Arc<dyn ash_core::TurnExecutionBackend>,
    updates: Arc<super::update_broker::UpdateBroker>,
    hooks: Arc<DeclarativeHookRuntime>,
    mcp_status: Arc<RwLock<ash_mcp_extension::McpRuntimeStatusSnapshot>>,
    config: Option<Arc<ConfigStore>>,
    local_tool_config: Arc<RwLock<LocalToolConfig>>,
    env_state: EnvStateMode,
    fast_regex_worker_command: Option<ash_fast_regex_search::FastRegexWorkerCommand>,
    codebase_models: Option<CodebaseModels>,
    semantic_model_provider: Option<Arc<dyn SemanticModelProvider>>,
    extension_hosts: Option<super::extension_host_runtime::ExtensionHostRuntime>,
}

impl EnvRuntimeControl {
    pub(crate) fn reconcile_local_tool_config(
        &self,
        config: &ash_config::ResolvedConfig,
    ) -> Result<(), EnvRuntimeError> {
        let _authority = self
            .authority_gate
            .lock()
            .map_err(|_| EnvRuntimeError::Failed("Environment runtime gate poisoned".into()))?;
        let local_tool_config = LocalToolConfig::from_resolved(config);
        let (
            authorization,
            codebase,
            symbol_index,
            semantic,
            cloud,
            customizations,
            dir_grants,
            agent_grep,
        ) = {
            let runtime = self
                .runtime
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            (
                runtime.selected_grant.clone(),
                runtime.codebase.clone(),
                runtime.symbol_index.clone(),
                runtime.codebase_semantic.clone(),
                runtime.cloud_codebase.clone(),
                runtime._dir_contributions.clone(),
                Arc::clone(&runtime.dir_grants),
                runtime.agent_grep.clone(),
            )
        };
        let Some(authorization) = authorization else {
            *self
                .local_tool_config
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = local_tool_config;
            return Ok(());
        };
        if !authorization
            .permissions()
            .allows(Permission::ExecuteCommands)
        {
            *self
                .local_tool_config
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner()) = local_tool_config;
            return Ok(());
        }
        let execution = authorization
            .authorize(Permission::ExecuteCommands)
            .map_err(|_| EnvRuntimeError::PermissionRequired)?;
        let mut local = compose_local_tools_with_config(
            authorization.clone(),
            &local_tool_config,
            dir_grants,
            agent_grep,
            self.env_state.runtime(),
            self.fast_regex_worker_command.as_ref(),
        )
        .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?;
        if let Some(codebase) = codebase {
            let action_policy_revision = local.action_policy_revision().clone();
            local = append_local_tool(
                local,
                Arc::new(
                    CodebaseRetrievalTool::new(
                        execution,
                        codebase.index(),
                        symbol_index.map(|runtime| runtime.index()),
                        semantic,
                        cloud,
                    )
                    .with_action_policy_revision(action_policy_revision),
                ),
            );
        }
        local = append_multi_agent_tools(
            local,
            &self.multi_agent,
            &self.model_instructions,
            &self.threads,
            &self.turn_backend,
            customizations.as_ref(),
        )?;
        let agent_grep = Arc::clone(&local.agent_grep);
        let local_port = local
            .tool_port()
            .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?;
        self.tools.replace_local(Some(local_port))?;
        self.runtime
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .agent_grep = Some(agent_grep);
        *self
            .local_tool_config
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = local_tool_config;
        Ok(())
    }

    pub(crate) fn reconcile_hooks(
        &self,
        config: &ash_config::HooksConfig,
    ) -> Result<(), EnvRuntimeError> {
        let _authority = self
            .authority_gate
            .lock()
            .map_err(|_| EnvRuntimeError::Failed("Environment runtime gate poisoned".into()))?;
        self.hooks.replace_config(config.clone());
        let dir = self
            .runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .selected_grant
            .as_ref()
            .filter(|authorization| {
                authorization
                    .permissions()
                    .allows(Permission::DiscoverHooks)
            })
            .map(|authorization| authorization.dir().clone());
        match dir {
            Some(dir) => self
                .hooks
                .bind_dir(dir)
                .map_err(|error| EnvRuntimeError::Failed(error.to_string())),
            None => {
                self.hooks.unbind_dir();
                Ok(())
            }
        }
    }

    pub(crate) fn replace_mcp_status(&self, snapshot: ash_mcp_extension::McpRuntimeStatusSnapshot) {
        *self
            .mcp_status
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = snapshot;
    }

    pub(crate) fn reconcile_codebase_runtime(&self) -> Result<(), EnvRuntimeError> {
        let _authority = self
            .authority_gate
            .lock()
            .map_err(|_| EnvRuntimeError::Failed("Environment runtime gate poisoned".into()))?;
        let (
            authorization,
            codebase,
            symbol_index,
            cloud,
            customizations,
            previous_watcher,
            previous_job,
        ) = {
            let mut runtime = self
                .runtime
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let Some(authorization) = runtime.selected_grant.as_ref().cloned() else {
                return Ok(());
            };
            if !authorization
                .permissions()
                .allows(Permission::ExecuteCommands)
            {
                return Ok(());
            }
            let Some(codebase) = runtime.codebase.clone() else {
                return Ok(());
            };
            let Some(symbol_index) = runtime.symbol_index.clone() else {
                return Ok(());
            };
            let Some(customizations) = runtime._dir_contributions.clone() else {
                return Ok(());
            };
            let previous_watcher = runtime._file_system_watcher.take();
            let previous_job = runtime.codebase_semantic_job.take();
            runtime.codebase_semantic = None;
            (
                authorization,
                codebase,
                symbol_index,
                runtime.cloud_codebase.clone(),
                customizations,
                previous_watcher,
                previous_job,
            )
        };
        drop(previous_watcher);
        drop(previous_job);
        self.tools.replace_local(None)?;

        let semantic = open_codebase_semantic_runtime(
            &codebase,
            self.codebase_models.as_ref(),
            self.semantic_model_provider.as_ref(),
            self.config.as_ref(),
        )?;
        let semantic_job = semantic.as_ref().and_then(|service| {
            match SemanticIndexJobController::start(Arc::clone(service)) {
                Ok(job) => Some(job),
                Err(error) => {
                    log::warn!("semantic codebase job is unavailable: {error}");
                    None
                }
            }
        });
        let execution = authorization
            .authorize(Permission::ExecuteCommands)
            .map_err(|_| EnvRuntimeError::PermissionRequired)?;
        let local_tool_config = self
            .local_tool_config
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone();
        let dir_grants = self
            .runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .dir_grants
            .clone();
        let local = compose_local_tools_with_config(
            authorization.clone(),
            &local_tool_config,
            dir_grants,
            self.runtime
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .agent_grep
                .clone(),
            self.env_state.runtime(),
            self.fast_regex_worker_command.as_ref(),
        )
        .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?;
        let action_policy_revision = local.action_policy_revision().clone();
        let local = append_local_tool(
            local,
            Arc::new(
                CodebaseRetrievalTool::new(
                    execution,
                    codebase.index(),
                    Some(symbol_index.index()),
                    semantic.clone(),
                    cloud.clone(),
                )
                .with_action_policy_revision(action_policy_revision),
            ),
        );
        let turn_backend: Arc<dyn ash_core::TurnExecutionBackend> = self.turn_backend.clone();
        let local = append_multi_agent_tools(
            local,
            &self.multi_agent,
            &self.model_instructions,
            &self.threads,
            &turn_backend,
            Some(&customizations),
        )?;
        let watcher = FileSystemWatcher::start_with_observers(
            authorization.dir().clone(),
            Arc::clone(&self.updates),
            Arc::clone(&codebase),
            Arc::clone(&symbol_index),
            semantic_job.clone(),
            customizations,
            Some(Arc::clone(&local.agent_grep)),
        )
        .map_err(|error| {
            EnvRuntimeError::Failed(format!(
                "failed to rebind semantic codebase watcher: {error}"
            ))
        })?;
        let local_port = local
            .tool_port()
            .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?;
        self.tools.replace_local(Some(local_port))?;
        let context_source = Arc::new(CodebaseRetrievalContextSource::new(
            codebase.index(),
            Some(symbol_index.index()),
            semantic.clone(),
            cloud.clone(),
            self.config.clone(),
        ));
        let mut runtime = self
            .runtime
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        runtime.codebase_semantic = semantic;
        runtime.codebase_semantic_job = semantic_job;
        runtime._file_system_watcher = Some(watcher);
        runtime.turn_executor = runtime
            .turn_executor
            .clone()
            .with_context_source("codebase", context_source);
        Ok(())
    }

    pub(crate) fn reconcile_user_dir_permissions(
        &self,
        config: &ash_config::ResolvedConfig,
    ) -> Result<(), EnvRuntimeError> {
        let _authority = self
            .authority_gate
            .lock()
            .map_err(|_| EnvRuntimeError::Failed("Environment runtime gate poisoned".into()))?;
        let mut runtime = self
            .runtime
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let Some(authorization) = runtime.selected_grant.as_ref() else {
            return Ok(());
        };
        if authorization.source() != GrantSource::ExplicitUser {
            return Ok(());
        }

        let permissions = config
            .dir_permissions
            .explicit_permissions_for(&authorization.dir().id())
            .cloned()
            .unwrap_or_else(inspection_permissions);
        if authorization.permissions() == &permissions {
            return Ok(());
        }

        let root = authorization.dir().clone();
        let replacement =
            Grant::for_environment(root.clone(), GrantSource::ExplicitUser, permissions.clone());
        let inspection_git = replacement
            .authorize(Permission::InspectRepository)
            .ok()
            .map(|authorization| GitRuntime::new(authorization, Arc::clone(&self.updates)))
            .transpose()
            .map_err(|_| EnvRuntimeError::Failed("failed to initialize Git runtime".into()))?;
        if let Some(extension_hosts) = &self.extension_hosts {
            extension_hosts.unbind_dir();
        }
        authorization.revoke();
        self.hooks.unbind_dir();
        let dir_grants = std::mem::take(&mut runtime.dirs);
        runtime.dir_file_systems.clear();
        let dir_content_search = std::mem::take(&mut runtime.dir_content_search);
        let dir_terminals = std::mem::take(&mut runtime.dir_terminals);
        let dir_debug_adapters = std::mem::take(&mut runtime.dir_debug_adapters);
        let cloud_codebase = runtime.cloud_codebase.clone();
        let old_file_system_watcher = runtime._file_system_watcher.take();
        let old_dir_file_system_watchers = std::mem::take(&mut runtime._dir_file_system_watchers);
        let codebase = runtime.codebase.clone();
        let symbol_index = runtime.symbol_index.clone();
        let customizations = runtime._dir_contributions.clone();
        let terminals = runtime.terminals.take();
        let debug_adapters = runtime.debug_adapters.take();
        let search = runtime.content_search.take();
        let git = runtime.git.take();
        let git_watcher = runtime._git_watcher.take();
        runtime.cloud_codebase = None;
        runtime.codebase_semantic = None;
        runtime.codebase_semantic_job = None;
        runtime.selected_file_system = Some(Arc::new(LocalFileSystem::new(replacement.clone())));
        runtime.selected_grant = Some(replacement);
        runtime.git = inspection_git;
        drop(runtime);

        for (_, authorization) in dir_grants {
            authorization.revoke();
        }
        for (_, search) in dir_content_search {
            search.cancel_all();
        }
        for (_, terminals) in dir_terminals {
            terminals.terminate_all();
        }
        for (_, debug_adapters) in dir_debug_adapters {
            debug_adapters.terminate_all();
        }
        drop(old_file_system_watcher);
        drop(old_dir_file_system_watchers);
        let (watcher, watcher_error) = match (
            permissions.allows(Permission::WatchFiles),
            codebase,
            symbol_index,
            customizations,
        ) {
            (true, Some(codebase), Some(symbol_index), Some(customizations)) => {
                match FileSystemWatcher::start_with_observers(
                    root.clone(),
                    Arc::clone(&self.updates),
                    codebase,
                    symbol_index,
                    None,
                    customizations,
                    None,
                ) {
                    Ok(watcher) => (Some(watcher), None),
                    Err(error) => (None, Some(error)),
                }
            }
            _ => (None, None),
        };
        self.runtime
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            ._file_system_watcher = watcher;

        let tool_result = self.tools.replace_executable(None, false);
        if let Some(terminals) = terminals {
            terminals.terminate_all();
        }
        if let Some(debug_adapters) = debug_adapters {
            debug_adapters.terminate_all();
        }
        if let Some(search) = search {
            search.cancel_all();
        }
        drop(git_watcher);
        drop(git);
        let interrupt_result = self.interrupt_active_turns();
        if let Some(controller) = cloud_codebase
            && controller.revoke().is_err()
        {
            log::warn!("cloud codebase deletion remains pending after permission revocation");
        }
        tool_result?;
        interrupt_result?;
        if let Some(error) = watcher_error {
            return Err(EnvRuntimeError::Failed(format!(
                "failed to update filesystem watcher permissions: {error}"
            )));
        }
        Ok(())
    }

    fn interrupt_active_turns(&self) -> Result<(), EnvRuntimeError> {
        for snapshot in self
            .threads
            .list_threads()
            .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?
        {
            let Some(turn) = snapshot.turns.iter().find(|turn| {
                matches!(
                    turn.status,
                    TurnStatus::Created
                        | TurnStatus::Running
                        | TurnStatus::WaitingForApproval
                        | TurnStatus::WaitingForUserInput
                        | TurnStatus::WaitingForCapability
                        | TurnStatus::Cancelling
                )
            }) else {
                continue;
            };
            let after_sequence = snapshot.sequence;
            self.threads
                .interrupt_turn(
                    &snapshot.thread_id,
                    InterruptTurnRequest {
                        command_id: CommandId::new(format!(
                            "dir-permission-revocation-{}-{}",
                            snapshot.thread_id, turn.turn_id
                        ))
                        .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?,
                        expected_sequence: SequenceExpectation::Exact(after_sequence),
                        turn_id: turn.turn_id.clone(),
                    },
                )
                .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?;
            let updates = self
                .threads
                .thread_updates_after(&snapshot.thread_id, after_sequence)
                .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?;
            self.updates.publish_thread(&snapshot.thread_id, &updates);
        }
        Ok(())
    }
}

#[derive(Clone)]
pub(crate) enum DirGrantPolicy {
    /// Keeps directory activation limited to inspection capabilities.
    #[cfg(test)]
    InspectOnly,
    /// Treats the local protocol connection as the host selection authority and binds every
    /// accepted selection to its exact canonical root.
    #[cfg(test)]
    HostSelectedDirs(ash_file_access::GrantSource),
    /// Resolves each client-requested root against the durable user Config authority.
    UserConfig(Arc<ConfigStore>),
}

impl DirGrantPolicy {
    fn grant(&self, dir: Dir) -> Result<Grant, EnvRuntimeError> {
        let (source, permissions) = match self {
            #[cfg(test)]
            Self::InspectOnly => (GrantSource::HostConfiguration, inspection_permissions()),
            #[cfg(test)]
            Self::HostSelectedDirs(source) => (*source, host_dir_permissions()),
            Self::UserConfig(config) => {
                let snapshot = config
                    .read_snapshot()
                    .map_err(|error| EnvRuntimeError::Failed(error.0))?;
                match snapshot
                    .values
                    .dir_permissions
                    .explicit_permissions_for(&dir.id())
                {
                    Some(permissions) => (GrantSource::ExplicitUser, permissions.clone()),
                    None => (GrantSource::HostConfiguration, inspection_permissions()),
                }
            }
        };
        Ok(Grant::for_environment(dir, source, permissions))
    }
}

fn inspection_permissions() -> Permissions {
    Permissions::new([
        Permission::ReadFiles,
        Permission::WatchFiles,
        Permission::BrowseFiles,
        Permission::SearchFiles,
        Permission::InspectRepository,
    ])
}

fn host_dir_permissions() -> Permissions {
    Permissions::new([
        Permission::ReadFiles,
        Permission::WriteFiles,
        Permission::ExecuteCommands,
        Permission::WatchFiles,
        Permission::BrowseFiles,
        Permission::SearchFiles,
        Permission::LoadInstructions,
        Permission::LoadConfig,
        Permission::DiscoverSkills,
        Permission::DiscoverMcp,
        Permission::UseLanguageServices,
        Permission::DiscoverHooks,
        Permission::DiscoverPlugins,
        Permission::InspectRepository,
        Permission::MutateRepository,
    ])
}

struct EnvToolPortState {
    dynamic: Option<ToolPort>,
    executables_enabled: bool,
    extension: Option<ToolPort>,
    host: Option<ToolPort>,
    host_available: bool,
    local: Option<ToolPort>,
    mcp: Option<ToolPort>,
    search: ToolSearchOptions,
    search_status: ToolSearchEmbeddingStatus,
    registry_generation: ToolRegistryGeneration,
}

pub(crate) struct EnvToolPorts {
    state: Mutex<EnvToolPortState>,
    reloadable: Arc<ReloadableToolPorts>,
    host: ToolPort,
    semantic_model_provider: Option<Arc<dyn SemanticModelProvider>>,
}

impl EnvToolPorts {
    #[cfg(test)]
    pub(crate) fn definitions(&self) -> Vec<ash_protocol::ToolDefinition> {
        self.reloadable.tools().definitions()
    }

    fn new(
        host: ToolPort,
        mcp: Option<ToolPort>,
        dynamic: Option<ToolPort>,
        extension: Option<ToolPort>,
        search_config: &ToolSearchConfig,
        providers: &std::collections::BTreeMap<ProviderId, ModelProviderConfig>,
        semantic_model_provider: Option<Arc<dyn SemanticModelProvider>>,
    ) -> Result<Arc<Self>, EnvRuntimeError> {
        let search =
            resolve_tool_search(search_config, providers, semantic_model_provider.as_ref());
        let registry_generation = ToolRegistryGeneration::new(1);
        let ports = extension
            .iter()
            .chain(dynamic.iter())
            .chain(mcp.iter())
            .cloned()
            .collect();
        let combined = combine_tool_ports_at_generation_with_search(
            ports,
            registry_generation,
            search.options.clone(),
        )
        .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?;
        Ok(Arc::new(Self {
            state: Mutex::new(EnvToolPortState {
                dynamic,
                executables_enabled: false,
                extension,
                host: None,
                host_available: false,
                local: None,
                mcp,
                search: search.options,
                search_status: search.status,
                registry_generation,
            }),
            reloadable: ReloadableToolPorts::new(combined),
            host,
            semantic_model_provider,
        }))
    }

    fn replace_local(&self, local: Option<ToolPort>) -> Result<(), EnvRuntimeError> {
        self.replace(|state| {
            state.local = local;
            Ok(())
        })
    }

    fn replace_executable(
        &self,
        local: Option<ToolPort>,
        executables_enabled: bool,
    ) -> Result<(), EnvRuntimeError> {
        let host = self.host.clone();
        self.replace(|state| {
            state.executables_enabled = executables_enabled;
            state.host = (executables_enabled && state.host_available).then_some(host);
            state.local = local;
            Ok(())
        })
    }

    pub(crate) fn replace_host_available(
        &self,
        host_available: bool,
    ) -> Result<(), EnvRuntimeError> {
        let host = self.host.clone();
        self.replace(|state| {
            state.host_available = host_available;
            state.host = (host_available && state.executables_enabled).then_some(host);
            Ok(())
        })
    }

    fn replace_dynamic(&self, dynamic: Option<ToolPort>) -> Result<(), EnvRuntimeError> {
        self.replace(|state| {
            state.dynamic = dynamic;
            Ok(())
        })
    }

    fn replace_extension(&self, extension: Option<ToolPort>) -> Result<(), EnvRuntimeError> {
        self.replace(|state| {
            state.extension = extension;
            Ok(())
        })
    }

    pub(crate) fn reconcile_user_config(
        &self,
        mcp: Option<ToolPort>,
        search_config: &ToolSearchConfig,
        providers: &std::collections::BTreeMap<ProviderId, ModelProviderConfig>,
    ) -> Result<(), EnvRuntimeError> {
        let search = resolve_tool_search(
            search_config,
            providers,
            self.semantic_model_provider.as_ref(),
        );
        self.replace(|state| {
            state.mcp = mcp;
            state.search = search.options;
            state.search_status = search.status;
            Ok(())
        })
    }

    fn replace(
        &self,
        update: impl FnOnce(&mut EnvToolPortState) -> Result<(), EnvRuntimeError>,
    ) -> Result<(), EnvRuntimeError> {
        let mut state = self
            .state
            .lock()
            .map_err(|_| EnvRuntimeError::Failed("Directory tool state poisoned".into()))?;
        let mut next = EnvToolPortState {
            dynamic: state.dynamic.clone(),
            executables_enabled: state.executables_enabled,
            extension: state.extension.clone(),
            host: state.host.clone(),
            host_available: state.host_available,
            local: state.local.clone(),
            mcp: state.mcp.clone(),
            search: state.search.clone(),
            search_status: state.search_status.clone(),
            registry_generation: ToolRegistryGeneration::new(
                state
                    .registry_generation
                    .get()
                    .checked_add(1)
                    .ok_or_else(|| {
                        EnvRuntimeError::Failed(
                            "Directory tool registry generation overflow".into(),
                        )
                    })?,
            ),
        };
        update(&mut next)?;
        let ports = next
            .extension
            .iter()
            .chain(next.dynamic.iter())
            .chain(next.host.iter())
            .chain(next.local.iter())
            .chain(next.mcp.iter())
            .cloned()
            .collect();
        let combined = combine_tool_ports_at_generation_with_search(
            ports,
            next.registry_generation,
            next.search.clone(),
        )
        .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?;
        *state = next;
        self.reloadable.replace(combined);
        Ok(())
    }

    pub(crate) fn record_reconcile_failure(&self, error: impl Into<String>) {
        self.reloadable.record_reconcile_failure(error);
    }

    pub(crate) fn tool_search_status(&self) -> ToolSearchEmbeddingStatus {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .search_status
            .clone()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum EnvRuntimeError {
    Unavailable,
    Busy,
    AccessRevisionConflict,
    PermissionRequired,
    Failed(String),
}

impl fmt::Display for EnvRuntimeError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Unavailable => formatter.write_str("local Directory switching is unavailable"),
            Self::Busy => formatter.write_str("a Turn is still active in the current Directory"),
            Self::AccessRevisionConflict => {
                formatter.write_str("the directory permissions changed")
            }
            Self::PermissionRequired => formatter.write_str(
                "the selected directory does not grant the capability required by this service",
            ),
            Self::Failed(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for EnvRuntimeError {}

impl AppServer {
    pub(crate) fn with_extension_tool_port(
        mut self,
        extension: Option<ToolPort>,
    ) -> Result<Self, EnvRuntimeError> {
        let Some(extension) = extension else {
            return Ok(self);
        };
        if let Some(tools) = self
            .local_env_host
            .as_ref()
            .map(|host| Arc::clone(&host.tools))
        {
            tools.replace_extension(Some(extension.clone()))?;
        } else {
            let ports = std::iter::once(extension.clone())
                .chain(self.dynamic_tool_port.iter().cloned())
                .collect();
            let combined = combine_tool_ports_at_generation_with_search(
                ports,
                ToolRegistryGeneration::new(1),
                ToolSearchOptions::default(),
            )
            .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?
            .expect("one extension ToolPort produces a combined runtime");
            self = self.with_tool_service(combined.tools, combined.policy);
        }
        self.extension_tool_port = Some(extension);
        Ok(self)
    }

    /// Installs client-hosted tools that execute through durable agent interactions.
    ///
    /// The definitions are validated and frozen before they enter the shared registry. A live
    /// connection must separately declare `DynamicTool` interaction support, list the exact hosted
    /// tool name, and subscribe to the target Thread before App Server can route an authorized
    /// invocation to it.
    pub fn with_dynamic_tools(
        mut self,
        specifications: Vec<ash_protocol::DynamicToolSpec>,
    ) -> Result<Self, DynamicToolCompositionError> {
        if self.dynamic_tool_port.is_some() {
            return Err(DynamicToolCompositionError::configuration(
                "dynamic tools are already installed",
            ));
        }
        let Some(composition) = compose_dynamic_tools(specifications)? else {
            return Ok(self);
        };
        let port = ToolPort::dynamic(composition.tools, composition.policy);
        if let Some(tools) = self
            .local_env_host
            .as_ref()
            .map(|host| Arc::clone(&host.tools))
        {
            tools
                .replace_dynamic(Some(port.clone()))
                .map_err(|error| DynamicToolCompositionError::configuration(error.to_string()))?;
        } else {
            let ports = self
                .extension_tool_port
                .iter()
                .cloned()
                .chain(std::iter::once(port.clone()))
                .collect();
            let combined = combine_tool_ports_at_generation_with_search(
                ports,
                ToolRegistryGeneration::new(1),
                ToolSearchOptions::default(),
            )
            .map_err(|error| DynamicToolCompositionError::configuration(error.to_string()))?
            .expect("one dynamic ToolPort produces a combined runtime");
            self = self.with_tool_service(combined.tools, combined.policy);
        }
        self.dynamic_tool_port = Some(port);
        Ok(self)
    }

    pub(super) fn tool_search_embedding_status(&self) -> ToolSearchEmbeddingStatus {
        self.local_env_host
            .as_ref()
            .map(|host| host.tools.tool_search_status())
            .unwrap_or(ToolSearchEmbeddingStatus::Disabled)
    }

    pub(super) fn active_dir_id(&self) -> Option<ash_file_access::DirId> {
        self.env_runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .selected_grant
            .as_ref()
            .map(|authorization| authorization.dir().id())
    }

    pub(super) fn reconcile_codebase_runtime(&self) -> Result<(), EnvRuntimeError> {
        let Some(control) = self.env_runtime_control() else {
            return Ok(());
        };
        control.reconcile_codebase_runtime()
    }

    pub(crate) fn with_local_env_host(
        mut self,
        mcp: Option<ToolPort>,
        grants: DirGrantPolicy,
    ) -> Result<Self, EnvRuntimeError> {
        if self.local_env_host.is_some() {
            return Err(EnvRuntimeError::Failed(
                "local Directory host is already installed".into(),
            ));
        }
        if matches!(self.env_state, EnvStateMode::Unconfigured) {
            return Err(EnvRuntimeError::Failed(
                "local Directory host requires an explicit Directory state mode".into(),
            ));
        }
        let (search_config, providers, hook_config) = match &self.config {
            Some(config) => {
                let snapshot = config
                    .read_snapshot()
                    .map_err(|error| EnvRuntimeError::Failed(error.0))?;
                (
                    snapshot.values.tool_search,
                    snapshot.values.providers,
                    snapshot.values.hooks,
                )
            }
            None => (
                ToolSearchConfig::default(),
                Default::default(),
                Default::default(),
            ),
        };
        let tools = EnvToolPorts::new(
            self.browser_tool_port.clone(),
            mcp,
            self.dynamic_tool_port.clone(),
            self.extension_tool_port.clone(),
            &search_config,
            &providers,
            self.semantic_model_provider.clone(),
        )?;
        let policy = Arc::new(ApprovalModeActionPolicyService::new(
            tools.reloadable.policy(),
            self.approval_review_model
                .clone()
                .map(guardian_v2::reviewer)
                .unwrap_or(ash_extension_api::ApprovalReviewer::Unavailable),
        ));
        let hooks = Arc::new(DeclarativeHookRuntime::new(
            hook_config,
            tools.reloadable.policy(),
        ));
        let mut executor = self
            .env_runtime_mut()
            .turn_executor
            .clone()
            .with_tool_service(tools.reloadable.tools(), policy)
            .with_hooks(hooks.clone())
            .with_thread_updates(Arc::new(AppServerThreadUpdates {
                threads: Arc::clone(&self.threads),
                updates: Arc::clone(&self.updates),
            }));
        executor = executor.with_extensions(Arc::clone(&self.agent_extensions));
        self.turn_backend.install_executor(executor.clone());
        self.env_runtime
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .turn_executor = executor;
        self.local_env_host = Some(LocalEnvHost {
            tools,
            hooks,
            grants,
        });
        self.use_current_env_turn_backend();
        Ok(self)
    }

    pub(crate) fn with_local_tool_config(self, config: LocalToolConfig) -> Self {
        *self
            .local_tool_config
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner()) = config;
        self
    }

    pub(crate) fn local_env_tool_ports(&self) -> Option<Arc<EnvToolPorts>> {
        self.local_env_host
            .as_ref()
            .map(|host| Arc::clone(&host.tools))
    }

    pub(crate) fn local_hook_runtime(&self) -> Option<Arc<DeclarativeHookRuntime>> {
        self.local_env_host
            .as_ref()
            .map(|host| Arc::clone(&host.hooks))
    }

    pub(crate) fn env_runtime_control(&self) -> Option<EnvRuntimeControl> {
        self.local_env_host.as_ref().map(|host| EnvRuntimeControl {
            authority_gate: Arc::clone(&self.env_runtime_gate),
            runtime: Arc::clone(&self.env_runtime),
            tools: Arc::clone(&host.tools),
            threads: self.threads.clone(),
            multi_agent: Arc::clone(&self.multi_agent),
            model_instructions: Arc::clone(&self.model_instructions),
            turn_backend: self.turn_backend.clone(),
            updates: Arc::clone(&self.updates),
            hooks: Arc::clone(&host.hooks),
            mcp_status: Arc::clone(&self.mcp_status),
            config: self.config.clone(),
            local_tool_config: Arc::clone(&self.local_tool_config),
            env_state: self.env_state.clone(),
            fast_regex_worker_command: self.fast_regex_worker_command.clone(),
            codebase_models: self.codebase_models.clone(),
            semantic_model_provider: self.semantic_model_provider.clone(),
            extension_hosts: self.extension_hosts.clone(),
        })
    }

    pub(crate) fn switch_local_dir_root(&self, root: PathBuf) -> Result<PathBuf, EnvRuntimeError> {
        let host = self
            .local_env_host
            .as_ref()
            .ok_or(EnvRuntimeError::Unavailable)?;
        let _env_runtime = self
            .env_runtime_gate
            .lock()
            .map_err(|_| EnvRuntimeError::Failed("Environment runtime gate poisoned".into()))?;
        self.ensure_env_cwd_set_is_idle()?;
        let dir =
            Dir::open_local(root).map_err(|error| EnvRuntimeError::Failed(error.to_string()))?;
        let authorization = host.grants.grant(dir)?;
        self.activate_dir_runtime(authorization, host)
    }

    pub(crate) fn set_env_cwd(&self, cwd: PathBuf) -> Result<PathBuf, EnvRuntimeError> {
        if self.local_env_host.is_none() {
            return Err(EnvRuntimeError::Unavailable);
        }
        self.ensure_env_cwd_set_is_idle()?;
        let cwd = Dir::open_local(cwd)
            .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?
            .canonical_path()
            .to_path_buf();
        self.env_runtime
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .cwd = Some(cwd.clone());
        Ok(cwd)
    }

    pub(crate) fn activate_host_configured_dir_root(
        &self,
        root: PathBuf,
    ) -> Result<PathBuf, EnvRuntimeError> {
        let host = self
            .local_env_host
            .as_ref()
            .ok_or(EnvRuntimeError::Unavailable)?;
        let _env_runtime = self
            .env_runtime_gate
            .lock()
            .map_err(|_| EnvRuntimeError::Failed("Environment runtime gate poisoned".into()))?;
        self.ensure_env_cwd_set_is_idle()?;
        let dir =
            Dir::open_local(root).map_err(|error| EnvRuntimeError::Failed(error.to_string()))?;
        let authorization =
            Grant::for_environment(dir, GrantSource::HostConfiguration, host_dir_permissions());
        self.activate_dir_runtime(authorization, host)
    }

    pub(crate) fn switch_local_dir_root_with_permissions(
        &self,
        root: PathBuf,
        source: GrantSource,
        permissions: Permissions,
    ) -> Result<PathBuf, EnvRuntimeError> {
        let host = self
            .local_env_host
            .as_ref()
            .ok_or(EnvRuntimeError::Unavailable)?;
        let _env_runtime = self
            .env_runtime_gate
            .lock()
            .map_err(|_| EnvRuntimeError::Failed("Environment runtime gate poisoned".into()))?;
        self.ensure_env_cwd_set_is_idle()?;
        let dir =
            Dir::open_local(root).map_err(|error| EnvRuntimeError::Failed(error.to_string()))?;
        self.activate_dir_runtime(Grant::for_environment(dir, source, permissions), host)
    }

    pub(crate) fn authorize_local_dir_root(
        &self,
        root: PathBuf,
        grant: Option<(GrantSource, Permissions)>,
    ) -> Result<Grant, EnvRuntimeError> {
        let host = self
            .local_env_host
            .as_ref()
            .ok_or(EnvRuntimeError::Unavailable)?;
        let dir =
            Dir::open_local(root).map_err(|error| EnvRuntimeError::Failed(error.to_string()))?;
        match grant {
            Some((source, permissions)) => Ok(Grant::for_environment(dir, source, permissions)),
            None => host.grants.grant(dir),
        }
    }

    pub(crate) fn activate_local_dirs(
        &self,
        dirs: Vec<(String, Grant)>,
    ) -> Result<Vec<(String, PathBuf, Permissions)>, EnvRuntimeError> {
        let host = self
            .local_env_host
            .as_ref()
            .ok_or(EnvRuntimeError::Unavailable)?;
        let _env_runtime = self
            .env_runtime_gate
            .lock()
            .map_err(|_| EnvRuntimeError::Failed("Environment runtime gate poisoned".into()))?;
        self.ensure_env_cwd_set_is_idle()?;
        if dirs.is_empty() {
            host.hooks.unbind_dir();
            host.tools.replace_executable(None, false)?;
            if let Some(extension_hosts) = &self.extension_hosts {
                extension_hosts.unbind_dir();
            }
            let mut current = self
                .env_runtime
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            current.dir_grants.clear();
            let executor = current.turn_executor.clone().without_context_source("codebase");
            let executor = match &self.home {
                Some(home) => executor
                    .with_harness_context_provider(Arc::new(HomeContext::new(Arc::clone(home)))),
                None => executor
                    .with_instructions(Arc::new(ash_core::HarnessInstructions::default())),
            };
            let mut next = EnvRuntime::empty(executor);
            next.cwd = current.cwd.clone();
            next.dir_grants = Arc::clone(&current.dir_grants);
            let previous = std::mem::replace(&mut *current, next);
            drop(current);
            retire_env_runtime(previous, None, None, None);
            self.reset_language_env_runtimes();
            return Ok(Vec::new());
        }
        let Some((_, primary)) = dirs.first() else {
            unreachable!("empty directory sets are handled above");
        };
        let git_dirs = dirs
            .iter()
            .map(|(id, authorization)| {
                authorization
                    .authorize(Permission::InspectRepository)
                    .map(|dir| (id.clone(), dir))
                    .map_err(|_| EnvRuntimeError::PermissionRequired)
            })
            .collect::<Result<Vec<_>, _>>()?;
        let git =
            GitRuntime::new_for_dirs(git_dirs, Arc::clone(&self.updates)).map_err(|error| {
                EnvRuntimeError::Failed(format!(
                    "failed to initialize multi-root Git runtime: {error:?}"
                ))
            })?;
        let watcher = git.start_watching();
        let dirs = dirs.iter().cloned().collect::<BTreeMap<_, _>>();
        let dir_file_systems = dirs
            .iter()
            .map(|(id, authorization)| {
                let file_system: Arc<dyn FileSystem> =
                    Arc::new(LocalFileSystem::new(authorization.clone()));
                (id.clone(), file_system)
            })
            .collect::<BTreeMap<_, _>>();
        self.activate_dir_runtime(primary.clone(), host)?;
        let (ripgrep, agent_grep, primary_search, primary_terminals, primary_debug_adapters) = {
            let runtime = self
                .env_runtime
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            (
                runtime.ripgrep.clone(),
                runtime.agent_grep.clone(),
                runtime.content_search.clone(),
                runtime.terminals.clone(),
                runtime.debug_adapters.clone(),
            )
        };
        let dir_file_system_watchers = dirs
            .iter()
            .skip(1)
            .map(|(id, authorization)| {
                FileSystemWatcher::start_for_dir(
                    authorization.dir().clone(),
                    Arc::clone(&self.updates),
                    id.clone(),
                    agent_grep.clone(),
                )
                .map_err(|error| {
                    EnvRuntimeError::Failed(format!(
                        "failed to initialize dir folder watcher: {error}"
                    ))
                })
            })
            .collect::<Result<Vec<_>, _>>()?;
        let dir_content_search = dirs
            .iter()
            .enumerate()
            .filter_map(|(index, (id, authorization))| {
                if !authorization.permissions().allows(Permission::SearchFiles) {
                    return None;
                }
                let service = if index == 0 {
                    primary_search.clone()
                } else {
                    ripgrep.as_ref().map(|ripgrep| {
                        Arc::new(ContentSearchService::new(
                            authorization.dir().clone(),
                            ripgrep.clone(),
                        ))
                    })
                }?;
                Some((id.clone(), service))
            })
            .collect::<BTreeMap<_, _>>();
        let mut dir_terminals = BTreeMap::new();
        for (index, (id, authorization)) in dirs.iter().enumerate() {
            if !authorization
                .permissions()
                .allows(Permission::ExecuteCommands)
            {
                continue;
            }
            let terminals = if index == 0 {
                primary_terminals.clone()
            } else {
                let capability = authorization
                    .authorize(Permission::ExecuteCommands)
                    .map_err(|_| EnvRuntimeError::PermissionRequired)?;
                Some(Arc::new(
                    crate::terminal_service::TerminalService::new(capability).map_err(|_| {
                        EnvRuntimeError::Failed(
                            "failed to initialize dir folder terminal runtime".into(),
                        )
                    })?,
                ))
            };
            if let Some(terminals) = terminals {
                dir_terminals.insert(id.clone(), terminals);
            }
        }
        let mut dir_debug_adapters = BTreeMap::new();
        for (index, (id, authorization)) in dirs.iter().enumerate() {
            if !authorization.permissions().allows(Permission::LoadConfig)
                || !authorization
                    .permissions()
                    .allows(Permission::ExecuteCommands)
            {
                continue;
            }
            let debug_adapters = if index == 0 {
                primary_debug_adapters.clone()
            } else {
                Some(Arc::new(
                    crate::debug_service::DebugAdapterService::new(
                        authorization
                            .authorize(Permission::LoadConfig)
                            .map_err(|_| EnvRuntimeError::PermissionRequired)?,
                        authorization
                            .authorize(Permission::ExecuteCommands)
                            .map_err(|_| EnvRuntimeError::PermissionRequired)?,
                        crate::terminal_environment::safe_process_environment(),
                    )
                    .map_err(|_| {
                        EnvRuntimeError::Failed(
                            "failed to initialize dir folder debug adapter runtime".into(),
                        )
                    })?,
                ))
            };
            if let Some(debug_adapters) = debug_adapters {
                dir_debug_adapters.insert(id.clone(), debug_adapters);
            }
        }
        let (previous_watcher, previous_dir_watchers) = {
            let mut runtime = self
                .env_runtime
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let previous_watcher = runtime._git_watcher.take();
            let previous_dir_watchers = std::mem::take(&mut runtime._dir_file_system_watchers);
            runtime.dirs = dirs.clone();
            runtime.dir_file_systems = dir_file_systems;
            runtime._dir_file_system_watchers = dir_file_system_watchers;
            runtime.dir_content_search = dir_content_search;
            runtime.dir_terminals = dir_terminals;
            runtime.dir_debug_adapters = dir_debug_adapters;
            runtime.git = Some(git);
            runtime._git_watcher = Some(watcher);
            (previous_watcher, previous_dir_watchers)
        };
        drop(previous_watcher);
        drop(previous_dir_watchers);
        self.reset_language_env_runtimes();
        Ok(dirs
            .into_iter()
            .map(|(id, authorization)| {
                (
                    id,
                    authorization.dir().canonical_path().to_path_buf(),
                    authorization.permissions().clone(),
                )
            })
            .collect())
    }

    pub(super) fn list_session_dirs(
        &self,
        session_id: &SessionId,
    ) -> Result<SessionDirEntrySnapshotSet, EnvRuntimeError> {
        ensure_session_exists(&self.threads, session_id)?;
        let runtime = self
            .env_runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if runtime.selected_grant.is_none() {
            return Err(EnvRuntimeError::Unavailable);
        }
        Ok(session_dir_snapshots(&runtime.dir_grants, session_id))
    }

    pub(super) fn add_session_dir(
        &self,
        session_id: &SessionId,
        root: PathBuf,
        permissions: ash_file_access::Permissions,
    ) -> Result<(PathBuf, Mutation, SessionDirEntrySnapshotSet), EnvRuntimeError> {
        ensure_session_exists(&self.threads, session_id)?;
        let _env_runtime = self
            .env_runtime_gate
            .lock()
            .map_err(|_| EnvRuntimeError::Failed("Environment runtime gate poisoned".into()))?;
        let (primary, dir_grants) = {
            let runtime = self
                .env_runtime
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            let primary = runtime
                .selected_grant
                .as_ref()
                .map(|authorization| authorization.dir().clone())
                .ok_or(EnvRuntimeError::Unavailable)?;
            (primary, Arc::clone(&runtime.dir_grants))
        };
        let requested = if root.is_absolute() {
            root
        } else {
            primary.canonical_path().join(root)
        };
        let dir = Dir::open_local(requested)
            .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?;
        let path = dir.canonical_path().to_path_buf();
        let authorization = Grant::for_session_tree(
            session_id.clone(),
            dir,
            GrantSource::ExplicitUser,
            permissions,
        );
        let mutation = dir_grants
            .add_dir(session_id.clone(), authorization)
            .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?;
        self.reconcile_session_dir_consumers(session_id)?;
        let snapshots = session_dir_snapshots(&dir_grants, session_id);
        Ok((path, mutation, snapshots))
    }

    pub(super) fn remove_session_dir(
        &self,
        session_id: &SessionId,
        root: &std::path::Path,
    ) -> Result<(Mutation, SessionDirEntrySnapshotSet), EnvRuntimeError> {
        ensure_session_exists(&self.threads, session_id)?;
        let _env_runtime = self
            .env_runtime_gate
            .lock()
            .map_err(|_| EnvRuntimeError::Failed("Environment runtime gate poisoned".into()))?;
        let dir_grants = {
            let runtime = self
                .env_runtime
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if runtime.selected_grant.is_none() {
                return Err(EnvRuntimeError::Unavailable);
            }
            Arc::clone(&runtime.dir_grants)
        };
        let mutation = dir_grants.remove_dir(session_id, root);
        self.reconcile_session_dir_consumers(session_id)?;
        self.terminate_revoked_terminal_sessions();
        let snapshots = session_dir_snapshots(&dir_grants, session_id);
        Ok((mutation, snapshots))
    }

    pub(super) fn set_session_dir_permissions(
        &self,
        session_id: &SessionId,
        root: &std::path::Path,
        expected_revision: u64,
        permissions: ash_file_access::Permissions,
    ) -> Result<(Mutation, SessionDirEntrySnapshotSet), EnvRuntimeError> {
        ensure_session_exists(&self.threads, session_id)?;
        let _env_runtime = self
            .env_runtime_gate
            .lock()
            .map_err(|_| EnvRuntimeError::Failed("Environment runtime gate poisoned".into()))?;
        let dir_grants = {
            let runtime = self
                .env_runtime
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if runtime.selected_grant.is_none() {
                return Err(EnvRuntimeError::Unavailable);
            }
            Arc::clone(&runtime.dir_grants)
        };
        let mutation = dir_grants
            .set_permissions(session_id, root, expected_revision, permissions)
            .map_err(|error| match error {
                ash_file_access::AccessError::RevisionConflict { .. } => {
                    EnvRuntimeError::AccessRevisionConflict
                }
                other => EnvRuntimeError::Failed(other.to_string()),
            })?;
        self.reconcile_session_dir_consumers(session_id)?;
        self.terminate_revoked_terminal_sessions();
        let snapshots = session_dir_snapshots(&dir_grants, session_id);
        Ok((mutation, snapshots))
    }

    fn reconcile_session_dir_consumers(
        &self,
        session_id: &SessionId,
    ) -> Result<(), EnvRuntimeError> {
        let (access, customizations) = {
            let runtime = self
                .env_runtime
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            (
                Arc::clone(&runtime.dir_grants),
                runtime._dir_contributions.clone(),
            )
        };
        let instruction_dirs = access
            .snapshot_for(session_id, Permission::LoadInstructions)
            .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?
            .map(|snapshot| snapshot.authorizations().to_vec())
            .unwrap_or_default();
        let watched_dirs = access
            .snapshot_for(session_id, Permission::WatchFiles)
            .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?
            .map(|snapshot| snapshot.authorizations().to_vec())
            .unwrap_or_default();
        if let Some(host) = &self.local_env_host {
            let hook_dirs = access
                .snapshot_for(session_id, Permission::DiscoverHooks)
                .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?
                .into_iter()
                .flat_map(|snapshot| snapshot.authorizations().to_vec())
                .filter_map(|discovery| {
                    access
                        .authorize(
                            session_id,
                            discovery.dir().canonical_path(),
                            Permission::ExecuteCommands,
                        )
                        .transpose()
                        .map(|execution| execution.map(|execution| (discovery, execution)))
                })
                .collect::<Result<Vec<_>, _>>()
                .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?
                .into_iter()
                .map(|(discovery, execution)| {
                    read_dir_config(discovery.dir())
                        .map(|document| (document.hooks, discovery, execution))
                })
                .collect::<Result<Vec<_>, _>>()?;
            host.hooks
                .replace_session_dirs(session_id.clone(), hook_dirs)
                .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?;
        }
        let mut language_roots = access.dirs_for(Permission::UseLanguageServices);
        let execution_roots = access.dirs_for(Permission::ExecuteCommands);
        language_roots.retain(|root| execution_roots.contains(root));
        self.language
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .retain_dir_roots(&language_roots);
        if let Some(customizations) = &customizations {
            customizations.reconcile_session(session_id, instruction_dirs);
        }
        let desired = watched_dirs
            .into_iter()
            .map(|authorization| {
                (
                    authorization.dir().canonical_path().to_path_buf(),
                    authorization,
                )
            })
            .collect::<BTreeMap<_, _>>();
        let mut runtime = self
            .env_runtime
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        runtime
            .session_dir_watchers
            .retain(|(candidate_session, root), _| {
                candidate_session != session_id || desired.contains_key(root)
            });
        runtime
            .session_dir_search
            .retain(|(candidate_session, root), _| {
                if candidate_session != session_id {
                    return true;
                }
                access
                    .authorize(session_id, root, Permission::SearchFiles)
                    .ok()
                    .flatten()
                    .is_some()
            });
        let agent_grep = runtime.agent_grep.clone();
        let Some(customizations) = customizations else {
            return Ok(());
        };
        for (root, dir) in desired {
            let key = (session_id.clone(), root);
            if let Some(existing) = runtime.session_dir_watchers.get_mut(&key) {
                existing.authorization = dir;
                continue;
            }
            let watcher = FileSystemWatcher::start_for_session_directory(
                dir.dir().clone(),
                Arc::clone(&self.updates),
                session_id.clone(),
                customizations.clone(),
                agent_grep.clone(),
            )
            .map_err(|error| {
                EnvRuntimeError::Failed(format!("failed to initialize directory watcher: {error}"))
            })?;
            runtime.session_dir_watchers.insert(
                key,
                SessionDirEntryWatcher {
                    authorization: dir,
                    _watcher: watcher,
                },
            );
        }
        Ok(())
    }

    pub(super) fn clear_session_dirs(&self, session_id: &SessionId) {
        let _env_runtime = self
            .env_runtime_gate
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let mut runtime = self
            .env_runtime
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        runtime.dir_grants.clear_session(session_id);
        runtime
            .session_dir_watchers
            .retain(|(candidate, _), _| candidate != session_id);
        runtime
            .session_dir_search
            .retain(|(candidate, _), _| candidate != session_id);
        if let Some(customizations) = &runtime._dir_contributions {
            customizations.remove_session(session_id);
        }
        if let Some(host) = &self.local_env_host {
            host.hooks.remove_session(session_id);
        }
        drop(runtime);
        self.terminate_revoked_terminal_sessions();
    }

    fn activate_dir_runtime(
        &self,
        authorization: Grant,
        host: &LocalEnvHost,
    ) -> Result<PathBuf, EnvRuntimeError> {
        if self.selected_grant_is_current(&authorization) {
            return Ok(authorization.dir().canonical_path().to_path_buf());
        }
        let result = if !authorization
            .permissions()
            .allows(Permission::ExecuteCommands)
        {
            self.commit_limited_dir_runtime(authorization, host)
        } else {
            let local_tool_config = self
                .local_tool_config
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .clone();
            let dir_grants = self
                .env_runtime
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .dir_grants
                .clone();
            let local = compose_local_tools_with_config(
                authorization.clone(),
                &local_tool_config,
                dir_grants,
                None,
                self.env_state.runtime(),
                self.fast_regex_worker_command.as_ref(),
            )
            .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?;
            self.commit_full_env_runtime(authorization, local, host)
        };
        if result.is_ok() {
            self.reset_language_env_runtimes();
        }
        result
    }

    fn reset_language_env_runtimes(&self) {
        if let Ok(mut language) = self.language.lock() {
            language.reset_dirs();
        }
    }

    fn commit_limited_dir_runtime(
        &self,
        authorization: Grant,
        host: &LocalEnvHost,
    ) -> Result<PathBuf, EnvRuntimeError> {
        let dir = authorization.dir().clone();
        let canonical_root = dir.canonical_path().to_path_buf();
        self.revoke_cloud_index_for_dir(&dir);
        let file_system: Arc<dyn FileSystem> =
            Arc::new(LocalFileSystem::new(authorization.clone()));
        let codebase = self.open_codebase_runtime(dir.clone())?;
        let symbol_index = self.open_symbol_index_runtime(&codebase)?;
        self.retry_persisted_cloud_index_deletion(&codebase);
        let repository_inspection = authorization
            .authorize(Permission::InspectRepository)
            .map_err(|_| EnvRuntimeError::Failed("failed to authorize Git inspection".into()))?;
        let git = GitRuntime::new(repository_inspection, Arc::clone(&self.updates))
            .map_err(|_| EnvRuntimeError::Failed("failed to initialize Git runtime".into()))?;
        let dir_grants = self
            .env_runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .dir_grants
            .clone();
        let customizations = DirContributions::discover(
            &canonical_root,
            dir_grants,
            authorization.authorize(Permission::LoadInstructions).ok(),
            self.home.clone(),
        )
        .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?;
        let file_system_watcher = FileSystemWatcher::start_with_observers(
            dir,
            Arc::clone(&self.updates),
            Arc::clone(&codebase),
            Arc::clone(&symbol_index),
            None,
            customizations.clone(),
            None,
        )
        .map_err(|error| {
            EnvRuntimeError::Failed(format!("failed to initialize filesystem watcher: {error}"))
        })?;

        host.hooks.unbind_dir();
        host.tools.replace_executable(None, false)?;
        self.bind_dir_skills(&canonical_root)?;
        if let Some(extension_hosts) = &self.extension_hosts {
            extension_hosts.unbind_dir();
        }
        let mut current = self
            .env_runtime
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        current.dir_grants.clear();
        let next = EnvRuntime {
            cwd: current.cwd.clone(),
            selected_grant: Some(authorization),
            selected_file_system: Some(file_system),
            dirs: BTreeMap::new(),
            dir_file_systems: BTreeMap::new(),
            _file_system_watcher: Some(file_system_watcher),
            _dir_file_system_watchers: Vec::new(),
            session_dir_watchers: BTreeMap::new(),
            _git_watcher: None,
            git: Some(Arc::clone(&git)),
            content_search: None,
            dir_content_search: BTreeMap::new(),
            session_dir_search: BTreeMap::new(),
            ripgrep: None,
            agent_grep: None,
            codebase: Some(codebase),
            symbol_index: Some(symbol_index),
            codebase_semantic: None,
            codebase_semantic_job: None,
            cloud_codebase: None,
            _dir_contributions: Some(Arc::clone(&customizations)),
            terminals: None,
            dir_terminals: BTreeMap::new(),
            debug_adapters: None,
            dir_debug_adapters: BTreeMap::new(),
            dir_grants: Arc::clone(&current.dir_grants),
            turn_executor: current
                .turn_executor
                .clone()
                .with_harness_context_provider(customizations)
                .without_context_source("codebase"),
        };
        let previous = std::mem::replace(&mut *current, next);
        drop(current);
        retire_env_runtime(previous, None, None, None);
        Ok(canonical_root)
    }

    fn commit_full_env_runtime(
        &self,
        authorization: Grant,
        local: crate::local_tools::LocalToolComposition,
        host: &LocalEnvHost,
    ) -> Result<PathBuf, EnvRuntimeError> {
        let dir = authorization.dir().clone();
        let file_system: Arc<dyn FileSystem> =
            Arc::new(LocalFileSystem::new(authorization.clone()));
        let codebase = self.open_codebase_runtime(dir.clone())?;
        let symbol_index = self.open_symbol_index_runtime(&codebase)?;
        let codebase_semantic = self.open_codebase_semantic(&codebase)?;
        let codebase_semantic_job =
            codebase_semantic
                .as_ref()
                .and_then(
                    |service| match SemanticIndexJobController::start(Arc::clone(service)) {
                        Ok(job) => Some(job),
                        Err(error) => {
                            log::warn!("semantic codebase job is unavailable: {error}");
                            None
                        }
                    },
                );
        let cloud_codebase = self.open_cloud_codebase_controller(&codebase);
        let canonical_root = dir.canonical_path().to_path_buf();
        let dir_grants = self
            .env_runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .dir_grants
            .clone();
        let customizations = DirContributions::discover(
            &canonical_root,
            dir_grants,
            authorization.authorize(Permission::LoadInstructions).ok(),
            self.home.clone(),
        )
        .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?;
        let repository_mutation = authorization
            .authorize(Permission::MutateRepository)
            .map_err(|_| EnvRuntimeError::PermissionRequired)?;
        let git = GitRuntime::new(repository_mutation, Arc::clone(&self.updates))
            .map_err(|_| EnvRuntimeError::Failed("failed to initialize Git runtime".into()))?;
        let agent_grep = Arc::clone(&local.agent_grep);
        let file_system_watcher = FileSystemWatcher::start_with_observers(
            dir.clone(),
            Arc::clone(&self.updates),
            Arc::clone(&codebase),
            Arc::clone(&symbol_index),
            codebase_semantic_job.clone(),
            customizations.clone(),
            Some(Arc::clone(&agent_grep)),
        )
        .map_err(|error| {
            EnvRuntimeError::Failed(format!("failed to initialize filesystem watcher: {error}"))
        })?;
        let retrieval_authorization = authorization
            .authorize(Permission::ExecuteCommands)
            .map_err(|_| EnvRuntimeError::PermissionRequired)?;
        let action_policy_revision = local.action_policy_revision().clone();
        let local = append_local_tool(
            local,
            Arc::new(
                CodebaseRetrievalTool::new(
                    retrieval_authorization,
                    codebase.index(),
                    Some(symbol_index.index()),
                    codebase_semantic.clone(),
                    cloud_codebase.clone(),
                )
                .with_action_policy_revision(action_policy_revision),
            ),
        );
        let turn_backend: Arc<dyn ash_core::TurnExecutionBackend> = self.turn_backend.clone();
        let local = append_multi_agent_tools(
            local,
            &self.multi_agent,
            &self.model_instructions,
            &self.threads,
            &turn_backend,
            Some(&customizations),
        )?;
        let local_port = local
            .tool_port()
            .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?;
        let (existing_search, existing_terminals) = {
            let current = self
                .env_runtime
                .read()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            (current.content_search.clone(), current.terminals.clone())
        };
        let content_search = existing_search.unwrap_or_else(|| {
            Arc::new(ContentSearchService::new(
                dir.clone(),
                local.ripgrep.clone(),
            ))
        });
        let ripgrep = local.ripgrep.clone();
        content_search.cancel_all();
        content_search.set_dir(dir.clone());
        let terminal_capability = authorization
            .authorize(Permission::ExecuteCommands)
            .map_err(|_| EnvRuntimeError::PermissionRequired)?;
        let terminals = match existing_terminals {
            Some(terminals) => {
                terminals.terminate_all();
                terminals.set_dir(terminal_capability).map_err(|_| {
                    EnvRuntimeError::Failed("failed to switch terminal runtime".into())
                })?;
                terminals
            }
            None => Arc::new(
                crate::terminal_service::TerminalService::new(terminal_capability).map_err(
                    |_| EnvRuntimeError::Failed("failed to initialize terminal runtime".into()),
                )?,
            ),
        };
        let debug_adapters = Arc::new(
            crate::debug_service::DebugAdapterService::new(
                authorization
                    .authorize(Permission::LoadConfig)
                    .map_err(|_| EnvRuntimeError::PermissionRequired)?,
                authorization
                    .authorize(Permission::ExecuteCommands)
                    .map_err(|_| EnvRuntimeError::PermissionRequired)?,
                crate::terminal_environment::safe_process_environment(),
            )
            .map_err(|_| {
                EnvRuntimeError::Failed("failed to initialize debug adapter runtime".into())
            })?,
        );
        host.hooks
            .bind_dir(dir.clone())
            .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?;
        customizations.bind_hooks(Arc::clone(&host.hooks));
        host.tools.replace_executable(Some(local_port), true)?;
        self.bind_dir_skills(&canonical_root)?;
        let context_source = Arc::new(CodebaseRetrievalContextSource::new(
            codebase.index(),
            Some(symbol_index.index()),
            codebase_semantic.clone(),
            cloud_codebase.clone(),
            self.config.clone(),
        ));
        let extension_authorization = authorization
            .authorize(Permission::DiscoverPlugins)
            .map_err(|_| EnvRuntimeError::PermissionRequired)?;
        if let Some(extension_hosts) = &self.extension_hosts {
            extension_hosts.unbind_dir();
        }
        let mut current = self
            .env_runtime
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        current.dir_grants.clear();
        let next = EnvRuntime {
            cwd: current.cwd.clone(),
            selected_grant: Some(authorization),
            selected_file_system: Some(file_system),
            dirs: BTreeMap::new(),
            dir_file_systems: BTreeMap::new(),
            _file_system_watcher: Some(file_system_watcher),
            _dir_file_system_watchers: Vec::new(),
            session_dir_watchers: BTreeMap::new(),
            _git_watcher: None,
            git: Some(Arc::clone(&git)),
            content_search: Some(Arc::clone(&content_search)),
            dir_content_search: BTreeMap::new(),
            session_dir_search: BTreeMap::new(),
            ripgrep: Some(ripgrep),
            agent_grep: Some(agent_grep),
            codebase: Some(codebase),
            symbol_index: Some(symbol_index),
            codebase_semantic,
            codebase_semantic_job,
            cloud_codebase,
            _dir_contributions: Some(Arc::clone(&customizations)),
            terminals: Some(Arc::clone(&terminals)),
            dir_terminals: BTreeMap::new(),
            debug_adapters: Some(Arc::clone(&debug_adapters)),
            dir_debug_adapters: BTreeMap::new(),
            dir_grants: Arc::clone(&current.dir_grants),
            turn_executor: current
                .turn_executor
                .clone()
                .with_harness_context_provider(customizations)
                .with_context_source("codebase", context_source),
        };
        let previous = std::mem::replace(&mut *current, next);
        drop(current);
        retire_env_runtime(
            previous,
            Some(&content_search),
            Some(&terminals),
            Some(&debug_adapters),
        );
        if let Some(extension_hosts) = &self.extension_hosts
            && extension_hosts.bind_dir(extension_authorization).is_err()
        {
            log::warn!("failed to bind executable Editor Extensions to the new dir");
        }
        let git_watcher = git.start_watching();
        let mut runtime = self
            .env_runtime
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        runtime._git_watcher = Some(git_watcher);
        Ok(canonical_root)
    }

    fn bind_dir_skills(&self, dir_root: &std::path::Path) -> Result<(), EnvRuntimeError> {
        let Some(skills) = &self.skills else {
            return Ok(());
        };
        skills
            .bind_dir_root(dir_root.to_path_buf())
            .map(|_| ())
            .map_err(|error| {
                EnvRuntimeError::Failed(format!("failed to bind Directory Skill source: {error}"))
            })
    }

    fn selected_grant_is_current(&self, authorization: &Grant) -> bool {
        self.env_runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .selected_grant
            .as_ref()
            .is_some_and(|current| {
                current.dir() == authorization.dir()
                    && current.source() == authorization.source()
                    && current.permissions() == authorization.permissions()
                    && current.is_active() == authorization.is_active()
            })
    }

    #[cfg(test)]
    pub(crate) fn selected_dir_allows(&self, permission: Permission) -> bool {
        self.env_runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .selected_grant
            .as_ref()
            .is_some_and(|grant| grant.permissions().allows(permission))
    }

    pub(super) fn env_features(&self) -> (bool, bool, bool, bool, bool, bool, bool) {
        let runtime = self
            .env_runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let switchable = self.local_env_host.is_some();
        (
            switchable || runtime.selected_file_system.is_some(),
            switchable || runtime.git.is_some(),
            switchable || runtime.content_search.is_some(),
            switchable || runtime.codebase.is_some(),
            (switchable && !self.cloud_codebase_providers.is_empty())
                || runtime.cloud_codebase.is_some(),
            switchable || runtime.terminals.is_some(),
            switchable || runtime.debug_adapters.is_some(),
        )
    }

    pub(super) fn extension_dir_authorization(&self) -> Option<ash_file_access::Authorization> {
        self.env_runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .selected_grant
            .as_ref()?
            .authorize(Permission::DiscoverPlugins)
            .ok()
    }

    fn open_codebase_runtime(&self, dir: Dir) -> Result<Arc<CodebaseRuntime>, EnvRuntimeError> {
        let dir_id = dir.id();
        let store = match &self.env_state {
            EnvStateMode::Persistent(state) => {
                CodebaseStore::open(state, &dir_id).map_err(|error| {
                    EnvRuntimeError::Failed(format!("failed to lock Codebase storage: {error}"))
                })?
            }
            EnvStateMode::Ephemeral => CodebaseStore::memory(),
            EnvStateMode::Unconfigured => {
                return Err(EnvRuntimeError::Failed(
                    "Directory state mode is not configured".into(),
                ));
            }
        };
        CodebaseRuntime::open(dir, Arc::new(store))
            .map_err(|error| EnvRuntimeError::Failed(format!("failed to open Codebase: {error}")))
    }

    pub(super) fn codebase_service(&self) -> Result<Arc<CodebaseRuntime>, RpcError> {
        self.env_runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .codebase
            .clone()
            .ok_or_else(|| RpcError::new(-32090, AppServerErrorName::CodebaseUnavailable))
    }

    pub(super) fn agent_grep_index_context(
        &self,
    ) -> Result<(Arc<AgentGrepService>, Dir), RpcError> {
        let runtime = self
            .env_runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let root = runtime
            .selected_grant
            .as_ref()
            .map(|authorization| authorization.dir().clone())
            .ok_or_else(|| RpcError::new(-32090, AppServerErrorName::CodebaseUnavailable))?;
        let service = runtime
            .agent_grep
            .clone()
            .ok_or_else(|| RpcError::new(-32090, AppServerErrorName::CodebaseUnavailable))?;
        Ok((service, root))
    }

    fn open_symbol_index_runtime(
        &self,
        codebase: &Arc<CodebaseRuntime>,
    ) -> Result<Arc<SymbolIndexRuntime>, EnvRuntimeError> {
        SymbolIndexRuntime::open(codebase.index(), codebase.store()).map_err(|error| {
            EnvRuntimeError::Failed(format!("failed to open symbol index: {error}"))
        })
    }

    pub(super) fn symbol_index_service(&self) -> Result<Arc<SymbolIndexRuntime>, RpcError> {
        self.env_runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .symbol_index
            .clone()
            .ok_or_else(|| RpcError::new(-32092, AppServerErrorName::CodebaseSymbolsUnavailable))
    }

    fn open_codebase_semantic(
        &self,
        codebase: &Arc<CodebaseRuntime>,
    ) -> Result<Option<Arc<CodebaseSemanticService>>, EnvRuntimeError> {
        open_codebase_semantic_runtime(
            codebase,
            self.codebase_models.as_ref(),
            self.semantic_model_provider.as_ref(),
            self.config.as_ref(),
        )
    }

    pub(crate) fn codebase_semantic_service(&self) -> Option<Arc<CodebaseSemanticService>> {
        self.env_runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .codebase_semantic
            .clone()
    }

    pub(super) fn codebase_semantic_job(&self) -> Option<Arc<SemanticIndexJobController>> {
        self.env_runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .codebase_semantic_job
            .clone()
    }

    fn open_cloud_codebase_controller(
        &self,
        codebase: &Arc<CodebaseRuntime>,
    ) -> Option<Arc<CloudCodebaseController>> {
        if self.cloud_codebase_providers.is_empty() {
            return None;
        }
        let dir_id = codebase.root().id();
        let digest = dir_id
            .as_str()
            .strip_prefix("sha256:")
            .unwrap_or(dir_id.as_str());
        let storage = self
            .cloud_codebase_storage_root
            .as_ref()
            .map_or(CloudCodebaseStorage::Memory, |root| {
                CloudCodebaseStorage::Persistent(root.join(format!("{digest}.sqlite3")))
            });
        match CloudCodebaseController::open(
            codebase.index(),
            self.cloud_codebase_providers.clone(),
            storage,
        ) {
            Ok(controller) => Some(controller),
            Err(error) => {
                log::warn!("cloud codebase authority is unavailable: {error}");
                None
            }
        }
    }

    fn revoke_cloud_index_for_dir(&self, dir: &Dir) {
        let mut runtime = self
            .env_runtime
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let same_root = runtime
            .selected_grant
            .as_ref()
            .is_some_and(|authorization| authorization.dir() == dir);
        let controller = if same_root {
            if let Some(authorization) = runtime.selected_grant.as_ref() {
                authorization.revoke();
            }
            runtime.cloud_codebase.take()
        } else {
            None
        };
        drop(runtime);
        if let Some(controller) = controller
            && controller.revoke().is_err()
        {
            log::warn!("cloud codebase deletion remains pending after directory access revocation");
        }
    }

    fn retry_persisted_cloud_index_deletion(&self, codebase: &Arc<CodebaseRuntime>) {
        let Some(controller) = self.open_cloud_codebase_controller(codebase) else {
            return;
        };
        if controller.revoke().is_err() {
            log::warn!("cloud codebase deletion remains pending for the directory");
        }
    }

    pub(super) fn cloud_codebase_service(&self) -> Result<Arc<CloudCodebaseController>, RpcError> {
        self.env_runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .cloud_codebase
            .clone()
            .ok_or_else(|| RpcError::new(-32093, AppServerErrorName::CloudCodebaseUnavailable))
    }

    pub(super) fn file_system_service_for(
        &self,
        dir_id: Option<&str>,
    ) -> Result<Arc<dyn FileSystem>, RpcError> {
        let runtime = self
            .env_runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(dir_id) = dir_id {
            return runtime
                .dir_file_systems
                .get(dir_id)
                .cloned()
                .ok_or_else(|| RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        runtime
            .selected_file_system
            .clone()
            .ok_or_else(|| RpcError::new(-32040, AppServerErrorName::FileSystemUnavailable))
    }

    pub(super) fn file_system_service_for_session_directory(
        &self,
        selector: &ash_app_server_protocol::protocol::environment::SessionDirSelector,
        permission: Permission,
    ) -> Result<Arc<dyn FileSystem>, RpcError> {
        let dir =
            self.session_dir_authorization(&selector.session_id, &selector.path, permission)?;
        Ok(Arc::new(LocalFileSystem::from_authorization(dir)))
    }

    pub(super) fn language_dir_root_for(
        &self,
        dir_id: Option<&str>,
        session_directory: Option<
            &ash_app_server_protocol::protocol::environment::SessionDirSelector,
        >,
    ) -> Result<Dir, RpcError> {
        if dir_id.is_some() && session_directory.is_some() {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        if let Some(selector) = session_directory {
            let language = self.session_dir_authorization(
                &selector.session_id,
                &selector.path,
                Permission::UseLanguageServices,
            )?;
            self.session_dir_authorization(
                &selector.session_id,
                &selector.path,
                Permission::ExecuteCommands,
            )?;
            return Ok(language.dir().clone());
        }
        let runtime = self
            .env_runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let authorization = match dir_id {
            Some(id) => runtime
                .dirs
                .get(id)
                .ok_or_else(|| RpcError::new(-32602, AppServerErrorName::InvalidParams))?,
            None => runtime.selected_grant.as_ref().ok_or_else(|| {
                RpcError::new(-32040, AppServerErrorName::LanguageServiceUnavailable)
            })?,
        };
        authorization
            .authorize(Permission::ExecuteCommands)
            .map_err(|_| RpcError::new(-32043, AppServerErrorName::PermissionRequired))?;
        Ok(authorization.dir().clone())
    }

    pub(super) fn git_runtime_service(&self) -> Result<Arc<GitRuntime>, RpcError> {
        self.env_runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .git
            .clone()
            .ok_or_else(|| RpcError::new(-32060, AppServerErrorName::GitUnavailable))
    }

    pub(super) fn content_search_service_for(
        &self,
        dir_id: Option<&str>,
    ) -> Result<Arc<ContentSearchService>, RpcError> {
        let runtime = self
            .env_runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(dir_id) = dir_id {
            return runtime
                .dir_content_search
                .get(dir_id)
                .cloned()
                .ok_or_else(|| RpcError::new(-32050, AppServerErrorName::SearchUnavailable));
        }
        runtime
            .content_search
            .clone()
            .ok_or_else(|| RpcError::new(-32050, AppServerErrorName::SearchUnavailable))
    }

    pub(super) fn content_search_service_for_session_directory(
        &self,
        selector: &ash_app_server_protocol::protocol::environment::SessionDirSelector,
    ) -> Result<Arc<ContentSearchService>, RpcError> {
        let dir = self.session_dir_authorization(
            &selector.session_id,
            &selector.path,
            Permission::SearchFiles,
        )?;
        let key = (
            selector.session_id.clone(),
            dir.dir().canonical_path().to_path_buf(),
        );
        let mut runtime = self
            .env_runtime
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(search) = runtime.session_dir_search.get(&key) {
            return Ok(Arc::clone(search));
        }
        let ripgrep = runtime
            .ripgrep
            .clone()
            .ok_or_else(|| RpcError::new(-32050, AppServerErrorName::SearchUnavailable))?;
        let search = Arc::new(
            ContentSearchService::new_authorized(dir, ripgrep)
                .map_err(|_| RpcError::new(-32043, AppServerErrorName::PermissionRequired))?,
        );
        runtime.session_dir_search.insert(key, Arc::clone(&search));
        Ok(search)
    }

    pub(super) fn terminal_service(
        &self,
    ) -> Result<Arc<crate::terminal_service::TerminalService>, RpcError> {
        self.terminal_service_for(None)
    }

    pub(super) fn session_dir_authorization(
        &self,
        session_id: &SessionId,
        root: &std::path::Path,
        permission: Permission,
    ) -> Result<ash_file_access::Authorization, RpcError> {
        if self
            .threads
            .list_session_threads(session_id)
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?
            .is_empty()
        {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        let runtime = self
            .env_runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        runtime
            .dir_grants
            .authorize(session_id, root, permission)
            .map_err(|_| RpcError::new(-32064, AppServerErrorName::TerminalOperationFailed))?
            .ok_or_else(|| RpcError::new(-32064, AppServerErrorName::TerminalOperationFailed))
    }

    fn terminate_revoked_terminal_sessions(&self) {
        for terminals in self.configured_terminal_services() {
            terminals.terminate_revoked_dirs();
        }
    }

    pub(super) fn terminal_service_for(
        &self,
        dir_id: Option<&str>,
    ) -> Result<Arc<crate::terminal_service::TerminalService>, RpcError> {
        let runtime = self
            .env_runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(dir_id) = dir_id {
            return runtime
                .dir_terminals
                .get(dir_id)
                .cloned()
                .ok_or_else(|| RpcError::new(-32060, AppServerErrorName::TerminalUnavailable));
        }
        runtime
            .terminals
            .clone()
            .ok_or_else(|| RpcError::new(-32060, AppServerErrorName::TerminalUnavailable))
    }

    pub(super) fn configured_terminal_services(
        &self,
    ) -> Vec<Arc<crate::terminal_service::TerminalService>> {
        let runtime = self
            .env_runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut services = Vec::new();
        if let Some(primary) = &runtime.terminals {
            services.push(Arc::clone(primary));
        }
        for service in runtime.dir_terminals.values() {
            if !services
                .iter()
                .any(|existing| Arc::ptr_eq(existing, service))
            {
                services.push(Arc::clone(service));
            }
        }
        services
    }

    pub(super) fn debug_adapter_service_for(
        &self,
        dir_id: Option<&str>,
    ) -> Result<Arc<crate::debug_service::DebugAdapterService>, RpcError> {
        let runtime = self
            .env_runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(dir_id) = dir_id {
            return runtime
                .dir_debug_adapters
                .get(dir_id)
                .cloned()
                .ok_or_else(|| RpcError::new(-32070, AppServerErrorName::DebugAdapterUnavailable));
        }
        runtime
            .debug_adapters
            .clone()
            .ok_or_else(|| RpcError::new(-32070, AppServerErrorName::DebugAdapterUnavailable))
    }

    pub(super) fn configured_debug_adapter_services(
        &self,
    ) -> Vec<Arc<crate::debug_service::DebugAdapterService>> {
        let runtime = self
            .env_runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut services = Vec::new();
        if let Some(primary) = &runtime.debug_adapters {
            services.push(Arc::clone(primary));
        }
        for service in runtime.dir_debug_adapters.values() {
            if !services
                .iter()
                .any(|existing| Arc::ptr_eq(existing, service))
            {
                services.push(Arc::clone(service));
            }
        }
        services
    }

    pub(super) fn turn_executor_snapshot(&self) -> TurnExecutor {
        self.env_runtime
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .turn_executor
            .clone()
    }

    fn ensure_env_cwd_set_is_idle(&self) -> Result<(), EnvRuntimeError> {
        let threads = self
            .threads
            .list_threads()
            .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?;
        let busy = threads.iter().flat_map(|thread| &thread.turns).any(|turn| {
            matches!(
                turn.status,
                TurnStatus::Created
                    | TurnStatus::Running
                    | TurnStatus::WaitingForApproval
                    | TurnStatus::WaitingForUserInput
                    | TurnStatus::WaitingForCapability
                    | TurnStatus::Cancelling
            )
        });
        if busy {
            return Err(EnvRuntimeError::Busy);
        }
        Ok(())
    }
}

pub(super) fn read_dir_config(
    root: &Dir,
) -> Result<ash_config::DirConfigDocument, EnvRuntimeError> {
    DirConfigStore::open(
        root.canonical_path().join(".ash/config.toml"),
        DirConfigScope::new(root.id()),
    )
    .read_document()
    .map_err(|error| EnvRuntimeError::Failed(error.to_string()))
}

fn session_dir_snapshots(access: &DirGrants, session_id: &SessionId) -> SessionDirEntrySnapshotSet {
    let dirs = access
        .list(session_id)
        .iter()
        .map(|entry| SessionDirEntrySnapshot {
            path: entry.dir().canonical_path().to_path_buf(),
            permissions: entry.permissions().clone(),
        })
        .collect();
    SessionDirEntrySnapshotSet {
        revision: access.revision(session_id),
        dirs,
    }
}

fn ensure_session_exists(
    threads: &ThreadController,
    session_id: &SessionId,
) -> Result<(), EnvRuntimeError> {
    if threads
        .list_session_threads(session_id)
        .map_err(|error| EnvRuntimeError::Failed(error.to_string()))?
        .is_empty()
    {
        return Err(EnvRuntimeError::Failed(format!(
            "Session {session_id} has no Threads"
        )));
    }
    Ok(())
}

fn append_multi_agent_tools(
    local: crate::local_tools::LocalToolComposition,
    coordinator: &Arc<MultiAgentCoordinator>,
    model_instructions: &Arc<ash_models_manager::ModelInstructionCatalog>,
    threads: &Arc<ThreadController>,
    turn_backend: &Arc<dyn ash_core::TurnExecutionBackend>,
    customizations: Option<&Arc<DirContributions>>,
) -> Result<crate::local_tools::LocalToolComposition, EnvRuntimeError> {
    let action_policy_revision = local.action_policy_revision().clone();
    let local = append_local_tool(
        local,
        Arc::new(
            UpdatePlanToolService::new(Arc::clone(threads))
                .with_action_policy_revision(action_policy_revision.clone()),
        ),
    );
    let local = append_local_tool(
        local,
        Arc::new(GoalToolService::new(
            Arc::clone(threads),
            action_policy_revision.clone(),
        )),
    );
    let mut multi_agent = MultiAgentToolService::new(
        Arc::clone(coordinator),
        Arc::clone(threads),
        Arc::clone(turn_backend),
        action_policy_revision,
    )
    .with_model_instructions(Arc::clone(model_instructions));
    if let Some(customizations) = customizations {
        multi_agent = multi_agent.with_dir_contributions(customizations.clone());
    }
    Ok(append_local_tool(local, Arc::new(multi_agent)))
}

fn open_codebase_semantic_runtime(
    codebase: &Arc<CodebaseRuntime>,
    fixed_models: Option<&CodebaseModels>,
    provider: Option<&Arc<dyn SemanticModelProvider>>,
    config: Option<&Arc<ConfigStore>>,
) -> Result<Option<Arc<CodebaseSemanticService>>, EnvRuntimeError> {
    let configured_models;
    let models = match fixed_models {
        Some(models) => models,
        None => {
            let (Some(provider), Some(config)) = (provider, config) else {
                return Ok(None);
            };
            let Some(resolved) = resolve_configured_codebase_models(provider, config) else {
                return Ok(None);
            };
            configured_models = resolved;
            &configured_models
        }
    };
    let store: Arc<dyn CodebaseVectorStore> =
        codebase.store().open_vector_store().map_err(|error| {
            EnvRuntimeError::Failed(format!("failed to open Codebase vector data: {error}"))
        })?;
    let service = CodebaseSemanticService::new(
        codebase.index(),
        models.embedding_index_key().clone(),
        models.embedding(),
        store,
    );
    let service = match models.rerank() {
        Some(rerank) => service.with_rerank(rerank),
        None => service,
    };
    Ok(Some(Arc::new(
        service.with_metrics(Arc::new(AppServerSemanticIndexMetrics)),
    )))
}

fn resolve_configured_codebase_models(
    provider: &Arc<dyn SemanticModelProvider>,
    config: &Arc<ConfigStore>,
) -> Option<CodebaseModels> {
    let snapshot = config.read_snapshot().ok()?;
    let models = snapshot.values.codebase.models.clone()?;
    let invokers =
        match resolve_semantic_model_invokers(provider, &models, &snapshot.values.providers) {
            Ok(invokers) => invokers,
            Err(error) => {
                log::warn!("configured semantic codebase models are unavailable: {error}");
                return None;
            }
        };
    let model_id = EmbeddingIndexKey::for_device_model(
        models.embedding_model.provider.as_str(),
        models.embedding_model.model.as_str(),
        invokers.embedding_identity.as_str(),
    )
    .ok()?;
    let mut resolved = CodebaseModels::new(model_id, invokers.embedding);
    if let Some(rerank) = invokers.rerank {
        resolved = resolved.with_rerank(rerank);
    }
    Some(resolved)
}

struct ResolvedSemanticModelInvokers {
    embedding_identity: EmbeddingRuntimeIdentity,
    embedding: Arc<dyn EmbeddingInvoker>,
    rerank: Option<Arc<dyn RerankInvoker>>,
}

fn resolve_semantic_model_invokers(
    provider: &Arc<dyn SemanticModelProvider>,
    models: &CodebaseModelSelection,
    providers: &BTreeMap<ProviderId, ModelProviderConfig>,
) -> Result<ResolvedSemanticModelInvokers, ModelProviderError> {
    let embedding_config = providers
        .get(&models.embedding_model.provider)
        .cloned()
        .ok_or_else(|| {
            ModelProviderError::Unavailable(format!(
                "semantic embedding provider '{}' is not configured",
                models.embedding_model.provider
            ))
        })?;
    let embedding_request =
        EmbeddingRuntimeRequest::new(models.embedding_model.clone(), embedding_config.clone());
    if provider.embedding_runtime_location(&embedding_request)? != SemanticRuntimeLocation::Device {
        return Err(ModelProviderError::Unavailable(
            "Codebase embedding model must run on this device".into(),
        ));
    }
    let embedding_identity = provider.embedding_runtime_identity(&embedding_request)?;
    let embedding = provider.embedding_runtime(embedding_request)?;
    let rerank = models
        .rerank_model
        .as_ref()
        .map(|model| {
            let config = providers.get(&model.provider).cloned().ok_or_else(|| {
                ModelProviderError::Unavailable(format!(
                    "semantic rerank provider '{}' is not configured",
                    model.provider
                ))
            })?;
            let request = RerankRuntimeRequest::new(model.clone(), config);
            if provider.rerank_runtime_location(&request)? != SemanticRuntimeLocation::Device {
                return Err(ModelProviderError::Unavailable(
                    "Codebase rerank model must run on this device".into(),
                ));
            }
            provider.rerank_runtime(request)
        })
        .transpose()?;
    Ok(ResolvedSemanticModelInvokers {
        embedding_identity,
        embedding,
        rerank,
    })
}

fn retire_env_runtime(
    mut runtime: EnvRuntime,
    retained_search: Option<&Arc<ContentSearchService>>,
    retained_terminals: Option<&Arc<crate::terminal_service::TerminalService>>,
    retained_debug_adapters: Option<&Arc<crate::debug_service::DebugAdapterService>>,
) {
    for (_, search) in std::mem::take(&mut runtime.dir_content_search) {
        if !retained_search.is_some_and(|retained| Arc::ptr_eq(retained, &search)) {
            search.cancel_all();
        }
    }
    for (_, terminals) in std::mem::take(&mut runtime.dir_terminals) {
        if !retained_terminals.is_some_and(|retained| Arc::ptr_eq(retained, &terminals)) {
            terminals.terminate_all();
        }
    }
    for (_, debug_adapters) in std::mem::take(&mut runtime.dir_debug_adapters) {
        if !retained_debug_adapters.is_some_and(|retained| Arc::ptr_eq(retained, &debug_adapters)) {
            debug_adapters.terminate_all();
        }
    }
    for (_, authorization) in std::mem::take(&mut runtime.dirs) {
        authorization.revoke();
    }
    if let Some(authorization) = runtime.selected_grant.take() {
        authorization.revoke();
    }
    if let Some(terminals) = runtime.terminals.take()
        && !retained_terminals.is_some_and(|retained| Arc::ptr_eq(retained, &terminals))
    {
        terminals.terminate_all();
    }
    if let Some(debug_adapters) = runtime.debug_adapters.take()
        && !retained_debug_adapters.is_some_and(|retained| Arc::ptr_eq(retained, &debug_adapters))
    {
        debug_adapters.terminate_all();
    }
    if let Some(search) = runtime.content_search.take()
        && !retained_search.is_some_and(|retained| Arc::ptr_eq(retained, &search))
    {
        search.cancel_all();
    }
}

#[cfg(test)]
#[path = "env_runtime_tests.rs"]
mod tests;

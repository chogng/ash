//! Session creation, discovery, subscriptions, and lifecycle mutations.
use core_api::AgentRuntime;

use super::ConnectionState;
use super::RpcError;
use super::core_error;
use super::decode;
use super::operations::SessionMutation;
use super::result;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::session::SessionCatalogReadResult;
use ash_app_server_protocol::protocol::session::SessionCreateParams;
use ash_app_server_protocol::protocol::session::SessionListResult;
use ash_app_server_protocol::protocol::session::SessionReadParams;
use ash_app_server_protocol::protocol::session::SessionResult;
use ash_app_server_protocol::protocol::session::SessionSubscribeParams;
use ash_app_server_protocol::protocol::session::SessionSubscribeResult;
use ash_app_server_protocol::protocol::session::SessionThreadProjection;
use ash_app_server_protocol::protocol::session::SessionUnsubscribeParams;
use ash_protocol::CommandId;
use ash_protocol::HookEvent;
use ash_protocol::SessionExecutionTarget;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use core_api::HookEventRequest;
use core_api::HookEventScope;
use core_api::StartThreadRequest;
use serde_json::Value;

/// Coordinates the existing owners needed by the sessions adapter.
/// This contract deliberately exposes no server object or unrestricted service registry.
pub(super) trait SessionRequestProcessorContext: Send + Sync {
    fn session_environments(&self) -> &crate::session_environment::SessionEnvironments;
    fn agent_runtime(&self) -> impl core_api::AgentRuntime + '_;
    fn bind_session_runtime(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<(), core_api::CoreError>;
    fn cancel_lost_dynamic_tool_owners(&self, requests: Vec<ash_protocol::AgentRequestEnvelope>);
    fn clear_session_dirs(&self, session_id: &ash_protocol::SessionId);
    fn collect_message_checkpoints(
        &self,
        source: &dyn core_api::MessageCheckpointSource,
    ) -> Result<(), core_api::CoreError>;
    fn emit_hook_event(
        &self,
        request: &core_api::HookEventRequest,
    ) -> Result<core_api::HookEventDecision, super::RpcError>;
    fn git_turn_changes_runtime(
        &self,
    ) -> Result<
        std::sync::Arc<super::git_turn_changes_runtime::GitTurnChangesRuntime>,
        super::RpcError,
    >;
    fn notify_thread_updates(
        &self,
        thread_id: &ash_protocol::ThreadId,
        after_sequence: u64,
    ) -> Result<(), super::RpcError>;
    fn offer_pending_interactions(&self, thread: &core_api::ThreadView);
    fn read_session_thread_snapshot(
        &self,
        session_id: &ash_protocol::SessionId,
        thread_id: &ash_protocol::ThreadId,
    ) -> Result<core_api::ThreadView, super::RpcError>;
    fn resolve_root_agent(
        &self,
        selection: &ash_protocol::AgentRoleSelection,
    ) -> Result<Option<ash_protocol::AgentConfiguration>, core_api::CoreError>;
    fn session_catalog_view(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<Option<ash_protocol::Session>, super::RpcError>;
    fn session_result(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<ash_app_server_protocol::protocol::session::SessionResult, super::RpcError>;
    fn session_view(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<ash_protocol::Session, super::RpcError>;
    fn session_views(&self) -> Result<Vec<ash_protocol::Session>, super::RpcError>;
    fn stop_session_automations(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<(), super::RpcError>;
    fn thread_directory(
        &self,
        thread_id: &ash_protocol::ThreadId,
    ) -> Result<Option<ash_protocol::SessionExecutionTarget>, super::RpcError>;
    fn trace_reader(&self) -> ash_rollout_trace::TraceReader;
}

pub(super) struct SessionRequestProcessor<'ctx, C: SessionRequestProcessorContext + ?Sized> {
    context: &'ctx C,
    agent_extensions: &'ctx super::Arc<super::ExtensionRegistry>,
    dir_services: &'ctx Option<super::Arc<super::thread_dirs::ThreadDirs>>,
    env_runtime: &'ctx super::Arc<super::RwLock<super::EnvRuntime>>,
    git_turn_changes:
        &'ctx Option<super::Arc<super::git_turn_changes_runtime::GitTurnChangesRuntime>>,
    message_board: &'ctx Option<super::Arc<dyn agent_message_board::BoardBackend>>,
    notes: &'ctx Option<super::Arc<history_notes::NotesStore>>,
    queue: &'ctx Option<super::Arc<queue::QueueStore>>,
    trace_recorder: &'ctx super::Arc<ash_rollout_trace::TraceRecorder>,
    updates: &'ctx super::Arc<super::UpdateBroker>,
    workflows: &'ctx super::Arc<workflows::Store>,
}

impl<'ctx, C: SessionRequestProcessorContext + ?Sized> SessionRequestProcessor<'ctx, C> {
    pub(super) fn new(
        context: &'ctx C,
        agent_extensions: &'ctx super::Arc<super::ExtensionRegistry>,
        dir_services: &'ctx Option<super::Arc<super::thread_dirs::ThreadDirs>>,
        env_runtime: &'ctx super::Arc<super::RwLock<super::EnvRuntime>>,
        git_turn_changes: &'ctx Option<
            super::Arc<super::git_turn_changes_runtime::GitTurnChangesRuntime>,
        >,
        message_board: &'ctx Option<super::Arc<dyn agent_message_board::BoardBackend>>,
        notes: &'ctx Option<super::Arc<history_notes::NotesStore>>,
        queue: &'ctx Option<super::Arc<queue::QueueStore>>,
        trace_recorder: &'ctx super::Arc<ash_rollout_trace::TraceRecorder>,
        updates: &'ctx super::Arc<super::UpdateBroker>,
        workflows: &'ctx super::Arc<workflows::Store>,
    ) -> Self {
        Self {
            context,
            agent_extensions,
            dir_services,
            env_runtime,
            git_turn_changes,
            message_board,
            notes,
            queue,
            trace_recorder,
            updates,
            workflows,
        }
    }
}

impl<'ctx, C: SessionRequestProcessorContext + ?Sized> SessionRequestProcessor<'ctx, C> {
    pub(super) fn delete_worktree_session(
        &self,
        owner_thread_id: &str,
        command_id: &CommandId,
    ) -> Result<(), RpcError> {
        let thread_id = ThreadId::new(owner_thread_id.to_owned()).map_err(|_| {
            RpcError::new(
                -32061,
                ash_app_server_protocol::protocol::error::AppServerErrorName::GitOperationFailed,
            )
        })?;
        let runtime = self.context.git_turn_changes_runtime()?;
        if runtime.binding(&thread_id).is_none() {
            return Err(RpcError::new(
                -32061,
                ash_app_server_protocol::protocol::error::AppServerErrorName::GitOperationFailed,
            ));
        }
        let agent_runtime = self.context.agent_runtime();
        match agent_runtime.read_thread(&thread_id) {
            Ok(thread) => {
                let session_id = thread.session_id;
                let thread_ids = agent_runtime
                    .read_session(&session_id)
                    .map_err(core_error)?
                    .threads
                    .into_iter()
                    .map(|thread| thread.thread_id)
                    .filter(|thread_id| runtime.binding(thread_id).is_some())
                    .collect::<Vec<_>>();
                // Keep bindings until filesystem cleanup succeeds so a failed removal can be retried
                // from the remaining worktree after the Session history is gone.
                self.delete_session_request(SessionMutation {
                    command_id: command_id.clone(),
                    session_id,
                })?;
                for thread_id in thread_ids {
                    runtime
                        .cleanup_deleted_thread(&thread_id)
                        .map_err(|_| RpcError::new(-32061, ash_app_server_protocol::protocol::error::AppServerErrorName::GitOperationFailed))?;
                }
            }
            Err(core_api::CoreError::NotFound(_)) => runtime
                .cleanup_deleted_thread(&thread_id)
                .map_err(|_| RpcError::new(-32061, ash_app_server_protocol::protocol::error::AppServerErrorName::GitOperationFailed))?,
            Err(error) => return Err(core_error(error)),
        }
        Ok(())
    }

    pub(super) fn agent_roles_list(&self) -> Result<Value, RpcError> {
        use ash_app_server_protocol::protocol::agent::AgentRoleEntry;
        use ash_app_server_protocol::protocol::agent::AgentRoleListResult;
        let environment = self.env_runtime.read().map_err(|_| {
            core_error(core_api::CoreError::Execution(
                "Environment runtime lock poisoned".into(),
            ))
        })?;
        let contributions = environment._dir_contributions.clone();
        drop(environment);
        // Before Session creation, only the environment grant can authorize a root definition.
        let snapshot = contributions
            .as_ref()
            .map(|catalog| catalog.refresh_root_agents());
        let agents = snapshot
            .as_ref()
            .map(|catalog| catalog.entries())
            .unwrap_or_default()
            .iter()
            .map(|role| AgentRoleEntry {
                name: role.name().to_owned(),
                description: role.description().to_owned(),
                source: match role.source() {
                    agent_roles::AgentRoleSource::BuiltIn => ash_protocol::AgentRoleSource::BuiltIn,
                    agent_roles::AgentRoleSource::Directory { id } => {
                        ash_protocol::AgentRoleSource::Directory { id: id.clone() }
                    }
                },
            })
            .collect();
        result(&AgentRoleListResult { agents })
    }

    pub(super) fn agent_role_catalog(&self) -> Result<Value, RpcError> {
        use ash_app_server_protocol::protocol::agent::AgentRoleCatalogResult;
        use ash_app_server_protocol::protocol::agent::AgentRoleDefinition;
        use ash_app_server_protocol::protocol::agent::AgentRoleLaunch;

        let contributions = self
            .env_runtime
            .read()
            .map_err(|_| {
                core_error(core_api::CoreError::Execution(
                    "Environment runtime lock poisoned".into(),
                ))
            })?
            ._dir_contributions
            .clone();
        let custom = contributions
            .as_ref()
            .map(|catalog| catalog.refresh_root_agents());
        let directory = contributions
            .as_ref()
            .and_then(|catalog| catalog.root_agents_directory());
        let built_in = agent_roles::built_in_roles();
        let agents = built_in
            .entries()
            .iter()
            .chain(
                custom
                    .as_ref()
                    .map(|catalog| catalog.entries())
                    .unwrap_or_default(),
            )
            .map(|role| AgentRoleDefinition {
                name: role.name().to_owned(),
                description: role.description().to_owned(),
                source: match role.source() {
                    agent_roles::AgentRoleSource::BuiltIn => ash_protocol::AgentRoleSource::BuiltIn,
                    agent_roles::AgentRoleSource::Directory { id } => {
                        ash_protocol::AgentRoleSource::Directory { id: id.clone() }
                    }
                },
                launch: match role.launch() {
                    agent_roles::RoleLaunch::Any => AgentRoleLaunch::Any,
                    agent_roles::RoleLaunch::Workflow => AgentRoleLaunch::Workflow,
                    agent_roles::RoleLaunch::Delegation => AgentRoleLaunch::Delegation,
                    agent_roles::RoleLaunch::Host => AgentRoleLaunch::Host,
                },
                callers: role.callers().to_vec(),
                delegates: role.delegates().map(<[String]>::to_vec),
                path: match role.source() {
                    agent_roles::AgentRoleSource::BuiltIn => None,
                    agent_roles::AgentRoleSource::Directory { .. } => {
                        directory.as_ref().map(|directory| {
                            directory
                                .join(role.relative_path())
                                .to_string_lossy()
                                .into_owned()
                        })
                    }
                },
                content_digest: role.content_digest().to_owned(),
                model: role.model().map(str::to_owned),
                tools: role.tools().map(<[String]>::to_vec),
                disallowed_tools: role.disallowed_tools().to_vec(),
                required_tools: role.required_tools().to_vec(),
                delegation_tools: role.delegation_tools().map(<[String]>::to_vec),
                disallowed_delegation_tools: role.disallowed_delegation_tools().to_vec(),
                required_delegation_tools: role.required_delegation_tools().to_vec(),
                skills: role.skills().map(<[String]>::to_vec),
                required_skills: role.required_skills().to_vec(),
                instructions: role.instructions().to_vec(),
                prompt: role.role_instructions().to_owned(),
            })
            .collect();
        let diagnostics = custom
            .as_ref()
            .map(|catalog| {
                catalog
                    .diagnostics()
                    .iter()
                    .map(|diagnostic| match diagnostic.relative_path() {
                        Some(path) => format!("{}: {}", path.display(), diagnostic.message()),
                        None => diagnostic.message().to_owned(),
                    })
                    .collect()
            })
            .unwrap_or_default();
        result(&AgentRoleCatalogResult {
            agents,
            diagnostics,
        })
    }

    pub(super) fn agent_read(&self, params: &Value) -> Result<Value, RpcError> {
        use ash_app_server_protocol::protocol::agent::AgentReadParams;
        use ash_app_server_protocol::protocol::agent::AgentReadResult;
        use ash_app_server_protocol::protocol::agent::AgentThread;
        let params: AgentReadParams = decode(params)?;
        let agent = self
            .context
            .agent_runtime()
            .read_agent(&params.agent_id)
            .map_err(core_error)?;
        let threads = self
            .context
            .agent_runtime()
            .list_agent_threads(&params.agent_id)
            .map_err(core_error)?
            .into_iter()
            .map(|binding| AgentThread {
                session_id: binding.session_id,
                thread_id: binding.thread_id,
                origin: binding.origin,
            })
            .collect();
        result(&AgentReadResult {
            agent_id: agent.agent_id,
            created_at_unix_ms: agent.created_at_unix_ms,
            threads,
        })
    }

    pub(super) fn session_create(
        &self,
        connection: &mut ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: SessionCreateParams = decode(params)?;
        let created = self.create_session(params)?;
        self.updates
            .subscribe_session(connection.connection_id, created.session.session_id.clone());
        result(&created)
    }

    pub(super) fn create_session(
        &self,
        params: SessionCreateParams,
    ) -> Result<SessionResult, RpcError> {
        if ash_protocol::SessionSource::is_automation_creation_command(params.command_id.as_str()) {
            return Err(core_error(core_api::CoreError::InvalidInput(
                "Session creation command ID belongs to automation".into(),
            )));
        }
        if let Some(values) = &params.environment_variables {
            self.context
                .session_environments()
                .validate(&values.0)
                .map_err(core_error)?;

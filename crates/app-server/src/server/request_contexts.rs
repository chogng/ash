use super::AppServer;
use super::RpcError;

impl super::attachment_operations::AttachmentRequestProcessorContext for AppServer {
    fn read_session_thread(
        &self,
        session_id: &ash_protocol::SessionId,
        thread_id: &ash_protocol::ThreadId,
    ) -> Result<ash_protocol::Thread, super::RpcError> {
        self.agent_processor()
            .read_session_thread(session_id, thread_id)
    }
}

impl super::cloud_codebase_operations::CloudCodebaseRequestProcessorContext for AppServer {
    fn cloud_codebase_service(
        &self,
    ) -> Result<std::sync::Arc<ash_cloud_codebase::CloudCodebaseController>, super::RpcError> {
        AppServer::cloud_codebase_service(self)
    }
}

impl super::codebase_operations::CodebaseRequestProcessorContext for AppServer {
    fn codebase_semantic_job(
        &self,
    ) -> Option<std::sync::Arc<super::semantic_index_job::SemanticIndexJobController>> {
        AppServer::codebase_semantic_job(self)
    }
    fn codebase_service(
        &self,
    ) -> Result<std::sync::Arc<super::codebase_runtime::CodebaseRuntime>, super::RpcError> {
        AppServer::codebase_service(self)
    }
    fn symbol_index_service(
        &self,
    ) -> Result<std::sync::Arc<super::symbol_index_runtime::SymbolIndexRuntime>, super::RpcError>
    {
        AppServer::symbol_index_service(self)
    }
}

impl super::codebase_retrieval_operations::CodebaseRetrievalRequestProcessorContext for AppServer {
    fn cloud_codebase_service(
        &self,
    ) -> Result<std::sync::Arc<ash_cloud_codebase::CloudCodebaseController>, super::RpcError> {
        AppServer::cloud_codebase_service(self)
    }
    fn codebase_semantic_service(
        &self,
    ) -> Option<std::sync::Arc<ash_codebase::CodebaseSemanticService>> {
        AppServer::codebase_semantic_service(self)
    }
    fn codebase_service(
        &self,
    ) -> Result<std::sync::Arc<super::codebase_runtime::CodebaseRuntime>, super::RpcError> {
        AppServer::codebase_service(self)
    }
    fn project_codebase_status(
        &self,
        runtime: &super::codebase_runtime::CodebaseRuntime,
    ) -> ash_app_server_protocol::protocol::codebase::CodebaseStatusResult {
        self.codebase_processor().project_codebase_status(runtime)
    }
    fn symbol_index_service(
        &self,
    ) -> Result<std::sync::Arc<super::symbol_index_runtime::SymbolIndexRuntime>, super::RpcError>
    {
        AppServer::symbol_index_service(self)
    }
}

impl super::config_operations::ConfigRequestProcessorContext for AppServer {
    fn active_dir_id(&self) -> Option<ash_file_access::DirId> {
        AppServer::active_dir_id(self)
    }
    fn codebase_semantic_service(
        &self,
    ) -> Option<std::sync::Arc<ash_codebase::CodebaseSemanticService>> {
        AppServer::codebase_semantic_service(self)
    }
    fn emit_hook_event(
        &self,
        request: &core_api::HookEventRequest,
    ) -> Result<core_api::HookEventDecision, super::RpcError> {
        AppServer::emit_hook_event(self, request)
    }
    fn env_runtime_control(&self) -> Option<super::environment_runtime::EnvRuntimeControl> {
        AppServer::env_runtime_control(self)
    }
    fn grep_index_context(
        &self,
    ) -> Result<(std::sync::Arc<grep::Service>, ash_file_access::Dir), super::RpcError> {
        AppServer::grep_index_context(self)
    }
    fn reconcile_active_directory_grant(&self) -> Result<(), super::RpcError> {
        self.environment_processor()
            .reconcile_active_directory_grant()
    }
    fn reconcile_codebase_runtime(
        &self,
    ) -> Result<(), super::environment_runtime::EnvRuntimeError> {
        AppServer::reconcile_codebase_runtime(self)
    }
    fn tool_search_embedding_status(&self) -> crate::tool_search_models::ToolSearchEmbeddingStatus {
        AppServer::tool_search_embedding_status(self)
    }
}

impl super::debug_operations::DebugRequestProcessorContext for AppServer {
    fn debug_adapter_service_for(
        &self,
        dir_id: Option<&str>,
    ) -> Result<std::sync::Arc<crate::debug_service::DebugAdapterService>, super::RpcError> {
        AppServer::debug_adapter_service_for(self, dir_id)
    }
}

impl super::environment_operations::EnvironmentRequestProcessorContext for AppServer {
    fn activate_local_dirs(
        &self,
        dirs: Vec<(String, ash_file_access::Grant)>,
    ) -> Result<
        Vec<(String, std::path::PathBuf, ash_file_access::Permissions)>,
        super::environment_runtime::EnvRuntimeError,
    > {
        AppServer::activate_local_dirs(self, dirs)
    }
    fn add_session_dir(
        &self,
        session_id: &ash_protocol::SessionId,
        root: std::path::PathBuf,
        permissions: ash_file_access::Permissions,
    ) -> Result<
        (
            std::path::PathBuf,
            ash_file_access::Mutation,
            super::environment_runtime::SessionDirEntrySnapshotSet,
        ),
        super::environment_runtime::EnvRuntimeError,
    > {
        AppServer::add_session_dir(self, session_id, root, permissions)
    }
    fn authorize_local_dir_root(
        &self,
        root: std::path::PathBuf,
        grant: Option<(ash_file_access::GrantSource, ash_file_access::Permissions)>,
    ) -> Result<ash_file_access::Grant, super::environment_runtime::EnvRuntimeError> {
        AppServer::authorize_local_dir_root(self, root, grant)
    }
    fn directory_grants_snapshot(
        &self,
    ) -> Result<ash_config::ResolvedConfigSnapshot, super::RpcError> {
        self.config_processor().directory_grants_snapshot()
    }
    fn directory_grants_store(&self) -> Result<&ash_config::ConfigStore, super::RpcError> {
        self.config_processor().directory_grants_store()
    }
    fn env_runtime_control(&self) -> Option<super::environment_runtime::EnvRuntimeControl> {
        AppServer::env_runtime_control(self)
    }
    fn list_session_dirs(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<
        super::environment_runtime::SessionDirEntrySnapshotSet,
        super::environment_runtime::EnvRuntimeError,
    > {
        AppServer::list_session_dirs(self, session_id)
    }
    fn move_session_dir(
        &self,
        session_id: &ash_protocol::SessionId,
        root: std::path::PathBuf,
        permissions: ash_file_access::Permissions,
    ) -> Result<
        (
            std::path::PathBuf,
            super::environment_runtime::SessionDirEntrySnapshotSet,
        ),
        super::environment_runtime::EnvRuntimeError,
    > {
        AppServer::move_session_dir(self, session_id, root, permissions)
    }
    fn remove_session_dir(
        &self,
        session_id: &ash_protocol::SessionId,
        root: &std::path::Path,
    ) -> Result<
        (
            ash_file_access::Mutation,
            super::environment_runtime::SessionDirEntrySnapshotSet,
        ),
        super::environment_runtime::EnvRuntimeError,
    > {
        AppServer::remove_session_dir(self, session_id, root)
    }
    fn set_session_directory_grant(
        &self,
        session_id: &ash_protocol::SessionId,
        root: &std::path::Path,
        expected_revision: u64,
        permissions: ash_file_access::Permissions,
    ) -> Result<
        (
            ash_file_access::Mutation,
            super::environment_runtime::SessionDirEntrySnapshotSet,
        ),
        super::environment_runtime::EnvRuntimeError,
    > {
        AppServer::set_session_directory_grant(
            self,
            session_id,
            root,
            expected_revision,
            permissions,
        )
    }
    fn switch_local_dir_root_with_permissions(
        &self,
        root: std::path::PathBuf,
        source: ash_file_access::GrantSource,
        permissions: ash_file_access::Permissions,
    ) -> Result<std::path::PathBuf, super::environment_runtime::EnvRuntimeError> {
        AppServer::switch_local_dir_root_with_permissions(self, root, source, permissions)
    }
}

impl super::extension_config_operations::ExtensionConfigRequestProcessorContext for AppServer {
    fn list_session_dirs(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<
        super::environment_runtime::SessionDirEntrySnapshotSet,
        super::environment_runtime::EnvRuntimeError,
    > {
        AppServer::list_session_dirs(self, session_id)
    }
}

impl super::extension_host_operations::ExtensionHostRequestProcessorContext for AppServer {
    fn file_system_service_for(
        &self,
        dir_id: Option<&str>,
    ) -> Result<std::sync::Arc<dyn ash_file_system::FileSystem>, super::RpcError> {
        AppServer::file_system_service_for(self, dir_id)
    }
}

impl super::fs_operations::FileSystemRequestProcessorContext for AppServer {
    fn file_system_service_for(
        &self,
        dir_id: Option<&str>,
    ) -> Result<std::sync::Arc<dyn ash_file_system::FileSystem>, super::RpcError> {
        AppServer::file_system_service_for(self, dir_id)
    }
    fn file_system_service_for_session_directory(
        &self,
        selector: &ash_app_server_protocol::protocol::environment::SessionDirSelector,
        permission: ash_file_access::Permission,
    ) -> Result<std::sync::Arc<dyn ash_file_system::FileSystem>, super::RpcError> {
        AppServer::file_system_service_for_session_directory(self, selector, permission)
    }
    fn session_dir_authorization(
        &self,
        session_id: &ash_protocol::SessionId,
        root: &std::path::Path,
        permission: ash_file_access::Permission,
    ) -> Result<ash_file_access::Authorization, super::RpcError> {
        AppServer::session_dir_authorization(self, session_id, root, permission)
    }
}

impl super::git_operations::GitRequestProcessorContext for AppServer {
    fn delete_worktree_session(
        &self,
        owner_thread_id: &str,
        command_id: &ash_protocol::CommandId,
    ) -> Result<(), super::RpcError> {
        self.session_processor()
            .delete_worktree_session(owner_thread_id, command_id)
    }
    fn emit_hook_event(
        &self,
        request: &core_api::HookEventRequest,
    ) -> Result<core_api::HookEventDecision, super::RpcError> {
        AppServer::emit_hook_event(self, request)
    }
    fn git_runtime_service(
        &self,
    ) -> Result<std::sync::Arc<super::git_runtime::GitRuntime>, super::RpcError> {
        AppServer::git_runtime_service(self)
    }
}

impl super::ide_operations::IdeRequestProcessorContext for AppServer {
    fn display_read_authorizations(
        &self,
        session: &ash_protocol::SessionId,
        thread: &ash_protocol::ThreadId,
    ) -> Result<Vec<ash_file_access::Authorization>, core_api::CoreError> {
        self.app_tools_processor()
            .display_read_authorizations(session, thread)
    }
    fn read_session_thread_snapshot(
        &self,
        session_id: &ash_protocol::SessionId,
        thread_id: &ash_protocol::ThreadId,
    ) -> Result<core_api::ThreadView, super::RpcError> {
        self.agent_processor()
            .read_session_thread_snapshot(session_id, thread_id)
    }
    fn session_view(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<ash_protocol::Session, super::RpcError> {
        self.agent_processor().session_view(session_id)
    }
}

impl super::instruction_import::InstructionImportRequestProcessorContext for AppServer {
    fn file_system_service_for_session_directory(
        &self,
        selector: &ash_app_server_protocol::protocol::environment::SessionDirSelector,
        permission: ash_file_access::Permission,
    ) -> Result<std::sync::Arc<dyn ash_file_system::FileSystem>, super::RpcError> {
        AppServer::file_system_service_for_session_directory(self, selector, permission)
    }
    fn session_dir_authorization(
        &self,
        session_id: &ash_protocol::SessionId,
        root: &std::path::Path,
        permission: ash_file_access::Permission,
    ) -> Result<ash_file_access::Authorization, super::RpcError> {
        AppServer::session_dir_authorization(self, session_id, root, permission)
    }
}

impl super::language_operations::LanguageRequestProcessorContext for AppServer {
    fn file_system_service_for(
        &self,
        dir_id: Option<&str>,
    ) -> Result<std::sync::Arc<dyn ash_file_system::FileSystem>, super::RpcError> {
        AppServer::file_system_service_for(self, dir_id)
    }
    fn language_dir_root_for(
        &self,
        dir_id: Option<&str>,
        session_directory: Option<
            &ash_app_server_protocol::protocol::environment::SessionDirSelector,
        >,
    ) -> Result<ash_file_access::Dir, super::RpcError> {
        AppServer::language_dir_root_for(self, dir_id, session_directory)
    }
}

impl super::language_document_features::LanguageDocumentRequestProcessorContext for AppServer {
    fn language_dir_root_for(
        &self,
        dir_id: Option<&str>,
        session_directory: Option<
            &ash_app_server_protocol::protocol::environment::SessionDirSelector,
        >,
    ) -> Result<ash_file_access::Dir, super::RpcError> {
        AppServer::language_dir_root_for(self, dir_id, session_directory)
    }
    fn prepare_document_runtime(
        &self,
        dir: &ash_file_access::Dir,
        source_path: &std::path::Path,
        document: &ash_app_server_protocol::protocol::language::LanguageDocumentDto,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<
        std::sync::MutexGuard<'_, super::language_runtime::AppServerLanguageRuntime>,
        super::RpcError,
    > {
        self.language_processor()
            .prepare_document_runtime(dir, source_path, document, cancellation)
    }
}

impl super::mcp_operations::McpRequestProcessorContext for AppServer {
    fn agent_runtime(&self) -> impl core_api::AgentRuntime + '_ {
        AppServer::agent_runtime(self)
    }
    fn read_session_thread(
        &self,
        session_id: &ash_protocol::SessionId,
        thread_id: &ash_protocol::ThreadId,
    ) -> Result<ash_protocol::Thread, super::RpcError> {
        self.agent_processor()
            .read_session_thread(session_id, thread_id)
    }
    fn list_app_tools(
        &self,
        origin: &ash_protocol::ToolCall,
        binding: &ash_protocol::ToolCallBinding,
    ) -> Result<Vec<serde_json::Value>, core_api::CoreError> {
        self.turn_executor_snapshot()
            .list_app_tools(origin, binding)
    }
    fn resolve_app_tool_call(
        &self,
        origin: &ash_protocol::ToolCall,
        binding: &ash_protocol::ToolCallBinding,
        name: &str,
        arguments: serde_json::Value,
        id: ash_protocol::ToolCallId,
    ) -> Result<(ash_protocol::ToolCall, ash_protocol::ToolCallBinding), core_api::CoreError> {
        self.turn_executor_snapshot()
            .resolve_app_tool_call(origin, binding, name, arguments, id)
    }
    fn read_tool_resource(
        &self,
        call: &ash_protocol::ToolCall,
        binding: &ash_protocol::ToolCallBinding,
        uri: &str,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<ash_protocol::ToolOutputArtifact, core_api::CoreError> {
        self.turn_executor_snapshot()
            .read_tool_resource(call, binding, uri, cancellation)
    }
    fn completed_tool_result(
        &self,
        thread_id: &ash_protocol::ThreadId,
        turn_id: &ash_protocol::TurnId,
        call_id: &ash_protocol::ToolCallId,
    ) -> Result<Option<ash_protocol::ThreadItem>, core_api::CoreError> {
        self.threads
            .completed_tool_result(thread_id, turn_id, call_id)
    }
}

impl super::memories_operations::MemoriesRequestProcessorContext for AppServer {
    fn refresh_analytics(&self) -> Result<(), super::RpcError> {
        self.diagnostics_processor().refresh_analytics()
    }
    fn memory_scope_labels(
        &self,
        thread_id: Option<&ash_protocol::ThreadId>,
    ) -> Result<Vec<(memories::MemoryScope, String)>, String> {
        AppServer::memory_scope_labels(self, thread_id)
    }
}

impl super::network_operations::NetworkRequestProcessorContext for AppServer {
    fn account_read(&self) -> Result<serde_json::Value, super::RpcError> {
        self.account_processor().account_read()
    }
    fn account_rate_limits_read(
        &self,
        params: &serde_json::Value,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<serde_json::Value, super::RpcError> {
        self.account_processor()
            .account_rate_limits_read(params, cancellation)
    }
    fn provider_list(&self) -> Result<serde_json::Value, super::RpcError> {
        self.provider_processor().provider_list()
    }
}

impl super::search_operations::SearchRequestProcessorContext for AppServer {
    fn content_search_service_for(
        &self,
        dir_id: Option<&str>,
    ) -> Result<std::sync::Arc<grep::Jobs>, super::RpcError> {
        AppServer::content_search_service_for(self, dir_id)
    }
    fn content_search_service_for_session_directory(
        &self,
        selector: &ash_app_server_protocol::protocol::environment::SessionDirSelector,
    ) -> Result<std::sync::Arc<grep::Jobs>, super::RpcError> {
        AppServer::content_search_service_for_session_directory(self, selector)
    }
    fn grep_index_context(
        &self,
    ) -> Result<(std::sync::Arc<grep::Service>, ash_file_access::Dir), super::RpcError> {
        AppServer::grep_index_context(self)
    }
    fn session_dir_authorization(
        &self,
        session_id: &ash_protocol::SessionId,
        root: &std::path::Path,
        permission: ash_file_access::Permission,
    ) -> Result<ash_file_access::Authorization, super::RpcError> {
        AppServer::session_dir_authorization(self, session_id, root, permission)
    }
}

impl super::session_operations::SessionRequestProcessorContext for AppServer {
    fn agent_runtime(&self) -> impl core_api::AgentRuntime + '_ {
        AppServer::agent_runtime(self)
    }
    fn bind_session_runtime(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<(), core_api::CoreError> {
        AppServer::bind_session_runtime(self, session_id)
    }
    fn cancel_lost_dynamic_tool_owners(&self, requests: Vec<ash_protocol::AgentRequestEnvelope>) {
        AppServer::cancel_lost_dynamic_tool_owners(self, requests)
    }
    fn clear_session_dirs(&self, session_id: &ash_protocol::SessionId) {
        AppServer::clear_session_dirs(self, session_id)
    }
    fn collect_message_checkpoints(
        &self,
        source: &dyn core_api::MessageCheckpointSource,
    ) -> Result<(), core_api::CoreError> {
        AppServer::collect_message_checkpoints(self, source)
    }
    fn emit_hook_event(
        &self,
        request: &core_api::HookEventRequest,
    ) -> Result<core_api::HookEventDecision, super::RpcError> {
        AppServer::emit_hook_event(self, request)
    }
    fn git_turn_changes_runtime(
        &self,
    ) -> Result<
        std::sync::Arc<super::git_turn_changes_runtime::GitTurnChangesRuntime>,
        super::RpcError,
    > {
        self.git_turn_changes_processor().git_turn_changes_runtime()
    }
    fn notify_thread_updates(
        &self,
        thread_id: &ash_protocol::ThreadId,
        after_sequence: u64,
    ) -> Result<(), super::RpcError> {
        self.agent_processor()
            .notify_thread_updates(thread_id, after_sequence)
    }
    fn offer_pending_interactions(&self, thread: &core_api::ThreadView) {
        self.agent_processor().offer_pending_interactions(thread)
    }
    fn read_session_thread_snapshot(
        &self,
        session_id: &ash_protocol::SessionId,
        thread_id: &ash_protocol::ThreadId,
    ) -> Result<core_api::ThreadView, super::RpcError> {
        self.agent_processor()
            .read_session_thread_snapshot(session_id, thread_id)
    }
    fn resolve_root_agent(
        &self,
        selection: &ash_protocol::AgentRoleSelection,
    ) -> Result<Option<ash_protocol::AgentConfiguration>, core_api::CoreError> {
        AppServer::resolve_root_agent(self, selection)
    }
    fn session_catalog_view(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<Option<ash_protocol::Session>, super::RpcError> {
        self.agent_processor().session_catalog_view(session_id)
    }
    fn session_result(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<ash_app_server_protocol::protocol::session::SessionResult, super::RpcError> {
        self.agent_processor().session_result(session_id)
    }
    fn session_view(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<ash_protocol::Session, super::RpcError> {
        self.agent_processor().session_view(session_id)
    }
    fn session_views(&self) -> Result<Vec<ash_protocol::Session>, super::RpcError> {
        self.agent_processor().session_views()
    }
    fn stop_session_automations(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<(), super::RpcError> {
        AppServer::stop_session_automations(self, session_id)
    }
    fn thread_directory(
        &self,
        thread_id: &ash_protocol::ThreadId,
    ) -> Result<Option<ash_protocol::SessionExecutionTarget>, super::RpcError> {
        AppServer::thread_directory(self, thread_id)
    }
    fn trace_reader(&self) -> ash_rollout_trace::TraceReader {
        AppServer::trace_reader(self)
    }
}

impl super::symbol_index_operations::SymbolIndexRequestProcessorContext for AppServer {
    fn codebase_service(
        &self,
    ) -> Result<std::sync::Arc<super::codebase_runtime::CodebaseRuntime>, super::RpcError> {
        AppServer::codebase_service(self)
    }
    fn symbol_index_service(
        &self,
    ) -> Result<std::sync::Arc<super::symbol_index_runtime::SymbolIndexRuntime>, super::RpcError>
    {
        AppServer::symbol_index_service(self)
    }
}

impl super::symphony_operations::SymphonyRequestProcessorContext for AppServer {
    fn agent_runtime(&self) -> impl core_api::AgentRuntime + '_ {
        AppServer::agent_runtime(self)
    }
}

impl super::symphony_tracker::SymphonyTrackerRequestProcessorContext for AppServer {
    fn github_client(
        &self,
        cancellation: &ash_async_utils::CancellationToken,
    ) -> Result<github::GitHub, RpcError> {
        AppServer::github_client(self, cancellation)
    }
}

impl super::terminal_operations::TerminalRequestProcessorContext for AppServer {
    fn session_dir_authorization(
        &self,
        session_id: &ash_protocol::SessionId,
        root: &std::path::Path,
        permission: ash_file_access::Permission,
    ) -> Result<ash_file_access::Authorization, super::RpcError> {
        AppServer::session_dir_authorization(self, session_id, root, permission)
    }
    fn session_terminal_service(
        &self,
        session_id: &ash_protocol::SessionId,
        authorization: &ash_file_access::Authorization,
    ) -> Result<std::sync::Arc<exec_server::terminal::TerminalService>, super::RpcError> {
        AppServer::session_terminal_service(self, session_id, authorization)
    }
    fn terminal_service_for(
        &self,
        dir_id: Option<&str>,
    ) -> Result<std::sync::Arc<exec_server::terminal::TerminalService>, super::RpcError> {
        AppServer::terminal_service_for(self, dir_id)
    }
}

impl super::team_operations::TeamRequestProcessorContext for AppServer {
    fn agent_runtime(&self) -> impl core_api::AgentRuntime + '_ {
        AppServer::agent_runtime(self)
    }
    fn bind_session_runtime(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<(), core_api::CoreError> {
        AppServer::bind_session_runtime(self, session_id)
    }
    fn resolve_root_agent(
        &self,
        selection: &ash_protocol::AgentRoleSelection,
    ) -> Result<Option<ash_protocol::AgentConfiguration>, core_api::CoreError> {
        AppServer::resolve_root_agent(self, selection)
    }
    fn start_agent_turn_request(
        &self,
        mutation: super::operations::ThreadMutation,
        thread_id: ash_protocol::ThreadId,
        approval_mode: ash_protocol::ApprovalMode,
        mode: ash_protocol::CollaborationMode,
        tool_mode_selection: super::operations::TurnToolModeSelection,
        input: Vec<ash_protocol::UserInput>,
        kind: ash_protocol::TurnKind,
        selection: super::operations::TurnInstructionSelection,
        model_selection: super::operations::TurnModelSelection,
        reasoning_effort: Option<ash_protocol::ReasoningEffort>,
    ) -> Result<ash_app_server_protocol::protocol::turn::TurnStartResult, super::RpcError> {
        self.agent_processor().start_agent_turn_request(
            mutation,
            thread_id,
            approval_mode,
            mode,
            tool_mode_selection,
            input,
            kind,
            selection,
            model_selection,
            reasoning_effort,
        )
    }
}

impl super::operations::AgentRequestProcessorContext for AppServer {
    fn submit_bound_turn_with_ide(
        &self,
        thread: &ash_protocol::ThreadId,
        request: core_api::SubmitTurnRequest,
        connection: Option<u64>,
        document_mode: crate::client_host::TextDocumentMode,
        expected_ide: Option<&str>,
    ) -> Result<core_api::TurnReceipt, core_api::CoreError> {
        // Core prepares the admission and dispatches only after the host releases its
        // document binding lock. The processor sees only the complete operation.
        AppServer::agent_runtime(self).submit_turn_with_admission(
            thread,
            request,
            |thread, request| {
                AppServer::admit_bound_turn_with_ide(
                    self,
                    thread,
                    request,
                    connection,
                    document_mode,
                    expected_ide,
                )
            },
        )
    }
    fn agent_runtime(&self) -> impl core_api::AgentRuntime + '_ {
        AppServer::agent_runtime(self)
    }
    fn archive_session_request(
        &self,
        mutation: super::operations::SessionMutation,
    ) -> Result<ash_app_server_protocol::protocol::session::SessionResult, super::RpcError> {
        self.session_processor().archive_session_request(mutation)
    }
    fn attach_instruction(
        &self,
        session_id: &ash_protocol::SessionId,
        path: &str,
    ) -> Result<ash_protocol::UserInput, super::RpcError> {
        self.instruction_processor()
            .attach_instruction(session_id, path)
    }
    fn cancel_lost_dynamic_tool_owners(&self, requests: Vec<ash_protocol::AgentRequestEnvelope>) {
        AppServer::cancel_lost_dynamic_tool_owners(self, requests)
    }
    fn delete_session_request(
        &self,
        mutation: super::operations::SessionMutation,
    ) -> Result<ash_protocol::SessionId, super::RpcError> {
        self.session_processor().delete_session_request(mutation)
    }
    fn emit_hook_event(
        &self,
        request: &core_api::HookEventRequest,
    ) -> Result<core_api::HookEventDecision, super::RpcError> {
        AppServer::emit_hook_event(self, request)
    }
    fn fork_session_request(
        &self,
        mutation: super::operations::SessionMutation,
        parent_thread_id: ash_protocol::ThreadId,
        title: String,
    ) -> Result<ash_app_server_protocol::protocol::session::SessionThreadResult, super::RpcError>
    {
        self.session_processor()
            .fork_session_request(mutation, parent_thread_id, title)
    }
    fn local_env_tool_ports(
        &self,
    ) -> Option<std::sync::Arc<super::environment_runtime::EnvToolPorts>> {
        AppServer::local_env_tool_ports(self)
    }
    fn refresh_analytics(&self) -> Result<(), super::RpcError> {
        self.diagnostics_processor().refresh_analytics()
    }
    fn restore_session_request(
        &self,
        mutation: super::operations::SessionMutation,
    ) -> Result<ash_app_server_protocol::protocol::session::SessionResult, super::RpcError> {
        self.session_processor().restore_session_request(mutation)
    }
    fn stop_session_request(
        &self,
        mutation: super::operations::SessionMutation,
    ) -> Result<ash_app_server_protocol::protocol::session::SessionResult, super::RpcError> {
        self.session_processor().stop_session_request(mutation)
    }
    fn submit_workflow(
        &self,
        thread: &ash_protocol::ThreadId,
        command: workflows::Command,
        request: core_api::SubmitTurnRequest,
        connection: Option<u64>,
        document_mode: crate::client_host::TextDocumentMode,
        expected_ide: Option<&str>,
    ) -> Result<workflows::Receipt, core_api::CoreError> {
        AppServer::submit_workflow(
            self,
            thread,
            command,
            request,
            connection,
            document_mode,
            expected_ide,
        )
    }
    fn terminal_service(
        &self,
    ) -> Result<std::sync::Arc<exec_server::terminal::TerminalService>, super::RpcError> {
        AppServer::terminal_service(self)
    }
    fn thread_directory(
        &self,
        thread_id: &ash_protocol::ThreadId,
    ) -> Result<Option<ash_protocol::SessionExecutionTarget>, super::RpcError> {
        AppServer::thread_directory(self, thread_id)
    }
}

impl super::app_tools_operations::AppToolsRequestProcessorContext for AppServer {
    fn session_views(&self) -> Result<Vec<ash_protocol::Session>, super::RpcError> {
        self.agent_processor().session_views()
    }

    fn archive_session_request(
        &self,
        mutation: super::operations::SessionMutation,
    ) -> Result<ash_app_server_protocol::protocol::session::SessionResult, super::RpcError> {
        self.session_processor().archive_session_request(mutation)
    }
    fn create_session(
        &self,
        params: ash_app_server_protocol::protocol::session::SessionCreateParams,
    ) -> Result<ash_app_server_protocol::protocol::session::SessionResult, super::RpcError> {
        self.session_processor().create_session(params)
    }
    fn fork_session_request(
        &self,
        mutation: super::operations::SessionMutation,
        parent_thread_id: ash_protocol::ThreadId,
        title: String,
    ) -> Result<ash_app_server_protocol::protocol::session::SessionThreadResult, super::RpcError>
    {
        self.session_processor()
            .fork_session_request(mutation, parent_thread_id, title)
    }
    fn read_session_thread_snapshot(
        &self,
        session_id: &ash_protocol::SessionId,
        thread_id: &ash_protocol::ThreadId,
    ) -> Result<core_api::ThreadView, super::RpcError> {
        self.agent_processor()
            .read_session_thread_snapshot(session_id, thread_id)
    }
    fn restore_session_request(
        &self,
        mutation: super::operations::SessionMutation,
    ) -> Result<ash_app_server_protocol::protocol::session::SessionResult, super::RpcError> {
        self.session_processor().restore_session_request(mutation)
    }
    fn session_thread_read(
        &self,
        params: &serde_json::Value,
    ) -> Result<serde_json::Value, super::RpcError> {
        self.agent_processor().session_thread_read(params)
    }
    fn session_view(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<ash_protocol::Session, super::RpcError> {
        self.agent_processor().session_view(session_id)
    }
}

impl super::queue_operations::QueueRequestProcessorContext for AppServer {
    fn agent_runtime(&self) -> impl core_api::AgentRuntime + '_ {
        AppServer::agent_runtime(self)
    }
    fn bind_session_runtime(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<(), core_api::CoreError> {
        AppServer::bind_session_runtime(self, session_id)
    }
    fn normalize_input(
        &self,
        session_id: &ash_protocol::SessionId,
        input: Vec<ash_app_server_protocol::protocol::turn::InputItem>,
    ) -> Result<Vec<ash_protocol::UserInput>, super::RpcError> {
        self.agent_processor().normalize_input(session_id, input)
    }
    fn read_session_thread(
        &self,
        session_id: &ash_protocol::SessionId,
        thread_id: &ash_protocol::ThreadId,
    ) -> Result<ash_protocol::Thread, super::RpcError> {
        self.agent_processor()
            .read_session_thread(session_id, thread_id)
    }
    fn refresh_analytics(&self) -> Result<(), super::RpcError> {
        self.diagnostics_processor().refresh_analytics()
    }
    fn start_agent_turn_request(
        &self,
        mutation: super::operations::ThreadMutation,
        thread_id: ash_protocol::ThreadId,
        approval_mode: ash_protocol::ApprovalMode,
        mode: ash_protocol::CollaborationMode,
        tool_mode_selection: super::operations::TurnToolModeSelection,
        input: Vec<ash_protocol::UserInput>,
        kind: ash_protocol::TurnKind,
        selection: super::operations::TurnInstructionSelection,
        model_selection: super::operations::TurnModelSelection,
        reasoning_effort: Option<ash_protocol::ReasoningEffort>,
    ) -> Result<ash_app_server_protocol::protocol::turn::TurnStartResult, super::RpcError> {
        self.agent_processor().start_agent_turn_request(
            mutation,
            thread_id,
            approval_mode,
            mode,
            tool_mode_selection,
            input,
            kind,
            selection,
            model_selection,
            reasoning_effort,
        )
    }
    fn turn_instruction_selection(
        &self,
        input: &mut Vec<ash_protocol::UserInput>,
        mode: ash_protocol::CollaborationMode,
    ) -> Result<super::operations::TurnInstructionSelection, super::RpcError> {
        self.agent_processor()
            .turn_instruction_selection(input, mode)
    }
}

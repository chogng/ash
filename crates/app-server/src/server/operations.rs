use super::AppServer;
use super::ConnectionState;
use super::RpcError;
use super::core_error;
use super::decode;
use super::result;
use ash_app_server_protocol::protocol::agent::AgentCapabilitiesReadResult;
use ash_app_server_protocol::protocol::common::SchemaHash;
use ash_app_server_protocol::protocol::common::ServerInfo;
use ash_app_server_protocol::protocol::document::TypstCompileParams;
use ash_app_server_protocol::protocol::document::TypstCompileResult;
use ash_app_server_protocol::protocol::document::TypstDiagnosticDto;
use ash_app_server_protocol::protocol::document::TypstDiagnosticSeverityDto;
use ash_app_server_protocol::protocol::document::TypstSourceRangeDto;
use ash_app_server_protocol::protocol::error::AppServerErrorName;
use ash_app_server_protocol::protocol::goal::ThreadGoalClearParams;
use ash_app_server_protocol::protocol::goal::ThreadGoalClearResponse;
use ash_app_server_protocol::protocol::goal::ThreadGoalGetParams;
use ash_app_server_protocol::protocol::goal::ThreadGoalGetResponse;
use ash_app_server_protocol::protocol::goal::ThreadGoalSetParams;
use ash_app_server_protocol::protocol::goal::ThreadGoalSetResponse;
use ash_app_server_protocol::protocol::initialize::InitializeParams;
use ash_app_server_protocol::protocol::initialize::InitializeResult;
use ash_app_server_protocol::protocol::initialize::ProtocolVersion;
use ash_app_server_protocol::protocol::initialize::ServerCapabilities;
use ash_app_server_protocol::protocol::model::ModelListParams;
use ash_app_server_protocol::protocol::model::ModelListResult;
use ash_app_server_protocol::protocol::model::ModelPreferencesUpdateParams;
use ash_app_server_protocol::protocol::provider::ProviderModelsListFailureCodeDto;
use ash_app_server_protocol::protocol::provider::ProviderModelsListFailureDto;
use ash_app_server_protocol::protocol::provider::ProviderModelsListResult;
use ash_app_server_protocol::protocol::resources::ResourceMetadataParams;
use ash_app_server_protocol::protocol::resources::ResourceMetadataResult;
use ash_app_server_protocol::protocol::resources::ResourceReadParams;
use ash_app_server_protocol::protocol::resources::ResourceReadResult;
use ash_app_server_protocol::protocol::resources::ResourceReleaseParams;
use ash_app_server_protocol::protocol::session::MAX_THREAD_SNAPSHOT_TURNS;
use ash_app_server_protocol::protocol::session::SessionRequest;
use ash_app_server_protocol::protocol::session::SessionRequestParams;
use ash_app_server_protocol::protocol::session::SessionRequestResult;
use ash_app_server_protocol::protocol::session::SessionRewriteResult;
use ash_app_server_protocol::protocol::session::SessionThreadReadParams;
use ash_app_server_protocol::protocol::session::SessionThreadReadResult;
use ash_app_server_protocol::protocol::session::SessionThreadResult;
use ash_app_server_protocol::protocol::session::SessionThreadSubscribeParams;
use ash_app_server_protocol::protocol::session::SessionThreadSubscribeResult;
use ash_app_server_protocol::protocol::session::SessionThreadUnsubscribeParams;
use ash_app_server_protocol::protocol::session::ThreadHistoryBoundary;
use ash_app_server_protocol::protocol::session::ThreadSnapshotHistory;
use ash_app_server_protocol::protocol::turn::InputItem;
use ash_app_server_protocol::protocol::turn::TurnInteractionResolveResult;
use ash_app_server_protocol::protocol::turn::TurnInterruptResult;
use ash_app_server_protocol::protocol::turn::TurnStartResult;
use ash_app_server_protocol::protocol::turn::TurnSteerResult;
use ash_app_server_protocol::schema_hash;
use ash_protocol::AgentRequestEnvelope;
use ash_protocol::HookEvent;
use ash_protocol::ModelAccess;
use ash_protocol::Session;
use ash_protocol::ThreadStatus;
use ash_protocol::UserInput;
use ash_typst::TypstCompileError;
use ash_typst::TypstCompileOutcome;
use ash_typst::TypstDiagnostic;
use ash_typst::TypstDiagnosticSeverity;
use base64::Engine;
use core_api::AgentRuntime;
use core_api::CreateBranchRequest;
use core_api::ForkThreadRequest;
use core_api::HookEventDecision;
use core_api::HookEventRequest;
use core_api::HookEventScope;
use core_api::InterruptTurnRequest;
use core_api::ResolveTurnInteractionRequest;
use core_api::RewindThreadRequest;
use core_api::SequenceExpectation;
use core_api::ShellTurnInvocation;
use core_api::SteerTurnRequest;
use core_api::ThreadView;
use serde_json::Value;
use std::time::Duration;

pub(super) enum TurnInstructionSelection {
    Agent,
    Product(ash_protocol::TurnInstructions),
    Setup(ash_protocol::TurnInstructions),
    Workflow(workflows::Command),
}

fn init_prompt() -> ash_protocol::TurnInstructions {
    ash_protocol::TurnInstructions::new(
        "app-server",
        "instructions/init",
        "instructions-init-v1",
        format!(
            "{}\n\n<always-on-template>\n{}\n</always-on-template>",
            include_str!("../../templates/instructions/init.md").trim(),
            ash_instructions::STARTER_ALWAYS_ON_TEMPLATE.trim()
        ),
    )
    .expect("built-in Ash initialization prompt is valid")
}

fn product_command(input: &[UserInput]) -> Option<&str> {
    input
        .iter()
        .find_map(|item| match item {
            UserInput::Text { text } => Some(text),
            _ => None,
        })
        .and_then(|text| text.split_whitespace().next())
}

pub(super) struct SessionMutation {
    pub(super) command_id: ash_protocol::CommandId,
    pub(super) session_id: ash_protocol::SessionId,
}

pub(super) struct ThreadMutation {
    pub(super) connection_id: Option<u64>,
    pub(super) command_id: ash_protocol::CommandId,
    pub(super) session_id: ash_protocol::SessionId,
    pub(super) expected_sequence: u64,
}

struct RewriteSessionMutation {
    parent_thread_id: ash_protocol::ThreadId,
    before_turn_id: ash_protocol::TurnId,
    title: String,
    tool_mode: Option<ash_protocol::ToolMode>,
    input: Vec<InputItem>,
}

pub(super) enum TurnToolModeSelection {
    ConfiguredDefault,
    Explicit(ash_protocol::ToolMode),
}

pub(super) enum TurnModelSelection {
    Current,
    Explicit(ash_protocol::ModelRef),
}

enum RewritePhase {
    Rewind,
    Start,
}

impl RewritePhase {
    fn as_str(&self) -> &'static str {
        match self {
            Self::Rewind => "rewind",
            Self::Start => "start",
        }
    }
}

impl AppServer {
    pub(super) fn context_read(&self, params: &Value) -> Result<Value, RpcError> {
        use ash_app_server_protocol::protocol::model::ContextReadParams;
        use ash_app_server_protocol::protocol::model::ContextReadResult;
        use ash_app_server_protocol::protocol::model::ContextReadScope;
        let params: ContextReadParams = decode(params)?;
        let thread = match &params.scope {
            ContextReadScope::Environment => None,
            ContextReadScope::Thread {
                session_id,
                thread_id,
            } => Some(self.read_session_thread_snapshot(session_id, thread_id)?),
        };
        let latest = thread.as_ref().and_then(|thread| thread.turns.last());
        let model = match thread
            .as_ref()
            .and_then(|thread| thread.agent_configuration())
            .and_then(|agent| agent.model())
        {
            Some(model) => Some(model.clone()),
            None => self
                .model_catalog
                .configured_default()
                .map_err(core_error)?,
        };
        let instructions = match latest
            .filter(|turn| turn.model == model)
            .and_then(|turn| turn.instructions.as_ref())
        {
            Some(instructions) => instructions.clone(),
            None => {
                let base = thread
                    .as_ref()
                    .and_then(|thread| thread.agent_configuration())
                    .and_then(|agent| agent.base_instructions.clone())
                    .unwrap_or_else(|| ash_prompts::AGENT_INSTRUCTIONS.freeze());
                let base = if base
                    .model_guidance()
                    .is_some_and(|guidance| guidance.model() == model.as_ref())
                {
                    base
                } else {
                    self.model_instructions.for_turn(base, model.as_ref())
                };
                let mode = latest.map(|turn| turn.mode).unwrap_or_default();
                base.with_mode(&collaboration_mode_templates::instructions(mode))
            }
        };
        let scope = match &params.scope {
            ContextReadScope::Environment => core_api::ContextInspectionScope::Environment,
            ContextReadScope::Thread { thread_id, .. } => {
                core_api::ContextInspectionScope::Thread(thread_id)
            }
        };
        let inspection = self
            .agent_runtime()
            .inspect_context(core_api::ContextInspectionRequest {
                context_policy: self
                    .config
                    .as_ref()
                    .map(|config| config.read_snapshot())
                    .transpose()
                    .map_err(|_| RpcError::new(-32030, AppServerErrorName::ConfigUnavailable))?
                    .map(|snapshot| snapshot.values.context)
                    .unwrap_or_default(),
                scope,
                model,
                instructions,
                approval_mode: latest.map(|turn| turn.approval_mode).unwrap_or_default(),
                tool_mode: latest.map(|turn| turn.tool_mode).unwrap_or_default(),
            })
            .map_err(core_error)?;
        let tool_definitions = match params.detail {
            ash_app_server_protocol::protocol::model::ContextReadDetail::Usage => Vec::new(),
            ash_app_server_protocol::protocol::model::ContextReadDetail::Diagnostics => {
                let sources = &inspection
                    .context
                    .categories
                    .iter()
                    .find(|category| {
                        category.category == ash_protocol::ModelContextCategory::SystemTools
                    })
                    .expect("inspection always includes the tool category")
                    .sources;
                inspection
                    .tool_definitions
                    .into_iter()
                    .map(|tool| {
                        let tokens = sources
                            .iter()
                            .find(|source| source.name == tool.name.as_str())
                            .expect("each inspected tool has an estimate from the same catalog")
                            .tokens;
                        ash_app_server_protocol::protocol::model::ContextToolDefinition {
                            name: tool.name.to_string(),
                            description: tool.description,
                            parameters: tool.parameters,
                            strict: tool.strict,
                            tokens,
                        }
                    })
                    .collect()
            }
        };
        result(&ContextReadResult {
            context: inspection.context,
            tool_definitions,
        })
    }

    pub(super) fn initialize(
        &self,
        connection: &mut ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
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
                capability.version != 3 || (!capability.observe && !capability.input)
            })
        {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        if params
            .capabilities
            .dir_permissions_host
            .as_ref()
            .is_some_and(|capability| capability.version != 1)
        {
            return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
        }
        if params.capabilities.dir_permissions_host.is_some()
            && !connection.allows_product_host_capabilities()
        {
            return Err(RpcError::new(
                -32073,
                AppServerErrorName::PermissionRequired,
            ));
        }
        connection.set_dir_permissions_host(params.capabilities.dir_permissions_host.is_some());
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
            typst: true,
            update_replay: true,
            extensions,
            extension_host: self.extension_hosts.is_some(),
            connectors: self.connectors.is_some(),
            plugins: self.plugins.is_some(),
            marketplace: self.plugin_package_service.is_some(),
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
        if self.assets.is_some() {
            capabilities.contracts.insert(
                "assets".into(),
                ash_app_server_protocol::protocol::initialize::CapabilityContract { version: 1 },
            );
        }
        if self.home.is_some() {
            capabilities.contracts.insert(
                "calls".into(),
                ash_app_server_protocol::protocol::initialize::CapabilityContract { version: 1 },
            );
        }
        if self.automation.is_some() {
            capabilities.contracts.insert(
                "automation".into(),
                ash_app_server_protocol::protocol::initialize::CapabilityContract { version: 1 },
            );
        }
        result(&InitializeResult {
            server_info: ServerInfo {
                name: "ash-app-server".into(),
                version: build_info::VERSION.into(),
            },
            protocol_version: ProtocolVersion::current(),
            schema_hash: SchemaHash(schema_hash()),
            capabilities,
            slash_commands: self.slash_commands.commands().to_vec(),
        })
    }

    pub(super) fn agent_capabilities_read(
        &self,
        connection: &ConnectionState,
    ) -> Result<Value, RpcError> {
        let (tools, configured) = match self.local_env_tool_ports() {
            Some(ports) => ports.capabilities_snapshot(),
            None => (Vec::new(), false),
        };
        #[cfg(windows)]
        let candidates = vec!["mxc".to_owned(), "windows".to_owned()];
        #[cfg(not(windows))]
        let candidates = vec!["mxc".to_owned()];
        let sandbox_backends = if configured { candidates } else { Vec::new() };
        let dir = self
            .env_runtime
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .selected_grant
            .as_ref()
            .map(|grant| grant.dir().clone());
        let sandbox_diagnostics = if let Some(dir) = dir.filter(|_| configured) {
            use ash_app_server_protocol::protocol::agent::SandboxDiagnosticDto;
            use ash_app_server_protocol::protocol::agent::SandboxNetworkModeDto;
            use ash_app_server_protocol::protocol::agent::SandboxReadinessDto;
            let executable = std::env::current_exe()
                .map_err(|_| RpcError::new(-32603, AppServerErrorName::InternalError))?;
            let mut sandbox =
                exec_server::LocalSandbox::new(ash_install_context::InstallContext::current());
            if let Some(helper) = &self.pty_helper {
                sandbox = sandbox.with_pty_helper(helper.clone());
            }
            let command = ash_sandboxing::SandboxCommand::new(
                executable,
                Vec::<String>::new(),
                dir.canonical_path(),
            );
            sandbox
                .build()
                .diagnostics(&command, &ash_sandboxing::SandboxScope::single(dir))
                .into_iter()
                .map(|diagnostic| SandboxDiagnosticDto {
                    backend: diagnostic.backend,
                    network: match diagnostic.network {
                        ash_sandboxing::NetworkAccess::Denied => SandboxNetworkModeDto::Denied,
                        ash_sandboxing::NetworkAccess::Allowed => SandboxNetworkModeDto::Allowed,
                        ash_sandboxing::NetworkAccess::Managed => SandboxNetworkModeDto::Managed,
                    },
                    readiness: match diagnostic.readiness {
                        ash_sandboxing::SandboxReadiness::Ready => SandboxReadinessDto::Ready,
                        ash_sandboxing::SandboxReadiness::Unsupported(reason) => {
                            SandboxReadinessDto::Unsupported { reason }
                        }
                        ash_sandboxing::SandboxReadiness::Unavailable(reason) => {
                            SandboxReadinessDto::Unavailable { reason }
                        }
                    },
                })
                .collect()
        } else {
            Vec::new()
        };
        let mut tool_sets = std::collections::BTreeMap::new();
        for tool in tools.iter().filter(|tool| {
            tool.exposure != ash_app_server_protocol::protocol::agent::ToolExposureDto::Hidden
        }) {
            // Source identity excludes catalog generations and remote tool names so a group's
            // identity survives reconnects and does not merge independent MCP servers.
            let source_id = tool
                .source_chain
                .iter()
                .rev()
                .find_map(|source| match source {
                    ash_protocol::ToolSourceProvenance::Mcp { server_id, .. } => {
                        Some(server_id.to_string())
                    }
                    ash_protocol::ToolSourceProvenance::Plugin { plugin_id, .. } => {
                        Some(plugin_id.to_string())
                    }
                    ash_protocol::ToolSourceProvenance::Extension { id } => Some(id.clone()),
                    ash_protocol::ToolSourceProvenance::Product { component } => {
                        Some(component.clone())
                    }
                    ash_protocol::ToolSourceProvenance::Dynamic { .. }
                    | ash_protocol::ToolSourceProvenance::System { .. } => None,
                })
                .unwrap_or_default();
            let id = serde_json::to_string(&(tool.source, &source_id))
                .map_err(|_| RpcError::new(-32603, AppServerErrorName::InternalError))?;
            let group = tool_sets.entry(id.clone()).or_insert_with(|| {
                ash_app_server_protocol::protocol::agent::AgentToolSetCapabilityDto {
                    id,
                    source: tool.source,
                    source_id,
                    tools: Vec::new(),
                }
            });
            group.tools.push(tool.name.clone());
        }
        result(&AgentCapabilitiesReadResult {
            tools,
            tool_sets: tool_sets.into_values().collect(),
            local_process_sandbox_configured: configured,
            sandbox_backends,
            sandbox_diagnostics,
            directory_grants_readable: connection.supports_dir_permissions_host(),
        })
    }

    pub(super) fn model_list(&self, params: &Value) -> Result<Value, RpcError> {
        let _: ModelListParams = decode(params)?;
        result(&ModelListResult {
            models: self.model_catalog.list().map_err(core_error)?,
        })
    }

    pub(super) fn model_preferences_update(&self, params: &Value) -> Result<Value, RpcError> {
        use crate::model_catalog::ModelPreferencesCommand;
        use crate::model_catalog::ModelPreferencesError;
        let params: ModelPreferencesUpdateParams = decode(params)?;
        let outcome = self
            .model_catalog
            .set_preferences(ModelPreferencesCommand {
                command_id: params.command_id,
                expected_revision: ash_config::ConfigRevision::new(params.expected_revision),
                model: params.model,
                update: ash_models_manager::ModelPreferencesUpdate {
                    acceleration: params.acceleration,
                    long_context: params.long_context,
                },
            })
            .map_err(|error| match error {
                ModelPreferencesError::Catalog(error) => core_error(error),
                ModelPreferencesError::InvalidPreferences(error) => RpcError {
                    detail: Some(error.to_string()),
                    ..RpcError::new(-32602, AppServerErrorName::InvalidParams)
                },
                ModelPreferencesError::Configuration(error) => {
                    super::config_operations::config_operation_error(error)
                }
            })?;
        result(&super::config_operations::config_command_result(outcome))
    }

    pub(super) fn provider_models_list(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::provider::ProviderModelsListParams =
            decode(params)?;
        let provider = ash_protocol::ModelConnectionId::new(params.connection)
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        let response = match self.model_catalog.refresh(&provider) {
            Ok(models) if models.is_empty() => ProviderModelsListResult::Empty,
            Ok(models) => ProviderModelsListResult::Models { models },
            Err(error) => ProviderModelsListResult::Failed {
                failure: ProviderModelsListFailureDto {
                    code: provider_models_failure_code(error),
                },
            },
        };
        result(&response)
    }

    /// Routes one canonical mutation through the owning Session aggregate.
    pub(super) fn session_request(
        &self,
        connection: &mut ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let SessionRequestParams {
            command_id,
            session_id,
            request,
        } = decode(params)?;
        self.session_view(&session_id)?;
        let mutation = SessionMutation {
            command_id: command_id.clone(),
            session_id: session_id.clone(),
        };

        match request {
            SessionRequest::Archive => result(&SessionRequestResult::Session(
                self.archive_session_request(mutation)?,
            )),
            SessionRequest::Restore => result(&SessionRequestResult::Session(
                self.restore_session_request(mutation)?,
            )),
            SessionRequest::Delete => result(&SessionRequestResult::Deleted(
                self.delete_session_request(mutation)?,
            )),
            SessionRequest::Stop => result(&SessionRequestResult::Session(
                self.stop_session_request(mutation)?,
            )),
            SessionRequest::CreateThread { agent_id, title } => result(
                &SessionRequestResult::Thread(self.create_session_thread_request(
                    connection.connection_id,
                    mutation,
                    agent_id,
                    title,
                )?),
            ),
            SessionRequest::ReplaceThread {
                source_thread_id,
                title,
            } => result(&SessionRequestResult::Thread(
                self.replace_session_thread_request(
                    connection.connection_id,
                    mutation,
                    source_thread_id,
                    title,
                )?,
            )),
            SessionRequest::RestoreMessage {
                thread_id,
                item_id,
                boundary,
                title,
            } => result(&SessionRequestResult::Thread(
                self.restore_message_request(
                    connection.connection_id,
                    mutation,
                    thread_id,
                    item_id,
                    boundary,
                    title,
                )?,
            )),
            SessionRequest::ForkSession {
                parent_thread_id,
                title,
            } => result(&SessionRequestResult::Thread(self.fork_session_request(
                mutation,
                parent_thread_id,
                title,
            )?)),
            SessionRequest::ForkThread {
                parent_thread_id,
                title,
            } => result(&SessionRequestResult::Thread(
                self.fork_session_thread_request(
                    connection.connection_id,
                    mutation,
                    parent_thread_id,
                    title,
                )?,
            )),
            SessionRequest::RewindThread {
                parent_thread_id,
                before_turn_id,
                title,
            } => result(&SessionRequestResult::Thread(
                self.rewind_session_thread_request(
                    connection.connection_id,
                    mutation,
                    parent_thread_id,
                    before_turn_id,
                    title,
                )?,
            )),
            SessionRequest::RewriteThread {
                parent_thread_id,
                before_turn_id,
                title,
                tool_mode,
                input,
            } => result(&SessionRequestResult::Rewrite(
                self.rewrite_session_thread_request(
                    connection.connection_id,
                    mutation,
                    RewriteSessionMutation {
                        parent_thread_id,
                        before_turn_id,
                        title,
                        tool_mode,
                        input,
                    },
                )?,
            )),
            SessionRequest::StartTurn {
                thread_id,
                expected_sequence,
                mode,
                approval_mode,
                model,
                reasoning_effort,
                tool_mode,
                input,
            } => result(&SessionRequestResult::Turn(self.start_turn_request(
                thread_mutation(mutation, expected_sequence, connection.connection_id),
                thread_id,
                approval_mode,
                mode,
                model.map_or(TurnModelSelection::Current, TurnModelSelection::Explicit),
                reasoning_effort,
                tool_mode,
                input,
            )?)),
            SessionRequest::StartReview {
                thread_id,
                expected_sequence,
                target,
            } => result(&SessionRequestResult::Turn(self.start_review_request(
                thread_mutation(mutation, expected_sequence, connection.connection_id),
                thread_id,
                target,
            )?)),
            SessionRequest::StartShellTurn {
                thread_id,
                expected_sequence,
                approval_mode,
                command,
                working_directory,
            } => result(&SessionRequestResult::Turn(self.start_shell_turn_request(
                thread_mutation(mutation, expected_sequence, connection.connection_id),
                thread_id,
                approval_mode,
                command,
                working_directory,
            )?)),
            SessionRequest::ConfigureAdvisor {
                thread_id,
                expected_sequence,
                selection,
            } => {
                self.read_session_thread(&mutation.session_id, &thread_id)?;
                if let Some(sequence) = self
                    .agent_runtime()
                    .replay_advisor_configuration(&thread_id, &mutation.command_id, &selection)
                    .map_err(core_error)?
                {
                    return result(&SessionRequestResult::AdvisorConfigured(
                        ash_app_server_protocol::protocol::session::AdvisorConfigureResult {
                            sequence,
                        },
                    ));
                }
                if let ash_protocol::AdvisorSelection::Model { config } = &selection {
                    config
                        .validate()
                        .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
                    let saved = self
                        .config
                        .as_ref()
                        .map(|store| store.read_snapshot())
                        .transpose()
                        .map_err(|_| RpcError::new(-32603, AppServerErrorName::InternalError))?;
                    if !self
                        .model_catalog
                        .list()
                        .map_err(core_error)?
                        .iter()
                        .any(|entry| entry.model == config.model)
                        && !saved.is_some_and(|snapshot| {
                            snapshot
                                .values
                                .providers
                                .contains_key(&config.model.provider)
                        })
                    {
                        return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
                    }
                }
                let sequence = self
                    .agent_runtime()
                    .configure_advisor(
                        &thread_id,
                        mutation.command_id,
                        SequenceExpectation::Exact(expected_sequence),
                        selection,
                    )
                    .map_err(core_error)?;
                result(&SessionRequestResult::AdvisorConfigured(
                    ash_app_server_protocol::protocol::session::AdvisorConfigureResult { sequence },
                ))
            }
            SessionRequest::ConsultAdvisor {
                thread_id,
                expected_sequence,
                question,
            } => {
                if question.trim().is_empty() || question.len() > 8000 {
                    return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
                }
                result(&SessionRequestResult::Turn(self.start_agent_turn_request(
                    thread_mutation(mutation, expected_sequence, connection.connection_id),
                    thread_id,
                    ash_protocol::ApprovalMode::default(),
                    ash_protocol::CollaborationMode::Ask,
                    TurnToolModeSelection::Explicit(ash_protocol::ToolMode::Direct),
                    vec![UserInput::Text { text: question }],
                    ash_protocol::TurnKind::Advisor,
                    TurnInstructionSelection::Agent,
                    TurnModelSelection::Current,
                    None,
                )?))
            }
            SessionRequest::CompactContext {
                thread_id,
                expected_sequence,
                retention_prompt,
            } => result(&SessionRequestResult::Turn(
                self.start_context_compaction_request(
                    thread_mutation(mutation, expected_sequence, connection.connection_id),
                    thread_id,
                    retention_prompt,
                )?,
            )),
            SessionRequest::SteerTurn {
                thread_id,
                expected_sequence,
                turn_id,
                input,
            } => result(&SessionRequestResult::TurnSteer(self.steer_turn_request(
                thread_mutation(mutation, expected_sequence, connection.connection_id),
                thread_id,
                turn_id,
                input,
            )?)),
            SessionRequest::InterruptTurn {
                thread_id,
                expected_sequence,
                turn_id,
            } => result(&SessionRequestResult::TurnInterrupt(
                self.interrupt_turn_request(
                    thread_mutation(mutation, expected_sequence, connection.connection_id),
                    thread_id,
                    turn_id,
                )?,
            )),
            SessionRequest::ResolveInteraction {
                thread_id,
                expected_sequence,
                turn_id,
                request_id,
                response,
            } => result(&SessionRequestResult::Interaction(
                self.resolve_turn_interaction_request(
                    connection.connection_id,
                    thread_mutation(mutation, expected_sequence, connection.connection_id),
                    thread_id,
                    turn_id,
                    request_id,
                    response,
                )?,
            )),
        }
    }

    fn create_session_thread_request(
        &self,
        connection_id: u64,
        mutation: SessionMutation,
        agent_id: Option<ash_protocol::AgentId>,
        title: String,
    ) -> Result<SessionThreadResult, RpcError> {
        let created = self
            .agent_runtime()
            .create_branch(CreateBranchRequest {
                agent_id,
                command_id: mutation.command_id,
                session_id: mutation.session_id.clone(),
                title,
            })
            .map_err(core_error)?;
        self.updates.subscribe_session_thread(
            connection_id,
            mutation.session_id.clone(),
            created.thread_id.clone(),
            0,
        );
        self.notify_thread_updates(&created.thread_id, 0)?;
        self.updates.publish_session_changed(&mutation.session_id);
        Ok(SessionThreadResult {
            session: self.session_view(&mutation.session_id)?,
            thread_id: created.thread_id,
        })
    }

    fn replace_session_thread_request(
        &self,
        connection_id: u64,
        mutation: SessionMutation,
        source_thread_id: ash_protocol::ThreadId,
        title: String,
    ) -> Result<SessionThreadResult, RpcError> {
        self.read_session_thread_snapshot(&mutation.session_id, &source_thread_id)?;
        let replaced = self
            .agent_runtime()
            .replace_thread(core_api::ReplaceThreadRequest {
                command_id: mutation.command_id,
                source_thread_id,
                title,
            })
            .map_err(core_error)?;
        self.updates.subscribe_session_thread(
            connection_id,
            mutation.session_id.clone(),
            replaced.thread_id.clone(),
            0,
        );
        self.notify_thread_updates(&replaced.thread_id, 0)?;
        self.updates.publish_session_changed(&mutation.session_id);
        Ok(SessionThreadResult {
            session: self.session_view(&mutation.session_id)?,
            thread_id: replaced.thread_id,
        })
    }

    pub(super) fn message_checkpoints(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ash_app_server_protocol::protocol::session::MessageCheckpointsParams =
            decode(params)?;
        self.read_session_thread_snapshot(&params.session_id, &params.thread_id)?;
        result(
            &ash_app_server_protocol::protocol::session::MessageCheckpointsResult {
                checkpoints: self
                    .agent_runtime()
                    .message_checkpoints(&params.thread_id)
                    .map_err(core_error)?,
            },
        )
    }

    fn restore_message_request(
        &self,
        connection_id: u64,
        mutation: SessionMutation,
        thread_id: ash_protocol::ThreadId,
        item_id: ash_protocol::ItemId,
        boundary: ash_protocol::MessageBoundary,
        title: String,
    ) -> Result<SessionThreadResult, RpcError> {
        self.read_session_thread_snapshot(&mutation.session_id, &thread_id)?;
        let restored = self
            .agent_runtime()
            .restore_message(core_api::RestoreMessageRequest {
                command_id: mutation.command_id.clone(),
                source_thread_id: thread_id.clone(),
                item_id,
                boundary,
                title,
            })
            .map_err(core_error)?;
        self.updates.subscribe_session_thread(
            connection_id,
            mutation.session_id.clone(),
            restored.thread_id.clone(),
            0,
        );
        self.notify_thread_updates(&restored.thread_id, 0)?;
        self.updates.publish_session_changed(&mutation.session_id);
        Ok(SessionThreadResult {
            session: self.session_view(&mutation.session_id)?,
            thread_id: restored.thread_id,
        })
    }

    fn fork_session_thread_request(
        &self,
        connection_id: u64,
        mutation: SessionMutation,
        parent_thread_id: ash_protocol::ThreadId,
        title: String,
    ) -> Result<SessionThreadResult, RpcError> {
        self.read_session_thread_snapshot(&mutation.session_id, &parent_thread_id)?;
        let forked = self
            .agent_runtime()
            .fork_thread(ForkThreadRequest {
                command_id: mutation.command_id,
                source_thread_id: parent_thread_id,
                title,
            })
            .map_err(core_error)?;
        self.updates.subscribe_session_thread(
            connection_id,
            mutation.session_id.clone(),
            forked.thread_id.clone(),
            0,
        );
        self.notify_thread_updates(&forked.thread_id, 0)?;
        self.updates.publish_session_changed(&mutation.session_id);
        Ok(SessionThreadResult {
            session: self.session_view(&mutation.session_id)?,
            thread_id: forked.thread_id,
        })
    }

    fn rewind_session_thread_request(
        &self,
        connection_id: u64,
        mutation: SessionMutation,
        parent_thread_id: ash_protocol::ThreadId,
        before_turn_id: ash_protocol::TurnId,
        title: String,
    ) -> Result<SessionThreadResult, RpcError> {
        self.read_session_thread_snapshot(&mutation.session_id, &parent_thread_id)?;
        let rewound = self
            .agent_runtime()
            .rewind_thread(RewindThreadRequest {
                command_id: mutation.command_id,
                source_thread_id: parent_thread_id,
                before_turn_id,
                title,
            })
            .map_err(core_error)?;
        self.updates.subscribe_session_thread(
            connection_id,
            mutation.session_id.clone(),
            rewound.thread_id.clone(),
            0,
        );
        self.notify_thread_updates(&rewound.thread_id, 0)?;
        self.updates.publish_session_changed(&mutation.session_id);
        Ok(SessionThreadResult {
            session: self.session_view(&mutation.session_id)?,
            thread_id: rewound.thread_id,
        })
    }

    fn rewrite_session_thread_request(
        &self,
        connection_id: u64,
        mutation: SessionMutation,
        rewrite: RewriteSessionMutation,
    ) -> Result<SessionRewriteResult, RpcError> {
        let source = self.read_session_thread(&mutation.session_id, &rewrite.parent_thread_id)?;
        let mode = source
            .turns
            .iter()
            .find(|turn| turn.turn_id == rewrite.before_turn_id)
            .ok_or_else(|| {
                core_error(core_api::CoreError::NotFound(
                    rewrite.before_turn_id.to_string(),
                ))
            })?
            .mode;
        let mut normalized_input =
            self.normalize_input(&mutation.session_id, rewrite.input.clone())?;
        self.turn_instruction_selection(&mut normalized_input, mode)?;
        let rewound = self
            .agent_runtime()
            .rewind_thread(RewindThreadRequest {
                command_id: rewrite_phase_command_id(&mutation.command_id, RewritePhase::Rewind)?,
                source_thread_id: rewrite.parent_thread_id,
                before_turn_id: rewrite.before_turn_id,
                title: rewrite.title,
            })
            .map_err(core_error)?;
        let thread_id = rewound.thread_id;
        let thread_before = self
            .agent_runtime()
            .read_thread(&thread_id)
            .map_err(core_error)?;
        let start_command_id = rewrite_phase_command_id(&mutation.command_id, RewritePhase::Start)?;
        let turn = match self
            .agent_runtime()
            .replay_turn(
                &thread_id,
                &start_command_id,
                core_api::SubmittedCommand::Input {
                    input: &normalized_input,
                },
            )
            .map_err(core_error)?
        {
            Some(replayed) => turn_start_result(replayed),
            None => self.start_turn_request(
                ThreadMutation {
                    connection_id: Some(connection_id),
                    command_id: start_command_id,
                    session_id: mutation.session_id.clone(),
                    expected_sequence: thread_before.sequence,
                },
                thread_id.clone(),
                ash_protocol::ApprovalMode::default(),
                mode,
                TurnModelSelection::Current,
                None,
                rewrite.tool_mode,
                rewrite.input,
            )?,
        };
        self.updates.subscribe_session_thread(
            connection_id,
            mutation.session_id.clone(),
            thread_id.clone(),
            0,
        );
        self.notify_thread_updates(&thread_id, 0)?;
        self.updates.publish_session_changed(&mutation.session_id);
        Ok(SessionRewriteResult {
            session: self.session_view(&mutation.session_id)?,
            thread_id,
            turn,
        })
    }

    pub(super) fn session_thread_read(&self, params: &Value) -> Result<Value, RpcError> {
        let params: SessionThreadReadParams = decode(params)?;
        let include_transient = !matches!(
            params.history.as_ref(),
            Some(ThreadSnapshotHistory::Before { .. })
        );
        let snapshot = self.read_session_thread_snapshot(&params.session_id, &params.thread_id)?;
        let (thread, history) = bounded_thread_snapshot(snapshot.public_thread(), params.history)?;
        let transcript = self
            .updates
            .thread_transcript_snapshot(&thread, include_transient);
        result(&SessionThreadReadResult {
            thread,
            transcript,
            history,
        })
    }

    pub(super) fn thread_goal_get(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ThreadGoalGetParams = decode(params)?;
        let thread = self.read_goal_thread(&params.thread_id)?;
        result(&ThreadGoalGetResponse { goal: thread.goal })
    }

    pub(super) fn thread_goal_set(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ThreadGoalSetParams = decode(params)?;
        self.read_goal_thread(&params.thread_id)?;
        let result_goal = self
            .agent_runtime()
            .set_goal(
                &params.thread_id,
                core_api::SetGoalRequest {
                    objective: params.objective,
                    status: params.status,
                    token_budget: params.token_budget,
                },
            )
            .map_err(core_error)?;
        result(&ThreadGoalSetResponse {
            goal: result_goal.goal,
        })
    }

    pub(super) fn thread_goal_clear(&self, params: &Value) -> Result<Value, RpcError> {
        let params: ThreadGoalClearParams = decode(params)?;
        self.read_goal_thread(&params.thread_id)?;
        let cleared = self
            .agent_runtime()
            .clear_goal(&params.thread_id)
            .map_err(core_error)?;
        result(&ThreadGoalClearResponse { cleared })
    }

    pub(super) fn session_thread_subscribe(
        &self,
        connection: &mut ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: SessionThreadSubscribeParams = decode(params)?;
        let inserted_subscription = self.updates.subscribe_session_thread(
            connection.connection_id,
            params.session_id.clone(),
            params.thread_id.clone(),
            params.after_sequence,
        );
        let result = self.session_thread_subscribe_after_registration(connection, params.clone());
        if result.is_err() && inserted_subscription {
            let lost_dynamic_tools = self.updates.unsubscribe_session_thread(
                connection.connection_id,
                &params.session_id,
                &params.thread_id,
            );
            self.cancel_lost_dynamic_tool_owners(lost_dynamic_tools);
        }
        result
    }

    fn session_thread_subscribe_after_registration(
        &self,
        connection: &mut ConnectionState,
        params: SessionThreadSubscribeParams,
    ) -> Result<Value, RpcError> {
        let bounded_history = params.history.is_some();
        let include_transient = !matches!(
            params.history.as_ref(),
            Some(ThreadSnapshotHistory::Before { .. })
        );
        let snapshot = self.read_session_thread_snapshot(&params.session_id, &params.thread_id)?;
        let (thread, history) = bounded_thread_snapshot(snapshot.public_thread(), params.history)?;
        let transcript = self
            .updates
            .thread_transcript_snapshot(&thread, include_transient);
        let replay_after = if bounded_history {
            params.after_sequence.max(thread.sequence)
        } else {
            params.after_sequence
        };
        let updates = self
            .agent_runtime()
            .thread_updates_after(&params.thread_id, replay_after)
            .map_err(core_error)?;
        self.updates.subscribe_session_thread(
            connection.connection_id,
            params.session_id.clone(),
            params.thread_id.clone(),
            thread.sequence,
        );
        self.offer_pending_interactions(&snapshot);
        result(&SessionThreadSubscribeResult {
            thread,
            transcript,
            updates,
            history,
        })
    }

    pub(super) fn session_thread_unsubscribe(
        &self,
        connection: &mut ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: SessionThreadUnsubscribeParams = decode(params)?;
        let lost_dynamic_tools = self.updates.unsubscribe_session_thread(
            connection.connection_id,
            &params.session_id,
            &params.thread_id,
        );
        self.cancel_lost_dynamic_tool_owners(lost_dynamic_tools);
        Ok(Value::Null)
    }

    pub(super) fn read_session_thread(
        &self,
        session_id: &ash_protocol::SessionId,
        thread_id: &ash_protocol::ThreadId,
    ) -> Result<ash_protocol::Thread, RpcError> {
        self.read_session_thread_snapshot(session_id, thread_id)
            .map(|thread| thread.public_thread())
    }

    pub(super) fn read_session_thread_snapshot(
        &self,
        session_id: &ash_protocol::SessionId,
        thread_id: &ash_protocol::ThreadId,
    ) -> Result<ThreadView, RpcError> {
        let thread = self
            .agent_runtime()
            .read_thread(thread_id)
            .map_err(core_error)?;
        if thread.session_id != *session_id {
            return Err(RpcError::new(
                -32010,
                AppServerErrorName::CoreOperationFailed,
            ));
        }
        Ok(thread)
    }

    fn read_goal_thread(&self, thread_id: &ash_protocol::ThreadId) -> Result<ThreadView, RpcError> {
        let thread = self
            .agent_runtime()
            .read_thread(thread_id)
            .map_err(core_error)?;
        Ok(thread)
    }

    pub(super) fn offer_pending_interactions(&self, thread: &ThreadView) {
        for turn in &thread.turns {
            if let Some(interaction) = &turn.pending_interaction {
                self.updates.offer_agent_request(AgentRequestEnvelope {
                    session_id: thread.session_id.clone(),
                    thread_id: thread.thread_id.clone(),
                    turn_id: turn.turn_id.clone(),
                    interaction: interaction.clone(),
                });
            }
        }
    }

    pub(super) fn start_turn_request(
        &self,
        mutation: ThreadMutation,
        thread_id: ash_protocol::ThreadId,
        approval_mode: ash_protocol::ApprovalMode,
        mode: ash_protocol::CollaborationMode,
        model_selection: TurnModelSelection,
        reasoning_effort: Option<ash_protocol::ReasoningEffort>,
        requested_tool_mode: Option<ash_protocol::ToolMode>,
        input: Vec<InputItem>,
    ) -> Result<TurnStartResult, RpcError> {
        let tool_mode = match requested_tool_mode {
            Some(tool_mode) => TurnToolModeSelection::Explicit(tool_mode),
            None => TurnToolModeSelection::ConfiguredDefault,
        };
        let mut input = self.normalize_input(&mutation.session_id, input)?;
        let selection = self.turn_instruction_selection(&mut input, mode)?;
        self.start_agent_turn_request(
            mutation,
            thread_id,
            approval_mode,
            mode,
            tool_mode,
            input,
            ash_protocol::TurnKind::Coding,
            selection,
            model_selection,
            reasoning_effort,
        )
    }

    pub(super) fn turn_instruction_selection(
        &self,
        input: &mut Vec<UserInput>,
        mode: ash_protocol::CollaborationMode,
    ) -> Result<TurnInstructionSelection, RpcError> {
        if product_command(input) != Some("/init") {
            // Analysis modes inspect workflow requests without starting their write-producing
            // orchestration. The selected approach still reaches the ordinary model Turn.
            if matches!(
                mode,
                ash_protocol::CollaborationMode::Plan | ash_protocol::CollaborationMode::Ask
            ) {
                return Ok(TurnInstructionSelection::Agent);
            }
            let command = input
                .iter()
                .find_map(|item| match item {
                    UserInput::Text { text } => Some(workflows::Command::parse(text)),
                    _ => None,
                })
                .transpose()
                .map_err(core_error)?
                .flatten();
            return Ok(match command {
                Some(command) => TurnInstructionSelection::Workflow(command),
                None => TurnInstructionSelection::Agent,
            });
        }
        if let Some(home) = &self.home {
            let context = UserInput::Context {
                name: "ash-home".into(),
                content: home.root().display().to_string(),
            };
            // Queue acceptance freezes this same expanded input before eventual delivery.
            if !input.contains(&context) {
                input.push(context);
            }
        }
        Ok(TurnInstructionSelection::Setup(init_prompt()))
    }

    fn start_review_request(
        &self,
        mutation: ThreadMutation,
        thread_id: ash_protocol::ThreadId,
        target: ash_protocol::ReviewTarget,
    ) -> Result<TurnStartResult, RpcError> {
        let prompt = ash_prompts::review_target_prompt(&target)
            .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
        let roles = agent_roles::built_in_roles();
        let role = roles.get("reviewer").expect("packaged reviewer role");
        let instructions = ash_protocol::TurnInstructions::new(
            "agent-roles",
            role.name(),
            role.content_digest(),
            role.role_instructions(),
        )
        .expect("validated reviewer instructions");
        self.start_agent_turn_request(
            mutation,
            thread_id,
            ash_protocol::ApprovalMode::default(),
            ash_protocol::CollaborationMode::Agent,
            TurnToolModeSelection::Explicit(ash_protocol::ToolMode::Direct),
            vec![UserInput::Text { text: prompt }],
            ash_protocol::TurnKind::Review,
            TurnInstructionSelection::Product(instructions),
            TurnModelSelection::Current,
            None,
        )
    }

    pub(super) fn start_agent_turn_request(
        &self,
        mutation: ThreadMutation,
        thread_id: ash_protocol::ThreadId,
        approval_mode: ash_protocol::ApprovalMode,
        mode: ash_protocol::CollaborationMode,
        tool_mode_selection: TurnToolModeSelection,
        input: Vec<UserInput>,
        kind: ash_protocol::TurnKind,
        selection: TurnInstructionSelection,
        model_selection: TurnModelSelection,
        reasoning_effort: Option<ash_protocol::ReasoningEffort>,
    ) -> Result<TurnStartResult, RpcError> {
        let thread_before = self
            .agent_runtime()
            .read_thread(&thread_id)
            .map_err(core_error)?;
        if thread_before.session_id != mutation.session_id {
            return Err(RpcError::new(
                -32010,
                AppServerErrorName::CoreOperationFailed,
            ));
        }
        if thread_before.status != ThreadStatus::Active {
            return Err(RpcError::new(
                -32010,
                AppServerErrorName::CoreOperationFailed,
            ));
        }
        let tool_mode = match tool_mode_selection {
            TurnToolModeSelection::Explicit(tool_mode) => tool_mode,
            TurnToolModeSelection::ConfiguredDefault => match self.config.as_ref() {
                Some(config) => {
                    config
                        .read_snapshot()
                        .map_err(|_| RpcError::new(-32030, AppServerErrorName::ConfigUnavailable))?
                        .values
                        .tool_mode
                }
                None => ash_protocol::ToolMode::Direct,
            },
        };
        if !matches!(selection, TurnInstructionSelection::Workflow(_))
            && let Some(replayed) = self
                .agent_runtime()
                .replay_turn(
                    &thread_id,
                    &mutation.command_id,
                    core_api::SubmittedCommand::Turn {
                        kind,
                        tool_mode,
                        mode,
                        input: &input,
                    },
                )
                .map_err(core_error)?
        {
            return Ok(turn_start_result(replayed));
        }
        if kind == ash_protocol::TurnKind::Coding
            && let Some(text) = input.iter().find_map(|item| match item {
                UserInput::Text { text } => Some(text),
                _ => None,
            })
            && let HookEventDecision::Deny { reason } = self.emit_hook_event(&HookEventRequest {
                event: HookEvent::UserPromptSubmit,
                scope: HookEventScope::Session {
                    session_id: mutation.session_id.clone(),
                },
                subject: Some(text.clone()),
                tool_name: None,
            })?
        {
            return Err(core_error(core_api::CoreError::Policy(reason)));
        }
        if !matches!(
            mode,
            ash_protocol::CollaborationMode::Plan | ash_protocol::CollaborationMode::Ask
        ) && matches!(&selection, TurnInstructionSelection::Setup(_))
            && let HookEventDecision::Deny { reason } = self.emit_hook_event(&HookEventRequest {
                event: HookEvent::Setup,
                scope: HookEventScope::Session {
                    session_id: mutation.session_id.clone(),
                },
                subject: None,
                tool_name: None,
            })?
        {
            return Err(core_error(core_api::CoreError::Policy(reason)));
        }
        if matches!(
            &selection,
            TurnInstructionSelection::Workflow(_) | TurnInstructionSelection::Setup(_)
        ) && let HookEventDecision::Deny { reason } =
            self.emit_hook_event(&HookEventRequest {
                event: HookEvent::UserPromptExpansion,
                scope: HookEventScope::Session {
                    session_id: mutation.session_id.clone(),
                },
                subject: input.iter().find_map(|item| match item {
                    UserInput::Text { text } => Some(text.clone()),
                    _ => None,
                }),
                tool_name: None,
            })?
        {
            return Err(core_error(core_api::CoreError::Policy(reason)));
        }
        if tool_mode != ash_protocol::ToolMode::Direct
            && let Some(config) = &self.config
            && !features::Feature::CodeMode.enabled(
                &config
                    .read_snapshot()
                    .map_err(|_| RpcError::new(-32030, AppServerErrorName::ConfigUnavailable))?
                    .values
                    .features,
            )
        {
            return Err(RpcError::new(-32125, AppServerErrorName::FeatureDisabled));
        }
        self.refresh_analytics()?;
        let model = match model_selection {
            TurnModelSelection::Explicit(model) => Some(model),
            TurnModelSelection::Current => match thread_before
                .agent_configuration()
                .and_then(|agent| agent.model())
            {
                Some(model) => Some(model.clone()),
                None => self
                    .model_catalog
                    .configured_default()
                    .map_err(core_error)?,
            },
        };
        let base = thread_before
            .agent_configuration()
            .and_then(|agent| agent.base_instructions.clone())
            .unwrap_or_else(|| ash_prompts::AGENT_INSTRUCTIONS.freeze());
        let base = if base
            .model_guidance()
            .is_some_and(|guidance| guidance.model() == model.as_ref())
        {
            base
        } else {
            self.model_instructions.for_turn(base, model.as_ref())
        };
        let guidance = base
            .model_guidance()
            .cloned()
            .expect("Agent base records its model selection");
        let (workflow, instructions) = match selection {
            TurnInstructionSelection::Agent => (None, base),
            TurnInstructionSelection::Product(prompt) => (None, prompt.with_shared(&base)),
            TurnInstructionSelection::Setup(prompt) => (None, prompt.with_shared(&base)),
            TurnInstructionSelection::Workflow(command) => (Some(command), base),
        };
        let instructions = instructions
            .with_mode(&collaboration_mode_templates::instructions(mode))
            .with_model_guidance(guidance);
        let advisor_default = self
            .config
            .as_ref()
            .map(|config| config.read_snapshot())
            .transpose()
            .map_err(|_| RpcError::new(-32030, AppServerErrorName::ConfigUnavailable))?
            .and_then(|snapshot| snapshot.values.advisor);
        let advisor = if advisor_default
            .as_ref()
            .is_some_and(|config| !config.enabled)
        {
            None
        } else if kind == ash_protocol::TurnKind::Advisor {
            advisor_default.clone()
        } else {
            thread_before.advisor.resolve(advisor_default.as_ref())
        };
        if kind == ash_protocol::TurnKind::Advisor && advisor.is_none() {
            return Err(RpcError::new(-32602, AppServerErrorName::AdvisorDisabled));
        }
        let activated_skills = thread_before
            .agent_configuration()
            .map(|agent| agent.capability_scope.skills.clone())
            .unwrap_or_default();
        let _env_runtime = self
            .env_runtime_gate
            .lock()
            .map_err(|_| RpcError::new(-32000, AppServerErrorName::ServerOverloaded))?;
        let is_workflow = workflow.is_some();
        let mut workflow_child = None;
        let document_mode = if self
            .git_turn_changes
            .as_ref()
            .and_then(|runtime| runtime.binding(&thread_id))
            .is_some_and(|binding| binding.checkout_root() != binding.source_repository_root())
        {
            crate::client_host::TextDocumentMode::FileSystem
        } else {
            crate::client_host::TextDocumentMode::Client
        };
        let request = core_api::SubmitTurnRequest {
            context_policy: self
                .config
                .as_ref()
                .map(|config| config.read_snapshot())
                .transpose()
                .map_err(|_| RpcError::new(-32030, AppServerErrorName::ConfigUnavailable))?
                .map(|snapshot| snapshot.values.context)
                .unwrap_or_default(),
            mode,
            command_id: mutation.command_id,
            expected_sequence: SequenceExpectation::Exact(mutation.expected_sequence),
            model,
            reasoning_effort,
            advisor,
            kind,
            instructions,
            approval_mode,
            tool_mode,
            activated_skills,
            input,
        };
        let receipt = if let Some(command) = workflow {
            let result = self
                .submit_workflow(
                    &thread_id,
                    command,
                    request,
                    mutation.connection_id,
                    document_mode,
                )
                .map_err(core_error)?;
            workflow_child = result.child;
            core_api::TurnReceipt {
                turn_id: result.turn_id,
                sequence: result.sequence,
            }
        } else {
            self.agent_runtime()
                .submit_turn_with_admission(&thread_id, request, |thread, request| {
                    self.admit_bound_turn(thread, request, mutation.connection_id, document_mode)
                })
                .map_err(core_error)?
        };
        if is_workflow {
            self.notify_thread_updates(&thread_id, thread_before.sequence)?;
            if let Some(child) = workflow_child {
                self.notify_thread_updates(&child, 0)?;
            }
        }
        Ok(turn_start_result(receipt))
    }

    fn start_shell_turn_request(
        &self,
        mutation: ThreadMutation,
        thread_id: ash_protocol::ThreadId,
        approval_mode: ash_protocol::ApprovalMode,
        command: String,
        working_directory: String,
    ) -> Result<TurnStartResult, RpcError> {
        let thread_before = self.read_session_thread(&mutation.session_id, &thread_id)?;
        if thread_before.status != ThreadStatus::Active {
            return Err(RpcError::new(
                -32010,
                AppServerErrorName::CoreOperationFailed,
            ));
        }
        let (program, arguments) = self.terminal_service()?.default_shell_command(&command);
        let receipt = self
            .agent_runtime()
            .submit_shell(
                &thread_id,
                core_api::SubmitShellRequest {
                    command_id: mutation.command_id,
                    expected_sequence: SequenceExpectation::Exact(mutation.expected_sequence),
                    approval_mode,
                    invocation: ShellTurnInvocation {
                        command,
                        program,
                        arguments,
                        working_directory,
                    },
                },
            )
            .map_err(core_error)?;
        Ok(turn_start_result(receipt))
    }

    fn start_context_compaction_request(
        &self,
        mutation: ThreadMutation,
        thread_id: ash_protocol::ThreadId,
        retention_prompt: Option<String>,
    ) -> Result<TurnStartResult, RpcError> {
        let thread = self.read_session_thread(&mutation.session_id, &thread_id)?;
        if thread.status != ThreadStatus::Active {
            return Err(RpcError::new(
                -32010,
                AppServerErrorName::CoreOperationFailed,
            ));
        }
        let model = self
            .model_catalog
            .configured_default()
            .map_err(core_error)?;
        let receipt = self
            .agent_runtime()
            .compact_thread(
                &thread_id,
                core_api::CompactThreadRequest {
                    command_id: mutation.command_id,
                    expected_sequence: SequenceExpectation::Exact(mutation.expected_sequence),
                    model,
                    retention_prompt,
                },
            )
            .map_err(core_error)?;
        Ok(turn_start_result(receipt))
    }

    pub(super) fn interrupt_turn_request(
        &self,
        mutation: ThreadMutation,
        thread_id: ash_protocol::ThreadId,
        turn_id: ash_protocol::TurnId,
    ) -> Result<TurnInterruptResult, RpcError> {
        self.read_session_thread(&mutation.session_id, &thread_id)?;
        let sequence = self
            .agent_runtime()
            .interrupt_turn(
                &thread_id,
                InterruptTurnRequest {
                    command_id: mutation.command_id,
                    expected_sequence: SequenceExpectation::Exact(mutation.expected_sequence),
                    turn_id,
                },
            )
            .map_err(core_error)?;
        Ok(TurnInterruptResult { sequence })
    }

    fn steer_turn_request(
        &self,
        mutation: ThreadMutation,
        thread_id: ash_protocol::ThreadId,
        turn_id: ash_protocol::TurnId,
        input: Vec<InputItem>,
    ) -> Result<TurnSteerResult, RpcError> {
        let thread = self.read_session_thread(&mutation.session_id, &thread_id)?;
        let turn = thread
            .turns
            .iter()
            .find(|turn| turn.turn_id == turn_id)
            .ok_or_else(|| RpcError::new(-32011, AppServerErrorName::CoreOperationFailed))?;
        let subscription = turn
            .model
            .as_ref()
            .map(|model| {
                self.model_catalog
                    .current_access(model)
                    .map(|access| access == ModelAccess::Subscription)
            })
            .transpose()
            .map_err(core_error)?
            .unwrap_or(false);
        if subscription
            && input.iter().any(|item| {
                !matches!(
                    item,
                    InputItem::Text { .. }
                        | InputItem::Context { .. }
                        | InputItem::Issue { .. }
                        | InputItem::ToolSelection { .. }
                )
            })
        {
            return Err(RpcError::new(
                -32010,
                AppServerErrorName::CoreOperationFailed,
            ));
        }
        let input = self.normalize_input(&mutation.session_id, input)?;
        let receipt = self
            .agent_runtime()
            .steer_turn(
                &thread_id,
                SteerTurnRequest {
                    command_id: mutation.command_id,
                    expected_sequence: SequenceExpectation::Exact(mutation.expected_sequence),
                    turn_id,
                    input,
                },
            )
            .map_err(core_error)?;
        Ok(TurnSteerResult {
            turn_id: receipt.turn_id,
            sequence: receipt.sequence,
        })
    }

    fn resolve_turn_interaction_request(
        &self,
        connection_id: u64,
        mutation: ThreadMutation,
        thread_id: ash_protocol::ThreadId,
        turn_id: ash_protocol::TurnId,
        request_id: ash_protocol::RequestId,
        response: ash_protocol::AgentResponse,
    ) -> Result<TurnInteractionResolveResult, RpcError> {
        if !self
            .updates
            .is_agent_interaction_owner(connection_id, &request_id)
        {
            return Err(RpcError::new(
                -32030,
                AppServerErrorName::AgentInteractionNotOwner,
            ));
        }
        let _env_runtime = self
            .env_runtime_gate
            .lock()
            .map_err(|_| RpcError::new(-32000, AppServerErrorName::ServerOverloaded))?;
        if self
            .updates
            .is_agent_interaction_expired(&request_id, super::update_broker::unix_time_millis())
        {
            return Err(RpcError::new(
                -32031,
                AppServerErrorName::AgentInteractionExpired,
            ));
        }
        let before = self
            .agent_runtime()
            .read_thread(&thread_id)
            .map_err(core_error)?;
        if before.session_id != mutation.session_id {
            return Err(RpcError::new(
                -32010,
                AppServerErrorName::CoreOperationFailed,
            ));
        }
        let sequence = self
            .agent_runtime()
            .resolve_interaction(
                &thread_id,
                ResolveTurnInteractionRequest {
                    command_id: mutation.command_id,
                    expected_sequence: SequenceExpectation::Exact(mutation.expected_sequence),
                    turn_id,
                    request_id,
                    response,
                },
            )
            .map_err(core_error)?;
        Ok(TurnInteractionResolveResult { sequence })
    }

    pub(super) fn resource_metadata(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ResourceMetadataParams = decode(params)?;
        let metadata = self
            .resources
            .lock()
            .map_err(|_| RpcError::new(-32000, AppServerErrorName::ServerOverloaded))?
            .metadata(connection.connection_id, &params.resource_id)
            .map_err(resource_rpc_error)?;
        result(&ResourceMetadataResult {
            resource_id: metadata.resource_id,
            mime_type: metadata.mime_type,
            size: metadata.size,
            sha256: metadata.sha256,
        })
    }

    pub(super) fn typst_compile(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: TypstCompileParams = decode(params)?;
        let outcome = self
            .typst
            .compile(&params.source)
            .map_err(|error| match error {
                TypstCompileError::SourceTooLarge { .. } => {
                    RpcError::new(-32602, AppServerErrorName::InvalidParams)
                }
            })?;
        match outcome {
            TypstCompileOutcome::Success(success) => {
                let metadata = self
                    .resources
                    .lock()
                    .map_err(|_| RpcError::new(-32000, AppServerErrorName::ServerOverloaded))?
                    .create(
                        connection.connection_id,
                        "application/pdf".into(),
                        success.pdf,
                        Duration::from_secs(300),
                    )
                    .map_err(resource_rpc_error)?;
                result(&TypstCompileResult::Success {
                    resource: ResourceMetadataResult {
                        resource_id: metadata.resource_id,
                        mime_type: metadata.mime_type,
                        size: metadata.size,
                        sha256: metadata.sha256,
                    },
                    warnings: success
                        .warnings
                        .into_iter()
                        .map(typst_diagnostic_dto)
                        .collect(),
                })
            }
            TypstCompileOutcome::Failed { diagnostics } => result(&TypstCompileResult::Failed {
                diagnostics: diagnostics.into_iter().map(typst_diagnostic_dto).collect(),
            }),
        }
    }

    pub(super) fn resource_read(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ResourceReadParams = decode(params)?;
        let resource_id = params.resource_id.clone();
        let chunk = self
            .resources
            .lock()
            .map_err(|_| RpcError::new(-32000, AppServerErrorName::ServerOverloaded))?
            .read(
                connection.connection_id,
                &params.resource_id,
                params.offset,
                params.max_bytes,
            )
            .map_err(resource_rpc_error)?;
        result(&ResourceReadResult {
            resource_id,
            offset: chunk.offset,
            data_base64: base64::engine::general_purpose::STANDARD.encode(&chunk.data),
            decoded_length: chunk.data.len(),
            eof: chunk.eof,
        })
    }

    pub(super) fn resource_release(
        &self,
        connection: &ConnectionState,
        params: &Value,
    ) -> Result<Value, RpcError> {
        let params: ResourceReleaseParams = decode(params)?;
        self.resources
            .lock()
            .map_err(|_| RpcError::new(-32000, AppServerErrorName::ServerOverloaded))?
            .release(connection.connection_id, &params.resource_id)
            .map_err(resource_rpc_error)?;
        Ok(Value::Null)
    }

    pub(super) fn session_view(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<Session, RpcError> {
        self.session_result(session_id).map(|result| result.session)
    }

    pub(super) fn session_result(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<ash_app_server_protocol::protocol::session::SessionResult, RpcError> {
        let view = self
            .agent_runtime()
            .read_session(session_id)
            .map_err(core_error)?;
        // Core writes root facts and branch management into one durable catalog. Detailed
        // reads share that source instead of maintaining a second status classifier here.
        let session = self
            .agent_runtime()
            .read_session_catalog(session_id)
            .map_err(core_error)?
            .ok_or_else(|| core_error(core_api::CoreError::NotFound(session_id.to_string())))?;
        let agent_tree = view.agent_tree;
        Ok(ash_app_server_protocol::protocol::session::SessionResult {
            session,
            agent_tree,
        })
    }

    pub(super) fn session_views(&self) -> Result<Vec<Session>, RpcError> {
        self.agent_runtime().list_sessions().map_err(core_error)
    }

    pub(super) fn session_catalog_view(
        &self,
        session_id: &ash_protocol::SessionId,
    ) -> Result<Option<Session>, RpcError> {
        self.agent_runtime()
            .read_session_catalog(session_id)
            .map_err(core_error)
    }

    pub(super) fn notify_thread_updates(
        &self,
        thread_id: &ash_protocol::ThreadId,
        after_sequence: u64,
    ) -> Result<(), RpcError> {
        let updates = self
            .agent_runtime()
            .thread_updates_after(thread_id, after_sequence)
            .map_err(core_error)?;
        self.updates.publish_thread(thread_id, &updates);
        Ok(())
    }
}

pub(super) fn provider_models_failure_code(
    error: crate::model_catalog::ModelCatalogRefreshError,
) -> ProviderModelsListFailureCodeDto {
    use crate::model_catalog::ModelCatalogRefreshError;
    match error {
        ModelCatalogRefreshError::Authentication => {
            ProviderModelsListFailureCodeDto::Authentication
        }
        ModelCatalogRefreshError::Permission => ProviderModelsListFailureCodeDto::Permission,
        ModelCatalogRefreshError::Unsupported => ProviderModelsListFailureCodeDto::Unsupported,
        ModelCatalogRefreshError::RateLimited => ProviderModelsListFailureCodeDto::RateLimited,
        ModelCatalogRefreshError::Unreachable => ProviderModelsListFailureCodeDto::Unreachable,
        ModelCatalogRefreshError::ProviderUnavailable => {
            ProviderModelsListFailureCodeDto::ProviderUnavailable
        }
        ModelCatalogRefreshError::InvalidRequest => {
            ProviderModelsListFailureCodeDto::InvalidRequest
        }
        ModelCatalogRefreshError::InvalidResponse => {
            ProviderModelsListFailureCodeDto::InvalidResponse
        }
        ModelCatalogRefreshError::InvalidConfiguration => {
            ProviderModelsListFailureCodeDto::InvalidConfiguration
        }
        ModelCatalogRefreshError::Cancelled => ProviderModelsListFailureCodeDto::Cancelled,
        ModelCatalogRefreshError::Unknown => ProviderModelsListFailureCodeDto::Unknown,
    }
}

fn thread_mutation(
    mutation: SessionMutation,
    expected_sequence: u64,
    connection_id: u64,
) -> ThreadMutation {
    ThreadMutation {
        connection_id: Some(connection_id),
        command_id: mutation.command_id,
        session_id: mutation.session_id,
        expected_sequence,
    }
}

impl AppServer {
    pub(super) fn normalize_input(
        &self,
        session_id: &ash_protocol::SessionId,
        input: Vec<InputItem>,
    ) -> Result<Vec<UserInput>, RpcError> {
        if input
            .iter()
            .filter(|item| matches!(item, InputItem::ToolSelection { .. }))
            .count()
            > 1
        {
            return Err(core_error(core_api::CoreError::InvalidInput(
                "Turn input may contain only one tool selection".into(),
            )));
        }
        input
            .into_iter()
            .map(|item| {
                Ok(match item {
                    InputItem::Issue { number } => {
                        if number == 0 {
                            return Err(core_error(core_api::CoreError::InvalidInput(
                                "Issue number must be positive".into(),
                            )));
                        }
                        UserInput::Context {
                            name: "issue".into(),
                            content: format!("[issue #{number}]"),
                        }
                    }
                    InputItem::Text { text } => UserInput::Text { text },
                    InputItem::Context { name, content } => UserInput::Context { name, content },
                    InputItem::ToolSelection { disabled } => {
                        if disabled.len() > 4096
                            || disabled
                                .iter()
                                .collect::<std::collections::BTreeSet<_>>()
                                .len()
                                != disabled.len()
                        {
                            return Err(core_error(core_api::CoreError::InvalidInput(
                                "Tool selection must contain at most 4096 unique tool names".into(),
                            )));
                        }
                        UserInput::ToolSelection { disabled }
                    }
                    InputItem::AudioAttachment { attachment } => {
                        UserInput::AudioAttachment { attachment }
                    }
                    InputItem::Audio { url } => UserInput::Audio { url },
                    InputItem::ImageAttachment { attachment } => {
                        UserInput::ImageAttachment { attachment }
                    }
                    InputItem::Image { url } => UserInput::Image { url },
                    InputItem::Instruction { path } => {
                        self.attach_instruction(session_id, &path)?
                    }
                    InputItem::Skill { skill } => UserInput::Skill { skill },
                })
            })
            .collect()
    }
}

fn rewrite_phase_command_id(
    operation_id: &ash_protocol::CommandId,
    phase: RewritePhase,
) -> Result<ash_protocol::CommandId, RpcError> {
    ash_protocol::CommandId::new(format!(
        "session-rewrite/{}/{}",
        phase.as_str(),
        operation_id.as_str()
    ))
    .map_err(|_| RpcError::new(-32602, AppServerErrorName::InvalidParams))
}

fn bounded_thread_snapshot(
    mut thread: ash_protocol::Thread,
    history: Option<ThreadSnapshotHistory>,
) -> Result<(ash_protocol::Thread, Option<ThreadHistoryBoundary>), RpcError> {
    let Some(history) = history else {
        return Ok((thread, None));
    };
    let (start, end, turn_limit) = match history {
        ThreadSnapshotHistory::Latest { turn_limit } => {
            let retained = usize::try_from(turn_limit).unwrap_or(usize::MAX);
            (
                thread.turns.len().saturating_sub(retained),
                thread.turns.len(),
                turn_limit,
            )
        }
        ThreadSnapshotHistory::Before {
            turn_id,
            turn_limit,
        } => {
            let end = thread
                .turns
                .iter()
                .position(|turn| turn.turn_id == turn_id)
                .ok_or_else(|| RpcError::new(-32602, AppServerErrorName::InvalidParams))?;
            let retained = usize::try_from(turn_limit).unwrap_or(usize::MAX);
            (end.saturating_sub(retained), end, turn_limit)
        }
    };
    if turn_limit == 0 || turn_limit > MAX_THREAD_SNAPSHOT_TURNS {
        return Err(RpcError::new(-32602, AppServerErrorName::InvalidParams));
    }
    let has_older_turns = start > 0;
    thread.turns = thread.turns[start..end].to_vec();
    let oldest_turn_id = thread.turns.first().map(|turn| turn.turn_id.clone());
    Ok((
        thread,
        Some(ThreadHistoryBoundary {
            has_older_turns,
            oldest_turn_id,
        }),
    ))
}

pub(super) fn resource_rpc_error(error: crate::resource_store::ResourceError) -> RpcError {
    use crate::resource_store::ResourceError;
    RpcError::new(
        -32020,
        match error {
            ResourceError::NotFound => AppServerErrorName::ResourceNotFound,
            ResourceError::NotOwner => AppServerErrorName::ResourceNotOwner,
            ResourceError::TooLarge => AppServerErrorName::ResourceTooLarge,
            ResourceError::InvalidChunkSize => AppServerErrorName::InvalidResourceChunkSize,
            ResourceError::InvalidOffset => AppServerErrorName::InvalidResourceOffset,
        },
    )
}

fn typst_diagnostic_dto(diagnostic: TypstDiagnostic) -> TypstDiagnosticDto {
    TypstDiagnosticDto {
        severity: match diagnostic.severity {
            TypstDiagnosticSeverity::Error => TypstDiagnosticSeverityDto::Error,
            TypstDiagnosticSeverity::Warning => TypstDiagnosticSeverityDto::Warning,
        },
        message: diagnostic.message,
        hints: diagnostic.hints,
        range: diagnostic.range.map(|range| TypstSourceRangeDto {
            start: range.start,
            end: range.end,
        }),
    }
}

fn turn_start_result(receipt: core_api::TurnReceipt) -> TurnStartResult {
    TurnStartResult {
        turn_id: receipt.turn_id,
        sequence: receipt.sequence,
    }
}

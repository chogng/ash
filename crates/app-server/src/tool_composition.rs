use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::RwLock;

use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ExecutionDecision;
use ash_action_policy::GrantId;
use ash_action_policy::ResolvedAction;
use ash_action_policy::SandboxCompatibility;
use ash_action_policy::ToolCallScope;
use ash_app_server_protocol::protocol::agent::AgentToolCapabilityDto;
use ash_app_server_protocol::protocol::agent::ToolAuthorityDto;
use ash_app_server_protocol::protocol::agent::ToolExposureDto;
use ash_app_server_protocol::protocol::agent::ToolSourceDto;
use ash_async_utils::CancellationToken;
use ash_config::ToolSearchModeConfig;
use ash_core::ModelToolCatalogSnapshot;
use ash_core::ToolActivationResult;
use ash_core::ToolAuthorization;
use ash_core::ToolExecutionFacts;
use ash_core::ToolOutputSink;
use ash_core::ToolService;
use ash_mcp_extension::McpToolComposition;
use ash_model_provider::EmbeddingInvoker;
use ash_model_provider::EmbeddingRequest;
use ash_model_provider::ModelProviderError;
use ash_protocol::ActionDigest;
use ash_protocol::ActionKind;
use ash_protocol::ActionPolicyRevision;
use ash_protocol::ActionProvenance;
use ash_protocol::ActionSource;
use ash_protocol::CapabilitySet;
use ash_protocol::ContentDigest;
use ash_protocol::ReviewEvidence;
use ash_protocol::ThreadId;
use ash_protocol::ToolActivity;
use ash_protocol::ToolCall;
use ash_protocol::ToolCallBinding;
use ash_protocol::ToolCallCaller;
use ash_protocol::ToolCallId;
use ash_protocol::ToolDefinition as ProtocolToolDefinition;
use ash_protocol::ToolExecutionOutput;
use ash_protocol::ToolName;
use ash_protocol::ToolSourceProvenance;
use ash_protocol::TurnId;
use ash_tools::ProtocolToolAdapterError;
use ash_tools::TOOL_SEARCH_TOOL_NAME;
use ash_tools::ToolBinding;
use ash_tools::ToolDefinition;
use ash_tools::ToolExposure;
use ash_tools::ToolInvocationKind;
use ash_tools::ToolLoading;
use ash_tools::ToolRegistryBuilder;
use ash_tools::ToolRegistryGeneration;
use ash_tools::ToolRegistryRegistration;
use ash_tools::ToolRegistrySnapshot;
use ash_tools::ToolRuntimeKey;
use ash_tools::ToolSearchLimit;
use ash_tools::ToolSearchMetadata;
use ash_tools::ToolSearchQuery;
use ash_tools::ToolSearchQuerySyntax;
use ash_tools::from_protocol_tool_definition;
use ash_tools::to_protocol_tool_definition;
use core_api::ActionPolicyService;
use core_api::AgentToolCatalog;
use core_api::CoreError;

use crate::tool_executor_adapter::ToolExecutorReviewer;
use crate::tool_executor_adapter::ToolExecutorRuntime;
use crate::tool_search_embedding::ToolSearchEmbeddingRuntime;

mod mcp_exposure;

use mcp_exposure::MCP_CALL_TOOL_NAME;
use mcp_exposure::MCP_SEARCH_TOOLS_NAME;
use mcp_exposure::McpMetaToolService;
use mcp_exposure::decide_mcp_catalog_search;
use mcp_exposure::should_defer_mcp_catalog;

const TOOL_SEARCH_EMBEDDING_PROBE_TEXT: &str = "ash tool search embedding readiness probe";
const TOOL_SEARCH_POLICY_REVISION: &str = "tool-search-v1";

#[derive(Clone)]
pub(crate) struct ToolSearchOptions {
    state: ToolSearchOptionState,
}

#[derive(Clone)]
enum ToolSearchOptionState {
    Lexical {
        embedding_candidate: Option<Arc<dyn EmbeddingInvoker>>,
    },
    Hybrid {
        embedding: Arc<dyn EmbeddingInvoker>,
    },
    Unavailable {
        reason: Arc<str>,
    },
}

impl ToolSearchOptions {
    pub(crate) fn new() -> Self {
        Self {
            state: ToolSearchOptionState::Lexical {
                embedding_candidate: None,
            },
        }
    }

    #[cfg(test)]
    pub(crate) fn mode(&self) -> ToolSearchModeConfig {
        match self.state {
            ToolSearchOptionState::Lexical { .. } => ToolSearchModeConfig::Lexical,
            ToolSearchOptionState::Hybrid { .. } | ToolSearchOptionState::Unavailable { .. } => {
                ToolSearchModeConfig::HybridEmbedding
            }
        }
    }

    pub(crate) fn unavailable(reason: impl Into<String>) -> Self {
        Self {
            state: ToolSearchOptionState::Unavailable {
                reason: Arc::from(reason.into()),
            },
        }
    }

    pub(crate) fn with_embedding(
        mut self,
        embedding: Arc<dyn EmbeddingInvoker>,
    ) -> Result<Self, ToolCompositionError> {
        match &mut self.state {
            ToolSearchOptionState::Lexical {
                embedding_candidate,
            } => *embedding_candidate = Some(embedding),
            ToolSearchOptionState::Hybrid { .. } | ToolSearchOptionState::Unavailable { .. } => {
                return Err(ToolCompositionError(
                    "tool-search embedding adapter must be installed before hybrid mode is enabled"
                        .into(),
                ));
            }
        }
        Ok(self)
    }

    pub(crate) fn with_mode(
        self,
        mode: ToolSearchModeConfig,
    ) -> Result<Self, ToolCompositionError> {
        match (self.state, mode) {
            (state @ ToolSearchOptionState::Lexical { .. }, ToolSearchModeConfig::Lexical)
            | (
                state @ ToolSearchOptionState::Hybrid { .. },
                ToolSearchModeConfig::HybridEmbedding,
            )
            | (
                state @ ToolSearchOptionState::Unavailable { .. },
                ToolSearchModeConfig::HybridEmbedding,
            ) => Ok(Self { state }),
            (
                ToolSearchOptionState::Lexical {
                    embedding_candidate,
                },
                ToolSearchModeConfig::HybridEmbedding,
            ) => {
                let embedding = embedding_candidate.ok_or_else(|| {
                    ToolCompositionError(
                        "hybrid embedding tool search requires an installed embedding adapter"
                            .into(),
                    )
                })?;
                Self::probe_embedding(embedding.as_ref())?;
                Ok(Self {
                    state: ToolSearchOptionState::Hybrid { embedding },
                })
            }
            (_, ToolSearchModeConfig::Lexical) => Ok(Self::new()),
        }
    }

    fn runtime_state(&self, registry: Arc<ToolRegistrySnapshot>) -> ToolSearchRuntimeState {
        match &self.state {
            ToolSearchOptionState::Lexical { .. } => ToolSearchRuntimeState::Lexical,
            ToolSearchOptionState::Hybrid { embedding } => ToolSearchRuntimeState::Hybrid(
                ToolSearchEmbeddingRuntime::new(registry, Arc::clone(embedding)),
            ),
            ToolSearchOptionState::Unavailable { reason } => {
                ToolSearchRuntimeState::Unavailable(Arc::clone(reason))
            }
        }
    }

    fn probe_embedding(embedding: &dyn EmbeddingInvoker) -> Result<(), ToolCompositionError> {
        let request = EmbeddingRequest::new(vec![TOOL_SEARCH_EMBEDDING_PROBE_TEXT.into()])
            .map_err(|error| ToolCompositionError(error.to_string()))?;
        let response = embedding.embed(&request).map_err(|error| {
            ToolCompositionError(format!(
                "hybrid embedding tool-search readiness probe failed: {error}"
            ))
        })?;
        if response.vectors().len() != 1 {
            return Err(ToolCompositionError(format!(
                "hybrid embedding tool-search readiness probe returned {} vectors instead of 1",
                response.vectors().len()
            )));
        }
        let magnitude = response.vectors()[0]
            .values()
            .iter()
            .map(|value| value * value)
            .sum::<f32>();
        if magnitude == 0.0 {
            return Err(ToolCompositionError(
                "hybrid embedding tool-search readiness probe returned a zero vector".into(),
            ));
        }
        Ok(())
    }
}

impl Default for ToolSearchOptions {
    fn default() -> Self {
        Self::new()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ToolPortKind {
    Environment,
    Application,
    Dynamic,
    Extension,
    Host,
    Local,
    Mcp,
}

impl ToolPortKind {
    fn runtime_namespace(self) -> &'static str {
        match self {
            Self::Environment => "environment",
            Self::Application => "application",
            Self::Dynamic => "dynamic",
            Self::Extension => "extension",
            Self::Host => "host",
            Self::Local => "local",
            Self::Mcp => "mcp",
        }
    }

    fn search_label(self) -> &'static str {
        match self {
            Self::Environment => "execution environment",
            Self::Application => "Ash application tool",
            Self::Dynamic => "client-hosted dynamic tool",
            Self::Extension => "host-installed extension tool",
            Self::Host => "product-hosted capability",
            Self::Local => "built-in directory tool",
            Self::Mcp => "MCP external tool",
        }
    }

    fn source_provenance(self, name: &ToolName) -> ToolSourceProvenance {
        match self {
            Self::Application => ToolSourceProvenance::Product {
                component: "ash-app-tools".into(),
            },
            Self::Environment => ToolSourceProvenance::Product {
                component: "ash-app-server/execution-environment".into(),
            },
            Self::Dynamic => ToolSourceProvenance::Dynamic {
                name: name.to_string(),
            },
            Self::Extension => ToolSourceProvenance::Extension {
                id: name.to_string(),
            },
            Self::Host => ToolSourceProvenance::Product {
                component: "ash-app-server/browser-host".into(),
            },
            Self::Local => ToolSourceProvenance::Product {
                component: "ash-app-server".into(),
            },
            Self::Mcp => ToolSourceProvenance::Mcp {
                server_id: "registry-projected".into(),
                remote_name: name.to_string(),
                catalog_generation: 0,
                connection_generation: 0,
            },
        }
    }
}

#[derive(Clone)]
pub(crate) struct ToolPort {
    kind: ToolPortKind,
    contributions: Vec<ToolContribution>,
    mcp_catalog: Option<Arc<McpMetaToolService>>,
    policy: Arc<dyn ActionPolicyService>,
    pub(crate) command_terminals: Option<Arc<dyn crate::local_tools::CommandTerminalService>>,
}

impl ToolPort {
    pub(crate) fn environment(
        tools: Arc<dyn ToolService>,
        policy: Arc<dyn ActionPolicyService>,
    ) -> Result<Self, ToolCompositionError> {
        Self::from_service(
            ToolPortKind::Environment,
            ToolExposure::Direct,
            tools,
            policy,
        )
    }

    pub(crate) fn application(
        tools: Arc<dyn ToolService>,
        policy: Arc<dyn ActionPolicyService>,
    ) -> Result<Self, ToolCompositionError> {
        Self::from_service(
            ToolPortKind::Application,
            ToolExposure::Direct,
            tools,
            policy,
        )
    }

    pub(crate) fn host(
        tools: Arc<dyn ToolService>,
        policy: Arc<dyn ActionPolicyService>,
    ) -> Result<Self, ToolCompositionError> {
        Self::from_service(ToolPortKind::Host, ToolExposure::Direct, tools, policy)
    }

    pub(crate) fn dynamic(composition: crate::dynamic_tools::DynamicToolComposition) -> Self {
        let kind = ToolPortKind::Dynamic;
        let search =
            ToolSearchMetadata::new(kind.search_label()).expect("static dynamic tool search label");
        let contributions = composition
            .definitions
            .iter()
            .cloned()
            .map(|definition| {
                ToolContribution::service(
                    Arc::clone(&composition.tools),
                    definition,
                    ToolExposure::Direct,
                    search.clone(),
                )
            })
            .collect();
        Self {
            kind,
            contributions,
            mcp_catalog: None,
            policy: composition.policy,
            command_terminals: None,
        }
    }

    pub(crate) fn extension(
        executors: Vec<Arc<dyn ash_tools::ToolExecutor>>,
        environment_id: ash_tools::EnvId,
        reviewer: Arc<dyn ToolExecutorReviewer>,
        policy: Arc<dyn ActionPolicyService>,
    ) -> Result<Self, ToolCompositionError> {
        let mut port = Self {
            kind: ToolPortKind::Extension,
            contributions: Vec::new(),
            mcp_catalog: None,
            policy,
            command_terminals: None,
        };
        for executor in executors {
            port = port.with_executor(executor, environment_id.clone(), Arc::clone(&reviewer))?;
        }
        Ok(port)
    }

    pub(crate) fn local(
        tools: Arc<dyn ToolService>,
        policy: Arc<dyn ActionPolicyService>,
    ) -> Result<Self, ToolCompositionError> {
        Self::from_service(ToolPortKind::Local, ToolExposure::Direct, tools, policy)
    }

    pub(crate) fn mcp(
        tools: Arc<dyn ToolService>,
        policy: Arc<dyn ActionPolicyService>,
    ) -> Result<Self, ToolCompositionError> {
        let definitions = tools.definitions();
        let mut port = if should_defer_mcp_catalog(&definitions) {
            let catalog = Arc::new(McpMetaToolService::new(Arc::clone(&tools), &definitions));
            let mut port = Self::from_service(
                ToolPortKind::Mcp,
                ToolExposure::Direct,
                catalog.clone(),
                policy,
            )?;
            port.mcp_catalog = Some(catalog);
            port
        } else {
            Self::from_service(
                ToolPortKind::Mcp,
                ToolExposure::Direct,
                Arc::clone(&tools),
                policy,
            )?
        };
        let search = ToolSearchMetadata::new(ToolPortKind::Mcp.search_label())
            .expect("static MCP search label");
        if port.mcp_catalog.is_some() {
            for definition in &definitions {
                port.contributions.push(ToolContribution::from_service(
                    Arc::clone(&tools),
                    definition,
                    ToolExposure::Deferred,
                    search.clone(),
                )?);
            }
        }
        let exposed_names = port
            .contributions
            .iter()
            .map(|tool| tool.definition.name().clone())
            .collect::<BTreeSet<_>>();
        for definition in tools
            .app_tool_definitions()
            .into_iter()
            .filter(|definition| !exposed_names.contains(&definition.name))
        {
            port.contributions.push(ToolContribution::from_service(
                Arc::clone(&tools),
                &definition,
                ToolExposure::Hidden,
                search.clone(),
            )?);
        }
        for contribution in &mut port.contributions {
            if contribution.tool_set == Some(mcp_exposure::GITHUB_ISSUE_TOOL_SET) {
                contribution.tool_set = None;
            }
        }
        Ok(port)
    }

    pub(crate) fn from_mcp(composition: McpToolComposition) -> Result<Self, ToolCompositionError> {
        let mut port = Self::mcp(composition.tools, composition.policy)?;
        for contribution in &mut port.contributions {
            if contribution.exposure != ToolExposure::Hidden
                && mcp_exposure::is_github_issue_tool(
                    &contribution.source_chain,
                    &composition.status,
                )
            {
                contribution.tool_set = Some(mcp_exposure::GITHUB_ISSUE_TOOL_SET);
            }
        }
        Ok(port)
    }

    fn from_service(
        kind: ToolPortKind,
        exposure: ToolExposure,
        tools: Arc<dyn ToolService>,
        policy: Arc<dyn ActionPolicyService>,
    ) -> Result<Self, ToolCompositionError> {
        let search = ToolSearchMetadata::new(kind.search_label())
            .expect("static App Server tool search metadata is valid");
        let contributions = tools
            .definitions()
            .into_iter()
            .map(|definition| {
                ToolContribution::from_service(
                    Arc::clone(&tools),
                    &definition,
                    exposure,
                    search.clone(),
                )
            })
            .collect::<Result<_, _>>()?;
        Ok(Self {
            kind,
            contributions,
            mcp_catalog: None,
            policy,
            command_terminals: None,
        })
    }

    pub(crate) fn with_executor(
        mut self,
        executor: Arc<dyn ash_tools::ToolExecutor>,
        environment_id: ash_tools::EnvId,
        reviewer: Arc<dyn ToolExecutorReviewer>,
    ) -> Result<Self, ToolCompositionError> {
        let definition = executor.definition();
        let runtime = Arc::new(ToolExecutorRuntime::new(executor, environment_id, reviewer));
        let contribution = ToolContribution {
            category: runtime.executor().category(),
            tool_set: runtime.executor().tool_set(),
            source_chain: vec![self.kind.source_provenance(definition.name())],
            definition,
            exposure: runtime.executor().exposure(),
            search: ToolSearchMetadata::new(self.kind.search_label())
                .expect("static App Server tool search metadata is valid"),
            runtime: ToolContributionRuntime::Executor(runtime),
        };
        if let Some(existing) = self
            .contributions
            .iter_mut()
            .find(|existing| existing.definition.name() == contribution.definition.name())
        {
            if existing.exposure != ToolExposure::Hidden {
                return Err(ToolCompositionError(format!(
                    "executable tool contribution duplicates visible tool {}",
                    contribution.definition.name()
                )));
            }
            *existing = contribution;
        } else {
            self.contributions.push(contribution);
        }
        Ok(self)
    }

    /// Overrides how one named tool enters the model catalog without changing its runtime source.
    pub(crate) fn with_tool_exposure(
        mut self,
        name: &ToolName,
        exposure: ToolExposure,
    ) -> Result<Self, ToolCompositionError> {
        let contribution = self
            .contributions
            .iter_mut()
            .find(|contribution| contribution.definition.name() == name)
            .ok_or_else(|| {
                ToolCompositionError(format!(
                    "cannot set exposure for unavailable tool contribution: {name}"
                ))
            })?;
        let loading = loading_for_exposure(exposure);
        match &contribution.runtime {
            ToolContributionRuntime::Service(_) => contribution.definition.set_loading(loading),
            ToolContributionRuntime::Executor(_) => {
                let declared = contribution.definition.loading();
                if declared != loading {
                    return Err(ToolCompositionError(format!(
                        "executable tool {name} declares {declared:?} loading and cannot use {exposure:?} exposure"
                    )));
                }
            }
        }
        contribution.exposure = exposure;
        Ok(self)
    }
}

#[derive(Clone)]
struct ToolContribution {
    tool_set: Option<&'static str>,
    category: Option<ash_protocol::ToolCategory>,
    definition: ToolDefinition,
    exposure: ToolExposure,
    search: ToolSearchMetadata,
    runtime: ToolContributionRuntime,
    source_chain: Vec<ToolSourceProvenance>,
}

impl ToolContribution {
    fn from_service(
        tools: Arc<dyn ToolService>,
        definition: &ProtocolToolDefinition,
        exposure: ToolExposure,
        search: ToolSearchMetadata,
    ) -> Result<Self, ToolCompositionError> {
        let definition = from_protocol_tool_definition(definition, loading_for_exposure(exposure))
            .map_err(|error| {
                ToolCompositionError(format!(
                    "could not validate model tool '{}': {error}",
                    definition.name
                ))
            })?;
        Ok(Self::service(tools, definition, exposure, search))
    }

    fn service(
        tools: Arc<dyn ToolService>,
        definition: ToolDefinition,
        exposure: ToolExposure,
        search: ToolSearchMetadata,
    ) -> Self {
        let name = definition.name();
        Self {
            category: tools.tool_category(name),
            tool_set: tools.tool_set(name),
            source_chain: tools.source_provenance(name),
            definition,
            exposure,
            search,
            runtime: ToolContributionRuntime::Service(tools),
        }
    }
}

#[derive(Clone)]
enum ToolContributionRuntime {
    Service(Arc<dyn ToolService>),
    Executor(Arc<ToolExecutorRuntime>),
}

pub(crate) struct CombinedToolPorts {
    pub(crate) tools: Arc<dyn ToolService>,
    pub(crate) policy: Arc<dyn ActionPolicyService>,
    catalog: Vec<AgentToolCapabilityDto>,
}

struct ToolGeneration {
    tools: Arc<dyn ToolService>,
    policy: Arc<dyn ActionPolicyService>,
    catalog: Vec<AgentToolCapabilityDto>,
}

type ToolTurn = (ThreadId, TurnId);
type TurnToolCalls = BTreeMap<ToolCallId, Arc<ToolGeneration>>;

/// Atomically switches future Tool safe points while retaining bindings for prepared calls.
pub(crate) struct ReloadableToolPorts {
    incarnation: String,
    current: RwLock<Arc<ToolGeneration>>,
    turns: Mutex<BTreeMap<ToolTurn, TurnToolCalls>>,
    diagnostic: Mutex<Option<String>>,
}

impl ReloadableToolPorts {
    pub(crate) fn new(initial: Option<CombinedToolPorts>) -> Arc<Self> {
        Arc::new(Self {
            incarnation: new_registry_incarnation(),
            current: RwLock::new(Arc::new(tool_generation(initial))),
            turns: Mutex::new(BTreeMap::new()),
            diagnostic: Mutex::new(None),
        })
    }

    pub(crate) fn replace(&self, next: Option<CombinedToolPorts>) {
        *self
            .current
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Arc::new(tool_generation(next));
        *self
            .diagnostic
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = None;
    }

    pub(crate) fn catalog(&self) -> Vec<AgentToolCapabilityDto> {
        self.generation().catalog.clone()
    }

    pub(crate) fn capability_catalog(
        &self,
    ) -> (
        Vec<AgentToolCapabilityDto>,
        Vec<ash_protocol::ToolSetDefinition>,
    ) {
        let generation = self.generation();
        (generation.catalog.clone(), generation.tools.tool_sets())
    }

    pub(crate) fn record_reconcile_failure(&self, error: impl Into<String>) {
        *self
            .diagnostic
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner) = Some(error.into());
    }

    #[cfg(test)]
    pub(crate) fn diagnostic(&self) -> Option<String> {
        self.diagnostic
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    pub(crate) fn tools(self: &Arc<Self>) -> Arc<dyn ToolService> {
        Arc::new(ReloadableToolService {
            ports: Arc::clone(self),
            turn: None,
        })
    }

    pub(crate) fn policy(self: &Arc<Self>) -> Arc<dyn ActionPolicyService> {
        Arc::new(ReloadableActionPolicyService {
            ports: Arc::clone(self),
        })
    }

    fn generation(&self) -> Arc<ToolGeneration> {
        Arc::clone(
            &self
                .current
                .read()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }

    fn pinned_generation(
        &self,
        turn: &ToolTurn,
        call: &ToolCallId,
    ) -> Result<Option<Arc<ToolGeneration>>, CoreError> {
        self.turns
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(turn)
            .map(|calls| calls.get(call).cloned())
            .ok_or_else(|| CoreError::Cancelled("tool Turn is no longer active".into()))
    }

    fn pin_generation(
        &self,
        turn: &ToolTurn,
        call: &ToolCallId,
        generation: &Arc<ToolGeneration>,
    ) -> Result<(), CoreError> {
        let mut turns = self
            .turns
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let calls = turns
            .get_mut(turn)
            .ok_or_else(|| CoreError::Cancelled("tool Turn is no longer active".into()))?;
        let pinned = calls
            .entry(call.clone())
            .or_insert_with(|| Arc::clone(generation));
        if !Arc::ptr_eq(pinned, generation) {
            return Err(CoreError::Policy(format!(
                "tool call {call} is already bound to another registry generation"
            )));
        }
        Ok(())
    }
}

fn new_registry_incarnation() -> String {
    use std::fmt::Write as _;

    let mut random = [0_u8; 16];
    getrandom::getrandom(&mut random).expect("registry incarnation entropy must be available");
    let mut value = String::with_capacity("tools_".len() + random.len() * 2);
    value.push_str("tools_");
    for byte in random {
        write!(value, "{byte:02x}").expect("writing to a String cannot fail");
    }
    value
}

fn with_registry_incarnation(
    binding: Option<ToolCallBinding>,
    incarnation: &str,
) -> Option<ToolCallBinding> {
    binding.map(|mut binding| {
        binding.registry_incarnation = Some(incarnation.into());
        binding
    })
}

#[derive(Clone)]
struct ReloadableToolService {
    ports: Arc<ReloadableToolPorts>,
    turn: Option<ToolTurn>,
}

impl ToolService for ReloadableToolService {
    fn scoped_to_turn(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
    ) -> Option<Arc<dyn ToolService>> {
        let turn = (thread_id.clone(), turn_id.clone());
        self.ports
            .turns
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(turn.clone())
            .or_default();
        Some(Arc::new(Self {
            ports: Arc::clone(&self.ports),
            turn: Some(turn),
        }))
    }

    fn finish_call(&self, scope: &ToolCallScope) {
        let generation = self
            .ports
            .turns
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get_mut(&(scope.thread_id.clone(), scope.turn_id.clone()))
            .and_then(|calls| calls.remove(&scope.call_id));
        if let Some(generation) = generation {
            generation.tools.finish_call(scope);
        }
    }

    fn finish_turn(&self, thread_id: &ThreadId, turn_id: &TurnId) {
        let turn = (thread_id.clone(), turn_id.clone());
        let calls = self
            .ports
            .turns
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&turn);
        for (call_id, generation) in calls.into_iter().flatten() {
            generation.tools.finish_call(&ToolCallScope {
                thread_id: thread_id.clone(),
                turn_id: turn_id.clone(),
                call_id,
            });
        }
    }

    fn list_app_tools(
        &self,
        origin: &ToolCall,
        binding: &ToolCallBinding,
    ) -> Result<Vec<serde_json::Value>, CoreError> {
        if binding.registry_incarnation.as_deref() != Some(self.ports.incarnation.as_str()) {
            return Err(CoreError::Policy(
                "App origin registry is unavailable".into(),
            ));
        }
        let generation = self.ports.generation();
        let mut inner = binding.clone();
        inner.registry_incarnation = None;
        generation
            .tools
            .validate_call_binding(origin, Some(&inner))?;
        generation.tools.list_app_tools(origin, &inner)
    }

    fn resolve_app_tool_call(
        &self,
        origin: &ToolCall,
        binding: &ToolCallBinding,
        name: &str,
        arguments: serde_json::Value,
        id: ToolCallId,
    ) -> Result<(ToolCall, ToolCallBinding), CoreError> {
        if binding.registry_incarnation.as_deref() != Some(self.ports.incarnation.as_str()) {
            return Err(CoreError::Policy(
                "App origin registry is unavailable".into(),
            ));
        }
        let generation = self.ports.generation();
        let mut inner = binding.clone();
        inner.registry_incarnation = None;
        let (call, _) = generation
            .tools
            .resolve_app_tool_call(origin, &inner, name, arguments, id)?;
        let binding = self
            .bind_call_in_generation(&generation, &call, ToolCallCaller::Direct)?
            .ok_or_else(|| CoreError::Policy("App tool registry binding is unavailable".into()))?;
        Ok((call, binding))
    }

    fn read_resource(
        &self,
        call: &ToolCall,
        uri: &str,
        cancellation: &CancellationToken,
    ) -> Result<ash_protocol::ToolOutputArtifact, CoreError> {
        self.bound_tools(call)?
            .read_resource(call, uri, cancellation)
    }

    fn definitions(&self) -> Vec<ProtocolToolDefinition> {
        self.ports.generation().tools.definitions()
    }

    fn conditional_tool_definitions(&self) -> Vec<ProtocolToolDefinition> {
        discovery_tool_definitions()
    }

    fn agent_tool_catalog(&self) -> AgentToolCatalog {
        self.ports.generation().tools.agent_tool_catalog()
    }

    fn tool_sets(&self) -> Vec<ash_protocol::ToolSetDefinition> {
        self.ports.generation().tools.tool_sets()
    }

    fn tool_category(&self, name: &ToolName) -> Option<ash_protocol::ToolCategory> {
        self.ports.generation().tools.tool_category(name)
    }

    fn resolve_tool_scope(
        &self,
        scope: &ash_protocol::ToolScope,
    ) -> Result<Vec<ToolName>, CoreError> {
        self.ports.generation().tools.resolve_tool_scope(scope)
    }

    fn model_definitions(
        &self,
        activated: &BTreeSet<ToolName>,
    ) -> Result<Vec<ProtocolToolDefinition>, CoreError> {
        self.ports.generation().tools.model_definitions(activated)
    }

    fn model_catalog_snapshot(
        &self,
        results: &mut dyn Iterator<Item = &ToolActivationResult<'_>>,
    ) -> Result<ModelToolCatalogSnapshot, CoreError> {
        let generation = self.ports.generation();
        let catalog = generation
            .tools
            .model_catalog_snapshot(&mut results.filter(|result| self.owns_result(result)))?;
        let tools = self.clone();
        Ok(catalog.with_binder(move |call, caller| {
            tools.bind_call_in_generation(&generation, call, caller)
        }))
    }

    fn code_mode_catalog_snapshot(
        &self,
        results: &mut dyn Iterator<Item = &ToolActivationResult<'_>>,
    ) -> Result<ModelToolCatalogSnapshot, CoreError> {
        let generation = self.ports.generation();
        let catalog = generation
            .tools
            .code_mode_catalog_snapshot(&mut results.filter(|result| self.owns_result(result)))?;
        let tools = self.clone();
        Ok(catalog.with_binder(move |call, caller| {
            tools.bind_call_in_generation(&generation, call, caller)
        }))
    }

    fn bind_call(
        &self,
        call: &ToolCall,
        caller: ToolCallCaller,
    ) -> Result<Option<ToolCallBinding>, CoreError> {
        let generation = self.ports.generation();
        self.bind_call_in_generation(&generation, call, caller)
    }

    fn validate_call_binding(
        &self,
        call: &ToolCall,
        binding: Option<&ToolCallBinding>,
    ) -> Result<(), CoreError> {
        let binding = binding.ok_or_else(|| {
            CoreError::Execution(format!(
                "legacy Tool Call {} has no durable source binding",
                call.id
            ))
        })?;
        if binding.registry_incarnation.as_deref() != Some(self.ports.incarnation.as_str()) {
            return Err(CoreError::Execution(format!(
                "tool {} belongs to an unavailable registry incarnation",
                call.name
            )));
        }
        let mut inner_binding = binding.clone();
        inner_binding.registry_incarnation = None;
        let generation = self.generation_for_call(call)?;
        generation
            .tools
            .validate_call_binding(call, Some(&inner_binding))?;
        if let Some(turn) = &self.turn {
            self.ports.pin_generation(turn, &call.id, &generation)?;
        }
        Ok(())
    }

    fn execution_interaction(
        &self,
        call: &ToolCall,
    ) -> Result<Option<ash_protocol::AgentRequest>, CoreError> {
        self.bound_tools(call)?.execution_interaction(call)
    }

    fn resolve_execution_interaction(
        &self,
        call: &ToolCall,
        request: &ash_protocol::AgentRequest,
        response: &ash_protocol::AgentResponse,
    ) -> Result<Option<ToolExecutionOutput>, CoreError> {
        self.bound_tools(call)?
            .resolve_execution_interaction(call, request, response)
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        self.prepare_bound(call, None)
    }

    fn prepare_with_facts(
        &self,
        call: &ToolCall,
        facts: &ToolExecutionFacts,
    ) -> Result<ActionReviewRequest, CoreError> {
        if !facts.allows_tool(&call.name) {
            return Err(CoreError::Policy(format!(
                "Tool '{}' is outside the current capability scope",
                call.name
            )));
        }

        self.prepare_bound(call, Some(facts))
    }

    fn review_evidence(&self, call: &ToolCall) -> Result<Vec<ReviewEvidence>, CoreError> {
        self.bound_tools(call)?.review_evidence(call)
    }

    fn execute(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        self.bound_tools(call)?
            .execute(call, authorization, cancellation)
    }

    fn execute_streaming(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        sink: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        self.bound_tools(call)?
            .execute_streaming(call, authorization, cancellation, sink)
    }

    fn execute_with_facts(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
    ) -> Result<ToolExecutionOutput, CoreError> {
        self.bound_tools(call)?
            .execute_with_facts(call, authorization, cancellation, facts)
    }

    fn execute_streaming_with_facts(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
        sink: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        self.bound_tools(call)?.execute_streaming_with_facts(
            call,
            authorization,
            cancellation,
            facts,
            sink,
        )
    }

    fn execute_streaming_with_facts_and_interactions(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
        interactions: Arc<dyn ash_core::ToolInteractionService>,
        sink: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        self.bound_tools(call)?
            .execute_streaming_with_facts_and_interactions(
                call,
                authorization,
                cancellation,
                facts,
                interactions,
                sink,
            )
    }
}

impl ReloadableToolService {
    fn owns_result(&self, result: &ToolActivationResult<'_>) -> bool {
        result.binding.as_ref().is_some_and(|binding| {
            binding.registry_incarnation.as_deref() == Some(self.ports.incarnation.as_str())
        })
    }

    fn bind_call_in_generation(
        &self,
        generation: &Arc<ToolGeneration>,
        call: &ToolCall,
        caller: ToolCallCaller,
    ) -> Result<Option<ToolCallBinding>, CoreError> {
        let binding = generation.tools.bind_call(call, caller)?;
        if let Some(turn) = &self.turn
            && binding.is_some()
        {
            self.ports.pin_generation(turn, &call.id, generation)?;
        }
        Ok(with_registry_incarnation(binding, &self.ports.incarnation))
    }

    fn generation_for_call(&self, call: &ToolCall) -> Result<Arc<ToolGeneration>, CoreError> {
        if let Some(turn) = &self.turn
            && let Some(generation) = self.ports.pinned_generation(turn, &call.id)?
        {
            return Ok(generation);
        }
        Ok(self.ports.generation())
    }

    fn prepare_bound(
        &self,
        call: &ToolCall,
        facts: Option<&ToolExecutionFacts>,
    ) -> Result<ActionReviewRequest, CoreError> {
        let generation = self.generation_for_call(call)?;
        if let Some(turn) = &self.turn {
            self.ports.pin_generation(turn, &call.id, &generation)?;
        }
        let request = match facts {
            Some(facts) => generation.tools.prepare_with_facts(call, facts)?,
            None => generation.tools.prepare(call)?,
        };
        if let Some(turn @ (thread_id, turn_id)) = &self.turn {
            let scope = ToolCallScope {
                thread_id: thread_id.clone(),
                turn_id: turn_id.clone(),
                call_id: call.id.clone(),
            };
            // Preparation can finish after the Turn was interrupted and its leases released.
            if !matches!(
                self.ports.pinned_generation(turn, &call.id),
                Ok(Some(pinned)) if Arc::ptr_eq(&pinned, &generation)
            ) {
                generation.tools.finish_call(&scope);
                return Err(CoreError::Cancelled("tool call is no longer active".into()));
            }
            return Ok(request.with_tool_call_scope(scope));
        }
        Ok(request)
    }

    fn bound_tools(&self, call: &ToolCall) -> Result<Arc<dyn ToolService>, CoreError> {
        self.generation_for_call(call)
            .map(|generation| Arc::clone(&generation.tools))
    }
}

struct ReloadableActionPolicyService {
    ports: Arc<ReloadableToolPorts>,
}

impl ActionPolicyService for ReloadableActionPolicyService {
    fn check_approval_mode(&self, mode: ash_protocol::ApprovalMode) -> Result<(), CoreError> {
        self.ports.generation().policy.check_approval_mode(mode)
    }

    fn permission_context(
        &self,
        session: &ash_protocol::SessionId,
        thread: &ash_protocol::ThreadId,
    ) -> Result<Vec<ash_protocol::ReviewEvidence>, CoreError> {
        self.ports
            .generation()
            .policy
            .permission_context(session, thread)
    }

    fn revision_for(&self, provenance: &ActionProvenance) -> String {
        self.ports.generation().policy.revision_for(provenance)
    }

    fn revision(&self) -> String {
        self.ports.generation().policy.revision()
    }

    fn decide(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        let generation = match request.tool_call_scope() {
            Some(scope) => self
                .ports
                .pinned_generation(
                    &(scope.thread_id.clone(), scope.turn_id.clone()),
                    &scope.call_id,
                )?
                .ok_or_else(|| {
                    CoreError::Policy("tool call policy binding is unavailable".into())
                })?,
            None => self.ports.generation(),
        };
        generation.policy.decide(request, cancellation)
    }
}

fn tool_generation(combined: Option<CombinedToolPorts>) -> ToolGeneration {
    match combined {
        Some(combined) => ToolGeneration {
            tools: combined.tools,
            policy: combined.policy,
            catalog: combined.catalog,
        },
        None => ToolGeneration {
            tools: Arc::new(EmptyToolService),
            policy: Arc::new(EmptyActionPolicyService),
            catalog: Vec::new(),
        },
    }
}

struct EmptyToolService;

impl ToolService for EmptyToolService {
    fn definitions(&self) -> Vec<ProtocolToolDefinition> {
        Vec::new()
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        Err(CoreError::Policy(format!(
            "tool is not available: {}",
            call.name
        )))
    }

    fn execute(
        &self,
        call: &ToolCall,
        _: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        Ok(ToolExecutionOutput::Failure(format!(
            "tool is not available: {}",
            call.name
        )))
    }
}

struct EmptyActionPolicyService;

impl ActionPolicyService for EmptyActionPolicyService {
    fn revision(&self) -> String {
        "empty-policy-v1".into()
    }

    fn decide(
        &self,
        _: &ActionReviewRequest,
        _: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        Err(CoreError::Policy(
            "no policy owns the requested tool action".into(),
        ))
    }
}

#[cfg(test)]
pub(crate) fn combine_tool_ports(
    ports: Vec<ToolPort>,
) -> Result<Option<CombinedToolPorts>, ToolCompositionError> {
    combine_tool_ports_at_generation(ports, ToolRegistryGeneration::new(1))
}

#[cfg(test)]
pub(crate) fn combine_tool_ports_at_generation(
    ports: Vec<ToolPort>,
    registry_generation: ToolRegistryGeneration,
) -> Result<Option<CombinedToolPorts>, ToolCompositionError> {
    combine_tool_ports_at_generation_with_search(
        ports,
        registry_generation,
        ToolSearchOptions::default(),
    )
}

pub(crate) fn combine_tool_ports_at_generation_with_search(
    ports: Vec<ToolPort>,
    registry_generation: ToolRegistryGeneration,
    search_options: ToolSearchOptions,
) -> Result<Option<CombinedToolPorts>, ToolCompositionError> {
    if ports.is_empty() {
        return Ok(None);
    }
    let mut definitions = Vec::new();
    let mut mcp_catalog = None;
    let mut names = BTreeSet::new();
    let mut local_policy = None;
    let mut mcp_policy = None;
    let mut dynamic_policy = None;
    let mut extension_policy = None;
    let mut host_policy = None;
    let mut application_policy = None;
    let mut environment_policy = None;
    for (service_index, port) in ports.into_iter().enumerate() {
        for contribution in port.contributions {
            if !names.insert(contribution.definition.name().clone()) {
                return Err(ToolCompositionError(format!(
                    "duplicate model tool name during App Server composition: {}",
                    contribution.definition.name()
                )));
            }
            definitions.push(CollectedToolDefinition {
                contribution,
                kind: port.kind,
                service_index,
            });
        }
        match port.kind {
            ToolPortKind::Application if application_policy.is_none() => {
                application_policy = Some(Arc::clone(&port.policy));
            }
            ToolPortKind::Application => {
                return Err(ToolCompositionError(
                    "multiple application tool policy ports".into(),
                ));
            }
            ToolPortKind::Environment if environment_policy.is_none() => {
                environment_policy = Some(Arc::clone(&port.policy));
            }
            ToolPortKind::Environment => {
                return Err(ToolCompositionError(
                    "multiple execution environment ports".into(),
                ));
            }
            ToolPortKind::Dynamic if dynamic_policy.is_none() => {
                dynamic_policy = Some(Arc::clone(&port.policy));
            }
            ToolPortKind::Extension if extension_policy.is_none() => {
                extension_policy = Some(Arc::clone(&port.policy));
            }
            ToolPortKind::Host if host_policy.is_none() => {
                host_policy = Some(Arc::clone(&port.policy));
            }
            ToolPortKind::Local if local_policy.is_none() => {
                local_policy = Some(Arc::clone(&port.policy));
            }
            ToolPortKind::Mcp if mcp_policy.is_none() => {
                mcp_policy = Some(Arc::clone(&port.policy));
                mcp_catalog = port.mcp_catalog;
            }
            ToolPortKind::Dynamic => {
                return Err(ToolCompositionError(
                    "multiple dynamic tool policy ports are not supported".into(),
                ));
            }
            ToolPortKind::Extension => {
                return Err(ToolCompositionError(
                    "multiple extension tool policy ports are not supported".into(),
                ));
            }
            ToolPortKind::Host => {
                return Err(ToolCompositionError(
                    "multiple product-hosted policy ports are not supported".into(),
                ));
            }
            ToolPortKind::Local => {
                return Err(ToolCompositionError(
                    "multiple local policy ports are not supported".into(),
                ));
            }
            ToolPortKind::Mcp => {
                return Err(ToolCompositionError(
                    "multiple MCP policy ports are not supported".into(),
                ));
            }
        }
    }
    let mut catalog = definitions
        .iter()
        .map(|collected| AgentToolCapabilityDto {
            category: collected.contribution.category,
            name: collected.contribution.definition.name().to_string(),
            description: collected.contribution.definition.description().to_owned(),
            source: match collected.kind {
                ToolPortKind::Environment => ToolSourceDto::Environment,
                ToolPortKind::Dynamic => ToolSourceDto::Dynamic,
                ToolPortKind::Extension => ToolSourceDto::Extension,
                ToolPortKind::Host | ToolPortKind::Application => ToolSourceDto::Host,
                ToolPortKind::Local => ToolSourceDto::Local,
                ToolPortKind::Mcp => ToolSourceDto::Mcp,
            },
            source_chain: tool_source_chain(collected),
            exposure: match collected.contribution.exposure {
                ToolExposure::Direct => ToolExposureDto::Direct,
                ToolExposure::Deferred => ToolExposureDto::Deferred,
                ToolExposure::DirectModelOnly => ToolExposureDto::ModelOnly,
                ToolExposure::Hidden => ToolExposureDto::Hidden,
            },
            authority: tool_authority(collected),
        })
        .collect::<Vec<_>>();
    let mut tool_sets = BTreeMap::<String, Vec<ToolName>>::new();
    for collected in &definitions {
        if let Some(id) = collected.contribution.tool_set
            && (id != mcp_exposure::GITHUB_ISSUE_TOOL_SET || collected.kind == ToolPortKind::Mcp)
        {
            tool_sets
                .entry(id.into())
                .or_default()
                .push(collected.contribution.definition.name().clone());
        }
    }
    let tool_sets = tool_sets
        .into_iter()
        .map(|(id, tools)| ash_protocol::ToolSetDefinition { id, tools })
        .collect();
    let definition_names = definitions
        .iter()
        .map(|collected| {
            let definition = &collected.contribution.definition;
            match definition.invocation() {
                ToolInvocationKind::Function { .. } => Ok(definition.name().clone()),
                ToolInvocationKind::Freeform { .. } => Err(ToolCompositionError(format!(
                    "could not project executable tool '{}': {}",
                    definition.name(),
                    ProtocolToolAdapterError::FreeformToolsUnsupported,
                ))),
            }
        })
        .collect::<Result<Vec<_>, _>>()?;
    let (registry, routes) = build_registry(registry_generation, definitions)?;
    let definition_order = definition_names
        .iter()
        .map(|name| {
            registry
                .position(name)
                .expect("registry contains every contribution")
        })
        .collect();
    let search = registry
        .has_deferred_tools()
        .then(|| ToolSearchRuntime::new(Arc::clone(&registry), &search_options));
    if let Some(search) = &search {
        catalog.push(AgentToolCapabilityDto {
            category: Some(ash_protocol::ToolCategory::Search),
            name: search.definition().name.to_string(),
            description: search.definition().description.clone(),
            source: ToolSourceDto::Host,
            source_chain: vec![ToolSourceProvenance::Product {
                component: "tool-search".into(),
            }],
            exposure: ToolExposureDto::Direct,
            authority: ToolAuthorityDto::ProductService,
        });
    }
    let categories = catalog
        .iter()
        .map(|tool| {
            (
                ToolName::new(tool.name.clone()).expect("validated catalog name"),
                tool.category,
            )
        })
        .collect();
    let search_enabled = search.is_some();
    Ok(Some(CombinedToolPorts {
        tools: Arc::new(CompositeToolService {
            tool_sets,
            categories,
            definition_order,
            routes,
            registry,
            search,
            mcp_catalog,
        }),
        policy: Arc::new(CompositeActionPolicyService {
            dynamic: dynamic_policy,
            extension: extension_policy,
            host: host_policy,
            application: application_policy,
            environment: environment_policy,
            local: local_policy,
            mcp: mcp_policy,
            search_enabled,
        }),
        catalog,
    }))
}

fn tool_authority(tool: &CollectedToolDefinition) -> ToolAuthorityDto {
    if tool.kind != ToolPortKind::Local {
        return match tool.kind {
            ToolPortKind::Environment
            | ToolPortKind::Dynamic
            | ToolPortKind::Extension
            | ToolPortKind::Mcp => ToolAuthorityDto::ProviderDefined,
            ToolPortKind::Host | ToolPortKind::Application => ToolAuthorityDto::ProductService,
            ToolPortKind::Local => unreachable!(),
        };
    }
    match tool.contribution.definition.name().as_str() {
        "read_file" | "grep" | "glob" | "find_symbol_references" => ToolAuthorityDto::DirectoryRead,
        "write_file" | "edit" | "apply_patch" | "rename_symbol" => ToolAuthorityDto::DirectoryWrite,
        "shell-command" | "shell-session" => ToolAuthorityDto::ProcessExecution,
        _ => ToolAuthorityDto::ProductService,
    }
}

fn tool_source_chain(tool: &CollectedToolDefinition) -> Vec<ToolSourceProvenance> {
    if tool.contribution.source_chain.is_empty() {
        vec![
            tool.kind
                .source_provenance(tool.contribution.definition.name()),
        ]
    } else {
        tool.contribution.source_chain.clone()
    }
}

struct CollectedToolDefinition {
    contribution: ToolContribution,
    kind: ToolPortKind,
    service_index: usize,
}

fn build_registry(
    generation: ToolRegistryGeneration,
    definitions: Vec<CollectedToolDefinition>,
) -> Result<
    (
        Arc<ToolRegistrySnapshot>,
        BTreeMap<ToolRuntimeKey, ToolContributionRuntime>,
    ),
    ToolCompositionError,
> {
    let mut builder = ToolRegistryBuilder::new(generation);
    let mut routes = BTreeMap::new();
    for collected in definitions {
        let source_chain = tool_source_chain(&collected);
        let contribution = collected.contribution;
        let runtime_key = ToolRuntimeKey::new(format!(
            "{}:{}:{}",
            collected.kind.runtime_namespace(),
            collected.service_index,
            contribution.definition.name()
        ))
        .map_err(|error| ToolCompositionError(error.to_string()))?;
        if routes
            .insert(runtime_key.clone(), contribution.runtime)
            .is_some()
        {
            return Err(ToolCompositionError(format!(
                "duplicate runtime route during App Server composition: {runtime_key}"
            )));
        }
        builder
            .register(
                ToolRegistryRegistration::new(
                    contribution.definition,
                    runtime_key,
                    contribution.exposure,
                    contribution.search,
                )
                .map_err(|error| ToolCompositionError(error.to_string()))?
                .with_source_chain(source_chain),
            )
            .map_err(|error| ToolCompositionError(error.to_string()))?;
    }
    let registry = builder
        .build()
        .map(Arc::new)
        .map_err(|error| ToolCompositionError(error.to_string()))?;
    Ok((registry, routes))
}

struct CompositeToolService {
    tool_sets: Vec<ash_protocol::ToolSetDefinition>,
    categories: BTreeMap<ToolName, Option<ash_protocol::ToolCategory>>,
    /// Composition order for the full catalog. Model selection uses registry order.
    definition_order: Vec<usize>,
    routes: BTreeMap<ToolRuntimeKey, ToolContributionRuntime>,
    registry: Arc<ToolRegistrySnapshot>,
    search: Option<ToolSearchRuntime>,
    mcp_catalog: Option<Arc<McpMetaToolService>>,
}

impl CompositeToolService {
    fn excluded_tools(&self, facts: &ToolExecutionFacts) -> Vec<ToolName> {
        self.categories
            .keys()
            .filter(|name| !facts.allows_tool(name))
            .cloned()
            .collect()
    }

    fn execute_search(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: Option<&ToolExecutionFacts>,
    ) -> Option<Result<ToolExecutionOutput, CoreError>> {
        if call.name.as_str() == MCP_SEARCH_TOOLS_NAME {
            return self.mcp_catalog.as_ref().map(|catalog| {
                catalog.execute_search(call, &self.registry, authorization, cancellation, facts)
            });
        }
        let search = self.search.as_ref()?;
        if call.name != search.definition().name {
            return None;
        }
        let excluded = facts.map_or_else(Vec::new, |facts| self.excluded_tools(facts));
        Some(search.execute_selected(call, authorization, cancellation, &excluded))
    }

    fn runtime(
        &self,
        call: &ToolCall,
    ) -> Result<(&ash_tools::ToolBinding, &ToolContributionRuntime), CoreError> {
        let binding = self
            .registry
            .resolve(&call.name)
            .map(|entry| entry.binding())
            .ok_or_else(|| CoreError::Policy(format!("tool is not available: {}", call.name)))?;
        self.routes
            .get(binding.runtime_key())
            .map(|runtime| (binding, runtime))
            .ok_or_else(|| {
                CoreError::Execution(format!(
                    "tool binding {} has no runtime route in registry generation {}",
                    binding.id(),
                    binding.registry_generation()
                ))
            })
    }
}

fn loading_for_exposure(exposure: ToolExposure) -> ToolLoading {
    match exposure {
        ToolExposure::Deferred => ToolLoading::Deferred,
        ToolExposure::Direct | ToolExposure::DirectModelOnly | ToolExposure::Hidden => {
            ToolLoading::Eager
        }
    }
}

/// Product composition is explicit. Future tools cannot join Code merely by sharing a category.
pub(crate) fn product_tool_profiles() -> Vec<ash_protocol::ToolProductProfile> {
    vec![
        ash_protocol::ToolProductProfile {
            id: "code".into(),
            sets: [
                "core.files",
                "core.search",
                "core.execution",
                "core.browser",
                "core.web",
                "core.github",
                "core.memory",
                "core.skills",
                "core.images",
                "agent.control",
                "agent.collaboration",
                "agent.planning",
                "agent.instructions",
                "app.sessions",
                "app.projects",
                "app.automations",
                "app.workbench",
                "app.application",
            ]
            .into_iter()
            .map(str::to_owned)
            .collect(),
            status: ash_protocol::ToolProductStatus::Ready,
        },
        ash_protocol::ToolProductProfile {
            id: "cowork".into(),
            sets: Vec::new(),
            status: ash_protocol::ToolProductStatus::Planned,
        },
        ash_protocol::ToolProductProfile {
            id: "design".into(),
            sets: Vec::new(),
            status: ash_protocol::ToolProductStatus::Planned,
        },
    ]
}

impl ToolService for CompositeToolService {
    fn conditional_tool_definitions(&self) -> Vec<ProtocolToolDefinition> {
        discovery_tool_definitions()
    }

    fn finish_call(&self, scope: &ToolCallScope) {
        for route in self.routes.values() {
            if let ToolContributionRuntime::Executor(executor) = route {
                executor.finish_call(scope);
            }
        }
    }

    fn finish_turn(&self, thread_id: &ThreadId, turn_id: &TurnId) {
        for route in self.routes.values() {
            if let ToolContributionRuntime::Executor(executor) = route {
                executor.finish_turn(thread_id, turn_id);
            }
        }
    }

    fn tool_sets(&self) -> Vec<ash_protocol::ToolSetDefinition> {
        self.tool_sets.clone()
    }
    fn tool_category(&self, name: &ToolName) -> Option<ash_protocol::ToolCategory> {
        self.categories.get(name).copied().flatten()
    }

    fn resolve_tool_scope(
        &self,
        scope: &ash_protocol::ToolScope,
    ) -> Result<Vec<ToolName>, CoreError> {
        scope.validate().map_err(CoreError::InvalidInput)?;
        if scope
            .tools
            .iter()
            .any(|name| !self.categories.contains_key(name))
        {
            return Err(CoreError::InvalidInput(
                "Tool scope contains an unknown tool".into(),
            ));
        }
        if scope
            .sets
            .iter()
            .any(|id| !self.tool_sets.iter().any(|set| &set.id == id))
        {
            return Err(CoreError::InvalidInput(
                "Tool scope contains an unknown tool set".into(),
            ));
        }
        let members = self
            .tool_sets
            .iter()
            .filter(|set| scope.sets.contains(&set.id))
            .flat_map(|set| &set.tools)
            .collect::<BTreeSet<_>>();
        let profile_members = scope
            .profile
            .as_ref()
            .map(|id| {
                let profile = product_tool_profiles()
                    .into_iter()
                    .find(|profile| &profile.id == id)
                    .ok_or_else(|| {
                        CoreError::InvalidInput(format!("Unknown tool product profile: {id}"))
                    })?;
                if profile.status == ash_protocol::ToolProductStatus::Planned {
                    return Err(CoreError::InvalidInput(format!(
                        "Tool product profile {id} is planned and has no available capabilities"
                    )));
                }
                Ok::<BTreeSet<ToolName>, CoreError>(
                    self.tool_sets
                        .iter()
                        .filter(|set| profile.sets.contains(&set.id))
                        .flat_map(|set| set.tools.iter().cloned())
                        .collect(),
                )
            })
            .transpose()?;

        let mut names = self
            .categories
            .iter()
            .filter(|(name, category)| {
                (scope.tools.contains(name)
                    || members.contains(name)
                    || (scope.sets.is_empty()
                        && scope.tools.is_empty()
                        && profile_members.is_some()))
                    && profile_members
                        .as_ref()
                        .is_none_or(|members| members.contains(name))
                    && (scope.categories.is_empty()
                        || category.is_some_and(|category| scope.categories.contains(&category)))
            })
            .map(|(name, _)| name.clone())
            .collect::<BTreeSet<_>>();
        // Discovery and MCP routing are infrastructure: their targets are still checked
        // against the resolved scope, so selecting a bridge never grants its whole catalog.
        if !names.is_empty() {
            if let Some(search) = &self.search {
                names.insert(search.definition().name.clone());
            }
            if self
                .mcp_catalog
                .as_ref()
                .is_some_and(|catalog| names.iter().any(|name| catalog.contains(name)))
            {
                for name in [MCP_SEARCH_TOOLS_NAME, MCP_CALL_TOOL_NAME] {
                    let name = ToolName::new(name).expect("static MCP bridge name");
                    if self.categories.contains_key(&name) {
                        names.insert(name);
                    }
                }
            }
        }
        Ok(names.into_iter().collect())
    }

    fn list_app_tools(
        &self,
        origin: &ToolCall,
        binding: &ToolCallBinding,
    ) -> Result<Vec<serde_json::Value>, CoreError> {
        self.validate_call_binding(origin, Some(binding))?;
        let (_, runtime) = self.runtime(origin)?;
        let ToolContributionRuntime::Service(service) = runtime else {
            return Err(CoreError::Policy("App origin is not a service".into()));
        };
        service.list_app_tools(origin, binding)
    }

    fn resolve_app_tool_call(
        &self,
        origin: &ToolCall,
        binding: &ToolCallBinding,
        name: &str,
        arguments: serde_json::Value,
        id: ToolCallId,
    ) -> Result<(ToolCall, ToolCallBinding), CoreError> {
        self.validate_call_binding(origin, Some(binding))?;
        let (_, runtime) = self.runtime(origin)?;
        let ToolContributionRuntime::Service(service) = runtime else {
            return Err(CoreError::Policy("App origin is not a service".into()));
        };
        let (call, _) = service.resolve_app_tool_call(origin, binding, name, arguments, id)?;
        let binding = self
            .bind_call(&call, ToolCallCaller::Direct)?
            .ok_or_else(|| CoreError::Policy("App tool registry binding is unavailable".into()))?;
        Ok((call, binding))
    }

    fn read_resource(
        &self,
        call: &ToolCall,
        uri: &str,
        cancellation: &CancellationToken,
    ) -> Result<ash_protocol::ToolOutputArtifact, CoreError> {
        let (_, runtime) = self.runtime(call)?;
        match runtime {
            ToolContributionRuntime::Service(service) => {
                service.read_resource(call, uri, cancellation)
            }
            ToolContributionRuntime::Executor(_) => Err(CoreError::Execution(
                "this tool executor cannot read resources".into(),
            )),
        }
    }

    fn definitions(&self) -> Vec<ProtocolToolDefinition> {
        let entries = self.registry.entries();
        let mut definitions = self
            .definition_order
            .iter()
            .map(|&position| {
                to_protocol_tool_definition(entries[position].definition())
                    .expect("App Server composition accepts only function tools")
            })
            .collect::<Vec<_>>();
        if let Some(search) = &self.search {
            definitions.push(search.definition().clone());
        }
        definitions
    }

    fn agent_tool_catalog(&self) -> AgentToolCatalog {
        let tools = self
            .registry
            .entries()
            .iter()
            .filter(|entry| entry.exposure() != ToolExposure::Hidden)
            .map(|entry| entry.definition().name().clone())
            .chain(
                self.search
                    .iter()
                    .map(|search| search.definition().name.clone()),
            )
            .collect();
        AgentToolCatalog {
            tools,
            sets: self.tool_sets.clone(),
        }
    }

    fn code_mode_catalog_snapshot(
        &self,
        results: &mut dyn Iterator<Item = &ToolActivationResult<'_>>,
    ) -> Result<ModelToolCatalogSnapshot, CoreError> {
        let eligible = ash_tools::CodeModeProjection::from_registry(&self.registry)
            .map_err(|error| CoreError::Policy(error.to_string()))?;
        let bindings = eligible
            .bindings()
            .iter()
            .map(|binding| &binding.binding_id)
            .collect::<BTreeSet<_>>();
        let catalog = self.model_catalog_snapshot(results)?;
        let names = catalog
            .definitions()
            .iter()
            .filter(|definition| {
                self.search
                    .as_ref()
                    .is_some_and(|search| search.definition().name == definition.name)
                    || self
                        .registry
                        .resolve(&definition.name)
                        .is_some_and(|entry| bindings.contains(entry.binding().id()))
            })
            .map(|definition| definition.name.clone())
            .collect::<Vec<_>>();
        Ok(catalog.restrict_to_names(&names))
    }

    fn bind_call(
        &self,
        call: &ToolCall,
        caller: ToolCallCaller,
    ) -> Result<Option<ToolCallBinding>, CoreError> {
        if let Some(search) = &self.search
            && call.name == search.definition().name
        {
            let definition = from_protocol_tool_definition(search.definition(), ToolLoading::Eager)
                .map_err(|error| CoreError::Execution(error.to_string()))?;
            return Ok(Some(ToolCallBinding {
                registry_incarnation: None,
                registry_generation: self.registry.generation().get(),
                definition_digest: definition.digest().to_string(),
                source_chain: vec![ToolSourceProvenance::System {
                    id: TOOL_SEARCH_TOOL_NAME.into(),
                }],
                activity: Some(ToolActivity::Search {
                    target: "tools".into(),
                }),
                caller,
            }));
        }
        let (binding, runtime) = self.runtime(call)?;
        let activity = match runtime {
            ToolContributionRuntime::Service(service) => service.activity(call),
            ToolContributionRuntime::Executor(executor) => executor.executor().activity(call),
        };
        Ok(Some(ToolCallBinding {
            registry_incarnation: None,
            registry_generation: binding.registry_generation().get(),
            definition_digest: binding.definition_digest().to_string(),
            source_chain: binding.source_chain().to_vec(),
            activity,
            caller,
        }))
    }

    fn validate_call_binding(
        &self,
        call: &ToolCall,
        binding: Option<&ToolCallBinding>,
    ) -> Result<(), CoreError> {
        let binding = binding.ok_or_else(|| {
            CoreError::Execution(format!(
                "legacy Tool Call {} has no durable source binding",
                call.id
            ))
        })?;
        let expected = self
            .bind_call(call, binding.caller.clone())?
            .ok_or_else(|| CoreError::Execution("tool binding is unavailable".into()))?;
        if !expected.matches_execution_source(binding) {
            return Err(CoreError::Execution(format!(
                "tool {} no longer matches registry generation {}, definition {}, and source chain",
                call.name, binding.registry_generation, binding.definition_digest
            )));
        }
        Ok(())
    }

    fn model_definitions(
        &self,
        activated: &BTreeSet<ToolName>,
    ) -> Result<Vec<ProtocolToolDefinition>, CoreError> {
        let mut definitions = self
            .registry
            .model_definitions(activated)
            .map(to_protocol_tool_definition)
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| CoreError::Execution(error.to_string()))?;
        if let Some(search) = &self.search {
            definitions.push(search.definition().clone());
        }
        Ok(definitions)
    }

    fn activated_tool_names(
        &self,
        result: &ToolActivationResult<'_>,
    ) -> Result<Vec<ToolName>, CoreError> {
        match &self.search {
            Some(search) => search.activated_tool_names(result),
            None => Ok(Vec::new()),
        }
    }

    fn execution_interaction(
        &self,
        call: &ToolCall,
    ) -> Result<Option<ash_protocol::AgentRequest>, CoreError> {
        if self
            .search
            .as_ref()
            .is_some_and(|search| call.name == search.definition().name)
        {
            return Ok(None);
        }
        let (_, runtime) = self.runtime(call)?;
        match runtime {
            ToolContributionRuntime::Service(service) => service.execution_interaction(call),
            ToolContributionRuntime::Executor(_) => Ok(None),
        }
    }

    fn resolve_execution_interaction(
        &self,
        call: &ToolCall,
        request: &ash_protocol::AgentRequest,
        response: &ash_protocol::AgentResponse,
    ) -> Result<Option<ToolExecutionOutput>, CoreError> {
        if self
            .search
            .as_ref()
            .is_some_and(|search| call.name == search.definition().name)
        {
            return Ok(None);
        }
        let (_, runtime) = self.runtime(call)?;
        match runtime {
            ToolContributionRuntime::Service(service) => {
                service.resolve_execution_interaction(call, request, response)
            }
            ToolContributionRuntime::Executor(_) => Ok(None),
        }
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        if let Some(search) = &self.search
            && call.name == search.definition().name
        {
            return search.prepare(call);
        }
        let (_, runtime) = self.runtime(call)?;
        match runtime {
            ToolContributionRuntime::Service(service) => service.prepare(call),
            ToolContributionRuntime::Executor(executor) => executor.prepare(call),
        }
    }

    fn prepare_with_facts(
        &self,
        call: &ToolCall,
        facts: &ToolExecutionFacts,
    ) -> Result<ActionReviewRequest, CoreError> {
        if !facts.allows_tool(&call.name) {
            return Err(CoreError::Policy(format!(
                "Tool '{}' is outside the current capability scope",
                call.name
            )));
        }

        if let Some(search) = &self.search
            && call.name == search.definition().name
        {
            return search.prepare(call);
        }
        let (_, runtime) = self.runtime(call)?;
        match runtime {
            ToolContributionRuntime::Service(service) => service.prepare_with_facts(call, facts),
            ToolContributionRuntime::Executor(executor) => executor.prepare_with_facts(call, facts),
        }
    }

    fn review_evidence(&self, call: &ToolCall) -> Result<Vec<ReviewEvidence>, CoreError> {
        if let Some(search) = &self.search
            && call.name == search.definition().name
        {
            return Ok(Vec::new());
        }
        let (_, runtime) = self.runtime(call)?;
        match runtime {
            ToolContributionRuntime::Service(service) => service.review_evidence(call),
            ToolContributionRuntime::Executor(executor) => executor.evidence(call),
        }
    }

    fn execute(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        if let Some(result) = self.execute_search(call, authorization, cancellation, None) {
            return result;
        }
        let (_, runtime) = self.runtime(call)?;
        match runtime {
            ToolContributionRuntime::Service(service) => {
                service.execute(call, authorization, cancellation)
            }
            ToolContributionRuntime::Executor(_) => Err(CoreError::Execution(
                "ToolExecutor invocation requires durable execution facts".into(),
            )),
        }
    }

    fn execute_streaming(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        sink: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        if let Some(result) = self.execute_search(call, authorization, cancellation, None) {
            return result;
        }
        let (_, runtime) = self.runtime(call)?;
        match runtime {
            ToolContributionRuntime::Service(service) => {
                service.execute_streaming(call, authorization, cancellation, sink)
            }
            ToolContributionRuntime::Executor(_) => Err(CoreError::Execution(
                "ToolExecutor invocation requires durable execution facts".into(),
            )),
        }
    }

    fn execute_with_facts(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
    ) -> Result<ToolExecutionOutput, CoreError> {
        if let Some(result) = self.execute_search(call, authorization, cancellation, Some(facts)) {
            return result;
        }
        let (binding, runtime) = self.runtime(call)?;
        match runtime {
            ToolContributionRuntime::Service(service) => {
                service.execute_with_facts(call, authorization, cancellation, facts)
            }
            ToolContributionRuntime::Executor(executor) => executor.execute(
                binding,
                call,
                authorization,
                cancellation,
                facts,
                &mut NoopToolOutputSink,
            ),
        }
    }

    fn execute_streaming_with_facts(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
        sink: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        if let Some(result) = self.execute_search(call, authorization, cancellation, Some(facts)) {
            return result;
        }
        let (binding, runtime) = self.runtime(call)?;
        match runtime {
            ToolContributionRuntime::Service(service) => {
                service.execute_streaming_with_facts(call, authorization, cancellation, facts, sink)
            }
            ToolContributionRuntime::Executor(executor) => {
                executor.execute(binding, call, authorization, cancellation, facts, sink)
            }
        }
    }

    fn execute_streaming_with_facts_and_interactions(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
        interactions: Arc<dyn ash_core::ToolInteractionService>,
        sink: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        if let Some(result) = self.execute_search(call, authorization, cancellation, Some(facts)) {
            return result;
        }
        let (binding, runtime) = self.runtime(call)?;
        match runtime {
            ToolContributionRuntime::Service(service) => service
                .execute_streaming_with_facts_and_interactions(
                    call,
                    authorization,
                    cancellation,
                    facts,
                    interactions,
                    sink,
                ),
            ToolContributionRuntime::Executor(executor) => executor.execute_with_interactions(
                binding,
                call,
                authorization,
                cancellation,
                facts,
                interactions,
                sink,
            ),
        }
    }
}

struct NoopToolOutputSink;

impl ToolOutputSink for NoopToolOutputSink {
    fn emit(&mut self, _: ash_protocol::ToolOutputStream, _: String) -> Result<(), CoreError> {
        Ok(())
    }
}

struct CompositeActionPolicyService {
    environment: Option<Arc<dyn ActionPolicyService>>,
    dynamic: Option<Arc<dyn ActionPolicyService>>,
    extension: Option<Arc<dyn ActionPolicyService>>,
    host: Option<Arc<dyn ActionPolicyService>>,
    application: Option<Arc<dyn ActionPolicyService>>,
    local: Option<Arc<dyn ActionPolicyService>>,
    mcp: Option<Arc<dyn ActionPolicyService>>,
    search_enabled: bool,
}

impl ActionPolicyService for CompositeActionPolicyService {
    fn check_approval_mode(&self, mode: ash_protocol::ApprovalMode) -> Result<(), CoreError> {
        for policy in [
            &self.environment,
            &self.dynamic,
            &self.extension,
            &self.host,
            &self.application,
            &self.local,
            &self.mcp,
        ]
        .into_iter()
        .flatten()
        {
            policy.check_approval_mode(mode)?;
        }
        Ok(())
    }

    fn permission_context(
        &self,
        session: &ash_protocol::SessionId,
        thread: &ash_protocol::ThreadId,
    ) -> Result<Vec<ash_protocol::ReviewEvidence>, CoreError> {
        let mut evidence = Vec::new();
        for policy in [
            &self.environment,
            &self.dynamic,
            &self.extension,
            &self.host,
            &self.application,
            &self.local,
            &self.mcp,
        ]
        .into_iter()
        .flatten()
        {
            evidence.extend(policy.permission_context(session, thread)?);
        }
        Ok(evidence)
    }

    fn revision_for(&self, provenance: &ActionProvenance) -> String {
        if provenance.source() == &ActionSource::User
            && ash_config::HookId::new(provenance.source_id()).is_ok()
            && let Some(policy) = &self.local
        {
            return policy.revision_for(provenance);
        }
        self.revision()
    }

    fn revision(&self) -> String {
        format!(
            "composite-policy-v1:application={}:environment={}:dynamic={}:extension={}:host={}:local={}:mcp={}:tool-search={}",
            self.application
                .as_ref()
                .map_or_else(|| "none".into(), |policy| policy.revision()),
            self.environment
                .as_ref()
                .map_or_else(|| "none".into(), |policy| policy.revision()),
            self.dynamic
                .as_ref()
                .map_or_else(|| "none".into(), |policy| policy.revision()),
            self.extension
                .as_ref()
                .map_or_else(|| "none".into(), |policy| policy.revision()),
            self.host
                .as_ref()
                .map_or_else(|| "none".into(), |policy| policy.revision()),
            self.local
                .as_ref()
                .map_or_else(|| "none".into(), |policy| policy.revision()),
            self.mcp
                .as_ref()
                .map_or_else(|| "none".into(), |policy| policy.revision()),
            if self.search_enabled {
                "enabled"
            } else {
                "disabled"
            }
        )
    }

    fn decide(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        if self.search_enabled && request.provenance().source_id() == TOOL_SEARCH_TOOL_NAME {
            return decide_tool_search(request, cancellation);
        }
        if request.provenance().source_id() == MCP_SEARCH_TOOLS_NAME {
            return decide_mcp_catalog_search(request, cancellation);
        }
        let policy = match request.provenance().source() {
            ActionSource::DynamicTool => self.dynamic.as_ref(),
            ActionSource::Plugin => self.extension.as_ref(),
            ActionSource::BuiltInTool
                if request.action_policy_revision().as_str() == "ash-app-tools-v1" =>
            {
                self.application.as_ref()
            }
            ActionSource::BuiltInTool
                if request.action_policy_revision().as_str()
                    == crate::browser_tool::BROWSER_POLICY_REVISION =>
            {
                self.host.as_ref()
            }
            ActionSource::BuiltInTool if request.provenance().source_id() == "environment" => {
                self.environment.as_ref()
            }
            ActionSource::BuiltInTool => self.local.as_ref(),
            ActionSource::McpServer => self.mcp.as_ref(),
            // Configured hook commands retain user provenance and use the local process policy.
            ActionSource::User
                if ash_config::HookId::new(request.provenance().source_id()).is_ok() =>
            {
                self.local.as_ref()
            }
            _ => None,
        }
        .ok_or_else(|| {
            CoreError::Policy("no policy owns the prepared tool action provenance".into())
        })?;
        policy.decide(request, cancellation)
    }
}

#[derive(serde::Deserialize)]
struct ToolSearchArguments {
    query: String,
    limit: Option<usize>,
    #[serde(default)]
    strategy: ToolSearchStrategy,
}

#[derive(Clone, Copy, Default, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
enum ToolSearchStrategy {
    #[default]
    Bm25,
    Regex,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
struct ToolSearchOutput {
    registry_generation: u64,
    tools: Vec<ToolSearchOutputMatch>,
}

#[derive(serde::Deserialize, serde::Serialize)]
#[serde(rename_all = "snake_case")]
struct ToolSearchOutputMatch {
    name: ToolName,
    description: String,
    definition_digest: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    source_digest: Option<ContentDigest>,
    score: u64,
}

struct ToolSearchRuntime {
    registry: Arc<ToolRegistrySnapshot>,
    definition: ProtocolToolDefinition,
    state: ToolSearchRuntimeState,
}

enum ToolSearchRuntimeState {
    Lexical,
    Hybrid(ToolSearchEmbeddingRuntime),
    Unavailable(Arc<str>),
}

impl ToolSearchRuntime {
    fn new(registry: Arc<ToolRegistrySnapshot>, options: &ToolSearchOptions) -> Self {
        Self {
            state: options.runtime_state(Arc::clone(&registry)),
            registry,
            definition: tool_search_definition(),
        }
    }

    fn definition(&self) -> &ProtocolToolDefinition {
        &self.definition
    }

    fn query(&self, call: &ToolCall) -> Result<ToolSearchQuery, CoreError> {
        if call.name != self.definition.name {
            return Err(CoreError::Policy(format!(
                "tool search cannot handle call for {}",
                call.name
            )));
        }
        let arguments = serde_json::from_value::<ToolSearchArguments>(call.arguments.clone())
            .map_err(|error| {
                CoreError::Policy(format!("invalid tool search arguments: {error}"))
            })?;
        let limit = arguments
            .limit
            .map(ToolSearchLimit::new)
            .transpose()
            .map_err(|error| CoreError::Policy(error.to_string()))?
            .unwrap_or_default();
        match arguments.strategy {
            ToolSearchStrategy::Bm25 => ToolSearchQuery::new(arguments.query, limit),
            ToolSearchStrategy::Regex => ToolSearchQuery::regex(arguments.query, limit),
        }
        .map_err(|error| CoreError::Policy(error.to_string()))
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        let query = self.query(call)?;
        let canonical = serde_json::to_vec(&serde_json::json!({
            "registry_generation": self.registry.generation().get(),
            "query": query.text(),
            "limit": query.limit().get(),
            "strategy": match query.syntax() {
                ToolSearchQuerySyntax::NaturalLanguage => "bm25",
                ToolSearchQuerySyntax::Regex => "regex",
            },
        }))
        .map_err(|error| CoreError::Policy(error.to_string()))?;
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(canonical),
                ActionKind::SystemOperation,
                "search the current authorized tool registry",
                CapabilitySet::new([]),
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, TOOL_SEARCH_TOOL_NAME),
            SandboxCompatibility::NotApplicable {
                reason: "tool search reads only an immutable in-process registry".into(),
            },
            ActionPolicyRevision::new(TOOL_SEARCH_POLICY_REVISION),
        ))
    }

    fn execute_selected(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        disabled: &[ToolName],
    ) -> Result<ToolExecutionOutput, CoreError> {
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        if !matches!(authorization, ToolAuthorization::UnsandboxedGrant { .. }) {
            return Err(CoreError::Policy(
                "tool search requires the host's read-only registry grant".into(),
            ));
        }
        let query = self.query(call)?;
        let result = match (&self.state, query.syntax()) {
            (ToolSearchRuntimeState::Hybrid(embedding), ToolSearchQuerySyntax::NaturalLanguage) => {
                embedding
                    .search(&query, disabled, cancellation)
                    .map_err(|error| match error {
                        ModelProviderError::Cancelled(reason) => CoreError::Cancelled(reason),
                        error => CoreError::Execution(format!(
                            "hybrid embedding tool search is unavailable: {error}"
                        )),
                    })?
            }
            (
                ToolSearchRuntimeState::Unavailable(reason),
                ToolSearchQuerySyntax::NaturalLanguage,
            ) => {
                return Err(CoreError::Execution(format!(
                    "hybrid embedding tool search is unavailable: {reason}"
                )));
            }
            (ToolSearchRuntimeState::Lexical, ToolSearchQuerySyntax::NaturalLanguage)
            | (_, ToolSearchQuerySyntax::Regex) => self.registry.search_excluding(&query, disabled),
        };
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        let output = ToolSearchOutput {
            registry_generation: result.registry_generation().get(),
            tools: result
                .matches()
                .iter()
                .filter(|matched| !disabled.contains(matched.loadable().definition().name()))
                .map(|matched| ToolSearchOutputMatch {
                    name: matched.loadable().definition().name().clone(),
                    description: matched.loadable().definition().description().to_owned(),
                    definition_digest: matched.loadable().binding().definition_digest().to_string(),
                    source_digest: Some(tool_search_source_digest(matched.loadable().binding())),
                    score: matched.score().get(),
                })
                .collect(),
        };
        serde_json::to_string(&output)
            .map(ToolExecutionOutput::Success)
            .map_err(|error| CoreError::Execution(error.to_string()))
    }

    fn activated_tool_names(
        &self,
        result: &ToolActivationResult<'_>,
    ) -> Result<Vec<ToolName>, CoreError> {
        if result.call.name != self.definition.name {
            return Ok(Vec::new());
        }
        let output = serde_json::from_str::<ToolSearchOutput>(&result.text).map_err(|error| {
            CoreError::Execution(format!("invalid durable tool search result: {error}"))
        })?;
        if result
            .binding
            .as_ref()
            .is_some_and(|binding| output.registry_generation != binding.registry_generation)
        {
            return Err(CoreError::Execution(
                "tool search result does not match its call's registry generation".into(),
            ));
        }
        let same_generation = output.registry_generation == self.registry.generation().get();
        Ok(output
            .tools
            .into_iter()
            .filter_map(|matched| {
                let entry = self.registry.resolve(&matched.name)?;
                if entry.exposure() != ToolExposure::Deferred
                    || entry.binding().definition_digest().as_str() != matched.definition_digest
                {
                    return None;
                }
                // Older results can only establish the source while their registry is current.
                let same_source = match matched.source_digest {
                    Some(digest) => digest == tool_search_source_digest(entry.binding()),
                    None => same_generation,
                };
                same_source.then_some(matched.name)
            })
            .collect())
    }
}

fn tool_search_source_digest(binding: &ToolBinding) -> ContentDigest {
    let bytes = serde_json::to_vec(binding.source_chain()).expect("serializable tool provenance");
    ContentDigest::sha256(&bytes)
}

fn discovery_tool_definitions() -> Vec<ProtocolToolDefinition> {
    let mut definitions = mcp_exposure::meta_definitions();
    definitions.push(tool_search_definition());
    definitions
}

fn tool_search_definition() -> ProtocolToolDefinition {
    ProtocolToolDefinition {
        name: ToolName::new(TOOL_SEARCH_TOOL_NAME).expect("static tool search name is valid"),
        description: "Search the current authorized tool catalog for capabilities needed by the task. Matching tools are loaded for the next model step.".into(),
        parameters: serde_json::json!({
            "type": "object",
            "properties": {
                "query": {
                    "type": "string",
                    "description": "Natural-language description of the capability to load."
                },
                "limit": {
                    "type": ["integer", "null"],
                    "minimum": 1,
                    "maximum": 32,
                    "description": "Maximum matches to load. Use null for the default."
                },
                "strategy": {
                    "type": "string",
                    "enum": ["bm25", "regex"],
                    "description": "Use bm25 for natural-language capability queries or regex for explicit catalog patterns."
                }
            },
            "required": ["query", "limit", "strategy"],
            "additionalProperties": false
        }),
        strict: true,
    }
}

fn decide_tool_search(
    request: &ActionReviewRequest,
    cancellation: &CancellationToken,
) -> Result<ExecutionDecision, CoreError> {
    cancellation
        .check()
        .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
    if request.action_policy_revision().as_str() != TOOL_SEARCH_POLICY_REVISION
        || request.provenance().source() != &ActionSource::BuiltInTool
        || request.provenance().source_id() != TOOL_SEARCH_TOOL_NAME
        || request.action().kind() != &ActionKind::SystemOperation
        || !request.action().required_capabilities().is_empty()
    {
        return Err(CoreError::Policy(
            "tool search policy rejected an action outside its read-only registry contract".into(),
        ));
    }
    Ok(ExecutionDecision::RunUnsandboxed {
        grant_id: GrantId::new("tool-search-read-only"),
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct ToolCompositionError(String);

impl std::fmt::Display for ToolCompositionError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for ToolCompositionError {}

#[cfg(test)]
#[path = "tool_composition_tests.rs"]
mod tests;

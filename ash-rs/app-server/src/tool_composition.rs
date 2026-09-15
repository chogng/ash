use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::RwLock;

use ash_action_policy::ActionDigest;
use ash_action_policy::ActionKind;
use ash_action_policy::ActionPolicyRevision;
use ash_action_policy::ActionProvenance;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::ActionSource;
use ash_action_policy::CapabilitySet;
use ash_action_policy::ExecutionDecision;
use ash_action_policy::GrantId;
use ash_action_policy::ResolvedAction;
use ash_action_policy::ReviewEvidence;
use ash_action_policy::SandboxCompatibility;
use ash_async_utils::CancellationToken;
use ash_config::ToolSearchModeConfig;
use core_api::ActionPolicyService;
use core_api::CoreError;
use ash_core::ModelToolCatalogSnapshot;
use ash_core::ToolAuthorization;
use ash_core::ToolExecutionFacts;
use ash_core::ToolOutputSink;
use ash_core::ToolService;
use ash_model_provider::EmbeddingInvoker;
use ash_model_provider::EmbeddingRequest;
use ash_protocol::ToolCall;
use ash_protocol::ToolCallBinding;
use ash_protocol::ToolCallCaller;
use ash_protocol::ToolCallId;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolExecutionOutput;
use ash_protocol::ToolName;
use ash_protocol::ToolSourceProvenance;
use ash_tools::TOOL_SEARCH_TOOL_NAME;
use ash_tools::ToolExposure;
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

use crate::tool_executor_adapter::ToolExecutorReviewer;
use crate::tool_executor_adapter::ToolExecutorRuntime;
use crate::tool_search_embedding::ToolSearchEmbeddingRuntime;

mod mcp_exposure;

use mcp_exposure::MCP_SEARCH_TOOLS_NAME;
use mcp_exposure::decide_mcp_catalog_search;
use mcp_exposure::project_mcp_service;

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
            Self::Dynamic => "client-hosted dynamic tool",
            Self::Extension => "host-installed extension tool",
            Self::Host => "product-hosted capability",
            Self::Local => "built-in directory tool",
            Self::Mcp => "MCP external tool",
        }
    }

    fn source_provenance(self, name: &ToolName) -> ToolSourceProvenance {
        match self {
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
    policy: Arc<dyn ActionPolicyService>,
}

impl ToolPort {
    pub(crate) fn environment(
        tools: Arc<dyn ToolService>,
        policy: Arc<dyn ActionPolicyService>,
    ) -> Self {
        Self::from_service(
            ToolPortKind::Environment,
            ToolExposure::Direct,
            tools,
            policy,
        )
    }

    pub(crate) fn host(tools: Arc<dyn ToolService>, policy: Arc<dyn ActionPolicyService>) -> Self {
        Self::from_service(ToolPortKind::Host, ToolExposure::Direct, tools, policy)
    }

    pub(crate) fn dynamic(
        tools: Arc<dyn ToolService>,
        policy: Arc<dyn ActionPolicyService>,
    ) -> Self {
        Self::from_service(ToolPortKind::Dynamic, ToolExposure::Direct, tools, policy)
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
            policy,
        };
        for executor in executors {
            port = port.with_executor(executor, environment_id.clone(), Arc::clone(&reviewer))?;
        }
        Ok(port)
    }

    pub(crate) fn local(tools: Arc<dyn ToolService>, policy: Arc<dyn ActionPolicyService>) -> Self {
        Self::from_service(ToolPortKind::Local, ToolExposure::Direct, tools, policy)
    }

    pub(crate) fn mcp(tools: Arc<dyn ToolService>, policy: Arc<dyn ActionPolicyService>) -> Self {
        Self::from_service(
            ToolPortKind::Mcp,
            ToolExposure::Direct,
            project_mcp_service(tools),
            policy,
        )
    }

    fn from_service(
        kind: ToolPortKind,
        exposure: ToolExposure,
        tools: Arc<dyn ToolService>,
        policy: Arc<dyn ActionPolicyService>,
    ) -> Self {
        let search = ToolSearchMetadata::new(kind.search_label())
            .expect("static App Server tool search metadata is valid");
        let contributions = tools
            .definitions()
            .into_iter()
            .map(|definition| {
                let source_chain = tools.source_provenance(&definition.name);
                ToolContribution {
                    definition,
                    exposure,
                    search: search.clone(),
                    runtime: ToolContributionRuntime::Service(Arc::clone(&tools)),
                    source_chain,
                }
            })
            .collect();
        Self {
            kind,
            contributions,
            policy,
        }
    }

    pub(crate) fn with_executor(
        mut self,
        executor: Arc<dyn ash_tools::ToolExecutor>,
        environment_id: ash_tools::EnvId,
        reviewer: Arc<dyn ToolExecutorReviewer>,
    ) -> Result<Self, ToolCompositionError> {
        let host_definition = executor.definition();
        let definition = to_protocol_tool_definition(&host_definition).map_err(|error| {
            ToolCompositionError(format!(
                "could not project executable tool '{}': {error}",
                host_definition.name()
            ))
        })?;
        let runtime = Arc::new(ToolExecutorRuntime::new(executor, environment_id, reviewer));
        let contribution = ToolContribution {
            source_chain: vec![self.kind.source_provenance(&definition.name)],
            definition,
            exposure: runtime.executor().exposure(),
            search: ToolSearchMetadata::new(self.kind.search_label())
                .expect("static App Server tool search metadata is valid"),
            runtime: ToolContributionRuntime::Executor(runtime),
        };
        if let Some(existing) = self
            .contributions
            .iter_mut()
            .find(|existing| existing.definition.name == contribution.definition.name)
        {
            if existing.exposure != ToolExposure::Hidden {
                return Err(ToolCompositionError(format!(
                    "executable tool contribution duplicates visible tool {}",
                    contribution.definition.name
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
            .find(|contribution| contribution.definition.name == *name)
            .ok_or_else(|| {
                ToolCompositionError(format!(
                    "cannot set exposure for unavailable tool contribution: {name}"
                ))
            })?;
        if let ToolContributionRuntime::Executor(runtime) = &contribution.runtime {
            let expected_loading = runtime.executor().definition().loading();
            let requested_loading = loading_for_exposure(exposure);
            if expected_loading != requested_loading {
                return Err(ToolCompositionError(format!(
                    "executable tool {name} declares {expected_loading:?} loading and cannot use {exposure:?} exposure"
                )));
            }
        }
        contribution.exposure = exposure;
        Ok(self)
    }
}

#[derive(Clone)]
struct ToolContribution {
    definition: ToolDefinition,
    exposure: ToolExposure,
    search: ToolSearchMetadata,
    runtime: ToolContributionRuntime,
    source_chain: Vec<ToolSourceProvenance>,
}

#[derive(Clone)]
enum ToolContributionRuntime {
    Service(Arc<dyn ToolService>),
    Executor(Arc<ToolExecutorRuntime>),
}

pub(crate) struct CombinedToolPorts {
    pub(crate) tools: Arc<dyn ToolService>,
    pub(crate) policy: Arc<dyn ActionPolicyService>,
}

struct ToolGeneration {
    tools: Arc<dyn ToolService>,
    policy: Arc<dyn ActionPolicyService>,
}

struct BoundToolCall {
    tools: Arc<dyn ToolService>,
    policy: Arc<dyn ActionPolicyService>,
    action_digest: Option<ActionDigest>,
}

/// Atomically switches future Tool safe points while retaining bindings for prepared calls.
pub(crate) struct ReloadableToolPorts {
    incarnation: String,
    current: RwLock<Arc<ToolGeneration>>,
    calls: Mutex<BTreeMap<ToolCallId, BoundToolCall>>,
    policies: Mutex<BTreeMap<ActionDigest, Arc<dyn ActionPolicyService>>>,
    diagnostic: Mutex<Option<String>>,
}

impl ReloadableToolPorts {
    pub(crate) fn new(initial: Option<CombinedToolPorts>) -> Arc<Self> {
        Arc::new(Self {
            incarnation: new_registry_incarnation(),
            current: RwLock::new(Arc::new(tool_generation(initial))),
            calls: Mutex::new(BTreeMap::new()),
            policies: Mutex::new(BTreeMap::new()),
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

    fn bind_call_in_generation(
        &self,
        generation: &Arc<ToolGeneration>,
        call: &ToolCall,
        caller: ToolCallCaller,
    ) -> Result<Option<ToolCallBinding>, CoreError> {
        if let Some(tools) = self
            .calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&call.id)
            .map(|binding| Arc::clone(&binding.tools))
        {
            return Ok(with_registry_incarnation(
                tools.bind_call(call, caller)?,
                &self.incarnation,
            ));
        }
        let binding =
            with_registry_incarnation(generation.tools.bind_call(call, caller)?, &self.incarnation);
        if binding.is_some() {
            self.calls
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(
                    call.id.clone(),
                    BoundToolCall {
                        tools: Arc::clone(&generation.tools),
                        policy: Arc::clone(&generation.policy),
                        action_digest: None,
                    },
                );
        }
        Ok(binding)
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

struct ReloadableToolService {
    ports: Arc<ReloadableToolPorts>,
}

impl ToolService for ReloadableToolService {
    fn definitions(&self) -> Vec<ToolDefinition> {
        self.ports.generation().tools.definitions()
    }

    fn model_definitions(
        &self,
        activated: &BTreeSet<ToolName>,
    ) -> Result<Vec<ToolDefinition>, CoreError> {
        self.ports.generation().tools.model_definitions(activated)
    }

    fn model_catalog_snapshot(
        &self,
        activated: &BTreeSet<ToolName>,
    ) -> Result<ModelToolCatalogSnapshot, CoreError> {
        let generation = self.ports.generation();
        let definitions = generation.tools.model_definitions(activated)?;
        let ports = Arc::clone(&self.ports);
        Ok(ModelToolCatalogSnapshot::with_binder(
            definitions,
            move |call, caller| ports.bind_call_in_generation(&generation, call, caller),
        ))
    }

    fn bind_call(
        &self,
        call: &ToolCall,
        caller: ToolCallCaller,
    ) -> Result<Option<ToolCallBinding>, CoreError> {
        let generation = self.ports.generation();
        self.ports
            .bind_call_in_generation(&generation, call, caller)
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
        if let Some(bound) = self
            .ports
            .calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&call.id)
        {
            return bound
                .tools
                .validate_call_binding(call, Some(&inner_binding));
        }
        self.ports
            .generation()
            .tools
            .validate_call_binding(call, Some(&inner_binding))
    }

    fn activated_tool_names(
        &self,
        call: &ToolCall,
        result: &str,
    ) -> Result<Vec<ToolName>, CoreError> {
        self.ports
            .generation()
            .tools
            .activated_tool_names(call, result)
    }

    fn execution_interaction(
        &self,
        call: &ToolCall,
    ) -> Result<Option<ash_protocol::AgentRequest>, CoreError> {
        self.bound_tools(call).execution_interaction(call)
    }

    fn resolve_execution_interaction(
        &self,
        call: &ToolCall,
        request: &ash_protocol::AgentRequest,
        response: &ash_protocol::AgentResponse,
    ) -> Result<Option<ToolExecutionOutput>, CoreError> {
        let tools = self.bound_tools(call);
        let result = tools.resolve_execution_interaction(call, request, response);
        if matches!(result, Ok(Some(_))) || result.is_err() {
            self.release(call);
        }
        result
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        self.prepare_bound(call, None)
    }

    fn prepare_with_facts(
        &self,
        call: &ToolCall,
        facts: &ToolExecutionFacts,
    ) -> Result<ActionReviewRequest, CoreError> {
        self.prepare_bound(call, Some(facts))
    }

    fn review_evidence(&self, call: &ToolCall) -> Result<Vec<ReviewEvidence>, CoreError> {
        self.bound_tools(call).review_evidence(call)
    }

    fn execute(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let tools = self.bound_tools(call);
        let result = tools.execute(call, authorization, cancellation);
        self.release_if_terminal(call, &result);
        result
    }

    fn execute_streaming(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        sink: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let tools = self.bound_tools(call);
        let result = tools.execute_streaming(call, authorization, cancellation, sink);
        self.release_if_terminal(call, &result);
        result
    }

    fn execute_with_facts(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let tools = self.bound_tools(call);
        let result = tools.execute_with_facts(call, authorization, cancellation, facts);
        self.release_if_terminal(call, &result);
        result
    }

    fn execute_streaming_with_facts(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
        sink: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let tools = self.bound_tools(call);
        let result =
            tools.execute_streaming_with_facts(call, authorization, cancellation, facts, sink);
        self.release_if_terminal(call, &result);
        result
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
        let tools = self.bound_tools(call);
        let result = tools.execute_streaming_with_facts_and_interactions(
            call,
            authorization,
            cancellation,
            facts,
            interactions,
            sink,
        );
        self.release_if_terminal(call, &result);
        result
    }
}

impl ReloadableToolService {
    fn prepare_bound(
        &self,
        call: &ToolCall,
        facts: Option<&ToolExecutionFacts>,
    ) -> Result<ActionReviewRequest, CoreError> {
        let generation = self.ports.generation();
        let (tools, policy) = self
            .ports
            .calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&call.id)
            .map(|binding| (Arc::clone(&binding.tools), Arc::clone(&binding.policy)))
            .unwrap_or_else(|| {
                (
                    Arc::clone(&generation.tools),
                    Arc::clone(&generation.policy),
                )
            });
        let request = match facts {
            Some(facts) => tools.prepare_with_facts(call, facts)?,
            None => tools.prepare(call)?,
        };
        let digest = request.action().digest().clone();
        self.ports
            .policies
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(digest.clone(), Arc::clone(&policy));
        self.ports
            .calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .entry(call.id.clone())
            .and_modify(|binding| binding.action_digest = Some(digest.clone()))
            .or_insert(BoundToolCall {
                tools,
                policy,
                action_digest: Some(digest),
            });
        Ok(request)
    }

    fn bound_tools(&self, call: &ToolCall) -> Arc<dyn ToolService> {
        self.ports
            .calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(&call.id)
            .map(|binding| Arc::clone(&binding.tools))
            .unwrap_or_else(|| Arc::clone(&self.ports.generation().tools))
    }

    fn release(&self, call: &ToolCall) {
        let binding = self
            .ports
            .calls
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .remove(&call.id);
        if let Some(binding) = binding
            && let Some(action_digest) = binding.action_digest
        {
            self.ports
                .policies
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .remove(&action_digest);
        }
    }

    fn release_if_terminal(
        &self,
        call: &ToolCall,
        result: &Result<ToolExecutionOutput, CoreError>,
    ) {
        if !matches!(result, Ok(ToolExecutionOutput::SandboxDenied(_))) {
            self.release(call);
        }
    }
}

struct ReloadableActionPolicyService {
    ports: Arc<ReloadableToolPorts>,
}

impl ActionPolicyService for ReloadableActionPolicyService {
    fn revision(&self) -> String {
        self.ports.generation().policy.revision()
    }

    fn decide(
        &self,
        request: &ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ExecutionDecision, CoreError> {
        let policy = self
            .ports
            .policies
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(request.action().digest())
            .cloned()
            .unwrap_or_else(|| Arc::clone(&self.ports.generation().policy));
        policy.decide(request, cancellation)
    }
}

fn tool_generation(combined: Option<CombinedToolPorts>) -> ToolGeneration {
    match combined {
        Some(combined) => ToolGeneration {
            tools: combined.tools,
            policy: combined.policy,
        },
        None => ToolGeneration {
            tools: Arc::new(EmptyToolService),
            policy: Arc::new(EmptyActionPolicyService),
        },
    }
}

struct EmptyToolService;

impl ToolService for EmptyToolService {
    fn definitions(&self) -> Vec<ToolDefinition> {
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
    let mut names = BTreeSet::new();
    let mut local_policy = None;
    let mut mcp_policy = None;
    let mut dynamic_policy = None;
    let mut extension_policy = None;
    let mut host_policy = None;
    let mut environment_policy = None;
    for (service_index, port) in ports.into_iter().enumerate() {
        for contribution in port.contributions {
            if !names.insert(contribution.definition.name.clone()) {
                return Err(ToolCompositionError(format!(
                    "duplicate model tool name during App Server composition: {}",
                    contribution.definition.name
                )));
            }
            definitions.push(CollectedToolDefinition {
                contribution,
                kind: port.kind,
                service_index,
            });
        }
        match port.kind {
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
    let (registry, routes) = build_registry(registry_generation, &definitions)?;
    let protocol_definitions = definitions
        .into_iter()
        .map(|collected| collected.contribution.definition)
        .collect::<Vec<_>>();
    let search = registry
        .has_deferred_tools()
        .then(|| ToolSearchRuntime::new(Arc::clone(&registry), &search_options));
    let search_enabled = search.is_some();
    Ok(Some(CombinedToolPorts {
        tools: Arc::new(CompositeToolService {
            definitions: protocol_definitions,
            routes,
            registry,
            search,
        }),
        policy: Arc::new(CompositeActionPolicyService {
            dynamic: dynamic_policy,
            extension: extension_policy,
            host: host_policy,
            environment: environment_policy,
            local: local_policy,
            mcp: mcp_policy,
            search_enabled,
        }),
    }))
}

struct CollectedToolDefinition {
    contribution: ToolContribution,
    kind: ToolPortKind,
    service_index: usize,
}

fn build_registry(
    generation: ToolRegistryGeneration,
    definitions: &[CollectedToolDefinition],
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
        let loading = loading_for_exposure(collected.contribution.exposure);
        let host_definition =
            from_protocol_tool_definition(&collected.contribution.definition, loading).map_err(
                |error| {
                    ToolCompositionError(format!(
                        "could not validate model tool '{}': {error}",
                        collected.contribution.definition.name
                    ))
                },
            )?;
        let runtime_key = ToolRuntimeKey::new(format!(
            "{}:{}:{}",
            collected.kind.runtime_namespace(),
            collected.service_index,
            collected.contribution.definition.name
        ))
        .map_err(|error| ToolCompositionError(error.to_string()))?;
        if routes
            .insert(runtime_key.clone(), collected.contribution.runtime.clone())
            .is_some()
        {
            return Err(ToolCompositionError(format!(
                "duplicate runtime route during App Server composition: {runtime_key}"
            )));
        }
        builder
            .register(
                ToolRegistryRegistration::new(
                    host_definition,
                    runtime_key,
                    collected.contribution.exposure,
                    collected.contribution.search.clone(),
                )
                .map_err(|error| ToolCompositionError(error.to_string()))?
                .with_source_chain(
                    if collected.contribution.source_chain.is_empty() {
                        vec![
                            collected
                                .kind
                                .source_provenance(&collected.contribution.definition.name),
                        ]
                    } else {
                        collected.contribution.source_chain.clone()
                    },
                ),
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
    definitions: Vec<ToolDefinition>,
    routes: BTreeMap<ToolRuntimeKey, ToolContributionRuntime>,
    registry: Arc<ToolRegistrySnapshot>,
    search: Option<ToolSearchRuntime>,
}

impl CompositeToolService {
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

impl ToolService for CompositeToolService {
    fn definitions(&self) -> Vec<ToolDefinition> {
        let mut definitions = self.definitions.clone();
        if let Some(search) = &self.search {
            definitions.push(search.definition().clone());
        }
        definitions
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
                caller,
            }));
        }
        let (binding, _) = self.runtime(call)?;
        Ok(Some(ToolCallBinding {
            registry_incarnation: None,
            registry_generation: binding.registry_generation().get(),
            definition_digest: binding.definition_digest().to_string(),
            source_chain: binding.source_chain().to_vec(),
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
        if &expected != binding {
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
    ) -> Result<Vec<ToolDefinition>, CoreError> {
        let by_name = self
            .definitions
            .iter()
            .map(|definition| (definition.name.clone(), definition))
            .collect::<BTreeMap<_, _>>();
        let mut definitions = self
            .registry
            .model_definitions(activated)
            .map(|definition| {
                by_name
                    .get(definition.name())
                    .cloned()
                    .cloned()
                    .ok_or_else(|| {
                        CoreError::Execution(format!(
                            "registry model definition is unavailable: {}",
                            definition.name()
                        ))
                    })
            })
            .collect::<Result<Vec<_>, _>>()?;
        if let Some(search) = &self.search {
            definitions.push(search.definition().clone());
        }
        Ok(definitions)
    }

    fn activated_tool_names(
        &self,
        call: &ToolCall,
        result: &str,
    ) -> Result<Vec<ToolName>, CoreError> {
        match &self.search {
            Some(search) => search.activated_tool_names(call, result),
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
        if let Some(search) = &self.search
            && call.name == search.definition().name
        {
            return search.execute(call, authorization, cancellation);
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
        if let Some(search) = &self.search
            && call.name == search.definition().name
        {
            return search.execute(call, authorization, cancellation);
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
        if let Some(search) = &self.search
            && call.name == search.definition().name
        {
            return search.execute(call, authorization, cancellation);
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
        if let Some(search) = &self.search
            && call.name == search.definition().name
        {
            return search.execute(call, authorization, cancellation);
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
        if let Some(search) = &self.search
            && call.name == search.definition().name
        {
            return search.execute(call, authorization, cancellation);
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
    local: Option<Arc<dyn ActionPolicyService>>,
    mcp: Option<Arc<dyn ActionPolicyService>>,
    search_enabled: bool,
}

impl ActionPolicyService for CompositeActionPolicyService {
    fn revision(&self) -> String {
        format!(
            "composite-policy-v1:environment={}:dynamic={}:extension={}:host={}:local={}:mcp={}:tool-search={}",
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
                if request.provenance().source_id().starts_with("browser_") =>
            {
                self.host.as_ref()
            }
            ActionSource::BuiltInTool if request.provenance().source_id() == "environment" => {
                self.environment.as_ref()
            }
            ActionSource::BuiltInTool => self.local.as_ref(),
            ActionSource::McpServer => self.mcp.as_ref(),
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
    score: u64,
}

struct ToolSearchRuntime {
    registry: Arc<ToolRegistrySnapshot>,
    definition: ToolDefinition,
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

    fn definition(&self) -> &ToolDefinition {
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

    fn execute(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
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
                embedding.search(&query).map_err(|error| {
                    CoreError::Execution(format!(
                        "hybrid embedding tool search is unavailable: {error}"
                    ))
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
            | (_, ToolSearchQuerySyntax::Regex) => self.registry.search(&query),
        };
        let output = ToolSearchOutput {
            registry_generation: result.registry_generation().get(),
            tools: result
                .matches()
                .iter()
                .map(|matched| ToolSearchOutputMatch {
                    name: matched.loadable().definition().name().clone(),
                    description: matched.loadable().definition().description().to_owned(),
                    definition_digest: matched.loadable().binding().definition_digest().to_string(),
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
        call: &ToolCall,
        result: &str,
    ) -> Result<Vec<ToolName>, CoreError> {
        if call.name != self.definition.name {
            return Ok(Vec::new());
        }
        let output = serde_json::from_str::<ToolSearchOutput>(result).map_err(|error| {
            CoreError::Execution(format!("invalid durable tool search result: {error}"))
        })?;
        if output.registry_generation != self.registry.generation().get() {
            return Err(CoreError::Execution(format!(
                "tool search result belongs to registry generation {}, current generation is {}",
                output.registry_generation,
                self.registry.generation()
            )));
        }
        output
            .tools
            .into_iter()
            .map(|matched| {
                let entry = self.registry.resolve(&matched.name).ok_or_else(|| {
                    CoreError::Execution(format!(
                        "tool search returned unavailable tool {}",
                        matched.name
                    ))
                })?;
                if entry.exposure() != ToolExposure::Deferred
                    || entry.binding().definition_digest().as_str() != matched.definition_digest
                {
                    return Err(CoreError::Execution(format!(
                        "tool search binding validation failed for {}",
                        matched.name
                    )));
                }
                Ok(matched.name)
            })
            .collect()
    }
}

fn tool_search_definition() -> ToolDefinition {
    ToolDefinition {
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

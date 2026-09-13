use crate::ContextBudget;
use crate::ContextTokenMeasurementCapability;
use crate::ContextTokenMeasurementOutcome;
use crate::CoreError;
use sha2::Digest;
use sha2::Sha256;
use std::collections::BTreeSet;
use std::path::PathBuf;
use std::sync::Arc;
use ash_action_policy::ActionReviewRequest;
use ash_action_policy::AutoReviewGrant;
use ash_action_policy::DeterministicPolicyGrant;
use ash_action_policy::GrantId;
use ash_action_policy::PermissionBypassGrant;
use ash_action_policy::ReviewEvidence;
use ash_async_utils::CancellationToken;
use ash_protocol::ActionApprovalRequest;
use ash_protocol::InteractionCancelReason;
use ash_protocol::ModelBillingScope;
use ash_protocol::ModelRef;
use ash_protocol::ModelRequest;
use ash_protocol::ModelResponse;
use ash_protocol::ModelStreamEvent;
use ash_protocol::ReasoningConfig;
use ash_protocol::RequestId;
use ash_protocol::RequestUserInput;
use ash_protocol::RequestUserInputResponse;
use ash_protocol::ThreadUpdateEnvelope;
use ash_protocol::ToolCall;
use ash_protocol::ToolCallBinding;
use ash_protocol::ToolCallCaller;
use ash_protocol::ToolCallId;
use ash_protocol::ToolDefinition;
use ash_protocol::ToolExecutionOutput;
use ash_protocol::ToolOutputStream;
use ash_protocol::ToolSourceProvenance;
use ash_sandboxing::SandboxPolicy;

/// Pixel and patch ceilings applied to one ephemeral provider-bound image clone.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ModelImageInputLimits {
    pub max_dimension: u32,
    pub max_patches: usize,
}

impl ModelImageInputLimits {
    pub const fn new(max_dimension: u32, max_patches: usize) -> Self {
        Self {
            max_dimension,
            max_patches,
        }
    }
}

/// Provider/model-specific image limits selected before attachment materialization.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ModelImageInputPolicy {
    auto: ModelImageInputLimits,
    low: ModelImageInputLimits,
    high: ModelImageInputLimits,
    original: ModelImageInputLimits,
}

impl ModelImageInputPolicy {
    pub const fn new(
        auto: ModelImageInputLimits,
        low: ModelImageInputLimits,
        high: ModelImageInputLimits,
        original: ModelImageInputLimits,
    ) -> Self {
        Self {
            auto,
            low,
            high,
            original,
        }
    }

    pub const fn limits_for(self, detail: ash_protocol::ImageDetail) -> ModelImageInputLimits {
        match detail {
            ash_protocol::ImageDetail::Auto => self.auto,
            ash_protocol::ImageDetail::Low => self.low,
            ash_protocol::ImageDetail::High => self.high,
            ash_protocol::ImageDetail::Original => self.original,
        }
    }
}

impl Default for ModelImageInputPolicy {
    fn default() -> Self {
        const LOW: ModelImageInputLimits = ModelImageInputLimits::new(512, 256);
        const STANDARD: ModelImageInputLimits = ModelImageInputLimits::new(2_048, 1_536);
        Self::new(STANDARD, LOW, STANDARD, STANDARD)
    }
}

/// Holds a process-local or inter-process write lock for a Thread.
///
/// Implementations release their underlying lease when the guard is dropped and must never let
/// two live guards represent concurrent writers for the same Thread.
pub trait LeaseGuard: Send {}

/// Arbitrates exclusive write access to one durable aggregate identity.
///
/// Implementations must scope leases by both the concrete ID type and value, reject competing
/// writers, and return a guard that holds the lease for the complete mutation.
pub trait WriterLease<Id>: Send + Sync {
    fn acquire(&self, id: &Id) -> Result<Box<dyn LeaseGuard>, CoreError>;
}

/// Receives provider-neutral incremental output for one model invocation.
///
/// Implementations must preserve event order and should return an error when the receiving
/// execution can no longer safely consume a delta, such as after cancellation.
pub trait ModelStreamSink {
    fn emit(&mut self, event: ModelStreamEvent) -> Result<(), CoreError>;
}

/// Selects the immutable model runtime used for one Turn.
///
/// Legacy Sessions without a durable selection use the resolved configuration default. New
/// Sessions pass their snapshotted model explicitly so later configuration or Session changes
/// cannot alter an already-started Turn.
#[derive(Clone, Copy)]
pub enum ModelSelection<'a> {
    ConfiguredDefault,
    Session(&'a ModelRef),
}

/// Executes one provider-independent model invocation.
///
/// Implementations receive a complete immutable request assembled by Core. They must not read
/// Thread state or mutable product configuration. Implementations should observe `cancellation`
/// before beginning expensive work and at every safe checkpoint supported by their transport.
pub trait ModelService: Send + Sync {
    /// Returns the verified billing surface for the selected immutable runtime.
    fn billing_scope(&self, _: ModelSelection<'_>) -> Result<ModelBillingScope, CoreError> {
        Ok(ModelBillingScope::Unavailable)
    }

    /// Returns the immutable context budget for the selected model invocation.
    ///
    /// Implementations should return a Core-managed budget only when the model window and product
    /// output reservation are known. Unknown or unlisted models retain provider-managed overflow
    /// behavior rather than receiving a fabricated context limit.
    fn context_budget(&self, _: ModelSelection<'_>) -> Result<ContextBudget, CoreError> {
        Ok(ContextBudget::provider_managed())
    }

    /// Returns the provider/model image limits used only for the outbound request clone.
    ///
    /// Unknown adapters use a conservative product default. Implementations that can resolve an
    /// immutable provider/model snapshot should override this with that snapshot's declared
    /// policy; durable attachment bytes are never changed by this operation.
    fn image_input_policy(
        &self,
        _: ModelSelection<'_>,
    ) -> Result<ModelImageInputPolicy, CoreError> {
        Ok(ModelImageInputPolicy::default())
    }

    /// Reports whether the selected immutable model can measure input locally or remotely.
    fn reasoning_config(
        &self,
        _: ModelSelection<'_>,
    ) -> Result<Option<ReasoningConfig>, CoreError> {
        Ok(None)
    }

    /// Reports whether the selected immutable model can measure input locally or remotely.
    fn input_token_measurement_capability(
        &self,
        _: ModelSelection<'_>,
    ) -> Result<ContextTokenMeasurementCapability, CoreError> {
        Ok(ContextTokenMeasurementCapability::Unavailable)
    }

    /// Measures one fully assembled candidate request before invocation.
    ///
    /// Implementations must measure the same immutable model and canonical request snapshot that
    /// [`Self::invoke`] receives. Post-response usage does not satisfy this contract.
    fn measure_input(
        &self,
        _: ModelSelection<'_>,
        _: &ModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<ContextTokenMeasurementOutcome, CoreError> {
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        Ok(ContextTokenMeasurementOutcome::Unavailable)
    }

    fn invoke(
        &self,
        selection: ModelSelection<'_>,
        request: &ModelRequest,
        cancellation: &CancellationToken,
    ) -> Result<ModelResponse, CoreError>;

    /// Returns the authoritative result and delivers incremental output when the service supports it.
    /// Synchronous services return only the result. They never synthesize deltas from completed text.
    fn stream(
        &self,
        selection: ModelSelection<'_>,
        request: &ModelRequest,
        cancellation: &CancellationToken,
        _: &mut dyn ModelStreamSink,
    ) -> Result<ModelResponse, CoreError> {
        self.invoke(selection, request, cancellation)
    }
}

/// Publishes a Core-produced Thread update to an outer subscription transport.
///
/// Implementations must treat transient updates as best-effort and must not block durable Core
/// commits on a slow client connection. Durable updates can always be replayed from the store.
pub trait ThreadUpdateSink: Send + Sync {
    fn publish(&self, update: ThreadUpdateEnvelope);
}

pub use ash_extension_api::ContextEvidence;
pub use ash_extension_api::ContextSourceRequest;

/// Supplies optional, low-trust evidence without owning context ordering or budget policy.
///
/// Implementations must return bounded data, preserve revision/provenance identities, observe
/// cancellation, and avoid mutating Thread state. Core treats all returned bodies as untrusted
/// user-level data and may omit them under budget pressure.
pub trait ContextSource: Send + Sync {
    fn collect(
        &self,
        request: &ContextSourceRequest<'_>,
        cancellation: &CancellationToken,
    ) -> Result<Vec<ContextEvidence>, CoreError>;
}

/// Receives transient, typed output from one running Tool Call.
///
/// Implementations publish best-effort output only. The durable Tool Result remains the
/// authoritative replay and recovery boundary.
pub trait ToolOutputSink {
    fn emit(&mut self, stream: ToolOutputStream, text: String) -> Result<(), CoreError>;
}

/// Durable outcome of one user-input request raised while a Tool Call is already running.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolUserInputOutcome {
    Answered(RequestUserInputResponse),
    Cancelled(InteractionCancelReason),
}

/// Core-owned interaction port available to a running Tool Call.
///
/// Implementations durably commit and route requests through the current Thread authority, then
/// wait for the exact response or cancellation. Tool services must never mutate Thread state or
/// contact product clients directly.
pub trait ToolInteractionService: Send + Sync {
    /// Applies the Turn's final policy to a live network request and, when needed, awaits one
    /// exact durable approval. Approval never changes the running process's sandbox.
    fn approve_network(
        &self,
        request: &ash_action_policy::ActionReviewRequest,
        cancellation: &CancellationToken,
    ) -> Result<ash_protocol::ActionApprovalDecision, CoreError>;

    fn request_user_input(
        &self,
        request: RequestUserInput,
    ) -> Result<ToolUserInputOutcome, CoreError>;
}

/// Update sink used by hosts that do not expose live Thread subscriptions.
pub struct NoThreadUpdates;

impl ThreadUpdateSink for NoThreadUpdates {
    fn publish(&self, _: ThreadUpdateEnvelope) {}
}

/// Explicit authority under which a prepared tool call may execute.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolAuthorization {
    Sandboxed(SandboxPolicy),
    UnsandboxedGrant { grant_id: GrantId },
    ExecPolicyGranted(ExecPolicyToolGrant),
    AutoReviewed(AutoReviewedToolGrant),
    PermissionBypassed(PermissionBypassToolGrant),
    ApprovedOnce(OneTimeToolGrant),
}

/// Non-reusable deterministic-policy authority bound to one exact durable Tool Call.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ExecPolicyToolGrant {
    tool_call_id: ToolCallId,
    policy_grant: DeterministicPolicyGrant,
}

impl ExecPolicyToolGrant {
    pub(crate) fn new(tool_call_id: ToolCallId, policy_grant: DeterministicPolicyGrant) -> Self {
        Self {
            tool_call_id,
            policy_grant,
        }
    }

    pub fn tool_call_id(&self) -> &ToolCallId {
        &self.tool_call_id
    }

    pub fn policy_grant(&self) -> &DeterministicPolicyGrant {
        &self.policy_grant
    }
}

type ModelToolCallBinder =
    dyn Fn(&ToolCall, ToolCallCaller) -> Result<Option<ToolCallBinding>, CoreError> + Send + Sync;

/// Frozen tool catalog selected for one model invocation safe point.
///
/// Reloadable registries attach a binder that resolves model-produced calls against this exact
/// catalog generation. Static services may omit the binder and let Core use their ordinary live
/// binding method because their definitions cannot change during the invocation.
pub struct ModelToolCatalogSnapshot {
    definitions: Vec<ToolDefinition>,
    binder: Option<Arc<ModelToolCallBinder>>,
}

impl ModelToolCatalogSnapshot {
    /// Freezes one static catalog that continues to use the service's ordinary binder.
    pub fn new(definitions: Vec<ToolDefinition>) -> Self {
        Self {
            definitions,
            binder: None,
        }
    }

    /// Freezes a reloadable catalog with the exact binder that produced its definitions.
    pub fn with_binder(
        definitions: Vec<ToolDefinition>,
        binder: impl Fn(&ToolCall, ToolCallCaller) -> Result<Option<ToolCallBinding>, CoreError>
        + Send
        + Sync
        + 'static,
    ) -> Self {
        Self {
            definitions,
            binder: Some(Arc::new(binder)),
        }
    }

    /// Returns the definitions visible to this model invocation.
    pub fn definitions(&self) -> &[ToolDefinition] {
        &self.definitions
    }

    /// Restricts a host-selected invocation while preserving its exact catalog binder.
    pub(crate) fn restrict_to_names(mut self, names: &[ash_protocol::ToolName]) -> Self {
        self.definitions
            .retain(|definition| names.contains(&definition.name));
        self
    }

    /// Appends definitions owned by Core while preserving the frozen binder for ordinary tools.
    #[cfg(feature = "code-mode")]
    pub(crate) fn with_additional_definitions(
        mut self,
        mut definitions: Vec<ToolDefinition>,
    ) -> Self {
        self.definitions.append(&mut definitions);
        self
    }

    /// Uses the frozen binder when the service supplied one.
    ///
    /// `None` means Core must use the static service's ordinary `bind_call` implementation.
    pub fn bind_call(
        &self,
        call: &ToolCall,
        caller: ToolCallCaller,
    ) -> Option<Result<Option<ToolCallBinding>, CoreError>> {
        if !self
            .definitions
            .iter()
            .any(|definition| definition.name == call.name)
        {
            return Some(Err(CoreError::Policy(format!(
                "Tool '{}' is not available in this frozen invocation",
                call.name
            ))));
        }
        self.binder.as_ref().map(|binder| binder(call, caller))
    }
}

/// Non-reusable automatic-review authority bound to one exact durable Tool Call.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AutoReviewedToolGrant {
    tool_call_id: ToolCallId,
    policy_grant: AutoReviewGrant,
}

impl AutoReviewedToolGrant {
    pub(crate) fn new(tool_call_id: ToolCallId, policy_grant: AutoReviewGrant) -> Self {
        Self {
            tool_call_id,
            policy_grant,
        }
    }

    pub fn tool_call_id(&self) -> &ToolCallId {
        &self.tool_call_id
    }

    pub fn policy_grant(&self) -> &AutoReviewGrant {
        &self.policy_grant
    }
}

/// Non-reusable permission-bypass authority bound to one exact durable Tool Call.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PermissionBypassToolGrant {
    tool_call_id: ToolCallId,
    policy_grant: PermissionBypassGrant,
}

impl PermissionBypassToolGrant {
    pub(crate) fn new(tool_call_id: ToolCallId, policy_grant: PermissionBypassGrant) -> Self {
        Self {
            tool_call_id,
            policy_grant,
        }
    }

    pub fn tool_call_id(&self) -> &ToolCallId {
        &self.tool_call_id
    }

    pub fn policy_grant(&self) -> &PermissionBypassGrant {
        &self.policy_grant
    }
}

/// A non-reusable user grant bound to one durable interaction and exact Tool Call.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OneTimeToolGrant {
    request_id: RequestId,
    tool_call_id: ToolCallId,
    approval: ActionApprovalRequest,
}

impl OneTimeToolGrant {
    pub(crate) fn new(
        request_id: RequestId,
        tool_call_id: ToolCallId,
        approval: ActionApprovalRequest,
    ) -> Self {
        Self {
            request_id,
            tool_call_id,
            approval,
        }
    }

    pub fn request_id(&self) -> &RequestId {
        &self.request_id
    }

    pub fn tool_call_id(&self) -> &ToolCallId {
        &self.tool_call_id
    }

    pub fn approval(&self) -> &ActionApprovalRequest {
        &self.approval
    }
}

/// Executes tools selected and durably recorded by Core.
///
/// Implementations expose immutable definitions and execute only the exact materialized call
/// passed by Core. They must enforce their sandbox and resource policy, preserve the call ID, and
/// never mutate Thread state directly.
pub trait ToolService: Send + Sync {
    fn definitions(&self) -> Vec<ToolDefinition>;

    /// Freezes the exact host definition and stable source chain selected for a model Tool Call.
    ///
    /// The default bridge hashes the canonical protocol definition at generation zero. A
    /// generation-bound registry must override this method with its exact definition digest and
    /// stable source chain before Core commits the call.
    fn bind_call(
        &self,
        call: &ToolCall,
        caller: ToolCallCaller,
    ) -> Result<Option<ToolCallBinding>, CoreError> {
        let definition = self
            .definitions()
            .into_iter()
            .find(|definition| definition.name == call.name)
            .ok_or_else(|| {
                CoreError::Execution(format!("tool definition is unavailable: {}", call.name))
            })?;
        let canonical = serde_json::to_vec(&definition)
            .map_err(|error| CoreError::Execution(error.to_string()))?;
        let source_chain = self.source_provenance(&call.name);
        Ok(Some(ToolCallBinding {
            registry_incarnation: None,
            registry_generation: 0,
            definition_digest: format!("sha256:{:x}", Sha256::digest(canonical)),
            source_chain: if source_chain.is_empty() {
                vec![ToolSourceProvenance::System {
                    id: "tool-service".into(),
                }]
            } else {
                source_chain
            },
            caller,
        }))
    }

    /// Verifies that a durable call still maps to the exact frozen definition and source chain.
    ///
    /// Implementations must not silently accept a same-named tool from a newer generation.
    fn validate_call_binding(
        &self,
        call: &ToolCall,
        binding: Option<&ToolCallBinding>,
    ) -> Result<(), CoreError> {
        let Some(binding) = binding else {
            return Ok(());
        };
        let expected = self
            .bind_call(call, binding.caller.clone())?
            .ok_or_else(|| CoreError::Execution("tool binding is unavailable".into()))?;
        if &expected != binding {
            return Err(CoreError::Execution(format!(
                "tool {} no longer matches its durable definition and source binding",
                call.name
            )));
        }
        Ok(())
    }

    /// Returns a stable, secret-free source chain for a callable tool definition.
    fn source_provenance(&self, _: &ash_protocol::ToolName) -> Vec<ToolSourceProvenance> {
        Vec::new()
    }

    /// Selects the exact definitions visible to the next model invocation.
    ///
    /// Implementations with no deferred catalog retain the complete definition set. Registry-backed
    /// implementations must include their direct tools and may additionally expose only the
    /// generation-validated names supplied in `activated`.
    fn model_definitions(
        &self,
        activated: &BTreeSet<ash_protocol::ToolName>,
    ) -> Result<Vec<ToolDefinition>, CoreError> {
        let _ = activated;
        Ok(self.definitions())
    }

    /// Freezes definitions and optional generation-bound binding authority for one model call.
    ///
    /// A reloadable implementation must override this method so a registry publication between
    /// model request and response cannot rebind a returned call to a newer same-named tool.
    fn model_catalog_snapshot(
        &self,
        activated: &BTreeSet<ash_protocol::ToolName>,
    ) -> Result<ModelToolCatalogSnapshot, CoreError> {
        Ok(ModelToolCatalogSnapshot::new(
            self.model_definitions(activated)?,
        ))
    }

    /// Interprets one successful tool result as additive model-tool activation.
    ///
    /// Ordinary tools return no names. A tool-search implementation must validate its own result,
    /// registry generation, binding identity, and definition digest before returning names. This
    /// method never executes a tool or changes the live registry.
    fn activated_tool_names(
        &self,
        _: &ToolCall,
        _: &str,
    ) -> Result<Vec<ash_protocol::ToolName>, CoreError> {
        Ok(Vec::new())
    }

    /// Returns a durable client interaction required to execute this exact Tool Call.
    ///
    /// Ordinary host and MCP tools return `None`. Dynamic tools return a request carrying the same
    /// Tool Call identity. Core persists and routes the request only after policy authorization;
    /// implementations must not contact a client or perform the action from this method.
    fn execution_interaction(
        &self,
        _: &ToolCall,
    ) -> Result<Option<ash_protocol::AgentRequest>, CoreError> {
        Ok(None)
    }

    /// Converts a resolved execution interaction into the canonical Tool execution outcome.
    ///
    /// Implementations must validate request kind, Tool Call identity, and output shape. Returning
    /// `None` declares that the response is not owned by this tool service.
    fn resolve_execution_interaction(
        &self,
        _: &ToolCall,
        _: &ash_protocol::AgentRequest,
        _: &ash_protocol::AgentResponse,
    ) -> Result<Option<ToolExecutionOutput>, CoreError> {
        Ok(None)
    }

    /// Materializes every security-relevant field before policy review.
    ///
    /// Implementations must resolve aliases, paths, executable identity, provenance, required
    /// capabilities, and sandbox compatibility without causing the requested side effect.
    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError>;

    /// Materializes a call using the durable Session and Turn identity that will execute it.
    ///
    /// Session-scoped services use this hook when their authorized resource set cannot be selected
    /// safely from the Tool Call alone. Other services retain the ordinary preparation path.
    fn prepare_with_facts(
        &self,
        call: &ToolCall,
        _: &ToolExecutionFacts,
    ) -> Result<ActionReviewRequest, CoreError> {
        self.prepare(call)
    }

    /// Collects bounded, secret-free evidence needed to interpret an otherwise opaque action.
    ///
    /// Implementations may inspect local state but must not perform the proposed action, use
    /// credentials, access the network, or mutate anything. Repository and file contents must be
    /// labeled as untrusted evidence by their constructors.
    fn review_evidence(&self, _: &ToolCall) -> Result<Vec<ReviewEvidence>, CoreError> {
        Ok(Vec::new())
    }

    /// Executes under the exact selected authority and reports a protocol-owned outcome.
    ///
    /// `SandboxDenied` is valid only for `Sandboxed` authority and must distinguish an ordinary
    /// command failure from backend enforcement. `SafeToRetry` additionally guarantees that the
    /// requested child action did not begin; otherwise implementations must report
    /// `MayHaveSideEffects` or `OutcomeUnknown`. An `Err` after invocation begins is treated as an
    /// unknown outcome and is never automatically replayed.
    fn execute(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError>;

    /// Executes a Tool Call with durable facts derived from the current Thread transcript.
    ///
    /// File-mutating implementations use these facts to enforce read-before-write without
    /// coupling the tool layer to Thread storage. Existing tools may retain the default bridge.
    fn execute_with_facts(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        _: &ToolExecutionFacts,
    ) -> Result<ToolExecutionOutput, CoreError> {
        self.execute(call, authorization, cancellation)
    }

    /// Executes a Tool Call while optionally publishing typed transient output.
    ///
    /// Services without an incremental transport retain the default terminal-only behavior.
    fn execute_streaming(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        _: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        self.execute(call, authorization, cancellation)
    }

    /// Streaming counterpart to [`ToolService::execute_with_facts`].
    fn execute_streaming_with_facts(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
        sink: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let _ = facts;
        self.execute_streaming(call, authorization, cancellation, sink)
    }

    /// Executes with durable facts, transient output, and Core-owned live interaction routing.
    ///
    /// Services that do not initiate interactions retain the existing streaming bridge.
    fn execute_streaming_with_facts_and_interactions(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
        _: Arc<dyn ToolInteractionService>,
        sink: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        self.execute_streaming_with_facts(call, authorization, cancellation, facts, sink)
    }
}

/// Durable execution identity and transcript-derived facts supplied to Tool services.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct ToolExecutionFacts {
    execution: Option<ToolExecutionIdentity>,
    read_paths: BTreeSet<PathBuf>,
    available_tools: BTreeSet<ash_protocol::ToolName>,
    delegation_tools: BTreeSet<ash_protocol::ToolName>,
    activated_skills: Vec<ash_protocol::FrozenSkillActivation>,
}

/// Returns paths confirmed by successful `read_file` calls in this Turn.
pub(crate) fn read_paths_for_turn(
    snapshot: &crate::ThreadSnapshot,
    turn_id: &ash_protocol::TurnId,
) -> Vec<PathBuf> {
    successful_read_paths(snapshot.items.iter().filter(|item| item.turn_id() == turn_id))
        .into_iter()
        .collect()
}

fn successful_read_paths<'a>(
    items: impl IntoIterator<Item = &'a ash_protocol::ThreadItem>,
) -> BTreeSet<PathBuf> {
    let mut calls = std::collections::BTreeMap::new();
    let mut paths = BTreeSet::new();
    for item in items {
        match item {
            ash_protocol::ThreadItem::ToolCall {
                tool_call_id,
                name,
                arguments_json,
                ..
            } => {
                if name.as_str() == "read_file"
                    && let Ok(arguments) =
                        serde_json::from_str::<serde_json::Value>(arguments_json)
                    && let Some(path) = arguments.get("path").and_then(serde_json::Value::as_str)
                {
                    calls.insert(tool_call_id.clone(), PathBuf::from(path));
                }
            }
            ash_protocol::ThreadItem::ToolResult {
                tool_call_id,
                is_error: false,
                ..
            } => {
                if let Some(path) = calls.get(tool_call_id) {
                    paths.insert(path.clone());
                }
            }
            _ => {}
        }
    }
    paths
}

impl ToolExecutionFacts {
    pub(crate) fn for_turn(
        snapshot: &crate::ThreadSnapshot,
        turn_id: &ash_protocol::TurnId,
        available_tools: impl IntoIterator<Item = ash_protocol::ToolName>,
    ) -> Result<Self, CoreError> {
        let turn = snapshot
            .turns
            .iter()
            .find(|turn| &turn.turn_id == turn_id)
            .ok_or_else(|| CoreError::NotFound(turn_id.to_string()))?;
        let mut host_tools = available_tools.into_iter().collect::<BTreeSet<_>>();
        if turn.tool_mode.requires_code_mode() {
            host_tools.insert(
                ash_protocol::ToolName::new("exec").expect("Code Mode Tool name is valid"),
            );
            host_tools.insert(
                ash_protocol::ToolName::new("wait").expect("Code Mode Tool name is valid"),
            );
        }
        let (available_tools, delegation_tools) = match snapshot.agent_configuration() {
            Some(seed) => {
                let own_ceiling = seed.capability_scope.tools.iter().collect::<BTreeSet<_>>();
                let delegation_ceiling = seed
                    .capability_scope
                    .delegation_tools
                    .iter()
                    .collect::<BTreeSet<_>>();
                (
                    host_tools
                        .iter()
                        .filter(|name| {
                            own_ceiling.contains(name)
                                || (!own_ceiling.is_empty()
                                    && turn.tool_mode.requires_code_mode()
                                    && matches!(name.as_str(), "exec" | "wait"))
                        })
                        .cloned()
                        .collect(),
                    host_tools
                        .iter()
                        .filter(|name| delegation_ceiling.contains(name))
                        .cloned()
                        .collect(),
                )
            }
            None => (host_tools.clone(), host_tools),
        };
        let facts = Self {
            execution: Some(ToolExecutionIdentity {
                session_id: snapshot.session_id.clone(),
                thread_id: snapshot.thread_id.clone(),
                turn_id: turn_id.clone(),
                model: turn.model.clone(),
                policy_revision: turn.policy_revision.clone(),
                tool_profile: turn.tool_profile.clone(),
            }),
            read_paths: successful_read_paths(snapshot.items.iter()),
            available_tools,
            delegation_tools,
            activated_skills: turn.activated_skills.clone(),
        };
        Ok(facts)
    }

    pub fn read_paths(&self) -> impl Iterator<Item = &PathBuf> {
        self.read_paths.iter()
    }

    /// Returns the exact durable Thread/Turn identity executing the current Tool Call.
    pub fn execution_identity(&self) -> Option<&ToolExecutionIdentity> {
        self.execution.as_ref()
    }

    /// Returns the exact tools this Agent may invoke.
    pub fn available_tools(&self) -> impl Iterator<Item = &ash_protocol::ToolName> {
        self.available_tools.iter()
    }

    /// Returns the host-backed ceiling from which a child Agent's two tool scopes are derived.
    pub fn delegation_tools(&self) -> impl Iterator<Item = &ash_protocol::ToolName> {
        self.delegation_tools.iter()
    }

    /// Returns the exact Skill versions already frozen for the current Turn.
    pub fn activated_skills(&self) -> &[ash_protocol::FrozenSkillActivation] {
        &self.activated_skills
    }
}

/// Durable caller identity supplied to a Tool Service without granting Thread mutation access.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolExecutionIdentity {
    session_id: ash_protocol::SessionId,
    thread_id: ash_protocol::ThreadId,
    turn_id: ash_protocol::TurnId,
    model: Option<ash_protocol::ModelRef>,
    policy_revision: String,
    tool_profile: Option<ash_protocol::ToolProfileSnapshot>,
}

impl ToolExecutionIdentity {
    pub fn session_id(&self) -> &ash_protocol::SessionId {
        &self.session_id
    }

    pub fn thread_id(&self) -> &ash_protocol::ThreadId {
        &self.thread_id
    }

    pub fn turn_id(&self) -> &ash_protocol::TurnId {
        &self.turn_id
    }

    pub fn model(&self) -> Option<&ash_protocol::ModelRef> {
        self.model.as_ref()
    }

    pub fn policy_revision(&self) -> &str {
        &self.policy_revision
    }

    pub fn tool_profile(&self) -> Option<&ash_protocol::ToolProfileSnapshot> {
        self.tool_profile.as_ref()
    }
}

/// Tool service used by hosts that expose no tools.
pub struct NoTools;

impl ToolService for NoTools {
    fn definitions(&self) -> Vec<ToolDefinition> {
        Vec::new()
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

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        Err(CoreError::Policy(format!(
            "tool is not available for policy review: {}",
            call.name
        )))
    }
}

#[cfg(test)]
#[path = "services_tests.rs"]
mod tests;

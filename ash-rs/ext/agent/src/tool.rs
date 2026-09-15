use action_policy::ActionDigest;
use action_policy::ActionKind;
use action_policy::ActionPolicyRevision;
use action_policy::ActionProvenance;
use action_policy::ActionReviewRequest;
use action_policy::ActionSource;
use action_policy::CapabilitySet;
use action_policy::ResolvedAction;
use action_policy::SandboxCompatibility;
use ash_core::JoinAgentsRequest;
use ash_core::MultiAgentCoordinator;
use ash_core::SendAgentMessageRequest;
use ash_core::SpawnAgentRequest;
use ash_core::ThreadController;
use ash_core::ToolAuthorization;
use ash_core::ToolExecutionFacts;
use ash_core::ToolOutputSink;
use ash_core::ToolService;
use ash_core::TurnExecutionBackend;
use async_utils::CancellationToken;
use core_api::CoreError;
use protocol::AgentContextMode;
use protocol::AgentContextSource;
use protocol::AgentJoinId;
use protocol::AgentJoinPolicy;
use protocol::AgentJoinStatus;
use protocol::AgentMessageId;
use protocol::AgentMessageProvenance;
use protocol::ContextCheckpointId;
use protocol::DelegatedPolicyCeiling;
use protocol::DelegatedTask;
use protocol::DelegationId;
use protocol::ForkedAgentContext;
use protocol::ItemId;
use protocol::ThreadId;
use protocol::ToolCall;
use protocol::ToolDefinition;
use protocol::ToolExecutionOutput;
use protocol::ToolName;
use serde::Deserialize;
use serde_json::Value;
use serde_json::json;
use std::sync::Arc;
use std::time::Duration;
use std::time::Instant;

use crate::ResolvedAgentSelection;
use crate::resolve_agent_selection;

pub const SPAWN_AGENT_TOOL_NAME: &str = "spawn_agent";
pub const SEND_AGENT_MESSAGE_TOOL_NAME: &str = "send_agent_message";
pub const WAIT_AGENT_TOOL_NAME: &str = "wait_agent";
const MAX_WAIT: Duration = Duration::from_secs(12 * 60 * 60);

pub struct MultiAgentToolService {
    coordinator: Arc<MultiAgentCoordinator>,
    threads: Arc<ThreadController>,
    turn_backend: Arc<dyn TurnExecutionBackend>,
    definitions: Vec<ToolDefinition>,
    action_policy_revision: ActionPolicyRevision,
    customizations: Option<Arc<dyn crate::AgentCatalogProvider>>,
    model_instructions: Arc<models_manager::ModelInstructionCatalog>,
}

impl MultiAgentToolService {
    pub fn new(
        coordinator: Arc<MultiAgentCoordinator>,
        threads: Arc<ThreadController>,
        turn_backend: Arc<dyn TurnExecutionBackend>,
        action_policy_revision: ActionPolicyRevision,
    ) -> Self {
        Self {
            coordinator,
            threads,
            turn_backend,
            definitions: vec![spawn_definition(), send_definition(), wait_definition()],
            action_policy_revision,
            customizations: None,
            model_instructions: models_manager::ModelInstructionCatalog::built_in(),
        }
    }

    pub fn with_model_instructions(
        mut self,
        catalog: Arc<models_manager::ModelInstructionCatalog>,
    ) -> Self {
        self.model_instructions = catalog;
        self
    }

    pub fn with_dir_contributions(
        mut self,
        customizations: Arc<dyn crate::AgentCatalogProvider>,
    ) -> Self {
        self.customizations = Some(customizations);
        self
    }

    fn execute_with_context(
        &self,
        call: &ToolCall,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
    ) -> Result<ToolExecutionOutput, CoreError> {
        cancellation
            .check()
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        let identity = facts.execution_identity().ok_or_else(|| {
            CoreError::Execution("Agent coordination tool requires durable caller identity".into())
        })?;
        match call.name.as_str() {
            SPAWN_AGENT_TOOL_NAME => {
                let delegation_id = DelegationId::new(format!("tool:{}", call.id))
                    .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
                // Core already bound this Tool Call's arguments durably. A retry must not
                // reselect its role or model from catalogs that may have changed meanwhile.
                let parent = self.threads.read_thread(identity.thread_id())?;
                let spawned = if parent.delegations.contains_key(&delegation_id) {
                    self.coordinator
                        .resume_delegation(identity.thread_id(), &delegation_id)?
                } else {
                    let arguments: SpawnArguments = decode_arguments(&call.arguments)?;
                    let selection = self.resolve_agent(&arguments, facts)?;
                    self.coordinator.spawn(SpawnAgentRequest {
                        delegation_id: delegation_id.clone(),
                        session_id: identity.session_id().clone(),
                        parent_thread_id: identity.thread_id().clone(),
                        parent_turn_id: identity.turn_id().clone(),
                        task: DelegatedTask {
                            title: arguments.name.unwrap_or_else(|| "subagent".into()),
                            instructions: arguments.task,
                        },
                        role: selection.role.clone(),
                        base_instructions: prompts::AGENT_INSTRUCTIONS
                            .freeze()
                            .with_model_guidance(
                                self.model_instructions.resolve(
                                    selection
                                        .role
                                        .as_ref()
                                        .and_then(|role| role.model.as_ref())
                                        .or(identity.model()),
                                ),
                            ),
                        inheritance: spawn_context(arguments.context)?,
                        policy_ceiling: DelegatedPolicyCeiling {
                            policy_revision: identity.policy_revision().into(),
                        },
                        capability_scope: selection.capability_scope,
                    })?
                };
                let child = self.threads.read_thread(&spawned.child_thread_id)?;
                let status = child
                    .turns
                    .iter()
                    .find(|turn| turn.turn_id == spawned.child_turn_id)
                    .ok_or_else(|| CoreError::NotFound(spawned.child_turn_id.to_string()))?
                    .status;
                if status == protocol::TurnStatus::Running {
                    self.turn_backend
                        .start(&spawned.child_thread_id, &spawned.child_turn_id)?;
                }
                success(json!({
                    "delegation_id": delegation_id,
                    "child_thread_id": spawned.child_thread_id,
                    "child_turn_id": spawned.child_turn_id,
                    "agent": spawned.context_seed.agent.role.as_ref().and_then(|role| role.definition.as_ref()),
                    "status": status
                }))
            }
            SEND_AGENT_MESSAGE_TOOL_NAME => {
                let arguments: SendArguments = decode_arguments(&call.arguments)?;
                let delegation_id = DelegationId::new(arguments.delegation_id)
                    .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
                let child_thread_id =
                    child_thread_for(&self.threads, identity.thread_id(), &delegation_id)?;
                let delivered = self.coordinator.send_message(SendAgentMessageRequest {
                    message_id: AgentMessageId::new(format!("tool:{}", call.id))
                        .map_err(|error| CoreError::InvalidInput(error.to_string()))?,
                    delegation_id: Some(delegation_id),
                    sender_thread_id: identity.thread_id().clone(),
                    receiver_thread_id: child_thread_id,
                    text: arguments.message,
                    provenance: AgentMessageProvenance::Agent,
                })?;
                success(json!({
                    "message_id": delivered.message.message_id,
                    "receiver_thread_id": delivered.message.receiver_thread_id,
                    "status": "delivered"
                }))
            }
            WAIT_AGENT_TOOL_NAME => {
                let arguments: WaitArguments = decode_arguments(&call.arguments)?;
                let (delegations, policy) = wait_join_policy(&arguments)?;
                let timeout = Duration::from_millis(arguments.timeout_ms.unwrap_or(43_200_000));
                if timeout > MAX_WAIT {
                    return Err(CoreError::InvalidInput(
                        "timeout_ms must not exceed 43200000".into(),
                    ));
                }
                self.wait_for_join(
                    identity.thread_id(),
                    AgentJoinId::new(format!("tool:{}", call.id))
                        .map_err(|error| CoreError::InvalidInput(error.to_string()))?,
                    delegations,
                    policy,
                    timeout,
                    cancellation,
                )
            }
            _ => Err(CoreError::Policy(format!(
                "tool is not available: {}",
                call.name
            ))),
        }
    }

    fn resolve_agent(
        &self,
        arguments: &SpawnArguments,
        facts: &ToolExecutionFacts,
    ) -> Result<ResolvedAgentSelection, CoreError> {
        let identity = facts.execution_identity().ok_or_else(|| {
            CoreError::Execution("Agent coordination tool requires durable caller identity".into())
        })?;
        let mut agent_snapshots = vec![agent_roles::built_in_roles()];
        agent_snapshots.extend(
            self.customizations
                .as_ref()
                .map(|customizations| customizations.agent_snapshots_for(identity.session_id()))
                .unwrap_or_default(),
        );
        let instruction_snapshots = self
            .customizations
            .as_ref()
            .map(|customizations| customizations.instruction_snapshots_for(identity.session_id()))
            .unwrap_or_default();
        resolve_agent_selection(
            &arguments.agent,
            identity.model(),
            facts.delegation_tools().cloned().collect(),
            facts.activated_skills(),
            &agent_snapshots,
            &instruction_snapshots,
        )
    }

    fn wait_for_join(
        &self,
        parent_thread_id: &ThreadId,
        join_id: AgentJoinId,
        delegations: Option<Vec<DelegationId>>,
        policy: AgentJoinPolicy,
        timeout: Duration,
        cancellation: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        let deadline = Instant::now() + timeout;
        let joined = self.coordinator.join(JoinAgentsRequest {
            join_id: join_id.clone(),
            parent_thread_id: parent_thread_id.clone(),
            policy: policy.clone(),
            delegations,
        })?;
        let delegations = joined.join.delegations;
        loop {
            cancellation
                .check()
                .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
            // Subscribe before reading state so completion before the first poll is retained.
            let mut changes = vec![Box::pin(self.threads.thread_changed(parent_thread_id)?)];
            let mut attention = Vec::new();
            for delegation in &delegations {
                let child = child_thread_for(&self.threads, parent_thread_id, delegation)?;
                changes.push(Box::pin(self.threads.thread_changed(&child)?));
                let snapshot = self.threads.read_thread(&child)?;
                for turn in &snapshot.turns {
                    if let Some(interaction) = &turn.pending_interaction
                        && matches!(
                            interaction.request,
                            protocol::AgentRequest::Approval { .. }
                                | protocol::AgentRequest::UserInput { .. }
                        )
                    {
                        attention.push(json!({
                            "delegation_id": delegation,
                            "child_thread_id": child,
                            "turn_id": turn.turn_id,
                            "request_id": interaction.request_id,
                            "status": turn.status,
                        }));
                    }
                }
            }
            self.complete_terminal_children(parent_thread_id, Some(&delegations))?;
            let joined = self.coordinator.join(JoinAgentsRequest {
                join_id: join_id.clone(),
                parent_thread_id: parent_thread_id.clone(),
                policy: policy.clone(),
                delegations: Some(delegations.clone()),
            })?;
            if joined.join.status == AgentJoinStatus::Satisfied {
                return success(json!({
                    "join_id": joined.join.join_id,
                    "status": joined.join.status,
                    "satisfied_by": joined.join.satisfied_by,
                    "results": joined.results
                }));
            }
            if !attention.is_empty() {
                return success(json!({
                    "join_id": joined.join.join_id,
                    "status": joined.join.status,
                    "reason": "needs_input",
                    "attention": attention,
                }));
            }
            if Instant::now() >= deadline {
                return success(json!({
                    "join_id": joined.join.join_id,
                    "delegations": joined.join.delegations,
                    "status": joined.join.status
                }));
            }
            pollster::block_on(async_utils::wait_until(
                futures::future::select_all(changes),
                deadline,
                cancellation,
            ))
            .map_err(|signal| CoreError::Cancelled(signal.reason().to_string()))?;
        }
    }

    fn complete_terminal_children(
        &self,
        parent_thread_id: &ThreadId,
        selected: Option<&[DelegationId]>,
    ) -> Result<(), CoreError> {
        let parent = self.threads.read_thread(parent_thread_id)?;
        let delegation_ids = selected
            .map(<[DelegationId]>::to_vec)
            .unwrap_or_else(|| parent.delegations.keys().cloned().collect());
        for delegation_id in delegation_ids {
            if parent
                .received_delegation_results
                .contains_key(&delegation_id)
            {
                continue;
            }
            let child_thread_id =
                child_thread_for(&self.threads, parent_thread_id, &delegation_id)?;
            self.coordinator
                .reconcile_terminal_delegation(&child_thread_id)?;
        }
        Ok(())
    }
}

impl ToolService for MultiAgentToolService {
    fn definitions(&self) -> Vec<ToolDefinition> {
        self.definitions.clone()
    }

    fn prepare(&self, call: &ToolCall) -> Result<ActionReviewRequest, CoreError> {
        if !self
            .definitions
            .iter()
            .any(|definition| definition.name == call.name)
        {
            return Err(CoreError::Policy(format!(
                "tool is not available: {}",
                call.name
            )));
        }
        let canonical = serde_json::to_vec(&json!({
            "tool": call.name,
            "arguments": call.arguments,
        }))
        .map_err(|error| CoreError::Policy(error.to_string()))?;
        Ok(ActionReviewRequest::new(
            ResolvedAction::new(
                ActionDigest::from_canonical_bytes(canonical),
                ActionKind::SystemOperation,
                format!("coordinate child Agent through {}", call.name),
                CapabilitySet::new([]),
            ),
            ActionProvenance::new(ActionSource::BuiltInTool, call.name.as_str()),
            SandboxCompatibility::NotApplicable {
                reason: "Agent coordination only mutates durable Ash Session/Thread state".into(),
            },
            self.action_policy_revision.clone(),
        ))
    }

    fn execute(
        &self,
        _: &ToolCall,
        _: &ToolAuthorization,
        _: &CancellationToken,
    ) -> Result<ToolExecutionOutput, CoreError> {
        Err(CoreError::Execution(
            "Agent coordination tool requires durable execution facts".into(),
        ))
    }

    fn execute_with_facts(
        &self,
        call: &ToolCall,
        _: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
    ) -> Result<ToolExecutionOutput, CoreError> {
        self.execute_with_context(call, cancellation, facts)
    }

    fn execute_streaming_with_facts(
        &self,
        call: &ToolCall,
        authorization: &ToolAuthorization,
        cancellation: &CancellationToken,
        facts: &ToolExecutionFacts,
        _: &mut dyn ToolOutputSink,
    ) -> Result<ToolExecutionOutput, CoreError> {
        self.execute_with_facts(call, authorization, cancellation, facts)
    }
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SpawnArguments {
    task: String,
    name: Option<String>,
    #[serde(default)]
    agent: protocol::AgentRoleSelection,
    context: Option<SpawnContextArguments>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpawnContextArguments {
    mode: SpawnContextMode,
    count: Option<u32>,
    sources: Option<Vec<SpawnContextSourceArguments>>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum SpawnContextMode {
    Fresh,
    Full,
    LastTurns,
    CheckpointAndTail,
    Selected,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SpawnContextSourceArguments {
    kind: SpawnContextSourceKind,
    source_thread_id: String,
    source_sequence: u64,
    item_id: Option<String>,
    checkpoint_id: Option<String>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum SpawnContextSourceKind {
    Item,
    Checkpoint,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SendArguments {
    delegation_id: String,
    message: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WaitArguments {
    delegation_id: Option<String>,
    delegation_ids: Option<Vec<String>>,
    policy: Option<WaitPolicy>,
    quorum: Option<u32>,
    timeout_ms: Option<u64>,
}

#[derive(Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
enum WaitPolicy {
    All,
    Any,
    Quorum,
}

fn spawn_context(context: Option<SpawnContextArguments>) -> Result<AgentContextMode, CoreError> {
    let Some(context) = context else {
        return Ok(AgentContextMode::Fresh);
    };
    match context.mode {
        SpawnContextMode::Fresh => {
            require_absent_context_fields(context.count, context.sources.as_ref())?;
            Ok(AgentContextMode::Fresh)
        }
        SpawnContextMode::Full => {
            require_absent_context_fields(context.count, context.sources.as_ref())?;
            Ok(AgentContextMode::ForkedPrefix {
                selection: ForkedAgentContext::Full,
            })
        }
        SpawnContextMode::LastTurns => {
            if context.sources.is_some() {
                return Err(CoreError::InvalidInput(
                    "lastTurns Agent context cannot include selected sources".into(),
                ));
            }
            let count = context.count.filter(|count| *count > 0).ok_or_else(|| {
                CoreError::InvalidInput("lastTurns Agent context requires count > 0".into())
            })?;
            Ok(AgentContextMode::ForkedPrefix {
                selection: ForkedAgentContext::LastTurns { count },
            })
        }
        SpawnContextMode::CheckpointAndTail => {
            require_absent_context_fields(context.count, context.sources.as_ref())?;
            Ok(AgentContextMode::ForkedPrefix {
                selection: ForkedAgentContext::CheckpointAndTail,
            })
        }
        SpawnContextMode::Selected => {
            if context.count.is_some() {
                return Err(CoreError::InvalidInput(
                    "Selected Agent context cannot include a Turn count".into(),
                ));
            }
            let sources = context.sources.ok_or_else(|| {
                CoreError::InvalidInput("Selected Agent context requires sources".into())
            })?;
            if sources.is_empty() {
                return Err(CoreError::InvalidInput(
                    "Selected Agent context requires at least one source".into(),
                ));
            }
            Ok(AgentContextMode::Selected {
                sources: sources
                    .into_iter()
                    .map(spawn_context_source)
                    .collect::<Result<Vec<_>, _>>()?,
            })
        }
    }
}

fn require_absent_context_fields(
    count: Option<u32>,
    sources: Option<&Vec<SpawnContextSourceArguments>>,
) -> Result<(), CoreError> {
    if count.is_some() || sources.is_some() {
        Err(CoreError::InvalidInput(
            "Agent context mode contains fields owned by another mode".into(),
        ))
    } else {
        Ok(())
    }
}

fn spawn_context_source(
    source: SpawnContextSourceArguments,
) -> Result<AgentContextSource, CoreError> {
    let source_thread_id = ThreadId::new(source.source_thread_id)
        .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
    match source.kind {
        SpawnContextSourceKind::Item => {
            if source.checkpoint_id.is_some() {
                return Err(CoreError::InvalidInput(
                    "Item Agent context source cannot include checkpoint_id".into(),
                ));
            }
            Ok(AgentContextSource::Item {
                source_thread_id,
                source_sequence: source.source_sequence,
                item_id: ItemId::new(source.item_id.ok_or_else(|| {
                    CoreError::InvalidInput("Item Agent context source requires item_id".into())
                })?)
                .map_err(|error| CoreError::InvalidInput(error.to_string()))?,
            })
        }
        SpawnContextSourceKind::Checkpoint => {
            if source.item_id.is_some() {
                return Err(CoreError::InvalidInput(
                    "checkpoint Agent context source cannot include item_id".into(),
                ));
            }
            Ok(AgentContextSource::Checkpoint {
                source_thread_id,
                source_sequence: source.source_sequence,
                checkpoint_id: ContextCheckpointId::new(source.checkpoint_id.ok_or_else(|| {
                    CoreError::InvalidInput(
                        "checkpoint Agent context source requires checkpoint_id".into(),
                    )
                })?)
                .map_err(|error| CoreError::InvalidInput(error.to_string()))?,
            })
        }
    }
}

fn wait_join_policy(
    arguments: &WaitArguments,
) -> Result<(Option<Vec<DelegationId>>, AgentJoinPolicy), CoreError> {
    if arguments.delegation_id.is_some() && arguments.delegation_ids.is_some() {
        return Err(CoreError::InvalidInput(
            "wait_agent accepts delegation_id or delegation_ids, not both".into(),
        ));
    }
    let delegations = match (&arguments.delegation_id, &arguments.delegation_ids) {
        (Some(delegation_id), None) => {
            Some(vec![DelegationId::new(delegation_id.clone()).map_err(
                |error| CoreError::InvalidInput(error.to_string()),
            )?])
        }
        (None, Some(delegation_ids)) => {
            if delegation_ids.is_empty() {
                return Err(CoreError::InvalidInput(
                    "delegation_ids must not be empty".into(),
                ));
            }
            Some(
                delegation_ids
                    .iter()
                    .cloned()
                    .map(DelegationId::new)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| CoreError::InvalidInput(error.to_string()))?,
            )
        }
        (None, None) => None,
        (Some(_), Some(_)) => unreachable!("conflicting fields rejected above"),
    };
    let policy = match arguments.policy {
        None | Some(WaitPolicy::All) => AgentJoinPolicy::All,
        Some(WaitPolicy::Any) => AgentJoinPolicy::Any,
        Some(WaitPolicy::Quorum) => AgentJoinPolicy::Quorum {
            count: arguments
                .quorum
                .filter(|count| *count > 0)
                .ok_or_else(|| CoreError::InvalidInput("quorum wait requires quorum > 0".into()))?,
        },
    };
    if !matches!(arguments.policy, Some(WaitPolicy::Quorum)) && arguments.quorum.is_some() {
        return Err(CoreError::InvalidInput(
            "quorum is only valid for quorum wait policy".into(),
        ));
    }
    Ok((delegations, policy))
}

fn child_thread_for(
    threads: &ThreadController,
    parent_thread_id: &ThreadId,
    delegation_id: &DelegationId,
) -> Result<ThreadId, CoreError> {
    threads
        .read_thread(parent_thread_id)?
        .delegations
        .get(delegation_id)
        .and_then(|delegation| delegation.child_thread_id.clone())
        .ok_or_else(|| CoreError::NotFound(delegation_id.to_string()))
}

fn decode_arguments<T: for<'de> Deserialize<'de>>(value: &Value) -> Result<T, CoreError> {
    serde_json::from_value(value.clone())
        .map_err(|error| CoreError::InvalidInput(format!("invalid tool arguments: {error}")))
}

fn success(value: Value) -> Result<ToolExecutionOutput, CoreError> {
    serde_json::to_string(&value)
        .map(ToolExecutionOutput::Success)
        .map_err(|error| CoreError::Execution(error.to_string()))
}

fn definition(name: &str, description: &str, parameters: Value) -> ToolDefinition {
    ToolDefinition {
        name: ToolName::new(name).expect("static Agent tool name is valid"),
        description: description.into(),
        parameters,
        strict: true,
    }
}

fn spawn_definition() -> ToolDefinition {
    let built_in_roles = agent_roles::built_in_roles()
        .entries()
        .iter()
        .map(|role| format!("{}: {}", role.name(), role.description()))
        .collect::<Vec<_>>()
        .join("\n");
    let agent_description = format!(
        "Select normal Agent behavior with type=default, or an exact role using type=exact, source and name. Omitted selects default and never inherits the parent role. Available built-in roles:\n{built_in_roles}"
    );
    definition(
        SPAWN_AGENT_TOOL_NAME,
        "Creates an independent child Agent Thread for one bounded task and returns immediately. The child has isolated history and receives only its frozen role, delegated task, active Skills, and allowed tool names. Use wait_agent with the returned delegation_id to collect its result.",
        json!({
            "type": "object",
            "properties": {
                "task": {
                    "type": "string",
                    "description": "The complete, bounded task the child Agent should execute independently."
                },
                "name": {
                    "type": ["string", "null"],
                    "description": "An optional short label for the delegation and child Thread."
                },
                "agent": {
                    "description": agent_description,
                    "anyOf": [
                        { "type": "object", "properties": { "type": { "const": "default" } }, "required": ["type"], "additionalProperties": false },
                        { "type": "object", "properties": {
                            "type": { "const": "exact" },
                            "name": { "type": "string", "minLength": 1 },
                            "source": { "anyOf": [
                                { "type": "object", "properties": { "type": { "const": "builtIn" } }, "required": ["type"], "additionalProperties": false },
                                { "type": "object", "properties": { "type": { "const": "directory" }, "id": { "type": "string", "minLength": 1 } }, "required": ["type", "id"], "additionalProperties": false }
                            ] }
                        }, "required": ["type", "name", "source"], "additionalProperties": false }
                    ]
                },
                "context": {
                    "type": ["object", "null"],
                    "description": "Optional immutable context inheritance. null means fresh.",
                    "properties": {
                        "mode": {
                            "type": "string",
                            "enum": ["fresh", "full", "lastTurns", "checkpointAndTail", "selected"]
                        },
                        "count": {
                            "type": ["integer", "null"],
                            "minimum": 1
                        },
                        "sources": {
                            "type": ["array", "null"],
                            "items": {
                                "type": "object",
                                "properties": {
                                    "kind": { "type": "string", "enum": ["item", "checkpoint"] },
                                    "sourceThreadId": { "type": "string" },
                                    "sourceSequence": { "type": "integer", "minimum": 1 },
                                    "itemId": { "type": ["string", "null"] },
                                    "checkpointId": { "type": ["string", "null"] }
                                },
                                "required": ["kind", "sourceThreadId", "sourceSequence", "itemId", "checkpointId"],
                                "additionalProperties": false
                            }
                        }
                    },
                    "required": ["mode", "count", "sources"],
                    "additionalProperties": false
                }
            },
            "required": ["task", "name", "agent", "context"],
            "additionalProperties": false
        }),
    )
}

fn send_definition() -> ToolDefinition {
    definition(
        SEND_AGENT_MESSAGE_TOOL_NAME,
        "Durably sends additional instructions to a child Agent using exact-once cross-Thread delivery.",
        json!({
            "type": "object",
            "properties": {
                "delegation_id": {
                    "type": "string",
                    "description": "The delegation_id returned by spawn_agent."
                },
                "message": {
                    "type": "string",
                    "description": "The additional instruction to deliver to the child Agent."
                }
            },
            "required": ["delegation_id", "message"],
            "additionalProperties": false
        }),
    )
}

fn wait_definition() -> ToolDefinition {
    definition(
        WAIT_AGENT_TOOL_NAME,
        "Waits for an All/Any/Quorum condition over a frozen set of child Agents. Runtime events wake this call; no model polling is needed. Defaults to a 12-hour deadline. Expiry returns the durable waiting join and does not cancel children. Returns early with needs_input when a child needs approval or user input; surface that request instead of repeatedly waiting. Use a shorter timeout only when the task needs it.",
        json!({
            "type": "object",
            "properties": {
                "delegation_id": {
                    "type": ["string", "null"],
                    "description": "One delegation_id. Use null when delegation_ids or all current children are selected."
                },
                "delegation_ids": {
                    "type": ["array", "null"],
                    "items": { "type": "string" },
                    "minItems": 1,
                    "description": "An exact frozen target set, or null to use delegation_id/all current children."
                },
                "policy": {
                    "type": ["string", "null"],
                    "enum": ["all", "any", "quorum", null],
                    "description": "Join policy. null defaults to all."
                },
                "quorum": {
                    "type": ["integer", "null"],
                    "minimum": 1,
                    "description": "Required result count for quorum; null for other policies."
                },
                "timeout_ms": {
                    "type": ["integer", "null"],
                    "minimum": 0,
                    "maximum": 43200000,
                    "description": "Maximum wait in milliseconds. null defaults to 43200000; 0 reads the current join immediately."
                }
            },
            "required": ["delegation_id", "delegation_ids", "policy", "quorum", "timeout_ms"],
            "additionalProperties": false
        }),
    )
}

#[cfg(test)]
#[path = "tool_tests.rs"]
mod tests;

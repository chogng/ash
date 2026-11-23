use super::ContextBudget;
use super::InstructionRetention;
use super::InstructionSource;
use crate::ContextEvidence;
use crate::CoreError;
use crate::ThreadSnapshot;
use crate::thread_reducer::ReferenceHistory;
use ash_context_fragments::ContextFragment;
use ash_extension_api::PromptFragment;
use ash_extension_api::PromptFragmentLayer;
use ash_protocol::ContextCheckpoint;
use ash_protocol::ItemId;
use ash_protocol::ThreadItem;
use ash_protocol::ToolDefinition;
use ash_protocol::TurnId;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::sync::Arc;

/// Stable rendering position, not permission or semantic authority.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) enum InstructionPlacement {
    System,
    Product,
    User,
    Directory,
    Skill,
    HistoryBoundary,
    /// Per-invocation context appended after the reusable history prefix.
    Turn,
    AgentMessage,
}

/// One bounded instruction contribution before placement and budget resolution.
pub(crate) type InstructionFragment = ContextFragment<InstructionPlacement>;

pub(crate) fn resolve_extension_fragment(
    fragment: PromptFragment,
) -> Result<InstructionFragment, CoreError> {
    if fragment.body().trim().is_empty() {
        return Err(CoreError::Context(
            "extension prompt fragment body must not be empty".into(),
        ));
    }
    let source = fragment.source();
    if source.kind().trim().is_empty()
        || source.identity().trim().is_empty()
        || source.revision().trim().is_empty()
    {
        return Err(CoreError::Context(
            "extension prompt fragment provenance must not be empty".into(),
        ));
    }
    Ok(fragment.map_layer(|layer| match layer {
        PromptFragmentLayer::System => InstructionPlacement::System,
        PromptFragmentLayer::Product => InstructionPlacement::Product,
        PromptFragmentLayer::Directory => InstructionPlacement::Directory,
        PromptFragmentLayer::Skill => InstructionPlacement::Skill,
        PromptFragmentLayer::AgentMessage => InstructionPlacement::AgentMessage,
    }))
}

/// Complete immutable input to one context-planning operation.
#[derive(Clone, Debug)]
pub(crate) struct ContextInput {
    identity: (ash_protocol::AgentId, ash_protocol::ThreadId),
    policy: ash_protocol::ContextCompactionPolicy,
    source_thread_sequence: u64,
    current_turn_id: TurnId,
    reference_history: Arc<ReferenceHistory>,
    instructions: Vec<InstructionFragment>,
    environment: String,
    evidence: Vec<ContextEvidence>,
    items: Vec<ThreadItem>,
    checkpoints: Vec<ContextCheckpoint>,
    terminal_turns: BTreeSet<TurnId>,
    turn_endings: BTreeMap<TurnId, ash_prompts::PromptArtifact>,
    item_sequences: BTreeMap<ItemId, u64>,
    // Planning (including a buffered Handoff clone) borrows the invocation's immutable
    // schemas. Only the final protocol request needs an owned Vec.
    tools: Arc<Vec<ToolDefinition>>,
    budget: ContextBudget,
    allow_empty_current_turn: bool,
}

impl ContextInput {
    pub(crate) fn new(
        snapshot: &ThreadSnapshot,
        current_turn_id: TurnId,
        mut instructions: Vec<InstructionFragment>,
        tools: impl Into<Arc<Vec<ToolDefinition>>>,
        budget: ContextBudget,
    ) -> Self {
        let allow_empty_current_turn = snapshot.commands.iter().any(|command| {
            matches!(
                (&command.receipt.command, &command.result),
                (
                    ash_protocol::ThreadCommand::StartTurn { input, .. },
                    crate::ThreadCommandResult::TurnAccepted { turn_id },
                ) if turn_id == &current_turn_id && input.is_empty()
            )
        });
        if !snapshot.reference_history.threads.is_empty() {
            for (prompt, placement) in [
                (
                    ash_prompts::SIDE_CHAT_REFERENCE_POLICY,
                    InstructionPlacement::Product,
                ),
                (
                    ash_prompts::SIDE_CHAT_REFERENCE_BOUNDARY,
                    InstructionPlacement::HistoryBoundary,
                ),
            ] {
                instructions.push(InstructionFragment::new(
                    InstructionSource::new(prompt.owner(), prompt.id(), prompt.revision()),
                    placement,
                    InstructionRetention::Required,
                    prompt.body(),
                ));
            }
        }
        Self {
            identity: (snapshot.agent_id.clone(), snapshot.thread_id.clone()),
            policy: snapshot.context_policy(&current_turn_id),
            source_thread_sequence: snapshot.sequence,
            current_turn_id: current_turn_id.clone(),
            reference_history: snapshot.reference_history.clone(),
            instructions,
            environment: String::new(),
            evidence: Vec::new(),
            items: model_items(snapshot, &current_turn_id),
            checkpoints: snapshot.context_checkpoints.clone(),
            terminal_turns: snapshot
                .turns
                .iter()
                .filter(|turn| {
                    matches!(
                        turn.status,
                        ash_protocol::TurnStatus::Completed
                            | ash_protocol::TurnStatus::Failed
                            | ash_protocol::TurnStatus::Interrupted
                    )
                })
                .map(|turn| turn.turn_id.clone())
                .collect(),
            turn_endings: snapshot
                .turns
                .iter()
                .filter_map(|turn| {
                    use ash_prompts::ReviewOutcome;
                    use ash_protocol::TurnKind;
                    use ash_protocol::TurnStatus;
                    let prompt = match (turn.kind, turn.status) {
                        (TurnKind::Review, TurnStatus::Completed) => {
                            ash_prompts::review_exit_prompt(ReviewOutcome::Completed)
                        }
                        (TurnKind::Review, TurnStatus::Interrupted) => {
                            ash_prompts::review_exit_prompt(ReviewOutcome::Interrupted)
                        }
                        (TurnKind::Review, TurnStatus::Failed) => {
                            ash_prompts::review_exit_prompt(ReviewOutcome::Failed)
                        }
                        (_, TurnStatus::Interrupted) => ash_prompts::TURN_INTERRUPTED_PROMPT,
                        _ => return None,
                    };
                    Some((turn.turn_id.clone(), prompt))
                })
                .collect(),
            item_sequences: snapshot.item_sequences.clone(),
            tools: tools.into(),
            budget,
            allow_empty_current_turn,
        }
    }

    pub(crate) fn with_evidence(mut self, evidence: Vec<ContextEvidence>) -> Self {
        self.evidence = evidence;
        self
    }

    pub(super) fn thread_hint(
        &self,
        checkpoint: Option<&ContextCheckpoint>,
    ) -> Option<(ash_protocol::ToolCallId, String)> {
        if !self.policy.context_window_as_tool_output() {
            return None;
        }
        let window = checkpoint.map_or("initial", |checkpoint| checkpoint.checkpoint_id.as_str());
        Some((
            ash_protocol::ToolCallId::new(format!(
                "ash-context-hint:{}:{window}",
                self.current_turn_id
            ))
            .expect("nonempty generated hint ID"),
            format!(
                "Agent ID: {}\nThread ID: {}\nFirst context window ID: {}:initial\nCurrent context window ID: {}:{window}",
                self.identity.0, self.identity.1, self.identity.1, self.identity.1
            ),
        ))
    }

    pub(crate) fn policy(&self) -> &ash_protocol::ContextCompactionPolicy {
        &self.policy
    }

    pub(crate) fn with_policy(mut self, policy: ash_protocol::ContextCompactionPolicy) -> Self {
        self.policy = policy;
        self
    }

    pub(crate) fn with_budget(mut self, budget: ContextBudget) -> Self {
        self.budget = budget;
        self
    }

    pub(crate) fn with_rendered_environment(mut self, environment: impl Into<String>) -> Self {
        self.environment = environment.into();
        self
    }

    pub(crate) fn with_time_context(
        mut self,
        current: &ash_protocol::TimeContext,
        references: &BTreeMap<ItemId, ash_protocol::TimeContext>,
    ) -> Result<Self, crate::CoreError> {
        let current = ash_agent_environment::TimeSnapshot::new(current.clone())
            .map_err(|error| crate::CoreError::Context(error.to_string()))?;
        if !self.environment.is_empty() {
            self.environment.push('\n');
        }
        self.environment.push_str(&current.render());
        self.with_time_references(references)
    }

    pub(crate) fn with_time_references(
        mut self,
        references: &BTreeMap<ItemId, ash_protocol::TimeContext>,
    ) -> Result<Self, crate::CoreError> {
        for item in &mut self.items {
            if let ThreadItem::UserMessage { item_id, text, .. } = item {
                let reference = match references.get(item_id) {
                    Some(time) => ash_agent_environment::TimeSnapshot::new(time.clone())
                        .map_err(|error| crate::CoreError::Context(error.to_string()))?
                        .render_reference(),
                    None => "<user_time unavailable=\"true\" />".into(),
                };
                *text = format!("{reference}\n{text}");
            }
        }
        Ok(self)
    }

    pub(crate) const fn source_thread_sequence(&self) -> u64 {
        self.source_thread_sequence
    }

    pub(crate) fn current_turn_id(&self) -> &TurnId {
        &self.current_turn_id
    }

    pub(crate) fn instructions(&self) -> &[InstructionFragment] {
        &self.instructions
    }

    pub(super) fn reference_history(&self) -> &Arc<ReferenceHistory> {
        &self.reference_history
    }

    pub(crate) fn environment(&self) -> &str {
        &self.environment
    }

    pub(crate) fn items(&self) -> &[ThreadItem] {
        &self.items
    }

    pub(crate) fn evidence(&self) -> &[ContextEvidence] {
        &self.evidence
    }

    pub(crate) fn checkpoints(&self) -> &[ContextCheckpoint] {
        &self.checkpoints
    }

    pub(crate) fn is_terminal_turn(&self, turn_id: &TurnId) -> bool {
        self.terminal_turns.contains(turn_id)
    }

    pub(crate) fn turn_endings(&self) -> &BTreeMap<TurnId, ash_prompts::PromptArtifact> {
        &self.turn_endings
    }

    pub(crate) fn item_sequence(&self, item_id: &ItemId) -> Option<u64> {
        self.item_sequences.get(item_id).copied()
    }

    pub(crate) fn tools(&self) -> &Arc<Vec<ToolDefinition>> {
        &self.tools
    }

    pub(crate) const fn budget(&self) -> ContextBudget {
        self.budget
    }

    pub(crate) const fn allow_empty_current_turn(&self) -> bool {
        self.allow_empty_current_turn
    }
}

// Nested calls are audit facts. Only their owning exec/wait output belongs in model
// context, including token measurement and compaction input.
fn model_items(snapshot: &ThreadSnapshot, current_turn_id: &TurnId) -> Vec<ThreadItem> {
    let items = &snapshot.items;
    let model = snapshot
        .turns
        .iter()
        .find(|turn| &turn.turn_id == current_turn_id)
        .and_then(|turn| turn.model.as_ref());
    let compatible_turn = |turn_id: &TurnId| {
        !snapshot.reference_history.turns.contains(turn_id)
            && model.is_none_or(|model| {
                snapshot
                    .turns
                    .iter()
                    .find(|turn| &turn.turn_id == turn_id)
                    .and_then(|turn| turn.model.as_ref())
                    .is_none_or(|origin| origin == model)
            })
    };
    // Read the effective mode from the latest compatible response, not from a model-name
    // heuristic. A missing mode stays unknown and is conservatively estimated on replay.
    let replay_context = items
        .iter()
        .rev()
        .find_map(|item| match item {
            ThreadItem::Reasoning { turn_id, state, .. } if compatible_turn(turn_id) => {
                state.last().map(|state| state.context)
            }
            _ => None,
        })
        .flatten();
    let nested = items
        .iter()
        .filter_map(|item| match item {
            ThreadItem::ToolCall {
                tool_call_id,
                binding: Some(binding),
                ..
            } if matches!(
                binding.caller,
                ash_protocol::ToolCallCaller::CodeMode { .. }
            ) =>
            {
                Some(tool_call_id)
            }
            _ => None,
        })
        .collect::<BTreeSet<_>>();
    items
        .iter()
        .filter(|item| match item {
            ThreadItem::ToolCall { tool_call_id, .. }
            | ThreadItem::ToolResult { tool_call_id, .. } => !nested.contains(tool_call_id),
            _ => true,
        })
        .cloned()
        .map(|mut item| {
            if let ThreadItem::Reasoning { turn_id, state, .. } = &mut item
                && (!compatible_turn(turn_id)
                    || (replay_context == Some(ash_protocol::ReasoningReplayContext::CurrentTurn)
                        && turn_id != current_turn_id))
            {
                // Exclude items that do not render into this sample from both assembly and
                // budgeting. Provider credential scope remains enforced at its boundary.
                state.clear();
            }
            item
        })
        .collect()
}

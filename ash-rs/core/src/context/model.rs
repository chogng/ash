use super::ContextBudget;
use crate::ContextEvidence;
use crate::ThreadSnapshot;
use ash_protocol::ContextCheckpoint;
use ash_protocol::ItemId;
use ash_protocol::ThreadItem;
use ash_protocol::ToolDefinition;
use ash_protocol::TurnId;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

/// Stable rendering position, not permission or semantic authority.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub(crate) enum InstructionPlacement {
    System,
    Product,
    User,
    Directory,
    Skill,
    /// Per-invocation context appended after the reusable history prefix.
    Turn,
    AgentMessage,
}

/// Whether budget pressure may remove an instruction fragment.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum InstructionRetention {
    Required,
    BestEffort,
}

/// Stable, diagnostic provenance for an instruction fragment.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct InstructionSource {
    kind: String,
    identity: String,
    revision: String,
}

impl InstructionSource {
    pub(crate) fn new(
        kind: impl Into<String>,
        identity: impl Into<String>,
        revision: impl Into<String>,
    ) -> Self {
        Self {
            kind: kind.into(),
            identity: identity.into(),
            revision: revision.into(),
        }
    }

    pub(crate) fn kind(&self) -> &str {
        &self.kind
    }

    pub(crate) fn identity(&self) -> &str {
        &self.identity
    }

    pub(crate) fn revision(&self) -> &str {
        &self.revision
    }
}

impl TryFrom<&ash_extension_api::PromptFragmentSource> for InstructionSource {
    type Error = crate::CoreError;

    fn try_from(source: &ash_extension_api::PromptFragmentSource) -> Result<Self, Self::Error> {
        if source.kind().trim().is_empty()
            || source.identity().trim().is_empty()
            || source.revision().trim().is_empty()
        {
            return Err(crate::CoreError::Context(
                "extension prompt fragment provenance must not be empty".into(),
            ));
        }
        Ok(Self {
            kind: source.kind().to_owned(),
            identity: source.identity().to_owned(),
            revision: source.revision().to_owned(),
        })
    }
}

/// One bounded instruction contribution before placement and budget resolution.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct InstructionFragment {
    source: InstructionSource,
    placement: InstructionPlacement,
    retention: InstructionRetention,
    body: String,
}

impl InstructionFragment {
    pub(crate) fn new(
        source: InstructionSource,
        placement: InstructionPlacement,
        retention: InstructionRetention,
        body: impl Into<String>,
    ) -> Self {
        Self {
            source,
            placement,
            retention,
            body: body.into(),
        }
    }

    pub(crate) fn source(&self) -> &InstructionSource {
        &self.source
    }

    pub(crate) const fn placement(&self) -> InstructionPlacement {
        self.placement
    }

    pub(crate) const fn retention(&self) -> InstructionRetention {
        self.retention
    }

    pub(crate) fn body(&self) -> &str {
        &self.body
    }
}

impl TryFrom<ash_extension_api::PromptFragment> for InstructionFragment {
    type Error = crate::CoreError;

    fn try_from(fragment: ash_extension_api::PromptFragment) -> Result<Self, Self::Error> {
        if fragment.body().trim().is_empty() {
            return Err(crate::CoreError::Context(
                "extension prompt fragment body must not be empty".into(),
            ));
        }
        Ok(Self {
            source: InstructionSource::try_from(fragment.source())?,
            placement: match fragment.layer() {
                ash_extension_api::PromptFragmentLayer::System => InstructionPlacement::System,
                ash_extension_api::PromptFragmentLayer::Product => InstructionPlacement::Product,
                ash_extension_api::PromptFragmentLayer::Directory => {
                    InstructionPlacement::Directory
                }
                ash_extension_api::PromptFragmentLayer::Skill => InstructionPlacement::Skill,
                ash_extension_api::PromptFragmentLayer::AgentMessage => {
                    InstructionPlacement::AgentMessage
                }
            },
            retention: match fragment.retention() {
                ash_extension_api::PromptFragmentRetention::Required => {
                    InstructionRetention::Required
                }
                ash_extension_api::PromptFragmentRetention::BestEffort => {
                    InstructionRetention::BestEffort
                }
            },
            body: fragment.body().to_owned(),
        })
    }
}

/// Complete immutable input to one context-planning operation.
#[derive(Clone, Debug)]
pub(crate) struct ContextInput {
    source_thread_sequence: u64,
    current_turn_id: TurnId,
    instructions: Vec<InstructionFragment>,
    environment: String,
    evidence: Vec<ContextEvidence>,
    items: Vec<ThreadItem>,
    checkpoints: Vec<ContextCheckpoint>,
    terminal_turns: BTreeSet<TurnId>,
    turn_endings: BTreeMap<TurnId, ash_prompts::PromptArtifact>,
    item_sequences: BTreeMap<ItemId, u64>,
    tools: Vec<ToolDefinition>,
    budget: ContextBudget,
    allow_empty_current_turn: bool,
}

impl ContextInput {
    pub(crate) fn new(
        snapshot: &ThreadSnapshot,
        current_turn_id: TurnId,
        instructions: Vec<InstructionFragment>,
        tools: Vec<ToolDefinition>,
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
        Self {
            source_thread_sequence: snapshot.sequence,
            current_turn_id,
            instructions,
            environment: String::new(),
            evidence: Vec::new(),
            items: model_items(&snapshot.items),
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
            tools,
            budget,
            allow_empty_current_turn,
        }
    }

    pub(crate) fn with_evidence(mut self, evidence: Vec<ContextEvidence>) -> Self {
        self.evidence = evidence;
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

    pub(crate) fn tools(&self) -> &[ToolDefinition] {
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
fn model_items(items: &[ThreadItem]) -> Vec<ThreadItem> {
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
        .collect()
}

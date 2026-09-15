use super::ContextTokenCount;
use super::InstructionFragment;
use crate::ContextEvidence;
use ash_protocol::ContextCheckpoint;
use ash_protocol::ContextSourceRange;
use ash_protocol::ThreadItem;
use ash_protocol::ToolDefinition;
use ash_protocol::TurnId;
use std::collections::BTreeMap;
use std::fmt;

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct OmittedInstruction {
    source_identity: String,
    reason: InstructionOmissionReason,
}

impl OmittedInstruction {
    pub(crate) fn source_identity(&self) -> &str {
        &self.source_identity
    }

    pub(crate) const fn reason(&self) -> InstructionOmissionReason {
        self.reason
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum InstructionOmissionReason {
    BudgetPressure,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ContextBudgetReport {
    ProviderManaged {
        estimated_input: ContextTokenCount,
        estimator_revision: &'static str,
    },
    CoreManaged {
        context_window: ContextTokenCount,
        reserved_output: ContextTokenCount,
        safety_margin: ContextTokenCount,
        maximum_input: ContextTokenCount,
        instruction_tokens: ContextTokenCount,
        tool_tokens: ContextTokenCount,
        current_turn_tokens: ContextTokenCount,
        history_tokens: ContextTokenCount,
        evidence_tokens: ContextTokenCount,
        estimator_revision: &'static str,
    },
}

impl ContextBudgetReport {
    pub(crate) const fn estimator_revision(&self) -> &'static str {
        match self {
            Self::ProviderManaged {
                estimator_revision, ..
            }
            | Self::CoreManaged {
                estimator_revision, ..
            } => estimator_revision,
        }
    }

    pub(crate) fn total_input(&self) -> ContextTokenCount {
        match self {
            Self::ProviderManaged {
                estimated_input, ..
            } => *estimated_input,
            Self::CoreManaged {
                instruction_tokens,
                tool_tokens,
                current_turn_tokens,
                history_tokens,
                evidence_tokens,
                ..
            } => instruction_tokens
                .saturating_add(*tool_tokens)
                .saturating_add(*current_turn_tokens)
                .saturating_add(*history_tokens)
                .saturating_add(*evidence_tokens),
        }
    }

    pub(crate) fn max_output_tokens(&self) -> Option<u32> {
        match self {
            Self::ProviderManaged { .. } => None,
            Self::CoreManaged {
                reserved_output, ..
            } => Some(reserved_output.get()),
        }
    }
}

/// Immutable, diagnostic selection result for one model invocation.
#[derive(Clone, Debug)]
pub(crate) struct ContextPlan {
    source_thread_sequence: u64,
    current_turn_id: TurnId,
    instructions: Vec<InstructionFragment>,
    environment: String,
    omitted_instructions: Vec<OmittedInstruction>,
    checkpoint: Option<ContextCheckpoint>,
    selected_items: Vec<ThreadItem>,
    turn_endings: BTreeMap<TurnId, ash_prompts::PromptArtifact>,
    evidence: Vec<ContextEvidence>,
    tools: Vec<ToolDefinition>,
    budget: ContextBudgetReport,
}

pub(super) struct ContextPlanInput {
    pub source_thread_sequence: u64,
    pub current_turn_id: TurnId,
    pub instructions: Vec<InstructionFragment>,
    pub environment: String,
    pub omitted_instructions: Vec<OmittedInstruction>,
    pub checkpoint: Option<ContextCheckpoint>,
    pub selected_items: Vec<ThreadItem>,
    pub turn_endings: BTreeMap<TurnId, ash_prompts::PromptArtifact>,
    pub evidence: Vec<ContextEvidence>,
    pub tools: Vec<ToolDefinition>,
    pub budget: ContextBudgetReport,
}

impl ContextPlan {
    pub(super) fn new(input: ContextPlanInput) -> Self {
        Self {
            source_thread_sequence: input.source_thread_sequence,
            current_turn_id: input.current_turn_id,
            instructions: input.instructions,
            environment: input.environment,
            omitted_instructions: input.omitted_instructions,
            checkpoint: input.checkpoint,
            selected_items: input.selected_items,
            turn_endings: input.turn_endings,
            evidence: input.evidence,
            tools: input.tools,
            budget: input.budget,
        }
    }

    pub(crate) const fn source_thread_sequence(&self) -> u64 {
        self.source_thread_sequence
    }

    pub(crate) fn instructions(&self) -> &[InstructionFragment] {
        &self.instructions
    }

    pub(crate) fn environment(&self) -> &str {
        &self.environment
    }

    pub(crate) fn omitted_instructions(&self) -> &[OmittedInstruction] {
        &self.omitted_instructions
    }

    pub(crate) fn selected_items(&self) -> &[ThreadItem] {
        &self.selected_items
    }

    pub(crate) fn current_turn_id(&self) -> &TurnId {
        &self.current_turn_id
    }

    pub(crate) fn turn_ending(&self, turn_id: &TurnId) -> Option<&ash_prompts::PromptArtifact> {
        self.turn_endings.get(turn_id)
    }

    pub(crate) fn evidence(&self) -> &[ContextEvidence] {
        &self.evidence
    }

    pub(crate) fn checkpoint(&self) -> Option<&ContextCheckpoint> {
        self.checkpoint.as_ref()
    }

    pub(crate) fn tools(&self) -> &[ToolDefinition] {
        &self.tools
    }

    pub(crate) fn budget(&self) -> &ContextBudgetReport {
        &self.budget
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct CompactionPlan {
    pub(crate) source_thread_sequence: u64,
    pub(crate) covered_turns: Vec<TurnId>,
    pub(crate) covered: ContextSourceRange,
    pub(crate) previous_checkpoint: Option<ContextCheckpoint>,
    pub(crate) source_items: Vec<ThreadItem>,
    pub(crate) target_tokens: ContextTokenCount,
    pub(crate) budget: ContextBudgetReport,
}

#[derive(Clone, Debug)]
pub(crate) enum ContextPreparation {
    Ready(ContextPlan),
    NeedsCompaction(CompactionPlan),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) enum ContextPreparationError {
    InvalidBudget,
    MandatoryInstructionsTooLarge {
        required: ContextTokenCount,
        available: ContextTokenCount,
    },
    ToolDefinitionsTooLarge {
        required: ContextTokenCount,
        available: ContextTokenCount,
    },
    CurrentInputTooLarge {
        required: ContextTokenCount,
        available: ContextTokenCount,
    },
    CheckpointCapacityTooSmall {
        available: ContextTokenCount,
    },
    CompactionSourceTooLarge {
        required: ContextTokenCount,
        available: ContextTokenCount,
    },
    NoCompactionCandidate,
    UnsupportedContextShape(String),
}

impl fmt::Display for ContextPreparationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidBudget => formatter.write_str(
                "context budget must leave room after reserved output and safety margin",
            ),
            Self::MandatoryInstructionsTooLarge {
                required,
                available,
            } => write!(
                formatter,
                "mandatory instructions require {required} tokens but only {available} are available"
            ),
            Self::ToolDefinitionsTooLarge {
                required,
                available,
            } => write!(
                formatter,
                "tool definitions require {required} tokens but only {available} remain"
            ),
            Self::CurrentInputTooLarge {
                required,
                available,
            } => write!(
                formatter,
                "current Turn requires {required} tokens but only {available} remain"
            ),
            Self::CheckpointCapacityTooSmall { available } => write!(
                formatter,
                "context history requires compaction but only {available} tokens are available for a durable checkpoint"
            ),
            Self::CompactionSourceTooLarge {
                required,
                available,
            } => write!(
                formatter,
                "the next durable history prefix requires {required} tokens to compact but only {available} are available"
            ),
            Self::NoCompactionCandidate => {
                formatter.write_str("no completed history prefix is available for compaction")
            }
            Self::UnsupportedContextShape(message) => formatter.write_str(message),
        }
    }
}

impl std::error::Error for ContextPreparationError {}

impl OmittedInstruction {
    pub(super) fn budget_pressure(source_identity: String) -> Self {
        Self {
            source_identity,
            reason: InstructionOmissionReason::BudgetPressure,
        }
    }
}

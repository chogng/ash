use super::CompactionPlan;
use super::ContextBudgetReport;
use super::ContextInput;
use super::ContextPlan;
use super::ContextPreparation;
use super::ContextPreparationError;
use super::ContextTokenCount;
use super::InstructionFragment;
use super::InstructionRetention;
use super::OmittedInstruction;
use super::compaction::estimate_compaction_input;
use super::input_limits::limit_model_input_items;
use super::plan::ContextPlanInput;
use ash_context_engine::ResolvedContextBudget;
use ash_protocol::ContentPart;
use ash_protocol::ContextCheckpoint;
use ash_protocol::ContextSourceRange;
use ash_protocol::ThreadItem;
use ash_protocol::ToolCallId;
use ash_protocol::ToolDefinition;
use ash_protocol::TurnId;
use std::collections::BTreeMap;
use std::collections::BTreeSet;

pub(crate) const CONTEXT_ESTIMATOR_REVISION: &str = "deterministic-bytes-v2";
const TEXT_ITEM_OVERHEAD: u32 = 6;
const TOOL_ITEM_OVERHEAD: u32 = 12;
const IMAGE_TOKEN_ESTIMATE: u32 = 1_024;
const MIN_CHECKPOINT_TOKENS: u32 = 16;
const MAX_OVERFLOW_CHECKPOINT_TOKENS: u32 = 1_024;

/// Pure, deterministic context selection and budget planner.
pub(crate) struct ContextPlanner;

impl ContextPlanner {
    /// Inspects loaded input without selecting, compacting, or mutating history.
    /// This shares the execution estimator, but it deliberately does not retrieve query evidence.
    pub(crate) fn inspect_categories(
        instructions: &[InstructionFragment],
        tools: &[ToolDefinition],
        environment: &str,
        history: Option<&ContextInput>,
    ) -> Vec<ash_protocol::ModelContextCategoryUsage> {
        use ash_protocol::ModelContextCategory;
        use ash_protocol::ModelContextCategoryUsage;
        use ash_protocol::ModelContextSourceUsage;
        // This is the context/read display order. Consumers use the same sequence for
        // category rows and the stacked gauge, regardless of relative token counts.
        let mut categories = [
            ModelContextCategory::SystemPrompt,
            ModelContextCategory::SystemTools,
            ModelContextCategory::MemoryFiles,
            ModelContextCategory::Skills,
            ModelContextCategory::Conversation,
        ]
        .map(|category| ModelContextCategoryUsage {
            category,
            tokens: 0,
            sources: Vec::new(),
        });
        for fragment in instructions {
            let index = match fragment.placement() {
                super::InstructionPlacement::User | super::InstructionPlacement::Directory => 2,
                super::InstructionPlacement::Skill => 3,
                super::InstructionPlacement::AgentMessage => 4,
                super::InstructionPlacement::System
                | super::InstructionPlacement::Product
                | super::InstructionPlacement::Turn => 0,
            };
            let tokens = u64::from(estimate_instruction(fragment).get());
            categories[index].tokens += tokens;
            categories[index].sources.push(ModelContextSourceUsage {
                name: fragment.source().identity().to_owned(),
                item_count: fragment.source().item_count(),
                tokens,
            });
        }
        let environment_tokens = u64::from(estimate_environment(environment).get());
        if environment_tokens > 0 {
            categories[0].tokens += environment_tokens;
            categories[0].sources.push(ModelContextSourceUsage {
                name: "environment".into(),
                item_count: None,
                tokens: environment_tokens,
            });
        }
        for tool in tools {
            let tokens = u64::from(estimate_tools(std::slice::from_ref(tool)).get());
            categories[1].tokens += tokens;
            categories[1].sources.push(ModelContextSourceUsage {
                name: tool.name.to_string(),
                item_count: None,
                tokens,
            });
        }
        if let Some(input) = history {
            let checkpoint = input.checkpoints().last();
            let covered = checkpoint
                .map(|checkpoint| checkpoint.referenced_items.iter().collect::<BTreeSet<_>>())
                .unwrap_or_default();
            let items = input
                .items()
                .iter()
                .filter(|item| !covered.contains(item.item_id()) || pinned_user_input(input, item))
                .cloned()
                .collect::<Vec<_>>();
            let mut items = limit_model_input_items(&items);
            if let ash_protocol::ContextCompactionPolicy::Summary { recent_tokens, .. } =
                input.policy()
                && let Ok(ResolvedContextBudget::CoreManaged(limits)) = input.budget().resolve()
            {
                let required = instructions
                    .iter()
                    .filter(|fragment| fragment.retention() == InstructionRetention::Required)
                    .cloned()
                    .collect::<Vec<_>>();
                if estimate_instructions(&required)
                    .saturating_add(estimate_tools(tools))
                    .saturating_add(estimate_environment(environment))
                    .saturating_add(estimate_items(&items))
                    .saturating_add(estimate_checkpoint(checkpoint))
                    > limits.maximum_input()
                {
                    clear_old_read_results(&mut items, ContextTokenCount::new(*recent_tokens));
                }
            }
            categories[4].tokens += u64::from(
                group_visible_items(&items)
                    .iter()
                    .fold(estimate_checkpoint(checkpoint), |total, group| {
                        total.saturating_add(estimate_group(input, group))
                    })
                    .get(),
            );
        }
        categories.into()
    }

    pub(crate) fn prepare(
        input: &ContextInput,
    ) -> Result<ContextPreparation, ContextPreparationError> {
        let buffered;
        let input =
            if let ash_protocol::ContextCompactionPolicy::Handoff { buffer_tokens, .. } =
                input.policy()
            {
                buffered = input.clone().with_budget(
                    input
                        .budget()
                        .with_input_buffer(ContextTokenCount::new(*buffer_tokens)),
                );
                &buffered
            } else {
                input
            };
        Self::prepare_inner(input, true)
    }

    fn prepare_inner(
        input: &ContextInput,
        allow_compaction: bool,
    ) -> Result<ContextPreparation, ContextPreparationError> {
        validate_shape(input)?;
        let mut required_instructions = input
            .instructions()
            .iter()
            .filter(|fragment| fragment.retention() == InstructionRetention::Required)
            .cloned()
            .collect::<Vec<_>>();
        sort_instructions(&mut required_instructions);
        let required_instruction_tokens = estimate_instructions(&required_instructions);
        let tool_tokens = estimate_tools(input.tools());
        let checkpoint = input.checkpoints().last().cloned();
        let checkpoint_items = checkpoint
            .as_ref()
            .map(|checkpoint| checkpoint.referenced_items.iter().collect::<BTreeSet<_>>())
            .unwrap_or_default();
        let raw_items = input
            .items()
            .iter()
            .filter(|item| {
                !checkpoint_items.contains(item.item_id()) || pinned_user_input(input, item)
            })
            .cloned()
            .collect::<Vec<_>>();
        validate_items(&raw_items)?;
        let mut model_items = limit_model_input_items(&raw_items);
        if let ash_protocol::ContextCompactionPolicy::Summary { recent_tokens, .. } = input.policy()
            && let ResolvedContextBudget::CoreManaged(limits) = input
                .budget()
                .resolve()
                .map_err(|_| ContextPreparationError::InvalidBudget)?
            && required_instruction_tokens
                .saturating_add(tool_tokens)
                .saturating_add(estimate_items(&model_items))
                .saturating_add(estimate_checkpoint(checkpoint.as_ref()))
                > limits.maximum_input()
        {
            clear_old_read_results(&mut model_items, ContextTokenCount::new(*recent_tokens));
        }
        let groups = group_visible_items(&model_items);
        let current_group = groups
            .iter()
            .find(|group| &group.turn_id == input.current_turn_id());
        let current_turn_tokens = match current_group {
            Some(group) => estimate_group(input, group),
            None if input.allow_empty_current_turn() => ContextTokenCount::ZERO,
            None => {
                return Err(ContextPreparationError::UnsupportedContextShape(format!(
                    "current Turn {} has no model-visible input",
                    input.current_turn_id()
                )));
            }
        }
        .saturating_add(estimate_environment(input.environment()));
        let history_groups = groups
            .iter()
            .filter(|group| &group.turn_id != input.current_turn_id())
            .collect::<Vec<_>>();
        let history_tokens = history_groups
            .iter()
            .fold(ContextTokenCount::ZERO, |total, group| {
                total.saturating_add(estimate_group(input, group))
            })
            .saturating_add(estimate_checkpoint(checkpoint.as_ref()));
        let all_evidence_tokens = estimate_evidence(input.evidence());

        let budget = match input
            .budget()
            .resolve()
            .map_err(|_| ContextPreparationError::InvalidBudget)?
        {
            ResolvedContextBudget::ProviderManaged => {
                let mut instructions = input.instructions().to_vec();
                sort_instructions(&mut instructions);
                let instruction_tokens = estimate_instructions(&instructions);
                let estimated_input = instruction_tokens
                    .saturating_add(tool_tokens)
                    .saturating_add(current_turn_tokens)
                    .saturating_add(history_tokens)
                    .saturating_add(all_evidence_tokens);
                let selected_items = groups
                    .iter()
                    .flat_map(|group| group.items.iter().cloned())
                    .collect();
                return Ok(ContextPreparation::Ready(ContextPlan::new(
                    ContextPlanInput {
                        source_thread_sequence: input.source_thread_sequence(),
                        current_turn_id: input.current_turn_id().clone(),
                        instructions,
                        environment: input.environment().to_owned(),
                        omitted_instructions: Vec::new(),
                        checkpoint,
                        selected_items,
                        turn_endings: input.turn_endings().clone(),
                        evidence: input.evidence().to_vec(),
                        tools: input.tools().to_vec(),
                        budget: ContextBudgetReport::ProviderManaged {
                            estimated_input,
                            estimator_revision: CONTEXT_ESTIMATOR_REVISION,
                        },
                    },
                )));
            }
            ResolvedContextBudget::CoreManaged(budget) => budget,
        };
        let maximum_input = budget.maximum_input();
        if required_instruction_tokens > maximum_input {
            return Err(ContextPreparationError::MandatoryInstructionsTooLarge {
                required: required_instruction_tokens,
                available: maximum_input,
            });
        }
        let after_instructions = subtract(maximum_input, required_instruction_tokens);
        if tool_tokens > after_instructions {
            return Err(ContextPreparationError::ToolDefinitionsTooLarge {
                required: tool_tokens,
                available: after_instructions,
            });
        }
        let after_tools = subtract(after_instructions, tool_tokens);
        if !allow_compaction && current_turn_tokens.saturating_add(history_tokens) > after_tools {
            return Err(ContextPreparationError::CurrentInputTooLarge {
                required: current_turn_tokens.saturating_add(history_tokens),
                available: after_tools,
            });
        }
        let after_current = subtract(after_tools, current_turn_tokens);
        let base_report = ContextBudgetReport::CoreManaged {
            context_window: budget.context_window(),
            reserved_output: budget.reserved_output(),
            safety_margin: budget.safety_margin(),
            maximum_input,
            instruction_tokens: required_instruction_tokens,
            tool_tokens,
            current_turn_tokens,
            history_tokens,
            evidence_tokens: ContextTokenCount::ZERO,
            estimator_revision: CONTEXT_ESTIMATOR_REVISION,
        };
        if current_turn_tokens.saturating_add(history_tokens) > after_tools {
            return automatic_compaction(input, &model_items, checkpoint, budget, base_report)
                .map(ContextPreparation::NeedsCompaction);
        }

        let mut selected_instructions = required_instructions;
        let mut omitted_instructions = Vec::new();
        let mut remaining = subtract(after_current, history_tokens);
        for fragment in input
            .instructions()
            .iter()
            .filter(|fragment| fragment.retention() == InstructionRetention::BestEffort)
        {
            let cost = estimate_instruction(fragment);
            if cost <= remaining {
                selected_instructions.push(fragment.clone());
                remaining = subtract(remaining, cost);
            } else {
                omitted_instructions.push(OmittedInstruction::budget_pressure(
                    fragment.source().identity().to_owned(),
                ));
            }
        }
        sort_instructions(&mut selected_instructions);
        let evidence_limit = ContextTokenCount::new(maximum_input.get() / 8);
        let mut evidence_remaining =
            ContextTokenCount::new(remaining.get().min(evidence_limit.get()));
        let mut selected_evidence = Vec::new();
        for evidence in input.evidence() {
            let cost = estimate_one_evidence(evidence);
            if cost <= evidence_remaining {
                selected_evidence.push(evidence.clone());
                evidence_remaining = subtract(evidence_remaining, cost);
            }
        }
        let evidence_tokens = estimate_evidence(&selected_evidence);
        let instruction_tokens = estimate_instructions(&selected_instructions);
        let final_report = ContextBudgetReport::CoreManaged {
            context_window: budget.context_window(),
            reserved_output: budget.reserved_output(),
            safety_margin: budget.safety_margin(),
            maximum_input,
            instruction_tokens,
            tool_tokens,
            current_turn_tokens,
            history_tokens,
            evidence_tokens,
            estimator_revision: CONTEXT_ESTIMATOR_REVISION,
        };
        let selected_items = groups
            .iter()
            .flat_map(|group| group.items.iter().cloned())
            .collect();
        Ok(ContextPreparation::Ready(ContextPlan::new(
            ContextPlanInput {
                source_thread_sequence: input.source_thread_sequence(),
                current_turn_id: input.current_turn_id().clone(),
                instructions: selected_instructions,
                environment: input.environment().to_owned(),
                omitted_instructions,
                checkpoint,
                selected_items,
                turn_endings: input.turn_endings().clone(),
                evidence: selected_evidence,
                tools: input.tools().to_vec(),
                budget: final_report,
            },
        )))
    }

    pub(crate) fn prepare_overflow_recovery(
        input: &ContextInput,
    ) -> Result<CompactionPlan, ContextPreparationError> {
        validate_shape(input)?;
        let checkpoint = input.checkpoints().last().cloned();
        let checkpoint_end = checkpoint
            .as_ref()
            .map_or(0, |checkpoint| checkpoint.covered.end_sequence);
        let checkpoint_items = checkpoint
            .as_ref()
            .map(|checkpoint| checkpoint.referenced_items.iter().collect::<BTreeSet<_>>())
            .unwrap_or_default();
        let raw_items = input
            .items()
            .iter()
            .filter(|item| !checkpoint_items.contains(item.item_id()))
            .cloned()
            .collect::<Vec<_>>();
        validate_items(&raw_items)?;
        let model_items = limit_model_input_items(&raw_items);
        let groups = group_visible_items(&model_items);
        let history_groups = match groups
            .iter()
            .position(|group| &group.turn_id == input.current_turn_id())
        {
            Some(current_group_index) => &groups[..current_group_index],
            None if input.allow_empty_current_turn() => groups.as_slice(),
            None => {
                return Err(ContextPreparationError::UnsupportedContextShape(format!(
                    "current Turn {} has no model-visible input",
                    input.current_turn_id()
                )));
            }
        };
        if history_groups
            .iter()
            .any(|group| !input.is_terminal_turn(&group.turn_id))
        {
            return Err(ContextPreparationError::UnsupportedContextShape(
                "context overflow recovery can compact only terminal Turns".into(),
            ));
        }
        let covered_turns = history_groups
            .iter()
            .map(|group| group.turn_id.clone())
            .collect::<Vec<_>>();
        let covered_end_sequence = history_groups
            .iter()
            .flat_map(|group| group.items.iter())
            .filter_map(|item| input.item_sequence(item.item_id()))
            .max()
            .unwrap_or(checkpoint_end);
        if covered_end_sequence == 0 {
            return Err(ContextPreparationError::NoCompactionCandidate);
        }
        let source_items = model_items
            .iter()
            .filter(|item| covered_turns.contains(item.turn_id()))
            .cloned()
            .collect::<Vec<_>>();
        let history_tokens =
            estimate_checkpoint(checkpoint.as_ref()).saturating_add(estimate_items(&source_items));
        if history_tokens.get() <= MIN_CHECKPOINT_TOKENS {
            return Err(ContextPreparationError::NoCompactionCandidate);
        }
        let target_tokens = ContextTokenCount::new(
            (history_tokens.get() / 4)
                .clamp(MIN_CHECKPOINT_TOKENS, MAX_OVERFLOW_CHECKPOINT_TOKENS)
                .min(history_tokens.get().saturating_sub(1))
                .min(
                    match input
                        .budget()
                        .resolve()
                        .map_err(|_| ContextPreparationError::InvalidBudget)?
                    {
                        ResolvedContextBudget::CoreManaged(budget) => {
                            budget.reserved_output().get()
                        }
                        ResolvedContextBudget::ProviderManaged => MAX_OVERFLOW_CHECKPOINT_TOKENS,
                    },
                ),
        );
        Ok(CompactionPlan {
            handoff_request: None,
            handoff_input_tokens: ContextTokenCount::ZERO,
            source_thread_sequence: input.source_thread_sequence(),
            #[cfg(test)]
            covered_turns,
            covered: ContextSourceRange {
                start_sequence: 1,
                end_sequence: covered_end_sequence,
            },
            previous_checkpoint: checkpoint,
            source_items,
            target_tokens,
            budget: ContextBudgetReport::ProviderManaged {
                estimated_input: history_tokens,
                estimator_revision: CONTEXT_ESTIMATOR_REVISION,
            },
        })
    }

    pub(crate) fn prepare_manual_compaction(
        input: &ContextInput,
        retention_prompt: Option<&str>,
    ) -> Result<CompactionPlan, ContextPreparationError> {
        validate_shape(input)?;
        let checkpoint = input.checkpoints().last().cloned();
        let checkpoint_end = checkpoint
            .as_ref()
            .map_or(0, |checkpoint| checkpoint.covered.end_sequence);
        let checkpoint_items = checkpoint
            .as_ref()
            .map(|checkpoint| checkpoint.referenced_items.iter().collect::<BTreeSet<_>>())
            .unwrap_or_default();
        let raw_items = input
            .items()
            .iter()
            .filter(|item| !checkpoint_items.contains(item.item_id()))
            .cloned()
            .collect::<Vec<_>>();
        validate_items(&raw_items)?;
        let model_items = limit_model_input_items(&raw_items);
        let groups = group_visible_items(&model_items);
        let safe_groups = groups
            .iter()
            .take_while(|group| {
                &group.turn_id != input.current_turn_id()
                    && input.is_terminal_turn(&group.turn_id)
                    && tool_group_is_complete(&group.items)
            })
            .collect::<Vec<_>>();
        if safe_groups.is_empty() {
            return Err(ContextPreparationError::NoCompactionCandidate);
        }

        let maximum_compaction_input = match input
            .budget()
            .resolve()
            .map_err(|_| ContextPreparationError::InvalidBudget)?
        {
            ResolvedContextBudget::ProviderManaged => None,
            ResolvedContextBudget::CoreManaged(budget) => Some(budget.maximum_compaction_input()),
        };
        let mut selected_groups = Vec::<&TurnGroup>::new();
        let mut first_required = None;
        for group in safe_groups {
            let covered_end_sequence = group
                .items
                .iter()
                .filter_map(|item| input.item_sequence(item.item_id()))
                .max()
                .unwrap_or(checkpoint_end);
            let source_items = model_items
                .iter()
                .filter(|item| {
                    item.turn_id() == &group.turn_id
                        || selected_groups
                            .iter()
                            .any(|selected| item.turn_id() == &selected.turn_id)
                })
                .cloned()
                .collect::<Vec<_>>();
            let required = estimate_compaction_input(
                ContextSourceRange {
                    start_sequence: 1,
                    end_sequence: covered_end_sequence,
                },
                checkpoint.as_ref(),
                &source_items,
                retention_prompt,
            )
            .map_err(|error| {
                ContextPreparationError::UnsupportedContextShape(format!(
                    "failed to estimate manual context compaction input: {error}"
                ))
            })?;
            first_required.get_or_insert(required);
            if maximum_compaction_input.is_some_and(|available| required > available) {
                break;
            }
            selected_groups.push(group);
        }
        if selected_groups.is_empty() {
            return Err(ContextPreparationError::CompactionSourceTooLarge {
                required: first_required.unwrap_or(ContextTokenCount::ZERO),
                available: maximum_compaction_input.unwrap_or(ContextTokenCount::ZERO),
            });
        }

        let covered_turns = selected_groups
            .iter()
            .map(|group| group.turn_id.clone())
            .collect::<Vec<_>>();
        let covered_end_sequence = selected_groups
            .iter()
            .flat_map(|group| group.items.iter())
            .filter_map(|item| input.item_sequence(item.item_id()))
            .max()
            .unwrap_or(checkpoint_end);
        let source_items = model_items
            .iter()
            .filter(|item| covered_turns.contains(item.turn_id()))
            .cloned()
            .collect::<Vec<_>>();
        let history_tokens =
            estimate_checkpoint(checkpoint.as_ref()).saturating_add(estimate_items(&source_items));
        if history_tokens.get() <= MIN_CHECKPOINT_TOKENS {
            return Err(ContextPreparationError::NoCompactionCandidate);
        }
        let target_tokens = ContextTokenCount::new(
            (history_tokens.get() / 4)
                .clamp(MIN_CHECKPOINT_TOKENS, MAX_OVERFLOW_CHECKPOINT_TOKENS)
                .min(history_tokens.get().saturating_sub(1))
                .min(
                    match input
                        .budget()
                        .resolve()
                        .map_err(|_| ContextPreparationError::InvalidBudget)?
                    {
                        ResolvedContextBudget::CoreManaged(budget) => {
                            budget.reserved_output().get()
                        }
                        ResolvedContextBudget::ProviderManaged => MAX_OVERFLOW_CHECKPOINT_TOKENS,
                    },
                ),
        );
        Ok(CompactionPlan {
            handoff_request: None,
            handoff_input_tokens: ContextTokenCount::ZERO,
            source_thread_sequence: input.source_thread_sequence(),
            #[cfg(test)]
            covered_turns,
            covered: ContextSourceRange {
                start_sequence: 1,
                end_sequence: covered_end_sequence,
            },
            previous_checkpoint: checkpoint,
            source_items,
            target_tokens,
            budget: ContextBudgetReport::ProviderManaged {
                estimated_input: history_tokens,
                estimator_revision: CONTEXT_ESTIMATOR_REVISION,
            },
        })
    }
}

// Current user intent is authoritative across every checkpoint in the same Turn.
// Checkpoints still cover its source ID; keeping this copy does not duplicate source references.
fn pinned_user_input(input: &ContextInput, item: &ThreadItem) -> bool {
    item.turn_id() == input.current_turn_id()
        && matches!(
            item,
            ThreadItem::UserMessage { .. }
                | ThreadItem::UserContext { .. }
                | ThreadItem::UserImage { .. }
                | ThreadItem::UserImageAttachment { .. }
                | ThreadItem::UserAudioAttachment { .. }
        )
}

fn clear_old_read_results(items: &mut [ThreadItem], recent: ContextTokenCount) {
    let mut tail = ContextTokenCount::ZERO;
    let mut first_recent = items.len();
    for (index, item) in items.iter().enumerate().rev() {
        tail = tail.saturating_add(estimate_items(std::slice::from_ref(item)));
        first_recent = index;
        if tail >= recent {
            break;
        }
    }
    let reads = items
        .iter()
        .filter_map(|item| match item {
            ThreadItem::ToolCall {
                tool_call_id, name, ..
            } if matches!(name.as_str(), "read_file" | "grep" | "glob") => {
                Some((tool_call_id.clone(), name.to_string()))
            }
            ThreadItem::ToolCall {
                tool_call_id,
                name,
                arguments_json,
                ..
            } if name.as_str() == "file-system"
                && serde_json::from_str::<serde_json::Value>(arguments_json)
                    .is_ok_and(|arguments| arguments["operation"] == "read") =>
            {
                Some((tool_call_id.clone(), name.to_string()))
            }
            _ => None,
        })
        .collect::<BTreeMap<_, _>>();
    for item in &mut items[..first_recent] {
        if let ThreadItem::ToolResult {
            item_id,
            tool_call_id,
            text,
            content: None,
            is_error: false,
            ..
        } = item
            && let Some(name) = reads.get(tool_call_id)
            && text.len() > 512
        {
            *text = format!(
                "[older {name} output removed from model input; durable item {item_id}; use the original call arguments to read the source again]"
            );
        }
    }
}

fn automatic_compaction(
    input: &ContextInput,
    model_items: &[ThreadItem],
    checkpoint: Option<ContextCheckpoint>,
    budget: ash_context_engine::ContextBudgetLimits,
    report: ContextBudgetReport,
) -> Result<CompactionPlan, ContextPreparationError> {
    let covered_ids = checkpoint
        .as_ref()
        .map(|checkpoint| checkpoint.referenced_items.iter().collect::<BTreeSet<_>>())
        .unwrap_or_default();
    // The compactor sees the bounded original source, never the read-result removal markers.
    let source = limit_model_input_items(
        &input
            .items()
            .iter()
            .filter(|item| !covered_ids.contains(item.item_id()))
            .cloned()
            .collect::<Vec<_>>(),
    );
    let pinned = estimate_items(
        &model_items
            .iter()
            .filter(|item| pinned_user_input(input, item))
            .cloned()
            .collect::<Vec<_>>(),
    );
    let (desired_summary, recent) = match *input.policy() {
        ash_protocol::ContextCompactionPolicy::Summary {
            summary_tokens,
            recent_tokens,
        } => (summary_tokens, recent_tokens),
        ash_protocol::ContextCompactionPolicy::Handoff { state_tokens, .. } => (state_tokens, 0),
    };
    let framing = estimate_bytes(
        ash_prompts::checkpoint_prompt_overhead(super::CHECKPOINT_ID_BYTES),
        TEXT_ITEM_OVERHEAD,
    );
    let fixed = match &report {
        ContextBudgetReport::CoreManaged {
            instruction_tokens,
            tool_tokens,
            ..
        } => instruction_tokens.saturating_add(*tool_tokens),
        ContextBudgetReport::ProviderManaged { .. } => {
            return Err(ContextPreparationError::InvalidBudget);
        }
    }
    .saturating_add(pinned)
    .saturating_add(estimate_environment(input.environment()))
    .saturating_add(framing);
    if fixed > budget.maximum_input() {
        return Err(ContextPreparationError::CurrentInputTooLarge {
            required: fixed,
            available: budget.maximum_input(),
        });
    }
    let capacity = budget.maximum_input().saturating_sub(fixed);
    let target = ContextTokenCount::new(
        desired_summary
            .min(budget.reserved_output().get())
            .min(capacity.get() / 3),
    );
    if target.get() < MIN_CHECKPOINT_TOKENS {
        return Err(ContextPreparationError::CheckpointCapacityTooSmall {
            available: capacity,
        });
    }
    let retain = capacity.saturating_sub(target).get().min(recent);
    let mut open = BTreeSet::new();
    let mut selected = None;
    let mut bounded = None;
    let previous_tokens = estimate_checkpoint(checkpoint.as_ref());
    if let Some(previous) = checkpoint.as_ref()
        && previous_tokens > target.saturating_add(framing)
    {
        let cost = estimate_compaction_input(previous.covered, Some(previous), &[], None)
            .map_err(|error| ContextPreparationError::UnsupportedContextShape(error.to_string()))?;
        if cost <= budget.maximum_compaction_input() {
            bounded = Some((0, previous.covered));
            let tail = model_items
                .iter()
                .filter(|item| !pinned_user_input(input, item))
                .cloned()
                .collect::<Vec<_>>();
            if estimate_items(&tail).get() <= retain {
                selected = bounded;
            }
        }
    }
    for (index, item) in source.iter().enumerate() {
        if item.turn_id() != input.current_turn_id() && !input.is_terminal_turn(item.turn_id()) {
            break;
        }
        match item {
            ThreadItem::ToolCall { tool_call_id, .. } => {
                open.insert(tool_call_id.clone());
            }
            ThreadItem::ToolResult { tool_call_id, .. } => {
                open.remove(tool_call_id);
            }
            _ => {}
        }
        let end_of_turn = source
            .get(index + 1)
            .is_none_or(|next| next.turn_id() != item.turn_id());
        let closed = open.is_empty()
            && (input.is_terminal_turn(item.turn_id()) && end_of_turn
                || item.turn_id() == input.current_turn_id()
                    && matches!(item, ThreadItem::ToolResult { .. }));
        if !closed {
            continue;
        }
        let prefix = &source[..=index];
        let end_sequence = prefix
            .iter()
            .filter_map(|item| input.item_sequence(item.item_id()))
            .max()
            .ok_or_else(|| {
                ContextPreparationError::UnsupportedContextShape(
                    "compaction prefix has no durable sequence".into(),
                )
            })?;
        let range = ContextSourceRange {
            start_sequence: 1,
            end_sequence,
        };
        let cost = estimate_compaction_input(range, checkpoint.as_ref(), prefix, None)
            .map_err(|error| ContextPreparationError::UnsupportedContextShape(error.to_string()))?;
        if matches!(
            input.policy(),
            ash_protocol::ContextCompactionPolicy::Summary { .. }
        ) && cost > budget.maximum_compaction_input()
        {
            break;
        }
        // Require useful progress, including when one active Turn spans many windows.
        let removed = estimate_items(
            &prefix
                .iter()
                .filter(|item| !pinned_user_input(input, item))
                .cloned()
                .collect::<Vec<_>>(),
        );
        if removed.saturating_add(previous_tokens) <= target.saturating_add(framing) {
            continue;
        }
        bounded = Some((index + 1, range));
        let tail = model_items
            .iter()
            .filter(|item| {
                !pinned_user_input(input, item)
                    && !prefix
                        .iter()
                        .any(|source| source.item_id() == item.item_id())
            })
            .cloned()
            .collect::<Vec<_>>();
        if estimate_items(&tail).get() <= retain {
            selected = bounded;
            break;
        }
    }
    let Some((count, covered)) = selected.or(bounded) else {
        return Err(ContextPreparationError::NoCompactionCandidate);
    };
    let source_items = source[..count].to_vec();
    #[cfg(test)]
    let covered_turns = source_items
        .iter()
        .map(|item| item.turn_id().clone())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect();
    let mut plan = CompactionPlan {
        handoff_request: None,
        handoff_input_tokens: ContextTokenCount::ZERO,
        source_thread_sequence: input.source_thread_sequence(),
        #[cfg(test)]
        covered_turns,
        covered,
        previous_checkpoint: checkpoint,
        source_items,
        target_tokens: target,
        budget: report,
    };
    if matches!(
        input.policy(),
        ash_protocol::ContextCompactionPolicy::Handoff { .. }
    ) {
        let hard_input = input
            .clone()
            .with_budget(input.budget().for_checkpoint(target));
        let ContextPreparation::Ready(context) = ContextPlanner::prepare_inner(&hard_input, false)?
        else {
            unreachable!("checkpoint planning disables compaction")
        };
        let mut request = super::ContextAssembler::assemble(&context)
            .map_err(|error| ContextPreparationError::UnsupportedContextShape(error.to_string()))?;
        request.tools.clear();
        request.tool_choice = ash_protocol::ToolChoice::None;
        request.parallel_tool_calls = false;
        request.prompt_cache_prefix_end = None;
        request
            .input
            .push(ash_protocol::InputItem::Message(ash_protocol::Message {
                role: ash_protocol::MessageRole::User,
                content: vec![ContentPart::Text(
                    ash_prompts::HANDOFF_PROMPT.body().to_owned(),
                )],
                tool_calls: Vec::new(),
            }));
        let estimated = context
            .budget()
            .total_input()
            .saturating_add(estimate_bytes(
                ash_prompts::HANDOFF_PROMPT.body().len(),
                TEXT_ITEM_OVERHEAD,
            ));
        let ResolvedContextBudget::CoreManaged(hard) = hard_input
            .budget()
            .resolve()
            .map_err(|_| ContextPreparationError::InvalidBudget)?
        else {
            unreachable!()
        };
        if estimated > hard.maximum_input() {
            return Err(ContextPreparationError::CompactionSourceTooLarge {
                required: estimated,
                available: hard.maximum_input(),
            });
        }
        plan.handoff_input_tokens = estimated;
        plan.handoff_request = Some(request);
    }
    Ok(plan)
}

struct TurnGroup {
    turn_id: TurnId,
    items: Vec<ThreadItem>,
}

fn validate_shape(input: &ContextInput) -> Result<(), ContextPreparationError> {
    for fragment in input.instructions() {
        let source = fragment.source();
        if source.kind().trim().is_empty()
            || source.identity().trim().is_empty()
            || source.revision().trim().is_empty()
        {
            return Err(ContextPreparationError::UnsupportedContextShape(
                "instruction provenance must include kind, identity, and revision".into(),
            ));
        }
    }
    for evidence in input.evidence() {
        if evidence.source.trim().is_empty()
            || evidence.reference.trim().is_empty()
            || evidence.revision.trim().is_empty()
            || evidence.body.trim().is_empty()
        {
            return Err(ContextPreparationError::UnsupportedContextShape(
                "context evidence must include source, reference, revision, and body".into(),
            ));
        }
    }
    validate_items(input.items())
}

fn validate_items(items: &[ThreadItem]) -> Result<(), ContextPreparationError> {
    let mut calls = BTreeMap::<ToolCallId, TurnId>::new();
    let mut results = BTreeSet::new();
    for item in items {
        match item {
            ThreadItem::ToolCall {
                turn_id,
                tool_call_id,
                arguments_json,
                ..
            } => {
                serde_json::from_str::<serde_json::Value>(arguments_json).map_err(|error| {
                    ContextPreparationError::UnsupportedContextShape(format!(
                        "Tool Call {tool_call_id} contains invalid JSON arguments: {error}"
                    ))
                })?;
                if calls
                    .insert(tool_call_id.clone(), turn_id.clone())
                    .is_some()
                {
                    return Err(ContextPreparationError::UnsupportedContextShape(format!(
                        "Tool Call {tool_call_id} is duplicated"
                    )));
                }
            }
            ThreadItem::ToolResult {
                turn_id,
                tool_call_id,
                ..
            } => {
                let Some(call_turn_id) = calls.get(tool_call_id) else {
                    return Err(ContextPreparationError::UnsupportedContextShape(format!(
                        "Tool Result references an unavailable Tool Call: {tool_call_id}"
                    )));
                };
                if call_turn_id != turn_id {
                    return Err(ContextPreparationError::UnsupportedContextShape(format!(
                        "Tool Call/Result {tool_call_id} crosses a Turn boundary"
                    )));
                }
                if !results.insert(tool_call_id.clone()) {
                    return Err(ContextPreparationError::UnsupportedContextShape(format!(
                        "Tool Call {tool_call_id} has more than one result"
                    )));
                }
            }
            ThreadItem::UserMessage { .. }
            | ThreadItem::UserContext { .. }
            | ThreadItem::UserImage { .. }
            | ThreadItem::UserImageAttachment { .. }
            | ThreadItem::UserAudioAttachment { .. }
            | ThreadItem::AgentMessage { .. }
            | ThreadItem::Reasoning { .. }
            | ThreadItem::Plan { .. } => {}
        }
    }
    Ok(())
}

fn estimate_group(input: &ContextInput, group: &TurnGroup) -> ContextTokenCount {
    estimate_items(&group.items).saturating_add(
        input
            .turn_endings()
            .get(&group.turn_id)
            .map_or(ContextTokenCount::ZERO, |prompt| {
                estimate_bytes(prompt.body().trim().len(), TEXT_ITEM_OVERHEAD)
            }),
    )
}

fn estimate_checkpoint(checkpoint: Option<&ContextCheckpoint>) -> ContextTokenCount {
    checkpoint.map_or(ContextTokenCount::ZERO, |checkpoint| {
        estimate_bytes(
            ash_prompts::checkpoint_prompt(checkpoint).body().len(),
            TEXT_ITEM_OVERHEAD,
        )
    })
}

fn group_visible_items(items: &[ThreadItem]) -> Vec<TurnGroup> {
    let mut groups = Vec::<TurnGroup>::new();
    for item in items.iter().filter(|item| is_model_visible(item)) {
        if let Some(group) = groups
            .iter_mut()
            .find(|group| &group.turn_id == item.turn_id())
        {
            group.items.push(item.clone());
        } else {
            groups.push(TurnGroup {
                turn_id: item.turn_id().clone(),
                items: vec![item.clone()],
            });
        }
    }
    groups
}

fn is_model_visible(item: &ThreadItem) -> bool {
    match item {
        ThreadItem::Reasoning { state, .. } => !state.is_empty(),
        ThreadItem::Plan { .. } => false,
        _ => true,
    }
}

fn tool_group_is_complete(items: &[ThreadItem]) -> bool {
    let calls = items
        .iter()
        .filter_map(|item| match item {
            ThreadItem::ToolCall { tool_call_id, .. } => Some(tool_call_id),
            _ => None,
        })
        .collect::<BTreeSet<_>>();
    let results = items
        .iter()
        .filter_map(|item| match item {
            ThreadItem::ToolResult { tool_call_id, .. } => Some(tool_call_id),
            _ => None,
        })
        .collect::<BTreeSet<_>>();
    calls == results
}

fn sort_instructions(instructions: &mut [InstructionFragment]) {
    instructions.sort_by_key(InstructionFragment::placement);
}

fn estimate_instructions(instructions: &[InstructionFragment]) -> ContextTokenCount {
    instructions
        .iter()
        .fold(ContextTokenCount::ZERO, |total, fragment| {
            total.saturating_add(estimate_instruction(fragment))
        })
}

fn estimate_instruction(fragment: &InstructionFragment) -> ContextTokenCount {
    estimate_bytes(fragment.body().len(), TEXT_ITEM_OVERHEAD)
}

fn estimate_environment(environment: &str) -> ContextTokenCount {
    if environment.trim().is_empty() {
        ContextTokenCount::ZERO
    } else {
        estimate_bytes(environment.len(), TEXT_ITEM_OVERHEAD)
    }
}

fn estimate_evidence(evidence: &[crate::ContextEvidence]) -> ContextTokenCount {
    evidence
        .iter()
        .fold(ContextTokenCount::ZERO, |total, evidence| {
            total.saturating_add(estimate_one_evidence(evidence))
        })
}

fn estimate_one_evidence(evidence: &crate::ContextEvidence) -> ContextTokenCount {
    estimate_bytes(
        evidence.source.len()
            + evidence.reference.len()
            + evidence.revision.len()
            + evidence.body.len(),
        TEXT_ITEM_OVERHEAD.saturating_mul(2),
    )
}

fn estimate_tools(tools: &[ToolDefinition]) -> ContextTokenCount {
    tools.iter().fold(ContextTokenCount::ZERO, |total, tool| {
        let bytes = serde_json::to_vec(tool).map_or(0, |encoded| encoded.len());
        total.saturating_add(estimate_bytes(bytes, TOOL_ITEM_OVERHEAD))
    })
}

fn estimate_items(items: &[ThreadItem]) -> ContextTokenCount {
    items.iter().fold(ContextTokenCount::ZERO, |total, item| {
        total.saturating_add(estimate_item(item))
    })
}

fn estimate_item(item: &ThreadItem) -> ContextTokenCount {
    match item {
        ThreadItem::UserMessage { text, .. } | ThreadItem::AgentMessage { text, .. } => {
            estimate_bytes(text.len(), TEXT_ITEM_OVERHEAD)
        }
        ThreadItem::UserContext { name, content, .. } => {
            estimate_bytes(name.len().saturating_add(content.len()), TEXT_ITEM_OVERHEAD)
        }
        ThreadItem::UserImage { url, .. } => ContextTokenCount::new(
            IMAGE_TOKEN_ESTIMATE.saturating_add(estimate_bytes(url.len(), 0).get()),
        ),
        ThreadItem::UserAudioAttachment { attachment, .. } => {
            estimate_audio(attachment.duration_ms)
        }
        ThreadItem::UserImageAttachment { .. } => ContextTokenCount::new(IMAGE_TOKEN_ESTIMATE),
        ThreadItem::ToolCall {
            name,
            arguments_json,
            ..
        } => estimate_bytes(
            name.as_str().len().saturating_add(arguments_json.len()),
            TOOL_ITEM_OVERHEAD,
        ),
        ThreadItem::ToolResult { text, content, .. } => content.as_ref().map_or_else(
            || estimate_bytes(text.len(), TOOL_ITEM_OVERHEAD),
            |content| estimate_content(content),
        ),
        ThreadItem::Reasoning { .. } | ThreadItem::Plan { .. } => ContextTokenCount::ZERO,
    }
}

fn estimate_content(content: &[ContentPart]) -> ContextTokenCount {
    content
        .iter()
        .fold(ContextTokenCount::new(TOOL_ITEM_OVERHEAD), |total, part| {
            let tokens = match part {
                ContentPart::Text(text) => estimate_bytes(text.len(), 0),
                ContentPart::AudioAttachment { attachment } => {
                    estimate_audio(attachment.duration_ms)
                }
                // Inline audio must be admitted before planning; it cannot bypass the budget.
                ContentPart::AudioUrl { .. } => ContextTokenCount::new(u32::MAX),
                ContentPart::ImageAttachment { .. } => ContextTokenCount::new(IMAGE_TOKEN_ESTIMATE),
                ContentPart::ImageUrl { url, .. } => ContextTokenCount::new(
                    IMAGE_TOKEN_ESTIMATE.saturating_add(estimate_bytes(url.len(), 0).get()),
                ),
            };
            total.saturating_add(tokens)
        })
}

fn estimate_audio(duration_ms: u64) -> ContextTokenCount {
    ContextTokenCount::new(
        u32::try_from(audio::approximate_tokens(duration_ms)).unwrap_or(u32::MAX),
    )
}

fn estimate_bytes(bytes: usize, overhead: u32) -> ContextTokenCount {
    let content = u32::try_from(bytes).unwrap_or(u32::MAX).saturating_add(3) / 4;
    ContextTokenCount::new(content.saturating_add(overhead))
}

fn subtract(total: ContextTokenCount, used: ContextTokenCount) -> ContextTokenCount {
    ContextTokenCount::new(total.get().saturating_sub(used.get()))
}

#[cfg(test)]
#[path = "planner_tests.rs"]
mod tests;

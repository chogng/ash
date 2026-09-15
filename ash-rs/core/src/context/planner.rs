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
    pub(crate) fn prepare(
        input: &ContextInput,
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
        let maximum_compaction_input = budget.maximum_compaction_input();
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
        if current_turn_tokens > after_tools {
            return Err(ContextPreparationError::CurrentInputTooLarge {
                required: current_turn_tokens,
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
        if history_tokens > after_current {
            let checkpoint_overhead = estimate_bytes(
                ash_prompts::checkpoint_prompt_overhead(super::CHECKPOINT_ID_BYTES),
                0,
            );
            let summary_capacity = subtract(after_current, checkpoint_overhead);
            let checkpoint_capacity = summary_capacity
                .get()
                .min(budget.reserved_output().get())
                .min(2_048);
            if checkpoint_capacity < MIN_CHECKPOINT_TOKENS {
                return Err(ContextPreparationError::CheckpointCapacityTooSmall {
                    available: ContextTokenCount::new(checkpoint_capacity),
                });
            }
            let summary_reserve = ContextTokenCount::new(
                (summary_capacity.get() / 3)
                    .clamp(MIN_CHECKPOINT_TOKENS, 2_048)
                    .min(checkpoint_capacity),
            );
            let retained_budget = subtract(summary_capacity, summary_reserve);
            let required_covered_turns = compaction_prefix(input, &history_groups, retained_budget);
            let covered_turns = bounded_compaction_prefix(
                input,
                checkpoint.as_ref(),
                &model_items,
                &required_covered_turns,
                maximum_compaction_input,
            )?;
            let covered_end_sequence = covered_turns
                .iter()
                .flat_map(|turn_id| {
                    model_items
                        .iter()
                        .filter(move |item| item.turn_id() == turn_id)
                })
                .filter_map(|item| input.item_sequence(item.item_id()))
                .max()
                .unwrap_or(checkpoint_end);
            if covered_end_sequence == 0 {
                return Err(ContextPreparationError::UnsupportedContextShape(
                    "context overflow did not identify a durable history prefix to compact".into(),
                ));
            }
            let source_items = model_items
                .iter()
                .filter(|item| covered_turns.contains(item.turn_id()))
                .cloned()
                .collect();
            return Ok(ContextPreparation::NeedsCompaction(CompactionPlan {
                source_thread_sequence: input.source_thread_sequence(),
                covered_turns,
                covered: ContextSourceRange {
                    start_sequence: 1,
                    end_sequence: covered_end_sequence,
                },
                previous_checkpoint: checkpoint,
                source_items,
                target_tokens: summary_reserve,
                budget: base_report,
            }));
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
                .min(history_tokens.get().saturating_sub(1)),
        );
        Ok(CompactionPlan {
            source_thread_sequence: input.source_thread_sequence(),
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
                .min(history_tokens.get().saturating_sub(1)),
        );
        Ok(CompactionPlan {
            source_thread_sequence: input.source_thread_sequence(),
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
    !matches!(item, ThreadItem::Reasoning { .. } | ThreadItem::Plan { .. })
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

fn compaction_prefix(
    input: &ContextInput,
    groups: &[&TurnGroup],
    available: ContextTokenCount,
) -> Vec<TurnId> {
    let mut retained = ContextTokenCount::ZERO;
    let mut first_retained = groups.len();
    for (index, group) in groups.iter().enumerate().rev() {
        let group_tokens = estimate_group(input, group);
        if retained.saturating_add(group_tokens) > available {
            break;
        }
        retained = retained.saturating_add(group_tokens);
        first_retained = index;
    }
    groups[..first_retained]
        .iter()
        .map(|group| group.turn_id.clone())
        .collect()
}

fn bounded_compaction_prefix(
    input: &ContextInput,
    checkpoint: Option<&ContextCheckpoint>,
    model_items: &[ThreadItem],
    required_turns: &[TurnId],
    available: ContextTokenCount,
) -> Result<Vec<TurnId>, ContextPreparationError> {
    let checkpoint_end = checkpoint.map_or(0, |checkpoint| checkpoint.covered.end_sequence);
    if required_turns.is_empty() {
        let covered = ContextSourceRange {
            start_sequence: 1,
            end_sequence: checkpoint_end,
        };
        let required =
            estimate_compaction_input(covered, checkpoint, &[], None).map_err(|error| {
                ContextPreparationError::UnsupportedContextShape(format!(
                    "failed to estimate context compaction input: {error}"
                ))
            })?;
        return if checkpoint_end > 0 && required <= available {
            Ok(Vec::new())
        } else {
            Err(ContextPreparationError::CompactionSourceTooLarge {
                required,
                available,
            })
        };
    }

    let mut selected = Vec::new();
    let mut first_required = ContextTokenCount::ZERO;
    for turn_id in required_turns {
        selected.push(turn_id.clone());
        let covered_end_sequence = selected
            .iter()
            .flat_map(|selected_turn| {
                model_items
                    .iter()
                    .filter(move |item| item.turn_id() == selected_turn)
            })
            .filter_map(|item| input.item_sequence(item.item_id()))
            .max()
            .unwrap_or(checkpoint_end);
        let source_items = model_items
            .iter()
            .filter(|item| selected.contains(item.turn_id()))
            .cloned()
            .collect::<Vec<_>>();
        let required = estimate_compaction_input(
            ContextSourceRange {
                start_sequence: 1,
                end_sequence: covered_end_sequence,
            },
            checkpoint,
            &source_items,
            None,
        )
        .map_err(|error| {
            ContextPreparationError::UnsupportedContextShape(format!(
                "failed to estimate context compaction input: {error}"
            ))
        })?;
        if selected.len() == 1 {
            first_required = required;
        }
        if required > available {
            selected.pop();
            break;
        }
    }
    if selected.is_empty() {
        return Err(ContextPreparationError::CompactionSourceTooLarge {
            required: first_required,
            available,
        });
    }
    Ok(selected)
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

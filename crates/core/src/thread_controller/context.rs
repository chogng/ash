use super::CommitContextCheckpointRequest;
use super::ContextCheckpointCommitKind;
use super::PrepareModelInvocationRequest;
use super::ThreadController;
use crate::ContextBudget;
use crate::CoreError;
use crate::ToolActivationResult;
use crate::TurnSnapshot;
use crate::context::CONTEXT_ESTIMATOR_REVISION;
use crate::context::ContextCalibration;
use crate::context::ContextInput;
use crate::context::ContextOverflowRecoveryPreparation;
use crate::context::ContextPreparation;
use crate::context::FrozenModelSelection;
use crate::context::ManualContextCompactionPreparation;
use crate::context::ModelInvocationPreparation;
use crate::context::ModelInvocationSnapshot;
use crate::services::successful_read_paths;
use crate::services::tool_activation_results;
use ash_protocol::ContextCheckpoint;
use ash_protocol::ContextCheckpointId;
use ash_protocol::ContextCheckpointVerification;
use ash_protocol::ContextCompactionPolicy;
use ash_protocol::MessagePhase;
use ash_protocol::SessionId;
use ash_protocol::ThreadCommand;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::TurnId;
use ash_thread_store::ThreadStoreError;
use std::path::PathBuf;

#[cfg(test)]
#[path = "context_tests.rs"]
mod tests;

/// Owned inputs for host preparation before the context planner reads the transcript.
pub(crate) struct ModelStepInputs {
    pub(crate) turn: TurnSnapshot,
    pub(crate) session_id: SessionId,
    pub(crate) sequence: u64,
    pub(crate) context_policy: ContextCompactionPolicy,
    pub(crate) calibration: Option<ContextCalibration>,
    pub(crate) read_paths: Vec<PathBuf>,
    pub(crate) first_query: Option<String>,
    pub(crate) tool_results: Vec<ToolActivationResult<'static>>,
    pub(crate) needs_continuation_instruction: bool,
}

impl ThreadController {
    pub(crate) fn read_model_step(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
    ) -> Result<ModelStepInputs, CoreError> {
        self.with_loaded_thread(thread_id, |loaded| {
            let snapshot = &loaded.snapshot;
            let turn = snapshot
                .turns
                .iter()
                .rev()
                .find(|turn| &turn.turn_id == turn_id)
                .ok_or_else(|| CoreError::NotFound(turn_id.to_string()))?;
            // Turns can interleave in the journal. Filter by identity once, then derive each
            // input from those items without copying historical messages or calling host services.
            let items: Vec<_> = snapshot
                .items
                .iter()
                .filter(|item| item.turn_id() == turn_id)
                .collect();
            let tool_results = tool_activation_results(items.iter().copied())?
                .into_iter()
                .map(ToolActivationResult::into_owned)
                .collect();
            let read_paths = successful_read_paths(items.iter().copied())
                .into_iter()
                .collect();
            let needs_continuation_instruction = turn.nonterminal_continuations > 0
                && matches!(
                    snapshot.items.last(),
                    Some(ThreadItem::AgentMessage {
                        phase: Some(MessagePhase::Commentary | MessagePhase::PartialAnswer),
                        ..
                    })
                );
            let calibration = turn
                .model
                .as_ref()
                .and_then(|model| snapshot.context_calibration(model, CONTEXT_ESTIMATOR_REVISION))
                .cloned();
            Ok(ModelStepInputs {
                turn: turn.clone(),
                session_id: snapshot.session_id.clone(),
                sequence: snapshot.sequence,
                context_policy: snapshot.context_policy(turn_id),
                calibration,
                read_paths,
                first_query: first_model_query(&items),
                tool_results,
                needs_continuation_instruction,
            })
        })
    }

    pub(crate) fn commit_context_checkpoint(
        &self,
        thread_id: &ThreadId,
        request: CommitContextCheckpointRequest,
    ) -> Result<ContextCheckpoint, CoreError> {
        self.commit_context_checkpoint_with_kind(
            thread_id,
            request,
            ContextCheckpointCommitKind::Automatic,
        )
    }

    pub(crate) fn commit_context_overflow_recovery(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        request: CommitContextCheckpointRequest,
    ) -> Result<ContextCheckpoint, CoreError> {
        self.commit_context_checkpoint_with_kind(
            thread_id,
            request,
            ContextCheckpointCommitKind::OverflowRecovery(turn_id.clone()),
        )
    }

    fn commit_context_checkpoint_with_kind(
        &self,
        thread_id: &ThreadId,
        request: CommitContextCheckpointRequest,
        kind: ContextCheckpointCommitKind,
    ) -> Result<ContextCheckpoint, CoreError> {
        if request.summary.trim().is_empty()
            || request.schema_revision.trim().is_empty()
            || request.prompt_revision.trim().is_empty()
            || request.context_policy_revision.trim().is_empty()
        {
            return Err(CoreError::InvalidInput(
                "context checkpoint summary and revision identities must not be empty".into(),
            ));
        }
        self.mutate_thread(thread_id, |snapshot| {
            if snapshot.sequence != request.source_thread_sequence {
                return Err(CoreError::ThreadStore(ThreadStoreError::SequenceConflict {
                    expected: request.source_thread_sequence,
                    actual: snapshot.sequence,
                }));
            }
            let checkpoint = ContextCheckpoint {
                checkpoint_id: ContextCheckpointId::new(
                    self.next_identifier(crate::context::CHECKPOINT_ID_PREFIX),
                )
                .expect("generated context checkpoint ID is non-empty"),
                source_thread_id: snapshot.thread_id.clone(),
                covered: request.covered,
                source_digest: snapshot
                    .context_items_digest(request.covered, &request.referenced_items)?,
                referenced_items: request.referenced_items,
                summary: request.summary,
                schema_revision: request.schema_revision,
                prompt_revision: request.prompt_revision,
                context_policy_revision: request.context_policy_revision,
                generator_model: request.generator_model,
                created_at_unix_ms: u64::try_from(self.timestamp()?.0).map_err(|_| {
                    CoreError::Journal("context checkpoint timestamp exceeds u64".into())
                })?,
                verification: ContextCheckpointVerification::Verified,
            };
            let event = match &kind {
                ContextCheckpointCommitKind::Automatic => ThreadEvent::ContextCheckpointCommitted {
                    thread_id: thread_id.clone(),
                    checkpoint: checkpoint.clone(),
                },
                ContextCheckpointCommitKind::OverflowRecovery(turn_id) => {
                    ThreadEvent::ContextOverflowRecoveryCommitted {
                        thread_id: thread_id.clone(),
                        turn_id: turn_id.clone(),
                        checkpoint: checkpoint.clone(),
                    }
                }
            };
            self.record_batch(snapshot, vec![event])?;
            Ok(checkpoint)
        })
    }

    pub(crate) fn prepare_context_overflow_recovery(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
    ) -> Result<ContextOverflowRecoveryPreparation, CoreError> {
        let include_time = self.sample_time_context()?.is_some();
        self.with_loaded_thread(thread_id, |loaded| {
            let turn = loaded
                .snapshot
                .turns
                .iter()
                .find(|turn| &turn.turn_id == turn_id)
                .ok_or_else(|| CoreError::NotFound(turn_id.to_string()))?;
            if turn.status != ash_protocol::TurnStatus::Running {
                return Err(CoreError::InvalidInput(
                    "context overflow recovery requires a running Turn".into(),
                ));
            }
            if loaded
                .snapshot
                .context_overflow_recoveries
                .contains_key(turn_id)
            {
                return Ok(ContextOverflowRecoveryPreparation::AlreadyAttempted);
            }
            let model = match &turn.model {
                Some(model) => FrozenModelSelection::Selected(model.clone()),
                None => FrozenModelSelection::ConfiguredDefault,
            };
            let mut input = ContextInput::new(
                &loaded.snapshot,
                turn_id.clone(),
                Vec::new(),
                Vec::new(),
                ContextBudget::provider_managed(),
            );
            if include_time {
                input = input.with_time_references(&loaded.snapshot.user_time_contexts)?;
            }
            let plan = match loaded.context.prepare_overflow_recovery(&input) {
                Ok(plan) => plan,
                Err(crate::context::ContextPreparationError::NoCompactionCandidate) => {
                    return Ok(ContextOverflowRecoveryPreparation::Unavailable);
                }
                Err(error) => return Err(CoreError::Context(error.to_string())),
            };
            Ok(ContextOverflowRecoveryPreparation::NeedsCompaction { model, plan })
        })
    }

    pub(crate) fn prepare_manual_context_compaction(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        budget: ContextBudget,
    ) -> Result<ManualContextCompactionPreparation, CoreError> {
        let include_time = self.sample_time_context()?.is_some();
        self.with_loaded_thread(thread_id, |loaded| {
            let turn = loaded
                .snapshot
                .turns
                .iter()
                .find(|turn| &turn.turn_id == turn_id)
                .ok_or_else(|| CoreError::NotFound(turn_id.to_string()))?;
            if turn.status != ash_protocol::TurnStatus::Running {
                return Err(CoreError::InvalidInput(
                    "manual context compaction requires a running Turn".into(),
                ));
            }
            let command = loaded
                .snapshot
                .commands
                .iter()
                .find(|command| {
                    matches!(
                        &command.result,
                        crate::ThreadCommandResult::TurnAccepted {
                            turn_id: command_turn_id,
                        } if command_turn_id == turn_id
                    )
                })
                .ok_or_else(|| {
                    CoreError::Journal(
                        "manual context compaction Turn has no command receipt".into(),
                    )
                })?;
            let ThreadCommand::CompactContext {
                model,
                retention_prompt,
            } = &command.receipt.command
            else {
                return Err(CoreError::InvalidInput(
                    "Turn is not a manual context compaction command".into(),
                ));
            };
            let frozen_model = match model {
                Some(model) => FrozenModelSelection::Selected(model.clone()),
                None => FrozenModelSelection::ConfiguredDefault,
            };
            let mut input = ContextInput::new(
                &loaded.snapshot,
                turn_id.clone(),
                Vec::new(),
                Vec::new(),
                budget,
            );
            if include_time {
                input = input.with_time_references(&loaded.snapshot.user_time_contexts)?;
            }
            match loaded
                .context
                .prepare_manual_compaction(&input, retention_prompt.as_deref())
            {
                Ok(plan) => Ok(ManualContextCompactionPreparation::NeedsCompaction {
                    model: frozen_model,
                    retention_prompt: retention_prompt.clone(),
                    plan,
                }),
                Err(crate::context::ContextPreparationError::NoCompactionCandidate) => {
                    Ok(ManualContextCompactionPreparation::Complete)
                }
                Err(error) => Err(CoreError::Context(error.to_string())),
            }
        })
    }

    pub(crate) fn prepare_model_invocation(
        &self,
        thread_id: &ThreadId,
        request: PrepareModelInvocationRequest<'_>,
    ) -> Result<ModelInvocationPreparation, CoreError> {
        self.with_loaded_thread(thread_id, |loaded| {
            let turn = loaded
                .snapshot
                .turns
                .iter()
                .find(|turn| &turn.turn_id == request.turn_id)
                .ok_or_else(|| CoreError::NotFound(request.turn_id.to_string()))?;
            let model = match &turn.model {
                Some(model) => FrozenModelSelection::Selected(model.clone()),
                None => FrozenModelSelection::ConfiguredDefault,
            };
            let instructions = turn.instructions.as_ref().ok_or_else(|| {
                CoreError::Context(format!(
                    "Turn {} has no frozen instructions",
                    request.turn_id
                ))
            })?;
            let mut additional = request.harness_context.instructions().context_fragments();
            additional.extend(crate::multi_agent::agent_context_fragments(
                &loaded.snapshot,
            ));
            additional.extend(request.additional_instructions);
            let instruction_fragments = crate::context::turn_instruction_fragments(
                instructions,
                turn.approval_mode,
                turn.mode,
                if loaded.snapshot.parent_thread_id.is_some() {
                    crate::context::AgentInstructionRole::Subagent
                } else {
                    crate::context::AgentInstructionRole::Root
                },
                additional,
            );
            let tools = crate::multi_agent::scope_agent_tools(
                &loaded.snapshot,
                turn.tool_mode,
                request.tools,
            );
            let mut input = ContextInput::new(
                &loaded.snapshot,
                request.turn_id.clone(),
                instruction_fragments,
                tools,
                request.budget,
            );
            if let Some(environment) = request.harness_context.environment() {
                input = input.with_rendered_environment(environment.render());
            }
            if let Some(time) = request.harness_context.time_context() {
                input = input.with_time_context(time, &loaded.snapshot.user_time_contexts)?;
            }
            input = input.with_evidence(request.evidence);
            match loaded
                .context
                .prepare(&input)
                .map_err(|error| CoreError::Context(error.to_string()))?
            {
                ContextPreparation::Ready(context) => Ok(ModelInvocationPreparation::Ready(
                    ModelInvocationSnapshot::new(
                        loaded.snapshot.session_id.clone(),
                        loaded.snapshot.thread_id.clone(),
                        request.turn_id.clone(),
                        model,
                        context,
                    ),
                )),
                ContextPreparation::NeedsCompaction(plan) => {
                    Ok(ModelInvocationPreparation::NeedsCompaction { model, plan })
                }
            }
        })
    }
}

fn first_model_query(items: &[&ThreadItem]) -> Option<String> {
    if items.iter().any(|item| {
        matches!(
            item,
            ThreadItem::AgentMessage { .. }
                | ThreadItem::ToolCall { .. }
                | ThreadItem::ToolResult { .. }
        )
    }) {
        return None;
    }
    let query = items
        .iter()
        .filter_map(|item| match item {
            ThreadItem::UserMessage { text, .. } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n");
    (!query.trim().is_empty()).then_some(query)
}

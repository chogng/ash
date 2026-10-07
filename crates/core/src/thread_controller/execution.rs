use super::CommitModelResponseResult;
use super::CompletedTurn;
use super::RecordToolExecutionEscalation;
use super::RecordToolExecutionStart;
use super::ThreadController;
use crate::CoreError;
use crate::ThreadCommandResult;
use ash_model_accounting::RateCard;
use ash_protocol::ItemId;
use ash_protocol::ModelBillingScope;
use ash_protocol::ModelInputEstimate;
use ash_protocol::ModelInvocationId;
use ash_protocol::ModelInvocationOutcome;
use ash_protocol::ModelInvocationRecord;
use ash_protocol::ModelRef;
use ash_protocol::ModelUsage;
use ash_protocol::RequestId;
use ash_protocol::StableTurnError;
use ash_protocol::StreamInstanceId;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::TurnId;
use std::sync::OnceLock;

#[cfg(test)]
use super::RecordedToolCall;
#[cfg(test)]
use ash_protocol::ToolCall;
#[cfg(test)]
use ash_protocol::ToolCallBinding;

impl ThreadController {
    /// Durably accounts for one completed provider invocation before its output is consumed.
    pub(crate) fn record_model_invocation(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        requested_model: Option<&ModelRef>,
        response_billing: Option<&ash_protocol::ModelResponseBilling>,
        billing_scope: ModelBillingScope,
        usage: Option<ModelUsage>,
        input_estimate: Option<ModelInputEstimate>,
        time_context: Option<ash_protocol::TimeContext>,
        started_at_unix_ms: u64,
        completed_at_unix_ms: u64,
    ) -> Result<u64, CoreError> {
        self.record_model_invocation_for_tool(
            thread_id,
            turn_id,
            requested_model,
            response_billing,
            billing_scope,
            usage,
            input_estimate,
            time_context,
            started_at_unix_ms,
            completed_at_unix_ms,
            None,
            ModelInvocationOutcome::Completed,
        )
    }

    pub(crate) fn record_model_invocation_for_tool(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        requested_model: Option<&ModelRef>,
        response_billing: Option<&ash_protocol::ModelResponseBilling>,
        billing_scope: ModelBillingScope,
        usage: Option<ModelUsage>,
        input_estimate: Option<ModelInputEstimate>,
        time_context: Option<ash_protocol::TimeContext>,
        started_at_unix_ms: u64,
        completed_at_unix_ms: u64,
        tool_call_id: Option<ash_protocol::ToolCallId>,
        outcome: ModelInvocationOutcome,
    ) -> Result<u64, CoreError> {
        static RATE_CARD: OnceLock<Result<RateCard, String>> = OnceLock::new();
        let rate_card = RATE_CARD
            .get_or_init(|| {
                RateCard::bundled_accelerated_public_prices().map_err(|error| error.to_string())
            })
            .as_ref()
            .map_err(|error| CoreError::Execution(format!("model accounting failed: {error}")))?;
        let priced = rate_card
            .price_invocation(
                requested_model,
                response_billing,
                billing_scope,
                usage.as_ref(),
                started_at_unix_ms,
            )
            .map_err(|error| CoreError::Execution(format!("model accounting failed: {error}")))?;
        let invocation_id = ModelInvocationId::new(self.next_identifier("model-invocation"))
            .expect("generated model invocation ID is non-empty");
        let record = ModelInvocationRecord {
            time_context,
            invocation_id,
            tool_call_id,
            thread_id: thread_id.clone(),
            turn_id: turn_id.clone(),
            requested_model: requested_model.cloned(),
            resolved_model: priced.resolved_model,
            billing: priced.billing,
            started_at_unix_ms,
            completed_at_unix_ms,
            outcome,
            usage,
            input_estimate,
            reference_cost: priced.reference_cost,
        };
        self.mutate_thread(thread_id, |snapshot| {
            self.record_batch(
                snapshot,
                vec![ThreadEvent::ModelInvocationRecorded {
                    thread_id: thread_id.clone(),
                    turn_id: turn_id.clone(),
                    record,
                }],
            )?;
            Ok(snapshot.sequence)
        })
    }

    #[cfg(test)]
    pub(crate) fn record_model_usage(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        usage: Option<ModelUsage>,
    ) -> Result<u64, CoreError> {
        self.record_model_invocation(
            thread_id,
            turn_id,
            None,
            None,
            ModelBillingScope::Unavailable,
            usage,
            None,
            None,
            0,
            0,
        )
    }

    /// Completes a Turn that intentionally produced no agent message.
    pub fn complete_turn_without_agent_message(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
    ) -> Result<u64, CoreError> {
        self.mutate_thread(thread_id, |snapshot| {
            self.record_batch(
                snapshot,
                vec![ThreadEvent::TurnCompleted {
                    thread_id: thread_id.clone(),
                    turn_id: turn_id.clone(),
                }],
            )?;
            Ok(snapshot.sequence)
        })
    }

    #[cfg(test)]
    pub(crate) fn record_model_tool_call(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        call: &ToolCall,
        binding: ToolCallBinding,
    ) -> Result<RecordedToolCall, CoreError> {
        let item = ThreadItem::ToolCall {
            item_id: ItemId::new(self.next_identifier("item"))
                .expect("generated Item ID is non-empty"),
            turn_id: turn_id.clone(),
            tool_call_id: call.id.clone(),
            name: call.name.clone(),
            arguments_json: serde_json::to_string(&call.arguments)
                .map_err(|error| CoreError::Context(error.to_string()))?,
            binding: Some(binding),
        };
        let sequence = self.record_item(thread_id, turn_id, item.clone())?;
        Ok(RecordedToolCall {
            item,
            tool_call_id: call.id.clone(),
            sequence,
        })
    }

    /// Commits one complete agent message produced by a Turn execution backend.
    pub fn record_agent_message(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        text: String,
    ) -> Result<u64, CoreError> {
        self.record_agent_message_with_id(
            thread_id,
            turn_id,
            ItemId::new(self.next_identifier("item")).expect("generated Item ID is non-empty"),
            text,
        )
    }

    /// Commits one complete agent message using the Item ID projected during streaming.
    pub fn record_agent_message_with_id(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        item_id: ItemId,
        text: String,
    ) -> Result<u64, CoreError> {
        self.record_item(
            thread_id,
            turn_id,
            ThreadItem::AgentMessage {
                phase: None,
                item_id,
                turn_id: turn_id.clone(),
                text,
            },
        )
    }

    /// Commits one complete reasoning item produced by a Turn execution backend.
    pub fn record_reasoning(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        text: String,
    ) -> Result<u64, CoreError> {
        self.record_reasoning_with_id(
            thread_id,
            turn_id,
            ItemId::new(self.next_identifier("item")).expect("generated Item ID is non-empty"),
            text,
        )
    }

    /// Commits one complete reasoning item using the Item ID projected during streaming.
    pub fn record_reasoning_with_id(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        item_id: ItemId,
        text: String,
    ) -> Result<u64, CoreError> {
        self.record_item(
            thread_id,
            turn_id,
            ThreadItem::Reasoning {
                state: Vec::new(),
                item_id,
                turn_id: turn_id.clone(),
                text,
            },
        )
    }

    /// Atomically commits the final agent message and terminal Turn completion.
    pub fn complete_turn_with_agent_message(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        item_id: ItemId,
        output: String,
    ) -> Result<CompletedTurn, CoreError> {
        self.mutate_thread(thread_id, |snapshot| {
            let item = ThreadItem::AgentMessage {
                phase: None,
                item_id,
                turn_id: turn_id.clone(),
                text: output,
            };
            self.record_batch(
                snapshot,
                vec![
                    ThreadEvent::ItemCompleted {
                        checkpoint_after_sequence: None,
                        workspace_checkpoint: None,
                        thread_id: thread_id.clone(),
                        turn_id: turn_id.clone(),
                        item: item.clone(),
                    },
                    ThreadEvent::TurnCompleted {
                        thread_id: thread_id.clone(),
                        turn_id: turn_id.clone(),
                    },
                ],
            )?;
            Ok(CompletedTurn {
                item,
                sequence: snapshot.sequence,
            })
        })
    }

    /// Commits response items and the loop decision together, checking steering under the writer lock.
    pub(crate) fn commit_model_response(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        source_thread_sequence: u64,
        items: Vec<ThreadItem>,
        mut decision: ash_protocol::TurnLoopDecision,
    ) -> Result<CommitModelResponseResult, CoreError> {
        self.mutate_thread(thread_id, |snapshot| {
            let turn = snapshot.turns.iter().find(|turn| &turn.turn_id == turn_id)
                .ok_or_else(|| CoreError::NotFound(turn_id.to_string()))?;
            if matches!(turn.status, ash_protocol::TurnStatus::Cancelling | ash_protocol::TurnStatus::Interrupted) {
                return Err(CoreError::Cancelled("Turn cancelled before response commit".into()));
            }
            if turn.status != ash_protocol::TurnStatus::Running {
                return Err(CoreError::Execution("model response requires a running Turn".into()));
            }
            let superseded = has_steer_after(snapshot, turn_id, source_thread_sequence);
            if superseded {
                decision.action = ash_protocol::TurnLoopAction::Superseded;
                decision.reason = ash_protocol::TurnLoopReason::NewInput;
            }
            let completed_item = if decision.action == ash_protocol::TurnLoopAction::Complete {
                if turn.pending_interaction.is_some() || snapshot.items.iter().any(|item| {
                    matches!(item, ThreadItem::ToolCall { turn_id: owner, tool_call_id, .. }
                        if owner == turn_id && !snapshot.items.iter().any(|result|
                            matches!(result, ThreadItem::ToolResult { tool_call_id: resolved, .. } if resolved == tool_call_id)))
                }) {
                    return Err(CoreError::Execution("Turn still has a pending interaction".into()));
                }
                Some(items.iter().rev().find(|item| matches!(item, ThreadItem::AgentMessage { text, .. } if !text.trim().is_empty()))
                    .cloned().ok_or_else(|| CoreError::Execution("model returned no final message".into()))?)
            } else {
                None
            };
            let failed = decision.action == ash_protocol::TurnLoopAction::Fail;
            let mut events = vec![ThreadEvent::ModelResponseEvaluated {
                thread_id: thread_id.clone(),
                turn_id: turn_id.clone(),
                source_thread_sequence,
                decision,
            }];
            if !superseded {
                events.extend(items.into_iter().map(|item| ThreadEvent::ItemCompleted {
                    checkpoint_after_sequence: None,
                    workspace_checkpoint: None,
                    thread_id: thread_id.clone(),
                    turn_id: turn_id.clone(),
                    item,
                }));
            }
            if completed_item.is_some() {
                events.push(ThreadEvent::TurnCompleted { thread_id: thread_id.clone(), turn_id: turn_id.clone() });
            } else if failed {
                events.push(ThreadEvent::TurnFailed {
                    thread_id: thread_id.clone(), turn_id: turn_id.clone(),
                    error: ash_protocol::StableTurnError::model_invocation_failed(),
                });
            }
            self.record_batch(snapshot, events)?;
            Ok(if superseded {
                CommitModelResponseResult::SupersededBySteer
            } else if let Some(item) = completed_item {
                CommitModelResponseResult::Completed(CompletedTurn { item, sequence: snapshot.sequence })
            } else {
                CommitModelResponseResult::Committed
            })
        })
    }

    /// Allocates a process-unique Item ID for a backend's transient stream projection.
    pub fn next_stream_item_id(&self) -> ItemId {
        ItemId::new(self.next_identifier("item")).expect("generated Item ID is non-empty")
    }

    /// Allocates a process-unique stream identity for ordered transient updates.
    pub fn next_stream_instance_id(&self) -> StreamInstanceId {
        StreamInstanceId::new(self.next_identifier("stream"))
            .expect("generated stream instance ID is non-empty")
    }

    /// Allocates a process-unique ID for a backend-originated durable interaction.
    pub fn next_interaction_request_id(&self) -> RequestId {
        RequestId::new(self.next_identifier("request"))
            .expect("generated interaction request ID is non-empty")
    }

    pub(crate) fn record_tool_execution_started(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        start: RecordToolExecutionStart,
    ) -> Result<(), CoreError> {
        self.mutate_thread(thread_id, |snapshot| {
            if start
                .expected_review_sequence
                .is_some_and(|expected| snapshot.sequence != expected)
            {
                return Err(CoreError::ReviewContextChanged);
            }
            self.record_batch(
                snapshot,
                vec![ThreadEvent::ToolExecutionStarted {
                    thread_id: thread_id.clone(),
                    turn_id: turn_id.clone(),
                    tool_call_id: start.tool_call_id,
                    action_digest: start.action_digest,
                    policy_revision: start.policy_revision,
                    authority: start.authority,
                }],
            )
        })
    }

    pub(crate) fn record_tool_execution_escalated(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        escalation: RecordToolExecutionEscalation,
    ) -> Result<(), CoreError> {
        self.mutate_thread(thread_id, |snapshot| {
            if escalation
                .expected_review_sequence
                .is_some_and(|expected| snapshot.sequence != expected)
            {
                return Err(CoreError::ReviewContextChanged);
            }
            self.record_batch(
                snapshot,
                vec![ThreadEvent::ToolExecutionEscalated {
                    thread_id: thread_id.clone(),
                    turn_id: turn_id.clone(),
                    tool_call_id: escalation.tool_call_id,
                    action_digest: escalation.action_digest,
                    policy_revision: escalation.policy_revision,
                    denial: escalation.denial,
                    authority: escalation.authority,
                }],
            )
        })
    }

    /// Enqueues backend work on the Thread-owned bounded execution mailbox.
    ///
    /// The task must keep all model and tool work inside the supplied cancellation scope. Returning
    /// releases the active operation; a later interaction continuation may enqueue another task.
    pub fn enqueue_turn_execution(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        task: impl FnOnce(super::mailbox::ThreadExecutionContext) + Send + 'static,
    ) -> Result<(), CoreError> {
        self.store.execution_binding(thread_id)?.require_bound()?;
        self.execution_mailboxes.enqueue(thread_id, turn_id, task)
    }

    pub(crate) fn interrupt_execution(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        reason: super::TurnInterruption,
    ) -> Result<(), CoreError> {
        let error = match reason {
            super::TurnInterruption::Cancelled => None,
            super::TurnInterruption::PolicyCircuitBreaker(reason) => {
                Some(StableTurnError::policy_circuit_breaker(reason))
            }
        };
        self.mutate_thread(thread_id, |snapshot| {
            let status = snapshot
                .turns
                .iter()
                .find(|turn| &turn.turn_id == turn_id)
                .map(|turn| turn.status)
                .ok_or_else(|| CoreError::NotFound(turn_id.to_string()))?;
            let events = match status {
                crate::TurnStatus::Created
                | crate::TurnStatus::Running
                | crate::TurnStatus::WaitingForApproval
                | crate::TurnStatus::WaitingForUserInput
                | crate::TurnStatus::WaitingForCapability => vec![
                    ThreadEvent::TurnCancelling {
                        thread_id: thread_id.clone(),
                        turn_id: turn_id.clone(),
                    },
                    ThreadEvent::TurnInterrupted {
                        thread_id: thread_id.clone(),
                        turn_id: turn_id.clone(),
                        error: error.clone(),
                    },
                ],
                crate::TurnStatus::Cancelling => vec![ThreadEvent::TurnInterrupted {
                    thread_id: thread_id.clone(),
                    turn_id: turn_id.clone(),
                    error: error.clone(),
                }],
                crate::TurnStatus::Completed
                | crate::TurnStatus::Failed
                | crate::TurnStatus::Interrupted => return Ok(()),
            };
            self.record_batch(snapshot, events)
        })
    }

    pub(crate) fn cancel_turn_execution(&self, thread_id: &ThreadId, turn_id: &TurnId) {
        self.execution_mailboxes.cancel(thread_id, turn_id);
    }
}

fn has_steer_after(
    snapshot: &crate::ThreadSnapshot,
    turn_id: &TurnId,
    source_thread_sequence: u64,
) -> bool {
    snapshot.commands.iter().any(|command| {
        command.response_sequence > source_thread_sequence
            && matches!(
                &command.result,
                ThreadCommandResult::TurnSteered {
                    turn_id: command_turn_id,
                } if command_turn_id == turn_id
            )
    })
}

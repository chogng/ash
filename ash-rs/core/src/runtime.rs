use crate::MultiAgentCoordinator;
use crate::ThreadController;
use crate::ThreadSnapshot;
use crate::TurnExecutionBackend;
use crate::TurnExecutor;
use ash_protocol::AgentId;
use ash_protocol::CommandId;
use ash_protocol::InteractionCancelReason;
use ash_protocol::MessageCheckpoint;
use ash_protocol::RequestId;
use ash_protocol::SessionId;
use ash_protocol::StableTurnError;
use ash_protocol::ThreadArchiveReason;
use ash_protocol::ThreadCommand;
use ash_protocol::ThreadGoalStatus;
use ash_protocol::ThreadId;
use ash_protocol::ThreadOrigin;
use ash_protocol::ThreadUpdateEnvelope;
use ash_protocol::ToolCall;
use ash_protocol::ToolCallCaller;
use ash_protocol::ToolCallId;
use ash_protocol::ToolName;
use ash_protocol::ToolProfileSnapshot;
use ash_protocol::TurnId;
use ash_protocol::TurnStatus;
use core_api::AcceptedCommand;
use core_api::AgentRuntime;
use core_api::CompactThreadRequest;
use core_api::CoreError;
use core_api::CreateBranchRequest;
use core_api::ForkThreadRequest;
use core_api::InteractionLifecycle;
use core_api::InterruptTurnRequest;
use core_api::ReplaceThreadRequest;
use core_api::ResolveTurnInteractionRequest;
use core_api::RestoreMessageRequest;
use core_api::RewindThreadRequest;
use core_api::SequenceExpectation;
use core_api::SessionView;
use core_api::SetGoalRequest;
use core_api::SetGoalResult;
use core_api::StartThreadRequest;
use core_api::SteerTurnRequest;
use core_api::SubmitShellRequest;
use core_api::SubmitTurnRequest;
use core_api::SubmittedCommand;
use core_api::ThreadUpdateSink;
use core_api::ThreadView;
use core_api::ThreadWorktreeBinder;
use core_api::TurnReceipt;

use std::collections::BTreeSet;
use std::sync::Arc;

/// Operation entrypoint over the shared Thread owner and one immutable execution selection.
/// This handle owns no second Thread state. Hosts select an environment before obtaining it.
pub struct Runtime<'a> {
    threads: &'a ThreadController,
    agents: &'a MultiAgentCoordinator,
    executor: TurnExecutor,
    backend: &'a dyn TurnExecutionBackend,
    binder: &'a dyn ThreadWorktreeBinder,
    updates: Arc<dyn ThreadUpdateSink>,
}

impl<'a> Runtime<'a> {
    pub fn new(
        threads: &'a ThreadController,
        agents: &'a MultiAgentCoordinator,
        executor: TurnExecutor,
        backend: &'a dyn TurnExecutionBackend,
        binder: &'a dyn ThreadWorktreeBinder,
        updates: Arc<dyn ThreadUpdateSink>,
    ) -> Self {
        Self {
            threads,
            agents,
            executor,
            backend,
            binder,
            updates,
        }
    }

    fn publish(&self, thread_id: &ThreadId, after: u64) -> Result<(), CoreError> {
        for update in self.threads.thread_updates_after(thread_id, after)? {
            self.updates.publish(update);
        }
        Ok(())
    }

    fn dispatch(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        result: Result<(), CoreError>,
    ) -> Result<(), CoreError> {
        if let Err(error) = result {
            let before = self.threads.read_thread(thread_id)?;
            if before.turns.iter().any(|turn| {
                &turn.turn_id == turn_id
                    && !matches!(
                        turn.status,
                        TurnStatus::Completed | TurnStatus::Failed | TurnStatus::Interrupted
                    )
            }) {
                self.threads.fail_turn(
                    thread_id,
                    turn_id,
                    StableTurnError::model_invocation_failed(),
                )?;
                self.publish(thread_id, before.sequence)?;
            }
            return Err(error);
        }
        Ok(())
    }

    fn sessions(&self) -> Result<BTreeSet<SessionId>, CoreError> {
        Ok(self
            .threads
            .list_loaded_threads()?
            .into_iter()
            .map(|thread| thread.session_id)
            .collect())
    }
}

impl AgentRuntime for Runtime<'_> {
    fn submit_turn(
        &self,
        thread_id: &ThreadId,
        request: SubmitTurnRequest,
    ) -> Result<TurnReceipt, CoreError> {
        if let Some(receipt) = self.replay_turn(
            thread_id,
            &request.command_id,
            SubmittedCommand::Turn {
                kind: request.kind,
                input: &request.input,
                tool_mode: request.tool_mode,
            },
        )? {
            return Ok(receipt);
        }
        let before = self.threads.read_thread(thread_id)?.sequence;
        let command_id = request.command_id.clone();
        let input = request.input.clone();
        let tool_mode = request.tool_mode;
        let kind = request.kind;
        let start = self.threads.start_turn(
            thread_id,
            crate::StartTurnRequest {
                command_id: request.command_id,
                expected_sequence: request.expected_sequence,
                model: request.model,
                advisor: request.advisor,
                kind: request.kind,
                instructions: request.instructions,
                policy_revision: self.executor.policy_revision(),
                approval_mode: request.approval_mode,
                tool_mode,
                tool_profile: Some(self.executor.tool_profile_snapshot()?),
                activated_skills: request.activated_skills,
                input: request.input,
            },
        )?;
        if start.disposition == crate::StartTurnDisposition::Replayed {
            return self
                .replay_turn(
                    thread_id,
                    &command_id,
                    SubmittedCommand::Turn {
                        kind,
                        input: &input,
                        tool_mode,
                    },
                )?
                .ok_or_else(|| CoreError::Journal("accepted Turn receipt is missing".into()));
        }
        self.publish(thread_id, before)?;
        self.dispatch(
            thread_id,
            &start.turn_id,
            self.backend.start(thread_id, &start.turn_id),
        )?;
        Ok(TurnReceipt {
            turn_id: start.turn_id,
            sequence: start.sequence,
        })
    }

    fn submit_shell(
        &self,
        thread_id: &ThreadId,
        request: SubmitShellRequest,
    ) -> Result<TurnReceipt, CoreError> {
        let before = self.threads.read_thread(thread_id)?;
        let tool_call_id = ToolCallId::new(format!("shell-turn-{}", request.command_id))
            .map_err(|error| CoreError::InvalidInput(error.to_string()))?;
        let call = ToolCall {
            id: tool_call_id.clone(),
            name: ToolName::new("shell-command").expect("static Tool name"),
            arguments: serde_json::json!({"program": request.invocation.program, "arguments": request.invocation.arguments, "working_directory": request.invocation.working_directory}),
        };
        let start = self.threads.start_shell_turn(
            thread_id,
            crate::StartShellTurnRequest {
                command_id: request.command_id,
                expected_sequence: request.expected_sequence,
                policy_revision: self.executor.policy_revision(),
                approval_mode: request.approval_mode,
                tool_call_id,
                binding: self
                    .executor
                    .bind_tool_call(&call, ToolCallCaller::Direct)?,
                invocation: request.invocation,
            },
        )?;
        if start.disposition == crate::StartTurnDisposition::Replayed {
            validate_replayed_turn(&before, &start.turn_id)?;
        } else {
            self.publish(thread_id, before.sequence)?;
            self.dispatch(
                thread_id,
                &start.turn_id,
                self.executor.start_shell(thread_id, &start.turn_id),
            )?;
        }
        Ok(TurnReceipt {
            turn_id: start.turn_id,
            sequence: start.sequence,
        })
    }

    fn compact_thread(
        &self,
        thread_id: &ThreadId,
        request: CompactThreadRequest,
    ) -> Result<TurnReceipt, CoreError> {
        let before = self.threads.read_thread(thread_id)?.sequence;
        let start = self.threads.start_context_compaction(
            thread_id,
            crate::StartContextCompactionRequest {
                command_id: request.command_id,
                expected_sequence: request.expected_sequence,
                model: request.model,
                retention_prompt: request.retention_prompt,
                policy_revision: self.executor.policy_revision(),
            },
        )?;
        if start.disposition == crate::StartTurnDisposition::Created {
            self.publish(thread_id, before)?;
            self.dispatch(
                thread_id,
                &start.turn_id,
                self.backend.start(thread_id, &start.turn_id),
            )?;
        }
        Ok(TurnReceipt {
            turn_id: start.turn_id,
            sequence: start.sequence,
        })
    }

    fn replay_turn(
        &self,
        thread_id: &ThreadId,
        command_id: &CommandId,
        command: SubmittedCommand<'_>,
    ) -> Result<Option<TurnReceipt>, CoreError> {
        let snapshot = self.threads.read_thread(thread_id)?;
        let Some(entry) = snapshot
            .commands
            .iter()
            .find(|entry| &entry.receipt.command_id == command_id)
        else {
            return Ok(None);
        };
        let matches = match (&entry.receipt.command, command) {
            (
                ThreadCommand::StartTurn {
                    input,
                    tool_mode,
                    kind,
                    ..
                },
                SubmittedCommand::Turn {
                    kind: wanted_kind,
                    input: wanted,
                    tool_mode: mode,
                },
            ) => input == wanted && *tool_mode == mode && *kind == wanted_kind,
            (ThreadCommand::StartTurn { input, .. }, SubmittedCommand::Input { input: wanted }) => {
                input == wanted
            }
            _ => false,
        };
        if !matches {
            return Err(CoreError::CommandConflict);
        }
        let turn_id = match &entry.result {
            crate::ThreadCommandResult::TurnAccepted { turn_id } => turn_id,
            _ => return Err(CoreError::CommandConflict),
        };
        validate_replayed_turn(&snapshot, turn_id)?;
        Ok(Some(TurnReceipt {
            turn_id: turn_id.clone(),
            sequence: entry.response_sequence,
        }))
    }

    fn accepted_command(
        &self,
        thread_id: &ThreadId,
        command_id: &CommandId,
        command: AcceptedCommand<'_>,
    ) -> Result<Option<TurnId>, CoreError> {
        let snapshot = self.threads.read_thread(thread_id)?;
        let Some(entry) = snapshot
            .commands
            .iter()
            .find(|entry| &entry.receipt.command_id == command_id)
        else {
            return Ok(None);
        };
        let matches = match (&entry.receipt.command, command) {
            (
                ThreadCommand::StartTurn {
                    input,
                    tool_mode,
                    approval_mode,
                    ..
                },
                AcceptedCommand::Turn {
                    input: wanted,
                    tool_mode: mode,
                    approval_mode: approval,
                },
            ) => input == wanted && *tool_mode == mode && *approval_mode == approval,
            (
                ThreadCommand::SteerTurn { input, turn_id },
                AcceptedCommand::Steer {
                    input: wanted,
                    turn_id: target,
                },
            ) => input == wanted && turn_id == target,
            _ => false,
        };
        if !matches {
            return Err(CoreError::CommandConflict);
        }
        match &entry.result {
            crate::ThreadCommandResult::TurnAccepted { turn_id }
            | crate::ThreadCommandResult::TurnSteered { turn_id } => Ok(Some(turn_id.clone())),
            _ => Err(CoreError::CommandConflict),
        }
    }

    fn accepted_turn(
        &self,
        thread_id: &ThreadId,
        command_id: &CommandId,
    ) -> Result<Option<TurnId>, CoreError> {
        Ok(self
            .threads
            .read_thread(thread_id)?
            .commands
            .iter()
            .find(|entry| &entry.receipt.command_id == command_id)
            .and_then(|entry| match &entry.result {
                crate::ThreadCommandResult::TurnAccepted { turn_id } => Some(turn_id.clone()),
                _ => None,
            }))
    }

    fn steer_turn(
        &self,
        thread_id: &ThreadId,
        request: SteerTurnRequest,
    ) -> Result<TurnReceipt, CoreError> {
        let before = self.threads.read_thread(thread_id)?.sequence;
        let turn_id = request.turn_id.clone();
        let command_id = request.command_id.clone();
        let input = request.input.clone();
        let result = self.threads.steer_turn(thread_id, request)?;
        let sequence = match result.disposition {
            crate::SteerTurnDisposition::Steered => {
                self.publish(thread_id, before)?;
                self.dispatch(
                    thread_id,
                    &turn_id,
                    self.backend.steer(thread_id, &turn_id, &command_id, &input),
                )?;
                let sequence =
                    self.threads
                        .mark_turn_steer_delivered(thread_id, &turn_id, &command_id)?;
                self.publish(thread_id, result.sequence)?;
                sequence
            }
            crate::SteerTurnDisposition::Replayed => self
                .threads
                .read_thread(thread_id)?
                .steer_deliveries
                .get(&command_id)
                .copied()
                .ok_or_else(|| CoreError::Execution("steer delivery was not completed".into()))?,
        };
        Ok(TurnReceipt { turn_id, sequence })
    }

    fn interrupt_turn(
        &self,
        thread_id: &ThreadId,
        request: InterruptTurnRequest,
    ) -> Result<u64, CoreError> {
        let before = self.threads.read_thread(thread_id)?;
        let sequences = self.threads.list_session_threads(&before.session_id)?;
        let interrupted = self.threads.interrupt_turn(thread_id, request)?;
        self.agents.cancel_descendants(thread_id)?;
        for thread in sequences {
            self.publish(&thread.thread_id, thread.sequence)?;
        }
        Ok(interrupted.sequence)
    }

    fn resolve_interaction(
        &self,
        thread_id: &ThreadId,
        request: ResolveTurnInteractionRequest,
    ) -> Result<u64, CoreError> {
        let before = self.threads.read_thread(thread_id)?.sequence;
        let turn_id = request.turn_id.clone();
        let result = self.threads.resolve_turn_interaction(thread_id, request)?;
        self.publish(thread_id, before)?;
        if result.disposition == crate::ResolveTurnInteractionDisposition::Resolved
            && !result.live_execution_woken
        {
            self.dispatch(
                thread_id,
                &turn_id,
                self.backend.resume(thread_id, &turn_id),
            )?;
        }
        Ok(result.sequence)
    }

    fn replay_advisor_configuration(
        &self,
        thread_id: &ThreadId,
        command_id: &CommandId,
        selection: &ash_protocol::AdvisorSelection,
    ) -> Result<Option<u64>, CoreError> {
        let snapshot = self.threads.read_thread(thread_id)?;
        let Some(entry) = snapshot
            .commands
            .iter()
            .find(|entry| &entry.receipt.command_id == command_id)
        else {
            return Ok(None);
        };
        if entry.receipt.command
            != (ThreadCommand::ConfigureAdvisor {
                selection: selection.clone(),
            })
        {
            return Err(CoreError::CommandConflict);
        }
        Ok(Some(entry.response_sequence))
    }

    fn configure_advisor(
        &self,
        thread_id: &ThreadId,
        command_id: CommandId,
        expected_sequence: SequenceExpectation,
        selection: ash_protocol::AdvisorSelection,
    ) -> Result<u64, CoreError> {
        let before = self.threads.read_thread(thread_id)?.sequence;
        let sequence =
            self.threads
                .configure_advisor(thread_id, command_id, expected_sequence, selection)?;
        self.publish(thread_id, before)?;
        Ok(sequence)
    }

    fn set_goal(
        &self,
        thread_id: &ThreadId,
        request: SetGoalRequest,
    ) -> Result<SetGoalResult, CoreError> {
        let result = self.threads.set_goal(thread_id, request)?;
        if result.changed && result.goal.status == ThreadGoalStatus::Active {
            self.executor.resume_extension_continuation(thread_id)?;
        }
        Ok(result)
    }
    fn clear_goal(&self, thread_id: &ThreadId) -> Result<bool, CoreError> {
        self.threads.clear_goal(thread_id)
    }
    fn archive_session(
        &self,
        session_id: &SessionId,
        command_id: &CommandId,
        reason: ThreadArchiveReason,
    ) -> Result<(), CoreError> {
        let before = self.threads.list_session_threads(session_id)?;
        self.threads
            .archive_session_threads(session_id, command_id, reason)?;
        if reason == ThreadArchiveReason::Stopped {
            for thread in &before {
                self.agents.cancel_descendants(&thread.thread_id)?;
            }
        }
        for thread in before {
            self.publish(&thread.thread_id, thread.sequence)?;
        }
        Ok(())
    }
    fn delete_session_threads(&self, session_id: &SessionId) -> Result<(), CoreError> {
        self.threads.delete_session_threads(session_id).map(|_| ())
    }
    fn has_active_turns(&self) -> Result<bool, CoreError> {
        Ok(self.threads.list_loaded_threads()?.iter().any(|thread| {
            thread.turns.iter().any(|turn| {
                !matches!(
                    turn.status,
                    TurnStatus::Completed | TurnStatus::Failed | TurnStatus::Interrupted
                )
            })
        }))
    }
    fn tool_profile(&self) -> Result<ToolProfileSnapshot, CoreError> {
        self.executor.tool_profile_snapshot()
    }
    fn cancel_interaction(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        request_id: &RequestId,
        reason: InteractionCancelReason,
    ) -> Result<(), CoreError> {
        let before = self.threads.read_thread(thread_id)?;
        if !before
            .turns
            .iter()
            .find(|turn| &turn.turn_id == turn_id)
            .and_then(|turn| turn.pending_interaction.as_ref())
            .is_some_and(|interaction| &interaction.request_id == request_id)
        {
            return Ok(());
        }
        let cancelled = self.threads.cancel_turn_interaction(
            thread_id,
            crate::CancelTurnInteractionRequest {
                turn_id: turn_id.clone(),
                request_id: request_id.clone(),
                reason,
            },
        )?;
        self.publish(thread_id, before.sequence)?;
        if !cancelled.live_execution_woken {
            self.dispatch(thread_id, turn_id, self.backend.resume(thread_id, turn_id))?;
        }
        Ok(())
    }
    fn recover_agents(&self) -> Result<usize, CoreError> {
        let mut count = 0;
        for session_id in self.sessions()? {
            for spawned in self.agents.recover_session(&session_id)? {
                let child = self.threads.read_thread(&spawned.child_thread_id)?;
                if child.turns.iter().any(|turn| {
                    turn.turn_id == spawned.child_turn_id
                        && turn.status == TurnStatus::Running
                        && !child.has_resumable_tool_continuation(&turn.turn_id)
                }) {
                    self.dispatch(
                        &spawned.child_thread_id,
                        &spawned.child_turn_id,
                        self.backend
                            .start(&spawned.child_thread_id, &spawned.child_turn_id),
                    )?;
                    count += 1;
                }
            }
        }
        Ok(count)
    }
    fn recover_tools(&self) -> Result<usize, CoreError> {
        self.executor
            .resume_recovered_tool_continuations_in_sessions(&self.sessions()?)
    }
    fn recover_extensions(&self) -> Result<usize, CoreError> {
        self.executor
            .resume_recovered_extension_turns_in_sessions(&self.sessions()?)
    }
    fn read_thread(&self, thread_id: &ThreadId) -> Result<ThreadView, CoreError> {
        self.threads.read_thread(thread_id).map(Into::into)
    }
    fn read_started_thread(&self, command_id: &CommandId) -> Result<Option<ThreadView>, CoreError> {
        self.threads
            .read_started_thread(command_id)
            .map(|thread| thread.map(Into::into))
    }
    fn read_session(&self, session_id: &SessionId) -> Result<SessionView, CoreError> {
        let threads = self.threads.list_session_threads(session_id)?;
        let agent_tree = crate::project_agent_tree(&threads);
        Ok(SessionView {
            threads: threads.into_iter().map(Into::into).collect(),
            agent_tree,
        })
    }
    fn list_thread_catalog(&self) -> Result<Vec<ash_thread_store::ThreadCatalogRecord>, CoreError> {
        self.threads.list_thread_catalog()
    }
    fn read_agent(&self, agent_id: &AgentId) -> Result<agent_graph_store::AgentRecord, CoreError> {
        self.threads.read_agent(agent_id)
    }
    fn list_agent_threads(
        &self,
        agent_id: &AgentId,
    ) -> Result<Vec<agent_graph_store::ThreadBinding>, CoreError> {
        self.threads.list_agent_threads(agent_id)
    }
    fn message_checkpoints(
        &self,
        thread_id: &ThreadId,
    ) -> Result<Vec<MessageCheckpoint>, CoreError> {
        self.threads.message_checkpoints(thread_id)
    }
    fn restore_session(&self, session_id: &SessionId) -> Result<ThreadView, CoreError> {
        self.threads.restore_session(session_id).map(Into::into)
    }
    fn thread_updates_after(
        &self,
        thread_id: &ThreadId,
        after_sequence: u64,
    ) -> Result<Vec<ThreadUpdateEnvelope>, CoreError> {
        self.threads.thread_updates_after(thread_id, after_sequence)
    }
    fn start_thread(&self, request: StartThreadRequest) -> Result<ThreadView, CoreError> {
        self.threads
            .start_thread(self.binder, request)
            .map(Into::into)
    }
    fn create_branch(&self, request: CreateBranchRequest) -> Result<ThreadView, CoreError> {
        self.threads
            .create_branch(self.binder, request)
            .map(Into::into)
    }
    fn fork_thread(&self, request: ForkThreadRequest) -> Result<ThreadView, CoreError> {
        self.threads
            .fork_thread(self.binder, request)
            .map(Into::into)
    }
    fn fork_session(&self, request: ForkThreadRequest) -> Result<ThreadView, CoreError> {
        self.threads
            .fork_session(self.binder, request)
            .map(Into::into)
    }
    fn replace_thread(&self, request: ReplaceThreadRequest) -> Result<ThreadView, CoreError> {
        self.threads
            .replace_thread(self.binder, request)
            .map(Into::into)
    }
    fn rewind_thread(&self, request: RewindThreadRequest) -> Result<ThreadView, CoreError> {
        self.threads
            .rewind_thread(self.binder, request)
            .map(Into::into)
    }

    fn restore_message(&self, request: RestoreMessageRequest) -> Result<ThreadView, CoreError> {
        let command = request.command_id.clone();
        let thread_id = request.source_thread_id.clone();
        let restored = self.threads.restore_message(self.binder, request)?;
        let ThreadOrigin::Message {
            parent_sequence, ..
        } = restored.origin
        else {
            return Err(CoreError::Journal("restoration origin is missing".into()));
        };
        let source = self
            .threads
            .read_thread_at_sequence(&thread_id, parent_sequence)?;
        for turn in source.turns.iter().filter(|turn| {
            !matches!(
                turn.status,
                TurnStatus::Completed | TurnStatus::Failed | TurnStatus::Interrupted
            )
        }) {
            let current = self.threads.read_thread(&thread_id)?;
            if current.turns.iter().any(|candidate| {
                candidate.turn_id == turn.turn_id
                    && !matches!(
                        candidate.status,
                        TurnStatus::Completed | TurnStatus::Failed | TurnStatus::Interrupted
                    )
            }) {
                self.interrupt_turn(
                    &thread_id,
                    InterruptTurnRequest {
                        command_id: CommandId::new(format!(
                            "restore-interrupt:{}:{}",
                            command, turn.turn_id
                        ))
                        .map_err(|error| CoreError::InvalidInput(error.to_string()))?,
                        expected_sequence: SequenceExpectation::Exact(current.sequence),
                        turn_id: turn.turn_id.clone(),
                    },
                )?;
            }
        }
        Ok(restored.into())
    }
}

fn validate_replayed_turn(snapshot: &ThreadSnapshot, turn_id: &TurnId) -> Result<(), CoreError> {
    let turn = snapshot
        .turns
        .iter()
        .find(|turn| &turn.turn_id == turn_id)
        .ok_or_else(|| CoreError::Journal("accepted Turn is missing".into()))?;
    match turn.status {
        TurnStatus::Failed | TurnStatus::Interrupted => Err(CoreError::Execution(
            "accepted Turn has terminated unsuccessfully".into(),
        )),
        TurnStatus::Cancelling => Err(CoreError::Execution("accepted Turn is cancelling".into())),
        _ => Ok(()),
    }
}

#[cfg(test)]
#[path = "runtime_tests.rs"]
mod tests;

impl InteractionLifecycle for ThreadController {
    fn expire_interaction(
        &self,
        thread_id: &ThreadId,
        turn_id: &TurnId,
        request_id: &RequestId,
        now_unix_ms: u64,
    ) -> Result<Option<Vec<ThreadUpdateEnvelope>>, CoreError> {
        let snapshot = self.read_thread(thread_id)?;
        let expired = snapshot
            .turns
            .iter()
            .find(|turn| &turn.turn_id == turn_id)
            .and_then(|turn| turn.pending_interaction.as_ref())
            .filter(|interaction| &interaction.request_id == request_id)
            .and_then(|interaction| interaction.deadline)
            .is_some_and(|deadline| deadline.expires_at_unix_ms <= now_unix_ms);
        if !expired {
            return Ok(None);
        }
        self.cancel_turn_interaction(
            thread_id,
            crate::CancelTurnInteractionRequest {
                turn_id: turn_id.clone(),
                request_id: request_id.clone(),
                reason: InteractionCancelReason::DeadlineElapsed,
            },
        )?;
        self.fail_turn(
            thread_id,
            turn_id,
            StableTurnError::interaction_deadline_elapsed(),
        )?;
        self.thread_updates_after(thread_id, snapshot.sequence)
            .map(Some)
    }
}

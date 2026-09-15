use super::BatchCommand;
use super::ThreadController;
use crate::CoreError;
use crate::ThreadSnapshot;
use ash_protocol::AgentContextSeed;
use ash_protocol::AgentJoin;
use ash_protocol::AgentJoinId;
use ash_protocol::AgentMessage;
use ash_protocol::DelegationId;
use ash_protocol::DelegationResult;
use ash_protocol::SessionId;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadId;
use ash_protocol::ThreadOrigin;
use std::sync::Arc;
use std::sync::Mutex;
use std::sync::Weak;

/// Creation request for a child Thread whose immutable Agent seed is committed atomically.
pub struct CreateAgentThreadRequest {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub title: String,
    pub context_seed: AgentContextSeed,
}

impl ThreadController {
    pub(crate) fn agent_spawn_gate(
        &self,
        session_id: &SessionId,
    ) -> Result<Arc<Mutex<()>>, CoreError> {
        let mut gates = self
            .agent_spawn_gates
            .lock()
            .map_err(|_| CoreError::Journal("Agent spawn gates poisoned".into()))?;
        gates.retain(|_, gate| gate.strong_count() > 0);
        if let Some(gate) = gates.get(session_id).and_then(Weak::upgrade) {
            return Ok(gate);
        }
        let gate = Arc::new(Mutex::new(()));
        gates.insert(session_id.clone(), Arc::downgrade(&gate));
        Ok(gate)
    }

    /// Creates an Agent child Thread and commits its context seed before the Thread is visible.
    ///
    /// Repeating the exact request is idempotent. An existing ordinary Thread or a child with a
    /// different seed is rejected so recovery cannot silently change delegated context.
    pub fn create_agent_thread(
        &self,
        binder: &dyn crate::ThreadWorktreeBinder,
        request: CreateAgentThreadRequest,
    ) -> Result<ThreadSnapshot, CoreError> {
        request
            .context_seed
            .agent
            .validate()
            .map_err(|error| CoreError::InvalidInput(error.into()))?;
        crate::multi_agent::validate_context_seed_digest(&request.context_seed)?;
        binder.provision(&crate::ThreadWorktreeBindingRequest {
            session_id: request.session_id.clone(),
            thread_id: request.thread_id.clone(),
            origin: ThreadOrigin::AgentSpawn {
                parent_thread_id: request.context_seed.parent_thread_id.clone(),
                parent_sequence: request.context_seed.parent_sequence,
                delegation_id: request.context_seed.delegation_id.clone(),
            },
        })?;
        let slot = self.loaded_threads.slot(&request.thread_id)?;
        let _permit = slot.enter_mutation()?;
        let _lease = self.acquire_writer_lease(&request.thread_id)?;
        let mut loaded = slot
            .loaded
            .lock()
            .map_err(|_| CoreError::Journal("loaded Thread state lock poisoned".into()))?;
        if let Some(existing) = loaded.as_ref() {
            return matching_agent_thread(&existing.snapshot, &request);
        }
        let durable = self.store.load(&request.thread_id)?;
        if !durable.is_empty() {
            let existing = self.load_snapshot(&request.thread_id)?;
            let existing = matching_agent_thread(&existing, &request)?;
            *loaded = Some(self.loaded_threads.install(existing.clone()));
            return Ok(existing);
        }

        let thread_id = request.thread_id;
        let mut prefixes = Vec::new();
        let mut prefix_event = None;
        if matches!(
            request.context_seed.inheritance,
            ash_protocol::AgentContextMode::ForkedPrefix {
                selection: ash_protocol::ForkedAgentContext::Full
            }
        ) && request.context_seed.materialized_context.is_empty()
        {
            let prefix = ash_history::HistoryPrefix {
                events: self
                    .store
                    .load(&request.context_seed.parent_thread_id)?
                    .into_iter()
                    .take_while(|event| event.sequence <= request.context_seed.parent_sequence)
                    .collect(),
            };
            prefix_event = Some(ThreadEvent::HistoryPrefixBound {
                thread_id: thread_id.clone(),
                prefix: prefix.reference().map_err(CoreError::Journal)?,
            });
            prefixes.push(prefix);
        }
        let mut events = vec![
            ThreadEvent::ThreadCreated {
                agent_id: Some(
                    ash_protocol::AgentId::new(format!("agent:{thread_id}"))
                        .map_err(|error| CoreError::InvalidInput(error.to_string()))?,
                ),
                origin: ThreadOrigin::AgentSpawn {
                    parent_thread_id: request.context_seed.parent_thread_id.clone(),
                    parent_sequence: request.context_seed.parent_sequence,
                    delegation_id: request.context_seed.delegation_id.clone(),
                },
                agent: None,
                session_id: request.session_id,
                thread_id: thread_id.clone(),
                title: request.title,
            },
            ThreadEvent::AgentContextSeedCommitted {
                thread_id: thread_id.clone(),
                seed: Box::new(request.context_seed),
            },
        ];
        events.extend(prefix_event);
        let (snapshot, batch) = self.project_batch_with_history(
            None,
            &thread_id,
            events,
            BatchCommand::None,
            prefixes,
        )?;
        self.commit_batch(&batch)?;
        *loaded = Some(self.loaded_threads.install(snapshot.clone()));
        Ok(snapshot)
    }

    /// Commits the immutable parent-side delegation request before child creation begins.
    pub fn record_delegation_requested(
        &self,
        parent_thread_id: &ThreadId,
        seed: AgentContextSeed,
    ) -> Result<u64, CoreError> {
        self.mutate_thread(parent_thread_id, |snapshot| {
            if let Some(existing) = snapshot.delegations.get(&seed.delegation_id) {
                return if existing.seed == seed {
                    Ok(snapshot.sequence)
                } else {
                    Err(CoreError::CommandConflict)
                };
            }
            self.record_batch(
                snapshot,
                vec![ThreadEvent::DelegationRequested {
                    thread_id: parent_thread_id.clone(),
                    seed: Box::new(seed),
                }],
            )?;
            Ok(snapshot.sequence)
        })
    }

    /// Commits the exact child Thread selected for a previously requested delegation.
    pub fn record_delegation_started(
        &self,
        parent_thread_id: &ThreadId,
        delegation_id: DelegationId,
        child_thread_id: ThreadId,
    ) -> Result<u64, CoreError> {
        self.mutate_thread(parent_thread_id, |snapshot| {
            let existing = snapshot
                .delegations
                .get(&delegation_id)
                .ok_or_else(|| CoreError::NotFound(delegation_id.to_string()))?;
            if let Some(existing_child) = &existing.child_thread_id {
                return if existing_child == &child_thread_id {
                    Ok(snapshot.sequence)
                } else {
                    Err(CoreError::CommandConflict)
                };
            }
            self.record_batch(
                snapshot,
                vec![ThreadEvent::DelegationStarted {
                    thread_id: parent_thread_id.clone(),
                    delegation_id,
                    child_thread_id,
                }],
            )?;
            Ok(snapshot.sequence)
        })
    }

    /// Records a parent-side cancellation request once before the signal crosses Threads.
    pub fn record_delegation_cancellation_requested(
        &self,
        parent_thread_id: &ThreadId,
        delegation_id: DelegationId,
    ) -> Result<u64, CoreError> {
        self.mutate_thread(parent_thread_id, |snapshot| {
            let delegation = snapshot
                .delegations
                .get(&delegation_id)
                .ok_or_else(|| CoreError::NotFound(delegation_id.to_string()))?;
            if delegation.cancellation_requested {
                return Ok(snapshot.sequence);
            }
            self.record_batch(
                snapshot,
                vec![ThreadEvent::DelegationCancellationRequested {
                    thread_id: parent_thread_id.clone(),
                    delegation_id,
                }],
            )?;
            Ok(snapshot.sequence)
        })
    }

    /// Records delivery of one parent cancellation to its exact child seed.
    pub fn record_agent_cancellation_received(
        &self,
        child_thread_id: &ThreadId,
        delegation_id: DelegationId,
        parent_thread_id: ThreadId,
    ) -> Result<u64, CoreError> {
        self.mutate_thread(child_thread_id, |snapshot| {
            if snapshot
                .agent_cancellations_received
                .contains(&delegation_id)
            {
                return Ok(snapshot.sequence);
            }
            self.record_batch(
                snapshot,
                vec![ThreadEvent::AgentCancellationReceived {
                    thread_id: child_thread_id.clone(),
                    delegation_id,
                    parent_thread_id,
                }],
            )?;
            Ok(snapshot.sequence)
        })
    }

    /// Commits a bounded terminal result to its child Thread before delivery is attempted.
    pub fn record_delegation_result_produced(
        &self,
        child_thread_id: &ThreadId,
        result: DelegationResult,
    ) -> Result<u64, CoreError> {
        self.mutate_thread(child_thread_id, |snapshot| {
            if let Some(existing) = snapshot
                .produced_delegation_results
                .get(&result.delegation_id)
            {
                return if existing == &result {
                    Ok(snapshot.sequence)
                } else {
                    Err(CoreError::CommandConflict)
                };
            }
            self.record_batch(
                snapshot,
                vec![ThreadEvent::DelegationResultProduced {
                    thread_id: child_thread_id.clone(),
                    result: Box::new(result),
                }],
            )?;
            Ok(snapshot.sequence)
        })
    }

    /// Applies one child result exactly once to the parent Thread projection.
    pub fn record_delegation_result_received(
        &self,
        parent_thread_id: &ThreadId,
        result: DelegationResult,
    ) -> Result<u64, CoreError> {
        self.mutate_thread(parent_thread_id, |snapshot| {
            if let Some(existing) = snapshot
                .received_delegation_results
                .get(&result.delegation_id)
            {
                return if existing == &result {
                    Ok(snapshot.sequence)
                } else {
                    Err(CoreError::CommandConflict)
                };
            }
            self.record_batch(
                snapshot,
                vec![ThreadEvent::DelegationResultReceived {
                    thread_id: parent_thread_id.clone(),
                    result: Box::new(result),
                }],
            )?;
            Ok(snapshot.sequence)
        })
    }

    /// Commits one sender-side outbox message exactly once.
    pub fn record_agent_message_sent(
        &self,
        sender_thread_id: &ThreadId,
        message: AgentMessage,
    ) -> Result<u64, CoreError> {
        self.mutate_thread(sender_thread_id, |snapshot| {
            if let Some(existing) = snapshot.sent_agent_messages.get(&message.message_id) {
                return if existing == &message {
                    Ok(snapshot.sequence)
                } else {
                    Err(CoreError::CommandConflict)
                };
            }
            self.record_batch(
                snapshot,
                vec![ThreadEvent::AgentMessageSent {
                    thread_id: sender_thread_id.clone(),
                    message: Box::new(message),
                }],
            )?;
            Ok(snapshot.sequence)
        })
    }

    /// Applies one sender outbox message exactly once to a receiver Thread inbox.
    pub fn record_agent_message_received(
        &self,
        receiver_thread_id: &ThreadId,
        message: AgentMessage,
    ) -> Result<u64, CoreError> {
        self.mutate_thread(receiver_thread_id, |snapshot| {
            if let Some(existing) = snapshot.received_agent_messages.get(&message.message_id) {
                return if existing == &message {
                    Ok(snapshot.sequence)
                } else {
                    Err(CoreError::CommandConflict)
                };
            }
            self.record_batch(
                snapshot,
                vec![ThreadEvent::AgentMessageReceived {
                    thread_id: receiver_thread_id.clone(),
                    message: Box::new(message),
                }],
            )?;
            Ok(snapshot.sequence)
        })
    }

    /// Creates one frozen durable join on a parent Thread.
    pub fn record_agent_join_requested(
        &self,
        parent_thread_id: &ThreadId,
        join: AgentJoin,
    ) -> Result<u64, CoreError> {
        self.mutate_thread(parent_thread_id, |snapshot| {
            if let Some(existing) = snapshot.agent_joins.get(&join.join_id) {
                return if existing == &join {
                    Ok(snapshot.sequence)
                } else {
                    Err(CoreError::CommandConflict)
                };
            }
            self.record_batch(
                snapshot,
                vec![ThreadEvent::AgentJoinRequested {
                    thread_id: parent_thread_id.clone(),
                    join: Box::new(join),
                }],
            )?;
            Ok(snapshot.sequence)
        })
    }

    /// Marks a waiting join satisfied from its exact durable result identities.
    pub fn record_agent_join_satisfied(
        &self,
        parent_thread_id: &ThreadId,
        join_id: AgentJoinId,
        satisfied_by: Vec<DelegationId>,
    ) -> Result<u64, CoreError> {
        self.mutate_thread(parent_thread_id, |snapshot| {
            let join = snapshot
                .agent_joins
                .get(&join_id)
                .ok_or_else(|| CoreError::NotFound(join_id.to_string()))?;
            if join.status == ash_protocol::AgentJoinStatus::Satisfied {
                return if join.satisfied_by == satisfied_by {
                    Ok(snapshot.sequence)
                } else {
                    Err(CoreError::CommandConflict)
                };
            }
            self.record_batch(
                snapshot,
                vec![ThreadEvent::AgentJoinSatisfied {
                    thread_id: parent_thread_id.clone(),
                    join_id,
                    satisfied_by,
                }],
            )?;
            Ok(snapshot.sequence)
        })
    }
}

fn matching_agent_thread(
    snapshot: &ThreadSnapshot,
    request: &CreateAgentThreadRequest,
) -> Result<ThreadSnapshot, CoreError> {
    if snapshot.session_id == request.session_id
        && snapshot.thread_id == request.thread_id
        && snapshot.title == request.title
        && snapshot.agent_context_seed.as_ref() == Some(&request.context_seed)
    {
        Ok(snapshot.clone())
    } else {
        Err(CoreError::CommandConflict)
    }
}

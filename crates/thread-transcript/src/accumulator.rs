use crate::ThreadTranscriptChange;
use crate::ThreadTranscriptEntry;
use crate::ThreadTranscriptUpdateEnvelope;
use crate::model::item_entry_id;
use crate::model::tool_output_entry_id;
use crate::model::turn_error_entry_id;
use crate::model::turn_plan_entry_id;
use ash_protocol::ItemDelta;
use ash_protocol::ItemId;
use ash_protocol::SessionId;
use ash_protocol::StreamInstanceId;
use ash_protocol::Thread;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::ThreadUpdate;
use ash_protocol::ThreadUpdateEnvelope;
use ash_protocol::ToolCallId;
use ash_protocol::ToolOutputStream;
use ash_protocol::TurnId;
use ash_protocol::TurnStatus;
use ash_utils_string::take_bytes_at_char_boundary;
use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::collections::VecDeque;
use std::collections::btree_map::Entry;

const MAX_TRANSIENT_ENTRIES: usize = 1_024;
const MAX_TRANSIENT_TEXT_BYTES: usize = 256 * 1024;
const MAX_COMMITTED_ITEM_IDS: usize = 4_096;
const MAX_TERMINAL_TURN_IDS: usize = 4_096;
const TRUNCATION_MARKER: &str = "\n… transient output truncated …";

/// Result of feeding one internal Thread update into a transcript accumulator.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TranscriptApplyResult {
    Applied(ThreadTranscriptUpdateEnvelope),
    Ignored,
}

/// Collects internal Thread deltas and emits complete transcript entry mutations.
///
/// App Server owns one accumulator per active Thread. Consumers never receive token fragments:
/// every `Upsert` contains the complete text accumulated so far for that entry.
#[derive(Clone, Debug)]
pub struct TranscriptAccumulator {
    session_id: SessionId,
    thread_id: ThreadId,
    durable_sequence: u64,
    revision: u64,
    stream_instance_id: Option<StreamInstanceId>,
    stream_sequence: u64,
    stream_valid: bool,
    transient_entries: BTreeMap<String, ThreadTranscriptEntry>,
    transient_order: VecDeque<String>,
    committed_item_ids: BTreeSet<ItemId>,
    committed_item_order: VecDeque<ItemId>,
    terminal_turn_ids: BTreeSet<TurnId>,
    terminal_turn_order: VecDeque<TurnId>,
}

impl TranscriptAccumulator {
    pub fn new(session_id: SessionId, thread_id: ThreadId) -> Self {
        Self {
            session_id,
            thread_id,
            durable_sequence: 0,
            revision: 0,
            stream_instance_id: None,
            stream_sequence: 0,
            stream_valid: false,
            transient_entries: BTreeMap::new(),
            transient_order: VecDeque::new(),
            committed_item_ids: BTreeSet::new(),
            committed_item_order: VecDeque::new(),
            terminal_turn_ids: BTreeSet::new(),
            terminal_turn_order: VecDeque::new(),
        }
    }

    pub fn apply(&mut self, update: &ThreadUpdateEnvelope) -> TranscriptApplyResult {
        if update.session_id != self.session_id || update.thread_id != self.thread_id {
            return TranscriptApplyResult::Ignored;
        }

        let mut changes = Vec::new();
        match &update.update {
            ThreadUpdate::Committed { .. } => {
                if update.durable_sequence <= self.durable_sequence {
                    return TranscriptApplyResult::Ignored;
                }
                self.durable_sequence = update.durable_sequence;
            }
            ThreadUpdate::ItemStarted { turn_id, .. }
            | ThreadUpdate::ItemDelta { turn_id, .. }
            | ThreadUpdate::ToolOutputDelta { turn_id, .. } => {
                // Retired streams cannot replace the current stream cursor or clear
                // another Turn's live text, even when their first event arrives late.
                if self.terminal_turn_ids.contains(turn_id) {
                    return TranscriptApplyResult::Ignored;
                }
                if !self.accept_stream_cursor(update, &mut changes) {
                    return self.finish(update, changes);
                }
            }
        }

        match &update.update {
            ThreadUpdate::Committed { event } => self.apply_committed(event, &mut changes),
            ThreadUpdate::ItemStarted { item, .. } => self.upsert_started(item, &mut changes),
            ThreadUpdate::ItemDelta {
                turn_id,
                item_id,
                delta,
            } => self.append_item_delta(turn_id, item_id, delta, &mut changes),
            ThreadUpdate::ToolOutputDelta {
                turn_id,
                tool_call_id,
                stream,
                text,
            } => self.append_tool_output(turn_id, tool_call_id, *stream, text, &mut changes),
        }
        self.finish(update, changes)
    }

    /// Builds a client snapshot from the supplied history window and its live transient entries.
    ///
    /// Returns `None` when the supplied Thread belongs to another accumulator scope.
    pub fn snapshot(&self, thread: &Thread) -> Option<crate::ThreadTranscriptSnapshot> {
        if thread.session_id != self.session_id || thread.thread_id != self.thread_id {
            return None;
        }
        let mut snapshot = crate::ThreadTranscriptSnapshot::from_thread(thread);
        snapshot.revision = self.revision;
        let live_turns = thread
            .turns
            .iter()
            .filter(|turn| match turn.status {
                TurnStatus::Created
                | TurnStatus::Running
                | TurnStatus::WaitingForApproval
                | TurnStatus::WaitingForUserInput
                | TurnStatus::WaitingForCapability
                | TurnStatus::Cancelling => true,
                TurnStatus::Completed | TurnStatus::Failed | TurnStatus::Interrupted => false,
            })
            .map(|turn| &turn.turn_id)
            .collect::<BTreeSet<_>>();
        let committed_item_ids = thread
            .turns
            .iter()
            .flat_map(|turn| &turn.items)
            .map(ThreadItem::item_id)
            .collect::<BTreeSet<_>>();
        let completed_tools = thread
            .turns
            .iter()
            .flat_map(|turn| {
                turn.items.iter().filter_map(|item| {
                    if let ThreadItem::ToolResult { tool_call_id, .. } = item {
                        Some((&turn.turn_id, tool_call_id))
                    } else {
                        None
                    }
                })
            })
            .collect::<BTreeSet<_>>();
        // Reads can observe durable completion before its notification reaches this cache.
        // The supplied history window and terminal state remain authoritative for visibility.
        snapshot.entries.extend(
            self.transient_order
                .iter()
                .filter_map(|entry_id| self.transient_entries.get(entry_id))
                .filter(|entry| {
                    entry
                        .turn_id()
                        .is_some_and(|turn| live_turns.contains(turn))
                })
                .filter(|entry| match entry {
                    ThreadTranscriptEntry::Item { item, .. } => {
                        !committed_item_ids.contains(item.item_id())
                    }
                    ThreadTranscriptEntry::ToolOutput {
                        turn_id,
                        tool_call_id,
                        ..
                    } => !completed_tools.contains(&(turn_id, tool_call_id)),
                    ThreadTranscriptEntry::VoiceTranscript { .. }
                    | ThreadTranscriptEntry::HookRun { .. }
                    | ThreadTranscriptEntry::TurnPlan { .. }
                    | ThreadTranscriptEntry::TurnError { .. } => true,
                })
                .cloned(),
        );
        Some(snapshot)
    }

    pub fn clear_transient(&mut self) -> Vec<String> {
        let entry_ids = self.transient_order.drain(..).collect::<Vec<_>>();
        self.transient_entries.clear();
        entry_ids
    }

    fn accept_stream_cursor(
        &mut self,
        update: &ThreadUpdateEnvelope,
        changes: &mut Vec<ThreadTranscriptChange>,
    ) -> bool {
        let Some(cursor) = &update.stream_cursor else {
            return false;
        };
        if self.stream_instance_id.as_ref() != Some(&cursor.stream_instance_id) {
            self.stream_instance_id = Some(cursor.stream_instance_id.clone());
            self.stream_sequence = cursor.sequence;
            self.stream_valid = cursor.sequence == 1;
            if !self.transient_entries.is_empty() {
                self.clear_transient();
                changes.push(ThreadTranscriptChange::ClearTransient);
            }
            return self.stream_valid;
        }
        if cursor.sequence <= self.stream_sequence {
            return false;
        }
        let continuous = cursor.sequence == self.stream_sequence.saturating_add(1);
        self.stream_sequence = cursor.sequence;
        if !continuous {
            self.stream_valid = false;
            self.clear_transient();
            changes.push(ThreadTranscriptChange::ClearTransient);
            return false;
        }
        self.stream_valid
    }

    fn apply_committed(&mut self, event: &ThreadEvent, changes: &mut Vec<ThreadTranscriptChange>) {
        match event {
            ThreadEvent::HookRunUpdated { run, .. } => {
                if let Some(turn_id) = &run.turn_id {
                    changes.push(ThreadTranscriptChange::Upsert {
                        entry: ThreadTranscriptEntry::HookRun {
                            entry_id: format!("hook:{}", run.run_id),
                            turn_id: turn_id.clone(),
                            run: run.clone(),
                        },
                    });
                }
            }
            ThreadEvent::ItemCompleted { item, .. } => {
                let entry_id = item_entry_id(item.item_id().as_str());
                self.remove_transient_entry(&entry_id);
                self.remember_committed_item(item.item_id().clone());
                if matches!(item, ThreadItem::Reasoning { text, .. } if text.is_empty()) {
                    changes.push(ThreadTranscriptChange::Remove {
                        entry_ids: vec![entry_id],
                    });
                    return;
                }
                if let ThreadItem::ToolResult { tool_call_id, .. } = item {
                    let removed = self.remove_tool_output(tool_call_id);
                    if !removed.is_empty() {
                        changes.push(ThreadTranscriptChange::Remove { entry_ids: removed });
                    }
                }
                changes.push(ThreadTranscriptChange::Upsert {
                    entry: ThreadTranscriptEntry::Item {
                        entry_id,
                        turn_id: item.turn_id().clone(),
                        item: item.clone(),
                        transient: false,
                    },
                });
            }
            ThreadEvent::PlanUpdated { turn_id, plan, .. } => {
                changes.push(ThreadTranscriptChange::Upsert {
                    entry: ThreadTranscriptEntry::TurnPlan {
                        entry_id: turn_plan_entry_id(turn_id.as_str()),
                        turn_id: turn_id.clone(),
                        plan: plan.clone(),
                    },
                });
            }
            ThreadEvent::TurnFailed { turn_id, error, .. }
            | ThreadEvent::TurnInterrupted {
                turn_id,
                error: Some(error),
                ..
            } => {
                let removed = self.retire_turn(turn_id);
                if !removed.is_empty() {
                    changes.push(ThreadTranscriptChange::Remove { entry_ids: removed });
                }
                changes.push(ThreadTranscriptChange::Upsert {
                    entry: ThreadTranscriptEntry::TurnError {
                        entry_id: turn_error_entry_id(turn_id.as_str()),
                        turn_id: turn_id.clone(),
                        error: error.clone(),
                    },
                });
            }
            ThreadEvent::TurnCompleted { turn_id, .. }
            | ThreadEvent::TurnInterrupted {
                turn_id,
                error: None,
                ..
            } => {
                let removed = self.retire_turn(turn_id);
                if !removed.is_empty() {
                    changes.push(ThreadTranscriptChange::Remove { entry_ids: removed });
                }
            }
            ThreadEvent::VoiceTranscriptRecorded { transcript, .. } => {
                changes.push(ThreadTranscriptChange::Upsert {
                    entry: ThreadTranscriptEntry::VoiceTranscript {
                        entry_id: transcript.item_id.to_string(),
                        transcript: transcript.clone(),
                    },
                });
            }
            ThreadEvent::HistoryPrefixBound { .. }
            | ThreadEvent::ThreadHistoryMoved { .. }
            | ThreadEvent::ThreadCreated { .. }
            | ThreadEvent::ThreadArchived { .. }
            | ThreadEvent::ThreadRestored { .. }
            | ThreadEvent::ThreadTitleChanged { .. }
            | ThreadEvent::GoalCreated { .. }
            | ThreadEvent::GoalUpdated { .. }
            | ThreadEvent::GoalCleared { .. }
            | ThreadEvent::UserGoalChanged { .. }
            | ThreadEvent::AdvisorConfigured { .. }
            | ThreadEvent::ModelProvidersMigrated { .. }
            | ThreadEvent::TurnExecutionBound { .. }
            | ThreadEvent::AgentContextSeedCommitted { .. }
            | ThreadEvent::HistoryImported { .. }
            | ThreadEvent::ForkHistoryImported { .. }
            | ThreadEvent::ForkTurnImported { .. }
            | ThreadEvent::ForkHistoryImportCompleted { .. }
            | ThreadEvent::ContextCheckpointCommitted { .. }
            | ThreadEvent::ContextOverflowRecoveryCommitted { .. }
            | ThreadEvent::TurnAccepted { .. }
            | ThreadEvent::TurnStarted { .. }
            | ThreadEvent::TurnModeChanged { .. }
            | ThreadEvent::TurnPermissionPolicyChanged { .. }
            | ThreadEvent::TurnSteered { .. }
            | ThreadEvent::TurnSteerDelivered { .. }
            | ThreadEvent::TurnExecutionAttempted { .. }
            | ThreadEvent::ModelUsageRecorded { .. }
            | ThreadEvent::ModelInvocationRecorded { .. }
            | ThreadEvent::ModelResponseEvaluated { .. }
            | ThreadEvent::InteractionRequested { .. }
            | ThreadEvent::InteractionResolved { .. }
            | ThreadEvent::ToolExecutionStarted { .. }
            | ThreadEvent::ToolExecutionEscalated { .. }
            | ThreadEvent::InteractionCancelled { .. }
            | ThreadEvent::TurnCancelling { .. }
            | ThreadEvent::DelegationRequested { .. }
            | ThreadEvent::DelegationStarted { .. }
            | ThreadEvent::DelegationCancellationRequested { .. }
            | ThreadEvent::AgentCancellationReceived { .. }
            | ThreadEvent::DelegationResultProduced { .. }
            | ThreadEvent::DelegationResultReceived { .. }
            | ThreadEvent::AgentMessageSent { .. }
            | ThreadEvent::AgentMessageReceived { .. }
            | ThreadEvent::AgentJoinRequested { .. }
            | ThreadEvent::AgentJoinSatisfied { .. } => {}
        }
    }

    fn upsert_started(&mut self, item: &ThreadItem, changes: &mut Vec<ThreadTranscriptChange>) {
        if self.committed_item_ids.contains(item.item_id()) {
            return;
        }
        let entry = ThreadTranscriptEntry::Item {
            entry_id: item_entry_id(item.item_id().as_str()),
            turn_id: item.turn_id().clone(),
            item: item.clone(),
            transient: true,
        };
        self.store_transient(entry.clone(), changes);
        changes.push(ThreadTranscriptChange::Upsert { entry });
    }

    fn append_item_delta(
        &mut self,
        turn_id: &TurnId,
        item_id: &ItemId,
        delta: &ItemDelta,
        changes: &mut Vec<ThreadTranscriptChange>,
    ) {
        if self.committed_item_ids.contains(item_id) {
            return;
        }
        let entry_id = item_entry_id(item_id.as_str());
        let entry = match self.transient_entries.entry(entry_id.clone()) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => {
                self.transient_order.push_back(entry_id.clone());
                entry.insert(ThreadTranscriptEntry::Item {
                    entry_id,
                    turn_id: turn_id.clone(),
                    item: item_from_delta(turn_id, item_id, delta),
                    transient: true,
                })
            }
        };
        let ThreadTranscriptEntry::Item { item, .. } = entry else {
            return;
        };
        if !append_matching_delta(item, delta) {
            return;
        }
        let entry = entry.clone();
        self.trim_transient(changes);
        changes.push(ThreadTranscriptChange::Upsert { entry });
    }

    fn append_tool_output(
        &mut self,
        turn_id: &TurnId,
        tool_call_id: &ToolCallId,
        stream: ToolOutputStream,
        text: &str,
        changes: &mut Vec<ThreadTranscriptChange>,
    ) {
        let entry_id = tool_output_entry_id(turn_id.as_str(), tool_call_id, stream);
        let entry = match self.transient_entries.entry(entry_id.clone()) {
            Entry::Occupied(entry) => entry.into_mut(),
            Entry::Vacant(entry) => {
                self.transient_order.push_back(entry_id.clone());
                entry.insert(ThreadTranscriptEntry::ToolOutput {
                    entry_id,
                    turn_id: turn_id.clone(),
                    tool_call_id: tool_call_id.clone(),
                    stream,
                    text: String::new(),
                })
            }
        };
        let ThreadTranscriptEntry::ToolOutput { text: output, .. } = entry else {
            return;
        };
        append_bounded(output, text);
        let entry = entry.clone();
        self.trim_transient(changes);
        changes.push(ThreadTranscriptChange::Upsert { entry });
    }

    fn store_transient(
        &mut self,
        entry: ThreadTranscriptEntry,
        changes: &mut Vec<ThreadTranscriptChange>,
    ) {
        let entry_id = entry.entry_id().to_owned();
        if !self.transient_entries.contains_key(&entry_id) {
            self.transient_order.push_back(entry_id.clone());
        }
        self.transient_entries.insert(entry_id, entry);
        self.trim_transient(changes);
    }

    fn trim_transient(&mut self, changes: &mut Vec<ThreadTranscriptChange>) {
        while self.transient_entries.len() > MAX_TRANSIENT_ENTRIES {
            let Some(expired) = self.transient_order.pop_front() else {
                break;
            };
            if self.transient_entries.remove(&expired).is_some() {
                changes.push(ThreadTranscriptChange::Remove {
                    entry_ids: vec![expired],
                });
            }
        }
    }

    fn remove_transient_entry(&mut self, entry_id: &str) {
        self.transient_entries.remove(entry_id);
        self.transient_order
            .retain(|candidate| candidate != entry_id);
    }

    fn remove_tool_output(&mut self, tool_call_id: &ToolCallId) -> Vec<String> {
        let removed = self
            .transient_entries
            .iter()
            .filter_map(|(entry_id, entry)| match entry {
                ThreadTranscriptEntry::ToolOutput {
                    tool_call_id: candidate,
                    ..
                } if candidate == tool_call_id => Some(entry_id.clone()),
                ThreadTranscriptEntry::Item { .. }
                | ThreadTranscriptEntry::TurnPlan { .. }
                | ThreadTranscriptEntry::TurnError { .. }
                | ThreadTranscriptEntry::ToolOutput { .. } => None,
                ThreadTranscriptEntry::VoiceTranscript { .. }
                | ThreadTranscriptEntry::HookRun { .. } => None,
            })
            .collect::<Vec<_>>();
        for entry_id in &removed {
            self.remove_transient_entry(entry_id);
        }
        removed
    }

    fn retire_turn(&mut self, turn_id: &TurnId) -> Vec<String> {
        // Keep bounded tombstones alongside the existing committed-item cache so
        // delayed producers cannot resurrect transient content after termination.
        if self.terminal_turn_ids.insert(turn_id.clone()) {
            self.terminal_turn_order.push_back(turn_id.clone());
        }
        while self.terminal_turn_ids.len() > MAX_TERMINAL_TURN_IDS {
            let Some(expired) = self.terminal_turn_order.pop_front() else {
                break;
            };
            self.terminal_turn_ids.remove(&expired);
        }
        let removed = self
            .transient_entries
            .iter()
            .filter(|(_, entry)| entry.turn_id() == Some(turn_id))
            .map(|(entry_id, _)| entry_id.clone())
            .collect::<Vec<_>>();
        for entry_id in &removed {
            self.remove_transient_entry(entry_id);
        }
        removed
    }

    fn remember_committed_item(&mut self, item_id: ItemId) {
        if self.committed_item_ids.insert(item_id.clone()) {
            self.committed_item_order.push_back(item_id);
        }
        while self.committed_item_ids.len() > MAX_COMMITTED_ITEM_IDS {
            let Some(expired) = self.committed_item_order.pop_front() else {
                break;
            };
            self.committed_item_ids.remove(&expired);
        }
    }

    fn finish(
        &mut self,
        update: &ThreadUpdateEnvelope,
        changes: Vec<ThreadTranscriptChange>,
    ) -> TranscriptApplyResult {
        if changes.is_empty() {
            return TranscriptApplyResult::Ignored;
        }
        self.revision = self
            .revision
            .checked_add(1)
            .expect("transcript revision should not exhaust u64");
        TranscriptApplyResult::Applied(ThreadTranscriptUpdateEnvelope {
            session_id: update.session_id.clone(),
            thread_id: update.thread_id.clone(),
            durable_sequence: update.durable_sequence,
            revision: self.revision,
            stream_cursor: update.stream_cursor.clone(),
            changes,
        })
    }
}

fn item_from_delta(turn_id: &TurnId, item_id: &ItemId, delta: &ItemDelta) -> ThreadItem {
    match delta {
        ItemDelta::AgentMessage { .. } | ItemDelta::AgentMessagePhase { .. } => {
            ThreadItem::AgentMessage {
                phase: None,
                item_id: item_id.clone(),
                turn_id: turn_id.clone(),
                text: String::new(),
            }
        }
        ItemDelta::Reasoning { .. } => ThreadItem::Reasoning {
            state: Vec::new(),
            item_id: item_id.clone(),
            turn_id: turn_id.clone(),
            text: String::new(),
        },
        ItemDelta::Plan { .. } => ThreadItem::Plan {
            item_id: item_id.clone(),
            turn_id: turn_id.clone(),
            text: String::new(),
        },
    }
}

fn append_matching_delta(item: &mut ThreadItem, delta: &ItemDelta) -> bool {
    if let ItemDelta::AgentMessagePhase { phase } = delta {
        if let ThreadItem::AgentMessage { phase: target, .. } = item {
            *target = phase.clone();
            return true;
        }
        return false;
    }
    let (target, addition) = match (item, delta) {
        (ThreadItem::AgentMessage { text, .. }, ItemDelta::AgentMessage { text: addition })
        | (ThreadItem::Reasoning { text, .. }, ItemDelta::Reasoning { text: addition })
        | (ThreadItem::Plan { text, .. }, ItemDelta::Plan { text: addition }) => (text, addition),
        _ => return false,
    };
    append_bounded(target, addition);
    true
}

fn append_bounded(target: &mut String, addition: &str) {
    if target.ends_with(TRUNCATION_MARKER) {
        return;
    }
    let content_limit = MAX_TRANSIENT_TEXT_BYTES - TRUNCATION_MARKER.len();
    if target.len() >= content_limit {
        truncate_to_char_boundary(target, content_limit);
        target.push_str(TRUNCATION_MARKER);
        return;
    }
    let available = content_limit - target.len();
    if addition.len() <= available {
        target.push_str(addition);
        return;
    }
    target.push_str(take_bytes_at_char_boundary(addition, available));
    target.push_str(TRUNCATION_MARKER);
}

fn truncate_to_char_boundary(value: &mut String, maximum: usize) {
    let end = take_bytes_at_char_boundary(value, maximum).len();
    value.truncate(end);
}

use crate::CoreError;
use crate::ThreadController;
use crate::ThreadSnapshot;
use crate::thread_reducer::ThreadCommandResult;
use ash_action_policy::ActionReviewRequest;
use ash_protocol::AgentResponse;
use ash_protocol::ItemId;
use ash_protocol::ReviewContext;
use ash_protocol::ReviewEvidence;
use ash_protocol::ReviewEvidenceKind;
use ash_protocol::ReviewEvidenceTrust;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::UserGoalChange;
use guardian_context::MessageOrigin;
use std::collections::BTreeSet;

pub(super) fn attach_review_context(
    request: ActionReviewRequest,
    threads: &ThreadController,
    snapshot: &ThreadSnapshot,
    pending_item_id: &ItemId,
    host_evidence: Vec<ReviewEvidence>,
) -> Result<ActionReviewRequest, CoreError> {
    let mut history = History {
        threads,
        pending_item_id,
        prefixes: BTreeSet::new(),
        items: BTreeSet::new(),
        answers: BTreeSet::new(),
        current_user_goals: BTreeSet::new(),
        reference_threads: &snapshot.reference_history.threads,
        evidence: Vec::new(),
    };
    history.append(snapshot, HistoryScope::Conversation)?;
    let user_intent = history
        .evidence
        .iter()
        .rev()
        .find(|entry| {
            entry.trust() == ReviewEvidenceTrust::TrustedUser
                && (entry.kind() == ReviewEvidenceKind::UserMessage
                    || (entry.kind() == ReviewEvidenceKind::UserGoal
                        && history.current_user_goals.contains(entry.source())))
        })
        .map(|entry| entry.content().to_owned())
        .unwrap_or_default();
    history.evidence.extend(host_evidence);
    Ok(request.with_context(ReviewContext::new(user_intent, history.evidence)))
}

struct History<'a> {
    threads: &'a ThreadController,
    pending_item_id: &'a ItemId,
    prefixes: BTreeSet<(ash_protocol::ThreadId, u64)>,
    items: BTreeSet<ItemId>,
    answers: BTreeSet<String>,
    current_user_goals: BTreeSet<String>,
    reference_threads: &'a BTreeSet<ThreadId>,
    evidence: Vec<ReviewEvidence>,
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum HistoryScope {
    Conversation,
    Reference,
}

impl HistoryScope {
    fn user_trust(self) -> ReviewEvidenceTrust {
        match self {
            Self::Conversation => ReviewEvidenceTrust::TrustedUser,
            Self::Reference => ReviewEvidenceTrust::UntrustedContent,
        }
    }
}

impl History<'_> {
    fn append(&mut self, snapshot: &ThreadSnapshot, scope: HistoryScope) -> Result<(), CoreError> {
        let reference_threads = self.reference_threads;
        let source_scope = |thread: &ThreadId| {
            if scope == HistoryScope::Reference
                || reference_threads.contains(thread)
                || snapshot.reference_history.threads.contains(thread)
            {
                HistoryScope::Reference
            } else {
                HistoryScope::Conversation
            }
        };
        if !self
            .prefixes
            .insert((snapshot.thread_id.clone(), snapshot.sequence))
        {
            return Ok(());
        }
        // Bound durable history traversal independently of Agent scheduling.
        if self.prefixes.len() > 64 {
            return Err(CoreError::Context(
                "review history exceeds its prefix limit".into(),
            ));
        }
        for prefix in snapshot.history_sources.values() {
            let source = self.threads.read_history_prefix(prefix)?;
            self.append(&source, source_scope(&source.thread_id))?;
        }
        if let Some(seed) = &snapshot.agent_context_seed
            && !self
                .prefixes
                .contains(&(seed.parent_thread_id.clone(), seed.parent_sequence))
        {
            let parent = self
                .threads
                .read_thread_at_sequence(&seed.parent_thread_id, seed.parent_sequence)?;
            self.append(&parent, source_scope(&parent.thread_id))?;
        }
        let mut ordered = Vec::new();
        let delegated_input = snapshot.agent_context_seed.as_ref().and_then(|_| {
            snapshot
                .items
                .iter()
                .find(|item| {
                    matches!(item, ThreadItem::UserMessage { .. })
                        && snapshot
                            .message_checkpoints
                            .get(item.item_id())
                            .is_some_and(|point| point.source_thread_id == snapshot.thread_id)
                })
                .map(ThreadItem::item_id)
        });
        for item in &snapshot.items {
            if !self.items.insert(item.item_id().clone()) || item.item_id() == self.pending_item_id
            {
                continue;
            }
            // Only the initial delegated input is synthesized by the coordinator. Subsequent
            // user messages are client commands; Agent follow-ups use the separate inbox.
            let origin = if scope == HistoryScope::Reference
                || snapshot.reference_history.turns.contains(item.turn_id())
            {
                MessageOrigin::Reference
            } else if delegated_input == Some(item.item_id()) {
                MessageOrigin::Agent
            } else {
                MessageOrigin::User
            };
            for entry in guardian_context::collect(&snapshot.thread_id, origin, [item]) {
                ordered.push((snapshot.item_sequences[item.item_id()], entry));
            }
        }
        for resolved in &snapshot.resolved_interactions {
            if !matches!(
                resolved.response,
                AgentResponse::Approval { .. } | AgentResponse::UserInput { .. }
            ) {
                continue;
            }
            let source = format!(
                "thread/{}/turn/{}/answer/{}",
                snapshot.thread_id, resolved.turn_id, resolved.interaction.request_id
            );
            if !self.answers.insert(source.clone()) {
                continue;
            }
            let command = snapshot.commands.iter().find(|command| {
                matches!(&command.result, ThreadCommandResult::InteractionResolved { request_id, .. }
                    if request_id == &resolved.interaction.request_id)
            }).ok_or_else(|| CoreError::Journal("review answer has no resolution sequence".into()))?;
            let content = serde_json::to_string(&serde_json::json!({
                "request": &resolved.interaction.request,
                "response": &resolved.response,
            }))
            .map_err(|error| CoreError::Context(error.to_string()))?;
            ordered.push((
                command.response_sequence,
                ReviewEvidence::new(
                    ReviewEvidenceKind::UserAnswer,
                    scope.user_trust(),
                    source,
                    content,
                ),
            ));
        }
        for (sequence, change) in &snapshot.user_goal_changes {
            let (goal_id, content) = match change {
                UserGoalChange::Set {
                    goal_id,
                    objective,
                    status,
                } => {
                    let content = match (objective, status) {
                        (Some(objective), Some(status)) => {
                            format!("{objective}\nGoal status: {status:?}")
                        }
                        (Some(objective), None) => objective.clone(),
                        (None, Some(status)) => format!("Goal status: {status:?}"),
                        (None, None) => unreachable!("reducer validates user Goal changes"),
                    };
                    (goal_id, content)
                }
                UserGoalChange::Clear { goal_id } => (goal_id, "Goal cleared".into()),
            };
            let source = format!(
                "thread/{}/goal/{goal_id}/change/{sequence}",
                snapshot.thread_id
            );
            if scope == HistoryScope::Conversation
                && matches!(change, UserGoalChange::Set { .. })
                && snapshot
                    .goal
                    .as_ref()
                    .is_some_and(|goal| goal.goal_id == *goal_id && !goal.status.is_complete())
            {
                self.current_user_goals.insert(source.clone());
            }
            ordered.push((
                *sequence,
                ReviewEvidence::new(
                    ReviewEvidenceKind::UserGoal,
                    scope.user_trust(),
                    source,
                    content,
                ),
            ));
        }
        ordered.sort_by_key(|(sequence, _)| *sequence);
        self.evidence
            .extend(ordered.into_iter().map(|(_, entry)| entry));
        Ok(())
    }
}

#[cfg(test)]
#[path = "review_context_tests.rs"]
mod tests;

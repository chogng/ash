impl From<crate::ThreadSnapshot> for core_api::ThreadView {
    fn from(snapshot: crate::ThreadSnapshot) -> Self {
        let agent = snapshot.agent_configuration().cloned();
        Self {
            agent_id: snapshot.agent_id,
            origin: snapshot.origin,
            session_id: snapshot.session_id,
            thread_id: snapshot.thread_id,
            created_at_unix_ms: snapshot.created_at_unix_ms,
            parent_thread_id: snapshot.parent_thread_id,
            forked_from_id: snapshot.forked_from_id,
            title: snapshot.title,
            status: snapshot.status,
            archived_at_unix_ms: snapshot.archived_at_unix_ms,
            archive_reason: snapshot.archive_reason,
            turn_execution_binding: snapshot.turn_execution_binding,
            sequence: snapshot.sequence,
            usage: snapshot.usage,
            reference_cost: snapshot.reference_cost,
            goal: snapshot.goal,
            advisor: snapshot.advisor,
            items: snapshot.items,
            hook_runs: snapshot.hook_runs,
            agent,
            turns: snapshot
                .turns
                .into_iter()
                .map(|turn| core_api::TurnView {
                    turn_id: turn.turn_id,
                    status: turn.status,
                    status_changed_at_unix_ms: turn.status_changed_at_unix_ms,
                    started_at_unix_ms: turn.started_at_unix_ms,
                    duration_ms: turn.duration_ms,
                    kind: turn.kind,
                    mode: turn.mode,
                    instructions: turn.instructions,
                    model: turn.model,
                    reasoning_effort: turn.reasoning_effort,
                    advisor: turn.advisor,
                    approval_mode: turn.approval_mode,
                    tool_mode: turn.tool_mode,
                    activated_skills: turn.activated_skills,
                    failure: turn.failure,
                    pending_interaction: turn.pending_interaction,
                    tool_profile: turn.tool_profile,
                    plan: turn.plan,
                    usage: turn.usage,
                    context_usage: turn.context_usage,
                })
                .collect(),
        }
    }
}

impl crate::ThreadSnapshot {
    pub(crate) fn public_history_thread(
        &self,
        indices: impl Iterator<Item = usize>,
    ) -> ash_protocol::Thread {
        let selected = indices.map(|index| &self.turns[index]).collect::<Vec<_>>();
        let mut items = selected
            .iter()
            .map(|turn| (&turn.turn_id, Vec::new()))
            .collect::<std::collections::BTreeMap<_, _>>();
        if !items.is_empty() {
            for item in &self.items {
                if let Some(turn_items) = items.get_mut(item.turn_id()) {
                    turn_items.push(item.clone());
                }
            }
        }
        ash_protocol::Thread {
            agent_id: self.agent_id.clone(),
            origin: self.origin.clone(),
            session_id: self.session_id.clone(),
            thread_id: self.thread_id.clone(),
            parent_thread_id: self.parent_thread_id.clone(),
            forked_from_id: self.forked_from_id.clone(),
            title: self.title.clone(),
            status: self.status,
            sequence: self.sequence,
            usage: self.usage.clone(),
            reference_cost: self.reference_cost.clone(),
            goal: self.goal.clone(),
            advisor: self.advisor.clone(),
            hook_runs: self.hook_runs.clone(),
            turns: selected
                .into_iter()
                .map(|turn| ash_protocol::Turn {
                    turn_id: turn.turn_id.clone(),
                    status: turn.status,
                    kind: turn.kind,
                    mode: turn.mode,
                    instructions: turn.instructions.clone(),
                    model: turn.model.clone(),
                    reasoning_effort: turn.reasoning_effort,
                    advisor: turn.advisor.clone(),
                    tool_profile: turn.tool_profile.clone(),
                    tool_mode: turn.tool_mode,
                    approval_mode: turn.approval_mode,
                    usage: turn.usage.clone(),
                    context_usage: turn.context_usage.clone(),
                    items: items.remove(&turn.turn_id).unwrap_or_default(),
                    plan: turn.plan.clone(),
                    pending_interaction: turn
                        .pending_interaction
                        .as_ref()
                        .map(ash_protocol::TurnInteraction::pending_state),
                    error: turn.failure.clone(),
                })
                .collect(),
        }
    }

    pub(crate) fn history_index(
        &self,
        previous: Option<&[crate::TurnSnapshot]>,
        ready: bool,
        completed_items: &std::collections::BTreeSet<ash_protocol::TurnId>,
    ) -> ash_thread_store::ThreadHistoryIndexUpdate {
        use ash_thread_store::ThreadHistoryIndexMode;
        let mode = if ready
            && previous.is_some_and(|previous| {
                previous.len() <= self.turns.len()
                    && previous
                        .iter()
                        .zip(&self.turns)
                        .all(|(old, new)| old.turn_id == new.turn_id)
            }) {
            ThreadHistoryIndexMode::Update
        } else {
            ThreadHistoryIndexMode::Replace
        };
        let ordinals = self
            .turns
            .iter()
            .enumerate()
            .filter_map(|(ordinal, turn)| {
                (mode == ThreadHistoryIndexMode::Replace
                    || completed_items.contains(&turn.turn_id)
                    || previous.and_then(|turns| turns.get(ordinal)) != Some(turn))
                .then_some(ordinal)
            })
            .collect::<Vec<_>>();
        let turns = self
            .public_history_thread(ordinals.iter().copied())
            .turns
            .into_iter()
            .zip(ordinals)
            .map(|(turn, ordinal)| ash_thread_store::ThreadHistoryTurn { turn, ordinal })
            .collect();
        let pending_interactions = self
            .turns
            .iter()
            .filter_map(|turn| {
                turn.pending_interaction.as_ref().map(|interaction| {
                    ash_protocol::AgentRequestEnvelope {
                        session_id: self.session_id.clone(),
                        thread_id: self.thread_id.clone(),
                        turn_id: turn.turn_id.clone(),
                        interaction: interaction.clone(),
                    }
                })
            })
            .collect();
        ash_thread_store::ThreadHistoryIndexUpdate {
            thread: self.public_history_thread(std::iter::empty()),
            turn_count: self.turns.len(),
            pending_interactions,
            turns,
            mode,
        }
    }
}

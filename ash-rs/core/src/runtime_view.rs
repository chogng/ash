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
            items: snapshot.items,
            agent,
            turns: snapshot
                .turns
                .into_iter()
                .map(|turn| core_api::TurnState {
                    turn_id: turn.turn_id,
                    status: turn.status,
                    status_changed_at_unix_ms: turn.status_changed_at_unix_ms,
                    started_at_unix_ms: turn.started_at_unix_ms,
                    duration_ms: turn.duration_ms,
                    kind: turn.kind,
                    instructions: turn.instructions,
                    model: turn.model,
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

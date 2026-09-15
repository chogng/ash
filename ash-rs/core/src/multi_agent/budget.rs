use crate::CoreError;
use crate::ThreadSnapshot;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use std::collections::BTreeSet;

/// Structural resource ceilings applied before a child Agent Thread is reserved.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct AgentTreeLimits {
    max_depth: u32,
    max_live_children: u32,
    max_total_descendants: u32,
}

impl AgentTreeLimits {
    /// Creates non-zero structural limits for one Agent tree.
    pub fn new(
        max_depth: u32,
        max_live_children: u32,
        max_total_descendants: u32,
    ) -> Result<Self, CoreError> {
        if max_depth == 0 || max_live_children == 0 || max_total_descendants == 0 {
            return Err(CoreError::InvalidInput(
                "Agent tree limits must be non-zero".into(),
            ));
        }
        Ok(Self {
            max_depth,
            max_live_children,
            max_total_descendants,
        })
    }
}

impl Default for AgentTreeLimits {
    fn default() -> Self {
        Self {
            max_depth: 4,
            max_live_children: 4,
            max_total_descendants: 16,
        }
    }
}

pub(super) fn validate_spawn_capacity(
    threads: &[ThreadSnapshot],
    session_id: &SessionId,
    parent_thread_id: &ThreadId,
    limits: AgentTreeLimits,
) -> Result<(), CoreError> {
    let parent_depth = agent_depth(threads, session_id, parent_thread_id)?;
    if parent_depth.saturating_add(1) > limits.max_depth {
        return Err(CoreError::InvalidInput(
            "Agent tree maximum depth has been reached".into(),
        ));
    }
    let materialized = threads
        .iter()
        .filter_map(|thread| {
            thread
                .agent_context_seed
                .as_ref()
                .map(|seed| &seed.delegation_id)
        })
        .collect::<BTreeSet<_>>();
    let pending = |thread: &ThreadSnapshot| {
        thread
            .delegations
            .keys()
            .filter(|id| !materialized.contains(id))
            .count() as u32
    };
    let reserved_children = threads
        .iter()
        .filter(|thread| &thread.thread_id == parent_thread_id)
        .map(pending)
        .sum::<u32>();
    let live_children = threads
        .iter()
        .filter(|thread| {
            &thread.session_id == session_id
                && thread.parent_thread_id.as_ref() == Some(parent_thread_id)
                && (thread.turns.is_empty()
                    || thread
                        .turns
                        .iter()
                        .any(|turn| !super::coordinator::is_terminal_turn(turn.status)))
        })
        .count() as u32;
    if live_children.saturating_add(reserved_children) >= limits.max_live_children {
        return Err(CoreError::InvalidInput(
            "Agent parent maximum live-child count has been reached".into(),
        ));
    }

    let root = agent_root(threads, session_id, parent_thread_id)?;
    let descendants = threads
        .iter()
        .filter(|thread| {
            &thread.session_id == session_id
                && thread.parent_thread_id.is_some()
                && agent_root(threads, session_id, &thread.thread_id)
                    .is_ok_and(|candidate| candidate == root)
        })
        .count() as u32;
    let reserved_descendants = threads
        .iter()
        .filter(|thread| {
            &thread.session_id == session_id
                && agent_root(threads, session_id, &thread.thread_id)
                    .is_ok_and(|candidate| candidate == root)
        })
        .map(pending)
        .sum::<u32>();
    if descendants.saturating_add(reserved_descendants) >= limits.max_total_descendants {
        return Err(CoreError::InvalidInput(
            "Agent tree maximum descendant count has been reached".into(),
        ));
    }
    Ok(())
}

fn agent_depth(
    threads: &[ThreadSnapshot],
    session_id: &SessionId,
    thread_id: &ThreadId,
) -> Result<u32, CoreError> {
    let root = agent_root_and_depth(threads, session_id, thread_id)?;
    Ok(root.1)
}

fn agent_root(
    threads: &[ThreadSnapshot],
    session_id: &SessionId,
    thread_id: &ThreadId,
) -> Result<ThreadId, CoreError> {
    Ok(agent_root_and_depth(threads, session_id, thread_id)?.0)
}

fn agent_root_and_depth(
    threads: &[ThreadSnapshot],
    session_id: &SessionId,
    thread_id: &ThreadId,
) -> Result<(ThreadId, u32), CoreError> {
    let mut current = thread_id.clone();
    let mut depth = 0_u32;
    let mut seen = BTreeSet::new();
    loop {
        if !seen.insert(current.clone()) {
            return Err(CoreError::Journal(
                "Agent Thread lineage contains a cycle".into(),
            ));
        }
        let thread = threads
            .iter()
            .find(|thread| thread.session_id == *session_id && thread.thread_id == current)
            .ok_or_else(|| CoreError::NotFound(current.to_string()))?;
        match &thread.parent_thread_id {
            Some(parent_thread_id) => {
                current = parent_thread_id.clone();
                depth = depth.saturating_add(1);
            }
            None => return Ok((current, depth)),
        }
    }
}

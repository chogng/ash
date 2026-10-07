use std::collections::BTreeMap;
use std::collections::BTreeSet;

use crate::ThreadSnapshot;
use ash_protocol::AgentTreeExecutionStatus;
use ash_protocol::AgentTreeNodeProjection;
use ash_protocol::AgentTreeProjection;
use ash_protocol::AgentTreeWaitingReason;
use ash_protocol::DelegationResult;
use ash_protocol::ModelUsageSummary;
use ash_protocol::ThreadId;
use ash_protocol::TurnStatus;

/// Derives the complete Agent observability tree from one consistent Thread read set.
pub fn project_agent_tree(threads: &[ThreadSnapshot]) -> AgentTreeProjection {
    let by_id = threads
        .iter()
        .map(|thread| (thread.thread_id.clone(), thread))
        .collect::<BTreeMap<_, _>>();
    let mut children = BTreeMap::<ThreadId, Vec<ThreadId>>::new();
    let mut roots = Vec::new();
    for thread in threads {
        let thread_id = thread.thread_id.clone();
        match thread.parent_thread_id.as_ref() {
            Some(parent) if parent != &thread_id && by_id.contains_key(parent) => {
                children.entry(parent.clone()).or_default().push(thread_id);
            }
            _ => roots.push(thread_id),
        }
    }
    let results = threads
        .iter()
        .flat_map(|thread| thread.received_delegation_results.values())
        .map(|result| (result.child_thread_id.clone(), result.clone()))
        .collect::<BTreeMap<_, _>>();
    let mut projected = BTreeSet::new();
    let mut nodes = roots
        .iter()
        .filter_map(|thread_id| build_node(thread_id, &by_id, &children, &results, &mut projected))
        .collect::<Vec<_>>();
    for thread in threads {
        if !projected.contains(&thread.thread_id)
            && let Some(node) = build_node(
                &thread.thread_id,
                &by_id,
                &children,
                &results,
                &mut projected,
            )
        {
            nodes.push(node);
        }
    }
    AgentTreeProjection { roots: nodes }
}

fn build_node(
    thread_id: &ThreadId,
    threads: &BTreeMap<ThreadId, &ThreadSnapshot>,
    children: &BTreeMap<ThreadId, Vec<ThreadId>>,
    results: &BTreeMap<ThreadId, DelegationResult>,
    projected: &mut BTreeSet<ThreadId>,
) -> Option<AgentTreeNodeProjection> {
    let thread = threads.get(thread_id)?;
    if !projected.insert(thread_id.clone()) {
        return None;
    }
    let turn = thread.turns.last();
    Some(AgentTreeNodeProjection {
        thread_id: thread_id.clone(),
        thread_sequence: thread.sequence,
        title: thread.title.clone(),
        parent_thread_id: thread.parent_thread_id.clone(),
        forked_from_id: thread.forked_from_id.clone(),
        execution_status: turn
            .map(|turn| execution_status(turn.status))
            .unwrap_or(AgentTreeExecutionStatus::Idle),
        current_turn_id: turn.map(|turn| turn.turn_id.clone()),
        waiting_reason: turn.and_then(|turn| waiting_reason(turn.status)),
        usage: turn
            .map(|turn| turn.usage.clone())
            .unwrap_or_else(ModelUsageSummary::default),
        goal: thread.goal.clone(),
        role: thread
            .agent_configuration()
            .and_then(|agent| agent.role.as_ref())
            .and_then(|role| role.definition.clone()),
        result: results.get(thread_id).cloned(),
        joins: thread.agent_joins.values().cloned().collect(),
        children: children
            .get(thread_id)
            .into_iter()
            .flatten()
            .filter_map(|child| build_node(child, threads, children, results, projected))
            .collect(),
    })
}

fn execution_status(status: TurnStatus) -> AgentTreeExecutionStatus {
    match status {
        TurnStatus::Created => AgentTreeExecutionStatus::Queued,
        TurnStatus::Running | TurnStatus::Cancelling => AgentTreeExecutionStatus::Running,
        TurnStatus::WaitingForApproval
        | TurnStatus::WaitingForUserInput
        | TurnStatus::WaitingForCapability => AgentTreeExecutionStatus::Waiting,
        TurnStatus::Completed => AgentTreeExecutionStatus::Completed,
        TurnStatus::Failed => AgentTreeExecutionStatus::Failed,
        TurnStatus::Interrupted => AgentTreeExecutionStatus::Cancelled,
    }
}

fn waiting_reason(status: TurnStatus) -> Option<AgentTreeWaitingReason> {
    match status {
        TurnStatus::WaitingForApproval => Some(AgentTreeWaitingReason::Approval),
        TurnStatus::WaitingForUserInput => Some(AgentTreeWaitingReason::UserInput),
        TurnStatus::WaitingForCapability => Some(AgentTreeWaitingReason::Capability),
        TurnStatus::Created
        | TurnStatus::Running
        | TurnStatus::Cancelling
        | TurnStatus::Completed
        | TurnStatus::Failed
        | TurnStatus::Interrupted => None,
    }
}

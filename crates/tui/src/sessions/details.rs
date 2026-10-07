use crate::widgets::detail_list::DetailList;
use crate::widgets::detail_list::DetailListRow;
use crate::widgets::overlay::DetailOverlay;
use ash_app_server_protocol::protocol::session::SessionResult;
use ash_protocol::AgentJoinStatus;
use ash_protocol::AgentTreeExecutionStatus;
use ash_protocol::AgentTreeNodeProjection;
use ash_protocol::AgentTreeWaitingReason;
use ash_protocol::Session;
use ash_protocol::SessionId;

#[derive(Debug)]
pub(crate) struct SessionDetails {
    pub(crate) overlay: DetailOverlay,
    pub(crate) session_id: SessionId,
    pub(crate) generation: u64,
    dirty: bool,
    last_read_at: Option<std::time::Instant>,
}

impl SessionDetails {
    pub(crate) fn new(session: &Session, generation: u64) -> Self {
        let mut rows = summary_rows(session);
        rows.push(DetailListRow::new("Threads", "Loading…"));
        Self {
            overlay: DetailOverlay::new(DetailList::new("Session details", rows)),
            session_id: session.session_id.clone(),
            generation,
            dirty: true,
            last_read_at: None,
        }
    }

    pub(crate) fn invalidate(&mut self) {
        self.dirty = true;
    }

    pub(crate) fn take_request(&mut self) -> Option<(u64, SessionId)> {
        let now = std::time::Instant::now();
        if !self.dirty
            && self
                .last_read_at
                .is_some_and(|last| now.duration_since(last) < std::time::Duration::from_secs(1))
        {
            return None;
        }
        self.dirty = false;
        self.last_read_at = Some(now);
        Some((self.generation, self.session_id.clone()))
    }

    pub(crate) fn install(&mut self, result: Result<SessionResult, String>) {
        let detail = match result {
            Ok(result) if result.session.session_id == self.session_id => render_details(&result),
            Ok(_) => DetailList::new(
                "Session details",
                vec![DetailListRow::new(
                    "Error",
                    "The response belongs to another session.",
                )],
            ),
            Err(error) => {
                DetailList::new("Session details", vec![DetailListRow::new("Error", error)])
            }
        };
        self.overlay.update(detail);
    }
}

fn summary_rows(session: &Session) -> Vec<DetailListRow> {
    vec![
        DetailListRow::new("Session", &session.title),
        DetailListRow::new(
            "Session ID",
            session
                .session_id
                .as_str()
                .strip_prefix("thread:")
                .unwrap_or(session.session_id.as_str()),
        ),
        DetailListRow::new(
            "Lifecycle",
            match session.status {
                ash_protocol::SessionStatus::Active => "active",
                ash_protocol::SessionStatus::Archived => "archived",
            },
        ),
        DetailListRow::new(
            "Status",
            super::manager::manager_status_label(session.manager.status),
        ),
        DetailListRow::new("Threads", session.threads.len().to_string()),
        DetailListRow::new("Total usage", super::session_size_label(session)),
        DetailListRow::new(
            "Model calls",
            session
                .threads
                .iter()
                .fold(0u64, |total, thread| {
                    total.saturating_add(thread.usage.model_invocations)
                })
                .to_string(),
        ),
    ]
}

fn render_details(result: &SessionResult) -> DetailList {
    let mut rows = summary_rows(&result.session);
    if result.agent_tree.roots.is_empty() {
        rows.push(DetailListRow::new("Threads", "No threads"));
    }
    let mut pending = result
        .agent_tree
        .roots
        .iter()
        .rev()
        .map(|node| (node, 0usize))
        .collect::<Vec<_>>();
    while let Some((node, depth)) = pending.pop() {
        let indent = "  ".repeat(depth);
        let relation = if node.parent_thread_id.is_some() {
            "Agent"
        } else if node.forked_from_id.is_some() {
            "Fork"
        } else if node.thread_id.as_str() == result.session.session_id.as_str() {
            "Root"
        } else {
            "Branch"
        };
        rows.push(DetailListRow::new(
            "Thread",
            format!(
                "{indent}{relation} · {} · {}",
                node.title,
                execution_label(node)
            ),
        ));
        rows.push(DetailListRow::new(
            "ID",
            format!("{indent}{}", node.thread_id),
        ));
        if let Some(parent) = &node.parent_thread_id {
            rows.push(DetailListRow::new("Parent", format!("{indent}{parent}")));
        }
        if let Some(source) = &node.forked_from_id {
            rows.push(DetailListRow::new(
                "Forked from",
                format!("{indent}{source}"),
            ));
        }
        if let Some(thread) = result
            .session
            .threads
            .iter()
            .find(|thread| thread.thread_id == node.thread_id)
        {
            rows.push(DetailListRow::new(
                "Lifecycle",
                format!(
                    "{indent}{}",
                    match thread.status {
                        ash_protocol::ThreadStatus::Active => "active",
                        ash_protocol::ThreadStatus::Archived => "archived",
                    }
                ),
            ));
        }
        for join in &node.joins {
            let status = match join.status {
                AgentJoinStatus::Waiting => "waiting",
                AgentJoinStatus::Satisfied => "satisfied",
            };
            rows.push(DetailListRow::new(
                "Join",
                format!(
                    "{indent}{status} · {} of {} results received",
                    join.satisfied_by.len(),
                    join.delegations.len()
                ),
            ));
        }
        if let Some(result) = &node.result {
            rows.push(DetailListRow::new(
                "Delivered result",
                format!("{indent}{}", result.summary),
            ));
        }
        pending.extend(node.children.iter().rev().map(|child| (child, depth + 1)));
    }
    DetailList::new("Session details", rows)
}

fn execution_label(node: &AgentTreeNodeProjection) -> &'static str {
    match node.execution_status {
        AgentTreeExecutionStatus::Idle => "idle",
        AgentTreeExecutionStatus::Queued => "queued",
        AgentTreeExecutionStatus::Running => "running",
        AgentTreeExecutionStatus::Waiting => match node.waiting_reason {
            Some(AgentTreeWaitingReason::Approval) => "waiting for approval",
            Some(AgentTreeWaitingReason::UserInput) => "waiting for user input",
            Some(AgentTreeWaitingReason::Capability) => "waiting for capability",
            None => "waiting",
        },
        AgentTreeExecutionStatus::Completed => "completed",
        AgentTreeExecutionStatus::Failed => "failed",
        AgentTreeExecutionStatus::Cancelled => "cancelled",
    }
}

#[cfg(test)]
#[path = "details_tests.rs"]
mod tests;

pub(crate) fn load_details<T: ash_app_server_client::JsonRpcTransport>(
    client: &mut ash_app_server_client::AppServerClient<T>,
    generation: u64,
    session_id: SessionId,
) -> super::Event {
    super::Event::DetailsReceived {
        generation,
        result: client
            .read_session(
                ash_app_server_protocol::protocol::session::SessionReadParams { session_id },
            )
            .map_err(|error| error.to_string()),
    }
}

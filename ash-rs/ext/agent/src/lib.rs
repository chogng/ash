//! Agent selection and execution over the shared Thread owner.
mod selection;
mod tool;
pub use selection::ResolvedAgentSelection;
pub use selection::resolve_agent_selection;
pub use selection::resolve_root_agent;
pub use tool::MultiAgentToolService;
pub use tool::SEND_AGENT_MESSAGE_TOOL_NAME;
pub use tool::SPAWN_AGENT_TOOL_NAME;
pub use tool::WAIT_AGENT_TOOL_NAME;

/// Supplies current, authorized role and instruction catalogs for a Session.
/// Hosts must omit sources whose directory grant has been revoked.
pub trait AgentCatalogProvider: Send + Sync {
    fn agent_snapshots_for(
        &self,
        session_id: &protocol::SessionId,
    ) -> Vec<std::sync::Arc<agent_roles::AgentRoleCatalogSnapshot>>;
    fn instruction_snapshots_for(
        &self,
        session_id: &protocol::SessionId,
    ) -> Vec<std::sync::Arc<instructions::InstructionCatalogSnapshot>>;
}

/// Reconciles durable spawn commands before starting newly materialized child Turns.
pub fn recover(
    coordinator: &ash_core::MultiAgentCoordinator,
    threads: &ash_core::ThreadController,
    backend: &dyn ash_core::TurnExecutionBackend,
    sessions: &std::collections::BTreeSet<protocol::SessionId>,
) -> Result<usize, core_api::CoreError> {
    let mut resumed = 0;
    for session_id in sessions {
        for spawned in coordinator.recover_session(session_id)? {
            let child = threads.read_thread(&spawned.child_thread_id)?;
            let should_start = child.turns.iter().any(|turn| {
                turn.turn_id == spawned.child_turn_id
                    && turn.status == protocol::TurnStatus::Running
                    && !child.has_resumable_tool_continuation(&turn.turn_id)
            });
            if should_start {
                backend.start(&spawned.child_thread_id, &spawned.child_turn_id)?;
                resumed += 1;
            }
        }
    }
    Ok(resumed)
}

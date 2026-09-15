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

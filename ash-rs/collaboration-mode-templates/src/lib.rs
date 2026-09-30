//! Model-facing instructions that shape how an Agent approaches a Turn.
//!
//! Shared Agent rules, role responsibilities, and tool capabilities remain owned by their
//! existing domains. These templates add only the selected collaboration approach.

pub const AGENT: &str = include_str!("../templates/agent.md");
pub const PLAN: &str = include_str!("../templates/plan.md");
pub const DEBUG: &str = include_str!("../templates/debug.md");
pub const MULTITASK: &str = include_str!("../templates/multitask.md");
pub const ASK: &str = include_str!("../templates/ask.md");

/// Freezes the approach separately from shared rules, model guidance and Role instructions.
pub fn instructions(mode: protocol::CollaborationMode) -> protocol::TurnInstructions {
    let (id, revision, body) = match mode {
        protocol::CollaborationMode::Agent => ("collaboration-mode/agent", "agent-v2", AGENT),
        protocol::CollaborationMode::Plan => ("collaboration-mode/plan", "plan-v2", PLAN),
        protocol::CollaborationMode::Debug => ("collaboration-mode/debug", "debug-v2", DEBUG),
        protocol::CollaborationMode::Multitask => {
            ("collaboration-mode/multitask", "multitask-v2", MULTITASK)
        }
        protocol::CollaborationMode::Ask => ("collaboration-mode/ask", "ask-v2", ASK),
    };
    protocol::TurnInstructions::new("collaboration-mode-templates", id, revision, body)
        .expect("packaged mode templates have valid identities and nonempty bodies")
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;

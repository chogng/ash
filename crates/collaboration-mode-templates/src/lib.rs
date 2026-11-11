//! Model-facing instructions that shape how an Agent approaches a Turn.
//!
//! Shared Agent rules, role responsibilities, and tool capabilities remain owned by their
//! existing domains. These templates add only the selected collaboration approach.

pub const AGENT: &str = include_str!("../templates/agent.md");
pub const PLAN: &str = include_str!("../templates/plan.md");
pub const DEBUG: &str = include_str!("../templates/debug.md");
pub const MULTITASK: &str = include_str!("../templates/multitask.md");
pub const ASK: &str = include_str!("../templates/ask.md");

const FOLLOWUPS: &str = "When a completed reply naturally leaves a specific next step the user could ask you to take, you may put up to three short, self-contained suggested prompts in a separate, final Markdown bullet list. Use one link per bullet with the literal destination #ash-followup, for example: - [Run the Windows smoke tests](#ash-followup). Write the labels in the user's language as requests the user could send. Skip the list while a decision is pending, if the reply asks a question, or if the suggestions would be generic.";

/// Freezes the approach separately from shared rules, model guidance and Role instructions.
pub fn instructions(mode: protocol::CollaborationMode) -> protocol::TurnInstructions {
    let (id, revision, body) = match mode {
        protocol::CollaborationMode::Agent => ("collaboration-mode/agent", "agent-v3", AGENT),
        protocol::CollaborationMode::Plan => ("collaboration-mode/plan", "plan-v4", PLAN),
        protocol::CollaborationMode::Debug => ("collaboration-mode/debug", "debug-v3", DEBUG),
        protocol::CollaborationMode::Multitask => {
            ("collaboration-mode/multitask", "multitask-v3", MULTITASK)
        }
        protocol::CollaborationMode::Ask => ("collaboration-mode/ask", "ask-v4", ASK),
    };
    let body = if mode == protocol::CollaborationMode::Plan {
        std::borrow::Cow::Borrowed(body)
    } else {
        std::borrow::Cow::Owned(format!("{}\n\n{FOLLOWUPS}\n", body.trim_end()))
    };
    protocol::TurnInstructions::new("collaboration-mode-templates", id, revision, body.as_ref())
        .expect("packaged mode templates have valid identities and nonempty bodies")
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;

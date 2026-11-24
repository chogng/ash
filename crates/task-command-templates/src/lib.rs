//! Model-facing instructions that shape how an Agent approaches a Turn.
//!
//! Shared Agent rules, role responsibilities, and tool capabilities remain owned by their
//! existing domains. These templates provide the instructions for default execution and task commands.

pub const AGENT: &str = include_str!("../templates/agent.md");
pub const PLAN: &str = include_str!("../templates/plan.md");
pub const DEBUG: &str = include_str!("../templates/debug.md");
pub const SWARM: &str = include_str!("../templates/swarm.md");
pub const ASK: &str = include_str!("../templates/ask.md");

const FOLLOWUPS: &str = "When a completed reply naturally leaves a specific next step the user could ask you to take, you may put up to three short, self-contained suggested prompts in a separate, final Markdown bullet list. Use one link per bullet with the literal destination #ash-followup, for example: - [Run the Windows smoke tests](#ash-followup). Write the labels in the user's language as requests the user could send. Skip the list while a decision is pending, if the reply asks a question, or if the suggestions would be generic.";

/// Freezes the approach separately from shared rules, model guidance and Role instructions.
pub fn instructions(execution: protocol::TaskExecution) -> protocol::TurnInstructions {
    let (id, revision, body) = match execution {
        protocol::TaskExecution::Agent => ("task-command/agent", "agent-v5", AGENT),
        protocol::TaskExecution::Plan => ("task-command/plan", "plan-v8", PLAN),
        protocol::TaskExecution::Debug => ("task-command/debug", "debug-v5", DEBUG),
        protocol::TaskExecution::Swarm => ("task-command/swarm", "swarm-v4", SWARM),
        protocol::TaskExecution::Ask => ("task-command/ask", "ask-v7", ASK),
    };
    let body = if execution == protocol::TaskExecution::Plan {
        std::borrow::Cow::Borrowed(body)
    } else {
        std::borrow::Cow::Owned(format!("{}\n\n{FOLLOWUPS}\n", body.trim_end()))
    };
    // This owner and the IDs above are persisted with each accepted Turn.
    protocol::TurnInstructions::new("task-command-templates", id, revision, body.as_ref())
        .expect("packaged task templates have valid identities and nonempty bodies")
}

#[cfg(test)]
#[path = "lib_tests.rs"]
mod tests;

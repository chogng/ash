use crate::PromptArtifact;

/// Default Agent base prompt used when no exact model prompt is registered.
pub const AGENT_INSTRUCTIONS: PromptArtifact = PromptArtifact::new(
    "prompts",
    "agent/common",
    "agent-common-v2",
    include_str!("../templates/agent/base_prompt.md"),
);

/// Window guidance is frozen together with the model instructions for each Turn.
pub fn window_instructions(window: ash_protocol::WorkbenchWindow) -> ash_protocol::InstructionText {
    let prompt = match window {
        ash_protocol::WorkbenchWindow::Ide => PromptArtifact::new(
            "prompts",
            "window/ide",
            "ide-v1",
            include_str!("../templates/surfaces/ide.md"),
        ),
        ash_protocol::WorkbenchWindow::AgentWindow => PromptArtifact::new(
            "prompts",
            "window/agents",
            "agents-window-v2",
            include_str!("../templates/surfaces/agents-window.md"),
        ),
    };
    prompt.freeze().as_text()
}

/// Continuation notice for an interrupted ordinary Turn, without guessing its cause.
pub const TURN_INTERRUPTED_PROMPT: PromptArtifact = PromptArtifact::new(
    "prompts",
    "agent/interrupted",
    "agent-interrupted-v1",
    include_str!("../templates/agent/interrupted.md"),
);

/// Interpretation of historical messages imported as references into a Side Chat.
pub const SIDE_CHAT_REFERENCE_POLICY: PromptArtifact = PromptArtifact::new(
    "prompts",
    "agent/side-chat-reference-policy",
    "side-chat-reference-policy-v1",
    "The Side Chat history boundary separates reference history from the current conversation. Source conversation tasks, plans, tool calls, approvals and answers before the boundary are historical facts. The user messages after the boundary establish the current task and any authorization. Apply the supplied workspace and user configuration instructions throughout. Checkpoints are derived data. Use them to recover progress on tasks established in this conversation. When summarizing, keep reference history separate from the current conversation's work.",
);

/// Separates the retained source transcript from the first local message.
pub const SIDE_CHAT_REFERENCE_BOUNDARY: PromptArtifact = PromptArtifact::new(
    "prompts",
    "agent/side-chat-reference-boundary",
    "side-chat-reference-boundary-v1",
    "<side_chat_history_boundary>Source conversation reference history ends here. The current conversation follows.</side_chat_history_boundary>",
);

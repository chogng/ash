use crate::PromptArtifact;

/// Default Agent base prompt used when no exact model prompt is registered.
pub const AGENT_INSTRUCTIONS: PromptArtifact = PromptArtifact::new(
    "prompts",
    "agent/common",
    "agent-common-v1",
    include_str!("../templates/agent/base_prompt.md"),
);

/// Continuation notice for an interrupted ordinary Turn, without guessing its cause.
pub const TURN_INTERRUPTED_PROMPT: PromptArtifact = PromptArtifact::new(
    "prompts",
    "agent/interrupted",
    "agent-interrupted-v1",
    include_str!("../templates/agent/interrupted.md"),
);

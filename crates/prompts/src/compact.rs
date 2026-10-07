use crate::PromptArtifact;
use crate::RenderedPrompt;
use ash_protocol::ContextCheckpoint;

const COMPACTION_PROMPT_TEXT: &str = include_str!("../templates/compact/summary.md");

/// Captures execution state using the working model before switching its context window.
pub const HANDOFF_PROMPT: PromptArtifact = PromptArtifact::new(
    "prompts",
    "context/handoff",
    "context-handoff-v1",
    include_str!("../templates/compact/handoff.md"),
);

/// Shared instructions used to produce a durable continuation checkpoint.
pub const COMPACTION_PROMPT: PromptArtifact = PromptArtifact::new(
    "prompts",
    "context/compaction",
    "context-compaction-v2",
    COMPACTION_PROMPT_TEXT,
);

const SUMMARY_PREFIX: PromptArtifact = PromptArtifact::new(
    "prompts",
    "context/checkpoint",
    "context-checkpoint-prompt-v1",
    include_str!("../templates/compact/summary_prefix.md"),
);

const CHECKPOINT_OPEN: &str = "\n\n<context_checkpoint id=\"";
const CHECKPOINT_DIGEST: &str = "\" source_digest=\"";
const CHECKPOINT_BODY: &str = "\" trust=\"derived-data\">\n";
const CHECKPOINT_CLOSE: &str = "\n</context_checkpoint>";

/// Renders a checkpoint as derived context while preserving its exact source identity.
pub fn checkpoint_prompt(checkpoint: &ContextCheckpoint) -> RenderedPrompt {
    SUMMARY_PREFIX.render(format!(
        "{}{CHECKPOINT_OPEN}{}{CHECKPOINT_DIGEST}{}{CHECKPOINT_BODY}{}{CHECKPOINT_CLOSE}",
        SUMMARY_PREFIX.body().trim(),
        escape_markup(checkpoint.checkpoint_id.as_str()),
        escape_markup(checkpoint.source_digest.as_str()),
        escape_markup(checkpoint.summary.trim()),
    ))
}

/// Bytes reserved for framing a new checkpoint, excluding its encoded summary.
/// `checkpoint_id_bytes` is the byte length of the markup-escaped checkpoint identity.
pub fn checkpoint_prompt_overhead(checkpoint_id_bytes: usize) -> usize {
    SUMMARY_PREFIX.body().trim().len()
        + CHECKPOINT_OPEN.len()
        + checkpoint_id_bytes
        + CHECKPOINT_DIGEST.len()
        + "sha256:".len()
        + 64
        + CHECKPOINT_BODY.len()
        + CHECKPOINT_CLOSE.len()
}

/// Measures the summary in its model-visible encoding before accepting compaction output.
pub fn checkpoint_summary_bytes(summary: &str) -> usize {
    escape_markup(summary.trim()).len()
}

fn escape_markup(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

#[cfg(test)]
#[path = "compact_tests.rs"]
mod tests;

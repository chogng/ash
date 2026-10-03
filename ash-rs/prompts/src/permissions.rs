use crate::PromptArtifact;
use ash_protocol::ApprovalMode;

const ACTION_PERMISSIONS: PromptArtifact = PromptArtifact::new(
    "prompts",
    "permissions/actions",
    "action-permissions-v1",
    include_str!("../templates/permissions/actions.md"),
);
const ASK_PERMISSIONS: PromptArtifact = PromptArtifact::new(
    "prompts",
    "permissions/approval/ask",
    "approval-ask-v2",
    include_str!("../templates/permissions/approval/ask.md"),
);
const AUTO_REVIEW: PromptArtifact = PromptArtifact::new(
    "prompts",
    "permissions/approval/auto-review",
    "approval-auto-review-v2",
    include_str!("../templates/permissions/approval/auto_review.md"),
);
const BYPASS_PERMISSIONS: PromptArtifact = PromptArtifact::new(
    "prompts",
    "permissions/approval/bypass",
    "approval-bypass-v1",
    include_str!("../templates/permissions/approval/bypass.md"),
);

/// Describes the host's per-action authorization and the Turn's recorded approval mode.
/// The selected text is explanatory; it neither resolves sandbox policies nor grants authority.
pub fn permissions_instructions(mode: ApprovalMode) -> [PromptArtifact; 2] {
    [
        ACTION_PERMISSIONS,
        match mode {
            ApprovalMode::Manual => ASK_PERMISSIONS,
            ApprovalMode::Auto => AUTO_REVIEW,
            ApprovalMode::BypassPermissions => BYPASS_PERMISSIONS,
        },
    ]
}

#[cfg(test)]
#[path = "permissions_tests.rs"]
mod tests;

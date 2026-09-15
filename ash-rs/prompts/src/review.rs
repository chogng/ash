use crate::PromptArtifact;
use ash_protocol::ReviewTarget;
use std::error::Error;
use std::fmt;

const REVIEW_PROMPT_TEXT: &str = include_str!("../templates/review/rubric.md");

/// Stable system instructions for a read-only code review Turn.
pub const REVIEW_PROMPT: PromptArtifact = PromptArtifact::new(
    "prompts",
    "review/code",
    "code-review-v3",
    REVIEW_PROMPT_TEXT,
);

/// The durable outcome of a completed review attempt, independent of the findings' verdict.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReviewOutcome {
    Completed,
    Interrupted,
    Failed,
}

/// Selects a continuation notice without duplicating or promoting the review's output.
pub fn review_exit_prompt(outcome: ReviewOutcome) -> PromptArtifact {
    match outcome {
        ReviewOutcome::Completed => PromptArtifact::new(
            "prompts",
            "review/exit/completed",
            "review-exit-completed-v1",
            include_str!("../templates/review/exit_success.xml"),
        ),
        ReviewOutcome::Interrupted => PromptArtifact::new(
            "prompts",
            "review/exit/interrupted",
            "review-exit-interrupted-v1",
            include_str!("../templates/review/exit_interrupted.xml"),
        ),
        ReviewOutcome::Failed => PromptArtifact::new(
            "prompts",
            "review/exit/failed",
            "review-exit-failed-v1",
            include_str!("../templates/review/exit_failed.xml"),
        ),
    }
}

/// Renders the user message that selects the change inspected by a review Turn.
pub fn review_target_prompt(target: &ReviewTarget) -> Result<String, ReviewPromptError> {
    match target {
        ReviewTarget::UncommittedChanges => Ok(
            "Review the current code changes, including staged, unstaged, and untracked files."
                .into(),
        ),
        ReviewTarget::BaseBranch { branch } => {
            let branch = required_value("base branch", branch)?;
            Ok(format!(
                "Review the changes against base branch `{branch}`. Determine the merge base with HEAD, then inspect the diff from that merge base."
            ))
        }
        ReviewTarget::Commit { sha, title } => {
            let sha = required_value("commit SHA", sha)?;
            match title
                .as_deref()
                .map(str::trim)
                .filter(|title| !title.is_empty())
            {
                Some(title) => Ok(format!(
                    "Review the changes introduced by commit `{sha}` ({title})."
                )),
                None => Ok(format!("Review the changes introduced by commit `{sha}`.")),
            }
        }
        ReviewTarget::Custom { instructions } => {
            Ok(required_value("custom review instructions", instructions)?.to_owned())
        }
    }
}

fn required_value<'a>(name: &'static str, value: &'a str) -> Result<&'a str, ReviewPromptError> {
    let value = value.trim();
    if value.is_empty() {
        return Err(ReviewPromptError { name });
    }
    Ok(value)
}

/// Identifies an empty value in a review target.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ReviewPromptError {
    name: &'static str,
}

impl fmt::Display for ReviewPromptError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} must not be empty", self.name)
    }
}

impl Error for ReviewPromptError {}

#[cfg(test)]
#[path = "review_tests.rs"]
mod tests;

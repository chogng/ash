use action_policy::ReviewContext;
use action_policy::ReviewEvidenceKind;
use action_policy::ReviewEvidenceTrust;
use std::fmt;

/// Limits apply to the complete serialized request, including its fixed instructions and schema.
/// Tokens are estimated as UTF-8 bytes / 3, rounded up; the independent byte ceiling remains exact.
#[derive(Clone, Copy, Debug)]
pub struct RequestBudget {
    pub max_bytes: usize,
    pub max_estimated_tokens: usize,
}

#[derive(Debug)]
pub enum BudgetError {
    Serialization(serde_json::Error),
    RequiredContextTooLarge { bytes: usize },
}

impl fmt::Display for BudgetError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Serialization(error) => write!(f, "review input serialization failed: {error}"),
            Self::RequiredContextTooLarge { bytes } => write!(
                f,
                "required review input exceeds the request budget: {bytes} bytes"
            ),
        }
    }
}

impl std::error::Error for BudgetError {}

/// Retains authorization and exact prepared evidence. Older optional observations are removed as
/// whole entries, with their omission count exposed to the reviewer. No action or instruction is
/// truncated. The caller measures its actual payload, so escaping and envelope overhead count.
pub fn fit(
    context: &ReviewContext,
    budget: RequestBudget,
    mut measure: impl FnMut(&ReviewContext) -> serde_json::Result<usize>,
) -> Result<ReviewContext, BudgetError> {
    let removable: Vec<_> = context
        .evidence()
        .iter()
        .enumerate()
        .filter_map(|(index, entry)| {
            (entry.trust() == ReviewEvidenceTrust::UntrustedContent
                && matches!(
                    entry.kind(),
                    ReviewEvidenceKind::AgentMessage
                        | ReviewEvidenceKind::Plan
                        | ReviewEvidenceKind::PriorToolCall
                        | ReviewEvidenceKind::PriorToolResult
                        | ReviewEvidenceKind::DirectoryFile
                ))
            .then_some(index)
        })
        .collect();
    let mut candidate = |count: usize| {
        let cutoff = count.checked_sub(1).map(|index| removable[index]);
        let evidence = context
            .evidence()
            .iter()
            .enumerate()
            .filter(|(index, _)| {
                !cutoff.is_some_and(|end| *index <= end && removable.binary_search(index).is_ok())
            })
            .map(|(_, entry)| entry.clone());
        let value = ReviewContext::new(context.user_intent(), evidence)
            .with_omitted_evidence(context.omitted_evidence() + count);
        let bytes = measure(&value).map_err(BudgetError::Serialization)?;
        Ok::<_, BudgetError>((value, bytes))
    };
    let fits = |bytes: usize| {
        bytes <= budget.max_bytes && bytes.div_ceil(3) <= budget.max_estimated_tokens
    };
    let (full, bytes) = candidate(0)?;
    if fits(bytes) {
        return Ok(full);
    }
    let (mut best, bytes) = candidate(removable.len())?;
    if !fits(bytes) {
        return Err(BudgetError::RequiredContextTooLarge { bytes });
    }
    // Removing a whole serialized entry decreases the payload. Find the smallest oldest prefix
    // to discard without repeatedly serializing the entire history once per observation.
    let mut low = 1;
    let mut high = removable.len();
    while low < high {
        let mid = low + (high - low) / 2;
        let (value, bytes) = candidate(mid)?;
        if fits(bytes) {
            best = value;
            high = mid;
        } else {
            low = mid + 1;
        }
    }
    Ok(best)
}

#[cfg(test)]
#[path = "budget_tests.rs"]
mod tests;

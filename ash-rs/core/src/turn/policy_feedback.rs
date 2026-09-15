use ash_action_policy::BlockReason;
use ash_action_policy::Capability;
use ash_action_policy::SaferActionRequest;
use ash_protocol::ThreadItem;
use ash_protocol::TurnId;
use serde::Deserialize;
use serde::Serialize;

const FEEDBACK_PREFIX: &str = "ash_action_policy_feedback:";
const CONSECUTIVE_REJECTION_LIMIT: usize = 3;
const ROLLING_REJECTION_LIMIT: usize = 10;
const ROLLING_RESULT_WINDOW: usize = 50;

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
enum ReviewFeedbackKind {
    ReviseAction,
    Denied,
}

#[derive(Debug, Deserialize, Serialize)]
struct ReviewFeedback {
    kind: ReviewFeedbackKind,
    assessment_id: String,
    reason: String,
    #[serde(default)]
    maximum_capabilities: Vec<Capability>,
    instruction: String,
}

pub(super) fn safer_action_feedback(request: &SaferActionRequest) -> String {
    render(ReviewFeedback {
        kind: ReviewFeedbackKind::ReviseAction,
        assessment_id: request.assessment_id().as_str().to_owned(),
        reason: request.reason().to_owned(),
        maximum_capabilities: request.maximum_capabilities().iter().cloned().collect(),
        instruction: "Choose a materially safer action within maximum_capabilities; do not retry \
                      the same action through a workaround."
            .into(),
    })
}

pub(super) fn denied_feedback(reason: &BlockReason) -> Option<String> {
    let (assessment_id, reason) = match reason {
        BlockReason::ReviewerDenied {
            assessment_id,
            reason,
        }
        | BlockReason::CriticalRisk {
            assessment_id,
            reason,
        } => (assessment_id.as_str(), reason.as_str()),
        _ => return None,
    };
    Some(render(ReviewFeedback {
        kind: ReviewFeedbackKind::Denied,
        assessment_id: assessment_id.to_owned(),
        reason: reason.to_owned(),
        maximum_capabilities: Vec::new(),
        instruction: "Do not pursue the same outcome by workaround, indirect execution, or policy \
                      circumvention. Continue only with a materially safer alternative."
            .into(),
    }))
}

pub(super) fn rejection_circuit_breaker(items: &[ThreadItem], turn_id: &TurnId) -> Option<String> {
    let results = items
        .iter()
        .filter_map(|item| match item {
            ThreadItem::ToolResult {
                turn_id: item_turn_id,
                text,
                ..
            } if item_turn_id == turn_id => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>();
    let consecutive = results
        .iter()
        .rev()
        .take_while(|text| parse(text).is_some())
        .count();
    let rolling = results
        .iter()
        .rev()
        .take(ROLLING_RESULT_WINDOW)
        .filter(|text| parse(text).is_some())
        .count();
    if consecutive >= CONSECUTIVE_REJECTION_LIMIT || rolling >= ROLLING_REJECTION_LIMIT {
        Some(format!(
            "automatic review circuit breaker opened after {consecutive} consecutive and \
             {rolling} recent rejected actions"
        ))
    } else {
        None
    }
}

fn render(feedback: ReviewFeedback) -> String {
    let json = serde_json::to_string(&feedback)
        .expect("policy feedback contains only serializable protocol values");
    format!("{FEEDBACK_PREFIX}{json}")
}

fn parse(value: &str) -> Option<ReviewFeedback> {
    serde_json::from_str(value.strip_prefix(FEEDBACK_PREFIX)?).ok()
}

#[cfg(test)]
#[path = "policy_feedback_tests.rs"]
mod tests;

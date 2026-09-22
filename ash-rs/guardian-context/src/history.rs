use action_policy::ReviewEvidence;
use action_policy::ReviewEvidenceKind;
use action_policy::ReviewEvidenceTrust;
use protocol::ThreadId;
use protocol::ThreadItem;

/// The host-established author of UserMessage records in a durable history prefix.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MessageOrigin {
    User,
    Agent,
}

/// Collects ordered text evidence from an exact prefix supplied by Core. Reasoning and attachment
/// bytes are not review evidence. A delegated task is never promoted to a user instruction.
pub fn collect<'a>(
    thread: &ThreadId,
    origin: MessageOrigin,
    items: impl IntoIterator<Item = &'a ThreadItem>,
) -> Vec<ReviewEvidence> {
    items
        .into_iter()
        .filter_map(|item| {
            let (kind, trust, content) = match item {
                ThreadItem::UserMessage { text, .. } => match origin {
                    MessageOrigin::User => (
                        ReviewEvidenceKind::UserMessage,
                        ReviewEvidenceTrust::TrustedUser,
                        text.clone(),
                    ),
                    MessageOrigin::Agent => (
                        ReviewEvidenceKind::Delegation,
                        ReviewEvidenceTrust::UntrustedContent,
                        text.clone(),
                    ),
                },
                ThreadItem::AgentMessage { text, .. } => (
                    ReviewEvidenceKind::AgentMessage,
                    ReviewEvidenceTrust::UntrustedContent,
                    text.clone(),
                ),
                ThreadItem::Plan { text, .. } => (
                    ReviewEvidenceKind::Plan,
                    ReviewEvidenceTrust::UntrustedContent,
                    text.clone(),
                ),
                ThreadItem::ToolCall {
                    name,
                    arguments_json,
                    ..
                } => (
                    ReviewEvidenceKind::PriorToolCall,
                    ReviewEvidenceTrust::UntrustedContent,
                    format!("{}\n{arguments_json}", name.as_str()),
                ),
                ThreadItem::ToolResult { text, .. } => (
                    ReviewEvidenceKind::PriorToolResult,
                    ReviewEvidenceTrust::UntrustedContent,
                    text.clone(),
                ),
                ThreadItem::UserContext { name, content, .. } => (
                    ReviewEvidenceKind::DirectoryFile,
                    ReviewEvidenceTrust::UntrustedContent,
                    format!("{name}\n{content}"),
                ),
                ThreadItem::Reasoning { .. }
                | ThreadItem::UserImage { .. }
                | ThreadItem::UserImageAttachment { .. }
                | ThreadItem::UserAudioAttachment { .. } => return None,
            };
            Some(ReviewEvidence::new(
                kind,
                trust,
                format!(
                    "thread/{thread}/turn/{}/item/{}",
                    item.turn_id(),
                    item.item_id()
                ),
                content,
            ))
        })
        .collect()
}

#[cfg(test)]
#[path = "history_tests.rs"]
mod tests;

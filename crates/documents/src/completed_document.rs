use ash_protocol::ContentDigest;
use ash_protocol::ItemId;
use ash_protocol::MessagePhase;
use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use ash_protocol::ThreadItem;
use ash_protocol::Turn;
use ash_protocol::TurnStatus;

/// The document creation workflow's accepted output, ready for create-only publication.
pub struct CompletedDocument {
    pub id: String,
    pub item_id: ItemId,
    pub title: String,
    pub markdown: String,
}

/// Selects a completed Docs response. Thread persistence never interprets product context names.
pub fn completed_document(
    session: &SessionId,
    thread: &ThreadId,
    turn: &Turn,
) -> Option<CompletedDocument> {
    if turn.status != TurnStatus::Completed || !turn.items.iter().any(
        |item| matches!(item, ThreadItem::UserContext { name, .. } if name == "ash.creation.docs"),
    ) {
        return None;
    }
    let messages = || {
        turn.items.iter().rev().filter_map(|item| match item {
            ThreadItem::AgentMessage {
                item_id,
                text,
                phase,
                ..
            } => Some((item_id, text, phase)),
            _ => None,
        })
    };
    let (item_id, markdown, _) = messages()
        .find(|(_, _, phase)| **phase == Some(MessagePhase::FinalAnswer))
        .or_else(|| messages().next().filter(|(_, _, phase)| phase.is_none()))?;
    if markdown.trim().is_empty() {
        return None;
    }
    let key = serde_json::json!([
        "local-agent-host",
        null,
        session.as_str(),
        thread.as_str(),
        item_id.as_str(),
        "markdown"
    ]);
    let digest = ContentDigest::sha256(key.to_string().as_bytes());
    let id = digest
        .as_str()
        .strip_prefix("sha256:")
        .expect("SHA-256 digest prefix")
        .to_owned();
    let heading = markdown.lines().find_map(|line| {
        let text = line.trim_start_matches('#');
        (text.len() < line.len() && text.starts_with([' ', '\t']))
            .then(|| text.trim().trim_end_matches('#').trim())
            .filter(|text| !text.is_empty())
    });
    let title = heading
        .or_else(|| {
            markdown
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
        })
        .unwrap_or(markdown.trim())
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(200)
        .collect();
    Some(CompletedDocument {
        id,
        item_id: item_id.clone(),
        title,
        markdown: markdown.clone(),
    })
}

#[cfg(test)]
#[path = "completed_document_tests.rs"]
mod tests;

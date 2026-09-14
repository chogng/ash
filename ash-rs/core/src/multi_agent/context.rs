use crate::ThreadSnapshot;
use crate::context::InstructionFragment;
use crate::context::InstructionPlacement;
use crate::context::InstructionRetention;
use crate::context::InstructionSource;
use ash_protocol::AgentContextContent;
use ash_protocol::AgentMessageContent;
use ash_protocol::ToolDefinition;
use std::collections::BTreeSet;

pub(crate) fn agent_context_fragments(snapshot: &ThreadSnapshot) -> Vec<InstructionFragment> {
    let mut fragments = Vec::new();
    if let Some(role) = snapshot
        .agent_configuration()
        .and_then(|agent| agent.role.as_ref())
    {
        let revision = ash_protocol::ContentDigest::sha256(role.instructions.as_bytes());
        fragments.push(InstructionFragment::new(
            InstructionSource::new("agent-role", role.name.clone(), revision.as_str()),
            InstructionPlacement::Product,
            InstructionRetention::Required,
            format!(
                "<agent-role name=\"{}\">\n{}\n</agent-role>",
                xml_escape(&role.name),
                role.instructions.trim()
            ),
        ));
    }
    if let Some(seed) = &snapshot.agent_context_seed {
        fragments.push(InstructionFragment::new(
            InstructionSource::new("agent-delegation", seed.delegation_id.to_string(), seed.digest.as_str()),
            InstructionPlacement::Turn,
            InstructionRetention::Required,
            format!("This is delegated work from Agent Thread {}. Complete the assigned task within your own role and permissions, and return the result and verification evidence to the caller.", seed.parent_thread_id),
        ));
        fragments.extend(seed.materialized_context.iter().map(|materialized| {
            let (source_thread_id, source_sequence, source_kind, source_id) =
                materialized_source_identity(&materialized.source);
            InstructionFragment::new(
                InstructionSource::new(
                    source_kind,
                    format!("{source_thread_id}:{source_id}"),
                    format!("{source_sequence}:{}", materialized.content_digest.as_str()),
                ),
                InstructionPlacement::Directory,
                InstructionRetention::Required,
                format!(
                    "<inherited-agent-context source-thread=\"{}\" source-sequence=\"{}\" kind=\"{}\">\n{}\n</inherited-agent-context>",
                    source_thread_id,
                    source_sequence,
                    source_kind,
                    xml_escape(&materialized_content_text(&materialized.content))
                ),
            )
        }));
    }
    let mut messages = snapshot
        .received_agent_messages
        .values()
        .collect::<Vec<_>>();
    messages.sort_by(|left, right| {
        left.sender_sequence
            .cmp(&right.sender_sequence)
            .then_with(|| left.message_id.cmp(&right.message_id))
    });
    fragments.extend(messages.into_iter().map(|message| {
        let body = match &message.content {
            AgentMessageContent::Instruction { text } => text.clone(),
            AgentMessageContent::Result { result } => format!(
                "Delegation {} completed with status {:?}.\n{}",
                result.delegation_id,
                result.status,
                result.summary.trim()
            ),
        };
        InstructionFragment::new(
            InstructionSource::new(
                "agent-message",
                message.message_id.to_string(),
                message.sender_sequence.to_string(),
            ),
            InstructionPlacement::Directory,
            InstructionRetention::BestEffort,
            format!(
                "<agent-message sender=\"{}\" provenance=\"{:?}\">\n{}\n</agent-message>",
                message.sender_thread_id,
                message.provenance,
                xml_escape(&body)
            ),
        )
    }));
    fragments
}

fn materialized_source_identity(
    source: &ash_protocol::AgentContextSource,
) -> (&ash_protocol::ThreadId, u64, &'static str, String) {
    match source {
        ash_protocol::AgentContextSource::Item {
            source_thread_id,
            source_sequence,
            item_id,
        } => (
            source_thread_id,
            *source_sequence,
            "item",
            item_id.to_string(),
        ),
        ash_protocol::AgentContextSource::Checkpoint {
            source_thread_id,
            source_sequence,
            checkpoint_id,
        } => (
            source_thread_id,
            *source_sequence,
            "checkpoint",
            checkpoint_id.to_string(),
        ),
    }
}

fn materialized_content_text(content: &AgentContextContent) -> String {
    match content {
        AgentContextContent::UserText { text } => format!("User: {text}"),
        AgentContextContent::UserImage { url } => format!("User image: {url}"),
        AgentContextContent::UserImageAttachment { attachment } => {
            format!("User image attachment: {}", attachment.content_digest)
        }
        AgentContextContent::AssistantText { text } => format!("Assistant: {text}"),
        AgentContextContent::Reasoning { text } => format!("Reasoning record: {text}"),
        AgentContextContent::Plan { text } => format!("Plan record: {text}"),
        AgentContextContent::ToolCall {
            name,
            arguments_json,
        } => format!("Tool call {name}: {arguments_json}"),
        AgentContextContent::ToolResult { text, is_error } => {
            format!("Tool result (error={is_error}): {text}")
        }
        AgentContextContent::Checkpoint { summary } => format!("Checkpoint: {summary}"),
    }
}

pub(crate) fn scope_agent_tools(
    snapshot: &ThreadSnapshot,
    tool_mode: ash_protocol::ToolMode,
    tools: Vec<ToolDefinition>,
) -> Vec<ToolDefinition> {
    let Some(seed) = snapshot.agent_configuration() else {
        return tools;
    };
    let allowed = seed
        .capability_scope
        .tools
        .iter()
        .cloned()
        .collect::<BTreeSet<_>>();
    tools
        .into_iter()
        .filter(|tool| {
            allowed.contains(&tool.name)
                || (!allowed.is_empty()
                    && tool_mode.requires_code_mode()
                    && matches!(tool.name.as_str(), "exec" | "wait"))
        })
        .collect()
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

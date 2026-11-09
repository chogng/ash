//! Subscriber updates combining committed facts with transient content deltas.

use crate::ItemId;
use crate::SessionId;
use crate::StreamCursor;
use crate::ThreadEvent;
use crate::ThreadId;
use crate::ThreadItem;
use crate::TurnId;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Consumer-facing update for one Thread.
///
/// `Committed` carries a durable fact. The remaining variants are low-latency projections and
/// may be dropped; a later committed Item snapshot remains authoritative.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ThreadUpdate {
    Committed {
        event: ThreadEvent,
    },
    ItemStarted {
        turn_id: TurnId,
        item: ThreadItem,
    },
    ItemDelta {
        turn_id: TurnId,
        item_id: ItemId,
        delta: ItemDelta,
    },
    ToolOutputDelta {
        turn_id: TurnId,
        tool_call_id: crate::ToolCallId,
        stream: ToolOutputStream,
        text: String,
    },
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ToolOutputStream {
    Stdout,
    Stderr,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ItemDelta {
    ToolCallArguments {
        tool_call_id: crate::ToolCallId,
        name: crate::ToolName,
        arguments: String,
    },
    AgentMessage {
        text: String,
    },
    AgentMessagePhase {
        phase: Option<crate::MessagePhase>,
    },
    Reasoning {
        text: String,
    },
    Plan {
        text: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct ThreadUpdateEnvelope {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    #[ts(type = "number")]
    pub durable_sequence: u64,
    /// Original journal time for committed user and assistant messages.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable, type = "number")]
    pub recorded_at_unix_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub stream_cursor: Option<StreamCursor>,
    /// Subscriptions carry wait metadata; only AgentRequestEnvelope discloses a review candidate.
    #[serde(serialize_with = "serialize_public_update")]
    pub update: ThreadUpdate,
}

fn serialize_public_update<S: serde::Serializer>(
    update: &ThreadUpdate,
    serializer: S,
) -> Result<S::Ok, S::Error> {
    if let ThreadUpdate::Committed {
        event: crate::ThreadEvent::InteractionRequested { interaction, .. },
    } = update
        && matches!(
            &interaction.request,
            crate::AgentRequest::ToolResultReview { .. }
        )
    {
        // Keep the durable event intact for recovery and owner selection. The public update
        // still identifies the call and wait, but cannot become an alternate disclosure path.
        let mut public = update.clone();
        if let ThreadUpdate::Committed {
            event: crate::ThreadEvent::InteractionRequested { interaction, .. },
        } = &mut public
            && let crate::AgentRequest::ToolResultReview { request } = &mut interaction.request
        {
            request.review.reason.clear();
            request.review.content.clear();
        }
        return public.serialize(serializer);
    }
    update.serialize(serializer)
}

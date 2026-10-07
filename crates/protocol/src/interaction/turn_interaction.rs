//! Durable Turn requests, pending metadata, deadlines, cancellation, and delivery envelopes.
//! Envelopes identify the task; App Server owns the connection that receives them.

use crate::ActionApprovalRequest;
use crate::ActionApprovalResponse;
use crate::DynamicToolCall;
use crate::DynamicToolResponse;
use crate::ItemId;
use crate::RequestId;
use crate::RequestUserInput;
use crate::RequestUserInputResponse;
use crate::SessionId;
use crate::ThreadId;
use crate::TurnId;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentRequest {
    Approval { request: ActionApprovalRequest },
    UserInput { request: RequestUserInput },
    DynamicTool { call: DynamicToolCall },
}

impl AgentRequest {
    pub fn kind(&self) -> AgentInteractionKind {
        match self {
            Self::Approval { .. } => AgentInteractionKind::Approval,
            Self::UserInput { .. } => AgentInteractionKind::UserInput,
            Self::DynamicTool { .. } => AgentInteractionKind::DynamicTool,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum AgentInteractionKind {
    Approval,
    UserInput,
    DynamicTool,
}

/// A wall-clock deadline that the interaction owner must enforce.
///
/// `expires_at_unix_ms` is persisted as an absolute instant so recovery can determine whether a
/// request is still actionable after a process restart. The protocol does not prescribe the
/// timeout policy or clock implementation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct InteractionDeadline {
    #[ts(type = "number")]
    pub expires_at_unix_ms: u64,
}

/// One outstanding interaction that pauses a Turn until it is resolved or cancelled.
///
/// The request is durable product state. Selecting a connection that receives it is an App
/// Server delivery concern and deliberately does not appear here.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TurnInteraction {
    pub request_id: RequestId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub item_id: Option<ItemId>,
    pub request: AgentRequest,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub deadline: Option<InteractionDeadline>,
}

impl TurnInteraction {
    /// Builds the redaction-safe wait state exposed by a readable Turn snapshot.
    pub fn pending_state(&self) -> PendingInteraction {
        PendingInteraction {
            request_id: self.request_id.clone(),
            item_id: self.item_id.clone(),
            kind: self.request.kind(),
            deadline: self.deadline,
        }
    }
}

/// Redaction-safe metadata for a Turn that is waiting on an interaction.
///
/// The full request payload stays in the durable interaction fact so an App Server can redeliver
/// it to its selected owner after recovery. Readable Thread snapshots expose only this metadata,
/// preventing a broad subscription from becoming an implicit interaction-delivery channel.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct PendingInteraction {
    pub request_id: RequestId,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub item_id: Option<ItemId>,
    pub kind: AgentInteractionKind,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub deadline: Option<InteractionDeadline>,
}

/// Delivery-ready view of a durable Turn interaction.
///
/// This envelope deliberately carries aggregate context but not a connection owner; App Server
/// owns routing to a live connection and must reselect or cancel on disconnect.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentRequestEnvelope {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub turn_id: TurnId,
    pub interaction: TurnInteraction,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AgentResponse {
    Approval { response: ActionApprovalResponse },
    UserInput { response: RequestUserInputResponse },
    DynamicTool { response: DynamicToolResponse },
}

impl AgentResponse {
    pub fn kind(&self) -> AgentInteractionKind {
        match self {
            Self::Approval { .. } => AgentInteractionKind::Approval,
            Self::UserInput { .. } => AgentInteractionKind::UserInput,
            Self::DynamicTool { .. } => AgentInteractionKind::DynamicTool,
        }
    }
}

/// Why a previously outstanding interaction was closed without a response.
///
/// The reason is durable so recovery and clients can distinguish an explicit Turn interruption
/// from a deadline or delivery failure. The policy deciding which reason applies lives outside
/// this shared contract.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum InteractionCancelReason {
    TurnInterrupted,
    DeadlineElapsed,
    OwnerDisconnected,
    ServerShutdown,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AgentResponseEnvelope {
    pub request_id: RequestId,
    pub response: AgentResponse,
}

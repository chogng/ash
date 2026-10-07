//! Shared collaboration contracts, independent of execution and storage.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Opens one shared structured-document room or joins an existing room.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCollaborationOpenParams {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub room_id: Option<String>,
    #[schemars(length(min = 1))]
    pub client_id: String,
    #[schemars(length(min = 1))]
    pub schema_id: String,
    /// Serialized, schema-validated document supplied only when creating a room.
    #[schemars(length(min = 1))]
    pub document: String,
}

/// Versioned canonical document snapshot returned while opening or resynchronizing a room.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCollaborationSnapshot {
    pub room_id: String,
    #[ts(type = "number")]
    pub version: u64,
    pub document: String,
}

/// Result of opening a shared structured-document room.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCollaborationOpenResult {
    pub client_id: String,
    pub schema_id: String,
    pub snapshot: DocumentCollaborationSnapshot,
}

/// Authenticated person or service principal acting in a collaboration room.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DocumentCollaborationPrincipal {
    pub id: String,
    pub display_name: String,
}

/// Permission assigned to one authenticated collaboration room member.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum DocumentCollaborationRoomRole {
    Owner,
    Editor,
    Viewer,
}

impl DocumentCollaborationRoomRole {
    /// Returns whether this role may create server-ordered document updates.
    pub fn can_submit(self) -> bool {
        matches!(self, Self::Owner | Self::Editor)
    }

    /// Returns whether this role may issue, revoke, or rotate room member credentials.
    pub fn can_manage_members(self) -> bool {
        matches!(self, Self::Owner)
    }
}

/// One newly provisioned room member access credential.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCollaborationInvite {
    pub room_id: String,
    pub principal_id: String,
    pub display_name: String,
    pub role: DocumentCollaborationRoomRole,
    /// Secret bearer credential shown only when the invitation is created.
    pub access_token: String,
}

/// One active authenticated member of a collaboration room, visible to room owners.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCollaborationMember {
    pub principal_id: String,
    pub display_name: String,
    pub role: DocumentCollaborationRoomRole,
}

/// One immutable room-security event retained for owner audit and incident review.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCollaborationAuditEvent {
    pub room_id: String,
    #[ts(type = "number")]
    pub event_id: u64,
    pub actor_principal_id: String,
    pub event_type: String,
    pub subject_principal_id: String,
    #[ts(type = "number")]
    pub occurred_at_ms: u64,
}

/// One active client selection announced independently from document history.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCollaborationPresence {
    pub client_id: String,
    /// Serialized Document Engine selection, validated as a bounded selection envelope by the authority.
    pub selection: String,
}

/// Current ephemeral room presence after one monotonically increasing generation.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCollaborationPresenceReplay {
    #[ts(type = "number")]
    pub generation: u64,
    pub presences: Vec<DocumentCollaborationPresence>,
}

/// One local-process presence mutation requested through the App Server protocol.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCollaborationPresenceParams {
    #[schemars(length(min = 1))]
    pub room_id: String,
    #[schemars(length(min = 1))]
    pub client_id: String,
    /// Omitting the selection clears this client's ephemeral presence record.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub selection: Option<String>,
}

/// Full current local-process presence projection for one collaboration room.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCollaborationPresenceSnapshot {
    pub room_id: String,
    #[ts(type = "number")]
    pub generation: u64,
    pub presences: Vec<DocumentCollaborationPresence>,
}

/// Reads the current ephemeral presence projection after opening a room.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCollaborationPresenceReadParams {
    #[schemars(length(min = 1))]
    pub room_id: String,
}

/// One server-ordered opaque Document Engine transaction.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCollaborationUpdate {
    pub room_id: String,
    pub client_id: String,
    #[ts(type = "number")]
    pub sequence: u64,
    #[ts(type = "number")]
    pub base_version: u64,
    #[ts(type = "number")]
    pub version: u64,
    /// Serialized Document Engine transaction. The renderer validates it against its schema before use.
    pub transaction: String,
}

/// Submits one optimistic local transaction alongside its resulting document snapshot.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct DocumentCollaborationSubmitParams {
    #[schemars(length(min = 1))]
    pub room_id: String,
    #[schemars(length(min = 1))]
    pub client_id: String,
    #[ts(type = "number")]
    pub sequence: u64,
    #[ts(type = "number")]
    pub base_version: u64,
    #[schemars(length(min = 1))]
    pub transaction: String,
    /// Serialized, schema-validated document after applying `transaction` optimistically.
    #[schemars(length(min = 1))]
    pub document: String,
}

/// Server outcome for an optimistic document submission.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum DocumentCollaborationSubmitResult {
    Accepted {
        update: DocumentCollaborationUpdate,
    },
    Conflict {
        updates: Vec<DocumentCollaborationUpdate>,
    },
    Resync {
        snapshot: DocumentCollaborationSnapshot,
    },
}

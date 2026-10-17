//! Durable human collaboration spaces. Membership covers the entire channel tree.
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum ChannelRole {
    Owner,
    Editor,
    Viewer,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Channel {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional = nullable)]
    pub parent_id: Option<String>,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelMember {
    pub id: String,
    pub name: String,
    pub role: ChannelRole,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelSnapshot {
    pub id: String,
    pub name: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub member_id: String,
    pub channels: Vec<Channel>,
    pub members: Vec<ChannelMember>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ChannelChange {
    Create {
        name: String,
        #[serde(default)]
        parent_id: Option<String>,
    },
    Rename {
        channel_id: String,
        name: String,
    },
    Remove {
        channel_id: String,
    },
    SetRole {
        member_id: String,
        role: ChannelRole,
    },
    RemoveMember {
        member_id: String,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelEditParams {
    pub space_id: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub change: ChannelChange,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelInviteParams {
    pub space_id: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub name: String,
    pub role: ChannelRole,
}

// Credentials intentionally omit Debug. They are returned only for explicit invitation or backup requests.
#[derive(Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelInvitation {
    pub server_url: String,
    pub credential: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelConnection {
    pub server_url: String,
    pub snapshot: ChannelSnapshot,
}

#[derive(Deserialize, JsonSchema, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ChannelConnectParams {
    Join {
        server_url: String,
        credential: String,
    },
    Create {
        server_url: String,
        administrator: String,
        name: String,
        member_name: String,
    },
}

/// Remote bootstrap input: the client retains the owner credential to recover a lost response.
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelCreate {
    pub name: String,
    pub member_name: String,
    pub credential: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelInvite {
    pub params: ChannelInviteParams,
    pub credential: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelResourceParams {
    pub space_id: String,
    pub channel_id: String,
}

/// A member-scoped resource credential. Never put it in a URL or a persisted editor input.
#[derive(Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ChannelResourceAccess {
    pub server_url: String,
    pub resource_id: String,
    pub credential: String,
}

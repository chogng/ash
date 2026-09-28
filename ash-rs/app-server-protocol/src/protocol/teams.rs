use crate::{JsonSchema, TS};
use ash_protocol::{
    AgentId, AgentMessageId, AgentRoleSelection, CommandId, SessionId, TeamId, TeamRunId, ThreadId,
};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamMemberDto {
    pub agent_id: AgentId,
    pub name: String,
    pub responsibility: String,
    pub role: AgentRoleSelection,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TeamStatusDto {
    Active,
    Archived,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamDto {
    pub team_id: TeamId,
    #[ts(type = "number")]
    pub revision: u64,
    pub status: TeamStatusDto,
    pub name: String,
    pub description: String,
    pub coordinator_id: AgentId,
    pub members: Vec<TeamMemberDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    tag = "type"
)]
pub enum TeamCommandDto {
    Create {
        name: String,
        description: String,
        coordinator_id: AgentId,
        members: Vec<TeamMemberDto>,
    },
    UpdateDetails {
        name: String,
        description: String,
    },
    AddMember {
        member: TeamMemberDto,
    },
    UpdateMember {
        member: TeamMemberDto,
    },
    RemoveMember {
        agent_id: AgentId,
    },
    SetCoordinator {
        agent_id: AgentId,
    },
    Archive,
    Restore,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(deny_unknown_fields)]
pub struct TeamListParams {}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamListResult {
    pub teams: Vec<TeamDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamReadParams {
    pub team_id: TeamId,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamReadResult {
    pub team: TeamDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamCommandParams {
    pub command_id: CommandId,
    pub team_id: TeamId,
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub command: TeamCommandDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamCommandResult {
    pub team: TeamDto,
    pub replayed: bool,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunDto {
    pub run_id: TeamRunId,
    pub team_id: TeamId,
    #[ts(type = "number")]
    pub team_revision: u64,
    pub members: Vec<TeamMemberDto>,
    pub coordinator_id: AgentId,
    pub session_id: SessionId,
    pub coordinator_thread_id: ThreadId,
    pub objective: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamRunStartParams {
    pub command_id: CommandId,
    pub run_id: TeamRunId,
    pub team_id: TeamId,
    #[ts(type = "number")]
    pub expected_team_revision: u64,
    pub objective: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunStartResult {
    pub run: TeamRunDto,
    pub replayed: bool,
}

/// Links an existing coordinator Thread and its Session to a Team task.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamRunAttachParams {
    pub command_id: CommandId,
    pub run_id: TeamRunId,
    pub team_id: TeamId,
    #[ts(type = "number")]
    pub expected_team_revision: u64,
    pub session_id: SessionId,
    pub coordinator_thread_id: ThreadId,
    pub objective: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamRunReadParams {
    pub run_id: TeamRunId,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunReadResult {
    pub run: TeamRunDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamRunListParams {
    pub team_id: TeamId,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamRunListResult {
    pub runs: Vec<TeamRunDto>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamMessageDto {
    pub message_id: AgentMessageId,
    pub team_id: TeamId,
    pub run_id: Option<TeamRunId>,
    pub sender_id: AgentId,
    pub receiver_id: Option<AgentId>,
    pub text: String,
    #[ts(type = "number")]
    pub created_at_unix_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamMessagePostParams {
    pub message_id: AgentMessageId,
    pub team_id: TeamId,
    pub run_id: Option<TeamRunId>,
    pub sender_id: AgentId,
    pub receiver_id: Option<AgentId>,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamMessagePostResult {
    pub message: TeamMessageDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TeamMessageListParams {
    pub team_id: TeamId,
    pub reader_id: AgentId,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct TeamMessageListResult {
    pub messages: Vec<TeamMessageDto>,
}

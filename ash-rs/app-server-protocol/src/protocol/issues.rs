use crate::JsonSchema;
use crate::TS;
use crate::protocol::common::CommandId;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IssueConfigDto {
    pub auto_refresh_minutes: u32,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IssueConfigureParams {
    pub command_id: CommandId,
    #[ts(type = "number")]
    pub expected_revision: u64,
    pub config: IssueConfigDto,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueRepository {
    pub host: String,
    pub owner: String,
    pub name: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueSummary {
    pub labels: Vec<String>,
    pub assignees: Vec<String>,
    #[ts(type = "number")]
    pub number: u64,
    pub title: String,
    pub url: String,
    pub updated_at: String,
    pub state: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum IssueState {
    Open,
    Closed,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum IssueListMode {
    Cached,
    Auto,
    Refresh,
    ClearCache,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueListParams {
    pub state: IssueState,
    pub page: u32,
    pub query: String,
    pub mode: IssueListMode,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueListResult {
    pub repository: IssueRepository,
    pub issues: Vec<IssueSummary>,
    pub next_page: Option<u32>,
    pub cached: bool,
    #[ts(type = "number")]
    pub fetched_at: u64,
    pub refresh_after_seconds: Option<u32>,
    pub notice: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueReadParams {
    pub repository: IssueRepository,
    #[ts(type = "number")]
    pub number: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueReadResult {
    pub issue: IssueSummary,
    pub body: String,
    pub comments: Vec<IssueComment>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct IssueComment {
    pub body: String,
    pub url: String,
    pub updated_at: String,
}

use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IssueReporterContext {
    pub report_issue_url: String,
    pub version: String,
    pub os: String,
    pub arch: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IssueReporterSearchParams {
    #[schemars(length(min = 1, max = 128))]
    pub operation_id: String,
    #[schemars(length(min = 1, max = 256))]
    pub title: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IssueReporterIssue {
    #[ts(type = "number")]
    pub number: u64,
    pub url: String,
    pub title: String,
    pub state: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IssueReporterSearchResult {
    pub issues: Vec<IssueReporterIssue>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IssueReporterSubmitParams {
    #[schemars(length(min = 1, max = 256))]
    pub title: String,
    #[schemars(length(min = 1, max = 65536))]
    pub body: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IssueReporterCancelParams {
    #[schemars(length(min = 1, max = 128))]
    pub operation_id: String,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum IssueReporterCancelStatus {
    Requested,
    AlreadyRequested,
    Completed,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IssueReporterCancelResult {
    pub status: IssueReporterCancelStatus,
}

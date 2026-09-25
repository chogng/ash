use crate::JsonSchema;
use crate::TS;
use serde::Deserialize;
use serde::Serialize;

/// Browser listener requested through the authenticated local launch connection.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebLaunchOptions {
    pub lease_id: [u8; 32],
    pub port: u16,
    pub assets: Option<std::path::PathBuf>,
    pub origin: Option<String>,
}

/// Private launcher output. The ticket is exchanged once, never sent in a URL query.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct WebListenInfo {
    pub endpoint: String,
    pub ticket: String,
    pub pid: u32,
}

/// Authenticated browser session and its server-selected workspace.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct WebSessionInfo {
    pub token: String,
    pub workspace_id: String,
    pub workspace_root: String,
}

/// A browser may inspect directory names before choosing a workspace grant.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct WebWorkspaceListRequest {
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct WebWorkspaceDirectory {
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct WebWorkspaceListResult {
    pub path: String,
    pub parent: Option<String>,
    pub directories: Vec<WebWorkspaceDirectory>,
}

/// Approval is a distinct user action after the server has identified the selected directory.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct WebWorkspaceOpenRequest {
    pub path: String,
    pub approved: bool,
}

#[cfg(test)]
#[path = "web_tests.rs"]
mod tests;

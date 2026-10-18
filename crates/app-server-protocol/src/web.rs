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

/// Private inbound-host helper record; the relay listener is reachable only through SSH.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct RemoteTunnelHostInfo {
    pub relay_host: String,
    pub relay_port: u16,
    pub web: WebListenInfo,
}

/// Authenticated browser session and its server-selected workspace.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct WebSessionInfo {
    pub token: String,
    pub workspace_id: String,
    pub workspace_root: String,
    /// Current listener-owned workspace projection, restored after page reload.
    pub workspace: WebWorkspaceState,
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

/// Workspace projection; authorization stays in the listener's isolated runtime.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct WebWorkspaceState {
    pub id: String,
    pub configuration: Option<String>,
    pub folders: Vec<WebWorkspaceFolder>,
}

#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub struct WebWorkspaceFolder {
    pub id: String,
    pub path: String,
    pub name: Option<String>,
}

/// Explicit workspace replacement through the authenticated browser control boundary.
#[derive(Clone, Debug, Deserialize, JsonSchema, Serialize, TS)]
#[serde(tag = "operation", rename_all = "camelCase", deny_unknown_fields)]
#[ts(rename_all = "camelCase")]
pub enum WebWorkspaceUpdateRequest {
    #[serde(rename_all = "camelCase")]
    Apply {
        transaction: String,
        configuration: Option<String>,
        folders: Vec<WebWorkspaceDirectory>,
        approved: bool,
    },
    #[serde(rename_all = "camelCase")]
    Finish { transaction: String, accepted: bool },
}

#[cfg(test)]
#[path = "web_tests.rs"]
mod tests;

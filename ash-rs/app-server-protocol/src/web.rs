use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Browser listener requested through the authenticated local launch connection.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WebLaunchOptions {
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

#[cfg(test)]
#[path = "web_tests.rs"]
mod tests;

use super::Client;
use crate::RequestError;
use async_utils::CancellationToken;
use http_client::HttpHeader;
use serde::Deserialize;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct ConfigBundle {
    pub config_toml: Option<DeliveredToml>,
    pub requirements_toml: Option<DeliveredToml>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct DeliveredToml {
    pub enterprise_managed: Option<Vec<TomlFragment>>,
    pub managed_layers: Option<ManagedLayers>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct ManagedLayers {
    pub baseline: Vec<TomlFragment>,
    pub system_overlay: Vec<TomlFragment>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct TomlFragment {
    pub id: String,
    pub name: String,
    pub contents: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct UserSettings {
    /// Absence remains unknown; runtime policy belongs to the consumer.
    pub commit_attribution_enabled: Option<bool>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct WorkspaceMessages {
    pub messages: Vec<WorkspaceMessage>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq)]
pub struct WorkspaceMessage {
    pub message_id: String,
    pub message_type: String,
    pub message_body: String,
    pub created_at: Option<String>,
    pub archived_at: Option<String>,
}

impl Client<'_> {
    pub fn read_config_bundle(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<ConfigBundle, RequestError> {
        self.http
            .get(self.endpoint(&["config", "bundle"])?, &[], cancellation)
    }

    pub fn read_user_settings(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<UserSettings, RequestError> {
        self.http.get(
            self.endpoint(&["settings", "user"])?,
            &[HttpHeader::new("Cache-Control", "no-cache, no-store")],
            cancellation,
        )
    }

    pub fn list_workspace_messages(
        &self,
        cancellation: &CancellationToken,
    ) -> Result<WorkspaceMessages, RequestError> {
        self.http.get(
            self.endpoint(&["workspace-messages"])?,
            &[HttpHeader::new("Cache-Control", "no-store")],
            cancellation,
        )
    }
}

#[cfg(test)]
#[path = "config_tests.rs"]
mod tests;

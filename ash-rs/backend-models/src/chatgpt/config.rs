//! ChatGPT configuration delivery HTTP contracts.

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

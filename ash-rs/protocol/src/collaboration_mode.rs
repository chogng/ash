use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Selects the approach an Agent should use for one user-requested Turn.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum CollaborationMode {
    #[default]
    Agent,
    Plan,
    Debug,
    Multitask,
    Ask,
}

impl CollaborationMode {
    pub const fn is_agent(&self) -> bool {
        matches!(self, Self::Agent)
    }

    /// Delegated execution retains analysis constraints without recursively making every worker
    /// a Multitask coordinator. Role and capability ceilings are resolved independently.
    pub const fn delegated(self) -> Self {
        match self {
            Self::Agent | Self::Multitask => Self::Agent,
            Self::Plan => Self::Plan,
            Self::Debug => Self::Debug,
            Self::Ask => Self::Ask,
        }
    }
}

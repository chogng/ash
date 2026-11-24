use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// The default execution or the approach selected by a task command.
#[derive(
    Clone,
    Copy,
    Debug,
    Default,
    Deserialize,
    Eq,
    JsonSchema,
    Ord,
    PartialEq,
    PartialOrd,
    Serialize,
    TS,
)]
#[serde(rename_all = "camelCase")]
pub enum TaskExecution {
    #[default]
    Agent,
    Plan,
    Debug,
    Swarm,
    Ask,
}

impl TaskExecution {
    pub const ALL: [Self; 5] = [Self::Agent, Self::Plan, Self::Debug, Self::Swarm, Self::Ask];

    pub const fn is_analysis(self) -> bool {
        matches!(self, Self::Plan | Self::Ask)
    }

    pub const fn is_default(&self) -> bool {
        matches!(self, Self::Agent)
    }

    /// Delegated execution retains analysis constraints without recursively making every worker
    /// a Swarm coordinator. Role and capability ceilings are resolved independently.
    pub const fn delegated(self) -> Self {
        match self {
            Self::Agent | Self::Swarm => Self::Agent,
            Self::Plan => Self::Plan,
            Self::Debug => Self::Debug,
            Self::Ask => Self::Ask,
        }
    }
}

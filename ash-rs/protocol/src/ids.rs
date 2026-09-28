use std::fmt;

macro_rules! identifier {
    ($(#[$attribute:meta])* $name:ident, $label:literal) => {
        $(#[$attribute])*
        #[derive(
            Clone,
            Debug,
            Eq,
            Hash,
            schemars::JsonSchema,
            Ord,
            PartialEq,
            PartialOrd,
            serde::Serialize,
            ts_rs::TS,
        )]
        pub struct $name(#[schemars(length(min = 1))] String);

        impl $name {
            pub fn new(value: impl Into<String>) -> Result<Self, super::InvalidIdentifier> {
                super::validate_identifier(value, $label).map(Self)
            }

            pub fn as_str(&self) -> &str {
                &self.0
            }
        }

        impl std::fmt::Display for $name {
            fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str(&self.0)
            }
        }

        impl<'de> serde::Deserialize<'de> for $name {
            fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
            where
                D: serde::Deserializer<'de>,
            {
                Self::new(<String as serde::Deserialize>::deserialize(deserializer)?)
                    .map_err(serde::de::Error::custom)
            }
        }
    };
}

mod agent_id;
mod agent_join_id;
mod agent_message_id;
mod command_id;
mod context_checkpoint_id;
mod delegation_id;
mod item_id;
mod model_invocation_id;
mod project_id;
mod request_id;
mod session_id;
mod team_id;
mod team_run_id;
mod thread_id;
mod tool_call_id;
mod turn_id;

pub use agent_id::AgentId;
pub use agent_join_id::AgentJoinId;
pub use agent_message_id::AgentMessageId;
pub use command_id::CommandId;
pub use context_checkpoint_id::ContextCheckpointId;
pub use delegation_id::DelegationId;
pub use item_id::ItemId;
pub use model_invocation_id::ModelInvocationId;
pub use project_id::ProjectId;
pub use request_id::RequestId;
pub use session_id::SessionId;
pub use team_id::TeamId;
pub use team_run_id::TeamRunId;
pub use thread_id::ThreadId;
pub use tool_call_id::ToolCallId;
pub use turn_id::TurnId;

/// Rejection reason returned when an externally supplied protocol identity is invalid.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InvalidIdentifier {
    kind: &'static str,
}

impl InvalidIdentifier {
    fn empty(kind: &'static str) -> Self {
        Self { kind }
    }
}

impl fmt::Display for InvalidIdentifier {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{} must not be empty", self.kind)
    }
}

impl std::error::Error for InvalidIdentifier {}

pub(crate) fn validate_identifier(
    value: impl Into<String>,
    kind: &'static str,
) -> Result<String, InvalidIdentifier> {
    let value = value.into();
    if value.trim().is_empty() {
        return Err(InvalidIdentifier::empty(kind));
    }
    Ok(value)
}

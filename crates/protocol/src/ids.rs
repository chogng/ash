//! Stable execution and interaction identifiers with shared boundary validation.
//! Provider, model, and connection identities are defined separately in `model/identity.rs`.

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
            pub fn new(value: impl Into<String>) -> Result<Self, InvalidIdentifier> {
                validate_identifier(value, $label).map(Self)
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

identifier!(
    /// Persistent Agent identity shared by its independent execution branches.
    AgentId,
    "agent ID"
);

identifier!(
    /// Stable identity for one durable parent-side Agent join.
    AgentJoinId,
    "Agent join ID"
);

identifier!(
    /// Stable identity used to deduplicate one cross-Thread Agent message.
    AgentMessageId,
    "agent message ID"
);

identifier!(
    /// Stable caller-supplied identity for one retry-safe product command.
    CommandId,
    "command ID"
);

identifier!(
    /// Stable identity for one durable context-compaction checkpoint.
    ContextCheckpointId,
    "context checkpoint ID"
);

identifier!(
    /// Stable identity for one parent-to-child Agent delegation.
    DelegationId,
    "delegation ID"
);

identifier!(
    /// Stable identity for one durable transcript item within a Turn.
    ItemId,
    "item ID"
);

identifier!(
    /// Stable identity for one request sent to a model provider.
    ModelInvocationId,
    "model invocation ID"
);

identifier!(
    /// Stable identity for one long-lived multi-root project catalog.
    ProjectId,
    "project ID"
);

identifier!(
    /// Stable identity for one outstanding bidirectional Agent interaction.
    RequestId,
    "request ID"
);

identifier!(
    /// Stable identity for one product-level Agent session.
    SessionId,
    "session ID"
);

identifier!(
    /// Stable identity of a long-lived Agent Team.
    TeamId,
    "Team ID"
);

identifier!(
    /// Stable identity of one Team task across retries and restarts.
    TeamRunId,
    "Team run ID"
);

identifier!(
    /// Stable identity for one independently ordered Agent execution branch.
    ThreadId,
    "thread ID"
);

identifier!(
    /// Stable identity for one model-requested tool call and its eventual result.
    ToolCallId,
    "tool call ID"
);

identifier!(
    /// Stable identity for one user-intent-driven Agent execution within a Thread.
    TurnId,
    "turn ID"
);

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

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Deserializer;
use serde::Serialize;
use serde::Serializer;
use serde::de::Visitor;
use std::cell::Cell;
use std::fmt;
use ts_rs::TS;

thread_local! {
    static LEGACY_HISTORY_ENCODING: Cell<bool> = const { Cell::new(false) };
}

/// Selects the approach an Agent should use for one user-requested Turn.
#[derive(Clone, Copy, Debug, Default, Eq, JsonSchema, Ord, PartialEq, PartialOrd, TS)]
#[serde(rename_all = "camelCase")]
pub enum AgentMode {
    #[default]
    Agent,
    Plan,
    Debug,
    Swarm,
    Ask,
}

impl AgentMode {
    pub const ALL: [Self; 5] = [Self::Agent, Self::Plan, Self::Debug, Self::Swarm, Self::Ask];

    /// Runs a synchronous history codec operation with the original Multitask ID,
    /// including mode keys embedded in frozen model guidance. The scope also preserves
    /// the bytes used by existing history and context-seed digests.
    pub fn with_legacy_history_encoding<T>(codec: impl FnOnce() -> T) -> T {
        struct RestoreEncoding(bool);
        impl Drop for RestoreEncoding {
            fn drop(&mut self) {
                LEGACY_HISTORY_ENCODING.set(self.0);
            }
        }
        let _encoding = RestoreEncoding(LEGACY_HISTORY_ENCODING.replace(true));
        codec()
    }

    const fn id(self) -> &'static str {
        match self {
            Self::Agent => "agent",
            Self::Plan => "plan",
            Self::Debug => "debug",
            Self::Swarm => "swarm",
            Self::Ask => "ask",
        }
    }

    pub const fn is_analysis(self) -> bool {
        matches!(self, Self::Plan | Self::Ask)
    }

    pub const fn is_agent(&self) -> bool {
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

impl Serialize for AgentMode {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let id = if *self == Self::Swarm && LEGACY_HISTORY_ENCODING.get() {
            "multitask"
        } else {
            self.id()
        };
        serializer.serialize_unit_variant("AgentMode", *self as u32, id)
    }
}

impl<'de> Deserialize<'de> for AgentMode {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ModeVisitor;
        impl<'de> Visitor<'de> for ModeVisitor {
            type Value = AgentMode;

            fn expecting(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
                formatter.write_str("an Agent mode")
            }

            fn visit_str<E: serde::de::Error>(self, value: &str) -> Result<AgentMode, E> {
                if value == "multitask" && LEGACY_HISTORY_ENCODING.get() {
                    return Ok(AgentMode::Swarm);
                }
                AgentMode::ALL
                    .into_iter()
                    .find(|mode| mode.id() == value)
                    .ok_or_else(|| {
                        E::unknown_variant(value, &["agent", "plan", "debug", "swarm", "ask"])
                    })
            }
        }
        deserializer.deserialize_str(ModeVisitor)
    }
}

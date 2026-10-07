use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// How a Thread preserves working state when ordinary input reaches its pressure boundary.
/// Both strategies keep the durable source history; a checkpoint only changes model input.
#[derive(Clone, Debug, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "mode",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
#[schemars(deny_unknown_fields)]
pub enum ContextCompactionPolicy {
    Summary {
        #[serde(default = "default_summary_tokens")]
        #[schemars(range(min = 1, max = 1000000))]
        summary_tokens: u32,
        #[serde(default = "default_recent_tokens")]
        #[schemars(range(min = 1, max = 1000000))]
        recent_tokens: u32,
    },
    Handoff {
        #[serde(default = "default_buffer_tokens")]
        #[schemars(range(min = 1, max = 1000000))]
        buffer_tokens: u32,
        #[serde(default = "default_summary_tokens")]
        #[schemars(range(min = 1, max = 1000000))]
        state_tokens: u32,
    },
}

const fn default_summary_tokens() -> u32 {
    8_192
}
const fn default_recent_tokens() -> u32 {
    16_384
}
const fn default_buffer_tokens() -> u32 {
    16_384
}

impl Default for ContextCompactionPolicy {
    fn default() -> Self {
        Self::Summary {
            summary_tokens: default_summary_tokens(),
            recent_tokens: default_recent_tokens(),
        }
    }
}

impl ContextCompactionPolicy {
    /// Omitting this value preserves the command encoding and digests of older journals.
    pub fn is_default(&self) -> bool {
        self == &Self::default()
    }
    /// Validates persisted policy independently of a model's later resolved capacity.
    pub fn validate(&self) -> Result<(), &'static str> {
        let valid = |tokens: u32| (1..=1_000_000).contains(&tokens);
        match *self {
            Self::Summary {
                summary_tokens,
                recent_tokens,
            } if valid(summary_tokens) && valid(recent_tokens) => Ok(()),
            Self::Handoff {
                buffer_tokens,
                state_tokens,
            } if valid(buffer_tokens) && valid(state_tokens) && state_tokens <= buffer_tokens => {
                Ok(())
            }
            Self::Summary { .. } => {
                Err("context summaryTokens and recentTokens must be between 1 and 1000000")
            }
            Self::Handoff { .. } => Err(
                "context stateTokens must be positive and no greater than bufferTokens (maximum 1000000)",
            ),
        }
    }
}

impl<'de> Deserialize<'de> for ContextCompactionPolicy {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        #[derive(Deserialize)]
        #[serde(
            tag = "mode",
            rename_all = "camelCase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        enum StrictPolicy {
            Summary {
                #[serde(default = "default_summary_tokens")]
                summary_tokens: u32,
                #[serde(default = "default_recent_tokens")]
                recent_tokens: u32,
            },
            Handoff {
                #[serde(default = "default_buffer_tokens")]
                buffer_tokens: u32,
                #[serde(default = "default_summary_tokens")]
                state_tokens: u32,
            },
        }

        Ok(match StrictPolicy::deserialize(deserializer)? {
            StrictPolicy::Summary {
                summary_tokens,
                recent_tokens,
            } => Self::Summary {
                summary_tokens,
                recent_tokens,
            },
            StrictPolicy::Handoff {
                buffer_tokens,
                state_tokens,
            } => Self::Handoff {
                buffer_tokens,
                state_tokens,
            },
        })
    }
}

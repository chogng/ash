use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Non-negative Unix milliseconds, restricted to dates through year 9999.
#[derive(Clone, Copy, Debug, Eq, JsonSchema, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[ts(type = "number")]
pub struct UnixMillis(#[schemars(range(max = 253_402_300_799_999_u64))] u64);

impl UnixMillis {
    pub const MAX: u64 = 253_402_300_799_999;

    pub fn new(value: u64) -> Result<Self, &'static str> {
        if value > Self::MAX {
            return Err("timestamp exceeds the supported calendar range");
        }
        Ok(Self(value))
    }

    pub fn get(self) -> u64 {
        self.0
    }
}

impl<'de> Deserialize<'de> for UnixMillis {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Self::new(u64::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AutomationSchedule {
    Once {
        at: UnixMillis,
    },
    Interval {
        anchor: UnixMillis,
        #[ts(type = "number")]
        minutes: u32,
    },
    Weekly {
        timezone: String,
        /// ISO weekdays: Monday is 1, Sunday is 7. All seven days means daily.
        weekdays: Vec<u8>,
        hour: u8,
        minute: u8,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum AutomationSession {
    New,
    Continue {
        session_id: crate::SessionId,
        thread_id: crate::ThreadId,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AutomationDefinition {
    pub title: String,
    pub prompt: String,
    /// Explicit local execution directory; never resolved from the active window.
    pub directory: String,
    pub session: AutomationSession,
    pub schedule: AutomationSchedule,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum AutomationStatus {
    Enabled,
    Paused,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Automation {
    pub id: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub definition: AutomationDefinition,
    pub status: AutomationStatus,
    pub created_at: UnixMillis,
    pub updated_at: UnixMillis,
    pub next_run_at: Option<UnixMillis>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum AutomationRunStatus {
    Pending,
    Running,
    NeedsInput,
    Stopping,
    Completed,
    Failed,
    Stopped,
    Skipped,
}

impl AutomationRunStatus {
    pub fn is_finished(self) -> bool {
        matches!(
            self,
            Self::Completed | Self::Failed | Self::Stopped | Self::Skipped
        )
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct AutomationRun {
    pub id: String,
    pub automation_id: String,
    #[ts(type = "number")]
    pub revision: u64,
    pub definition: AutomationDefinition,
    pub scheduled_at: UnixMillis,
    pub created_at: UnixMillis,
    pub started_at: Option<UnixMillis>,
    pub finished_at: Option<UnixMillis>,
    pub status: AutomationRunStatus,
    pub session_id: Option<crate::SessionId>,
    pub thread_id: Option<crate::ThreadId>,
    pub turn_id: Option<crate::TurnId>,
    pub message: Option<String>,
}

use crate::UnixMillis;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Explicit model-context policy; it does not control timers or execution deadlines.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TimeContextMode {
    Off,
    #[default]
    Date,
    Time,
}

/// Identifies whose calendar is being reported, without assuming the host is the user.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TimeZoneOrigin {
    Host,
    Configured,
}

/// Immutable clock facts used for an input reference or one prepared model request.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeContext {
    pub sampled_at_unix_ms: UnixMillis,
    /// Offset resolved when sampled; historical rendering does not use a newer tzdb's rules.
    #[schemars(range(min = -86399, max = 86399))]
    pub utc_offset_seconds: i32,
    #[schemars(length(min = 1, max = 128))]
    pub time_zone: String,
    pub origin: TimeZoneOrigin,
    pub mode: TimeContextMode,
}

use serde::Deserialize;
use serde::Serialize;
use serde_json::Value;

/// Automatic readers share the provider's result; an explicit retry starts a new attempt.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ManagedSettingsReadMode {
    Automatic,
    Retry,
}

/// Safe failure categories shared by all consumers of one exact account grant.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ManagedSettingsFailure {
    AuthenticationRequired,
    PermissionDenied,
    RateLimited,
    UpdateRequired,
    InvalidResponse,
    Unavailable,
    TimedOut,
}

/// Provider-owned refresh history. Times are milliseconds since the Unix epoch.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ManagedSettingsRefresh {
    Ready {
        last_attempt_at: u64,
        last_success_at: u64,
    },
    Failed {
        last_attempt_at: u64,
        last_success_at: Option<u64>,
        failure: ManagedSettingsFailure,
    },
}

/// Last successful raw settings and the latest refresh result for one grant.
/// Client registries own UI projections; this snapshot grants no execution permission.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
pub struct ManagedSettingsSnapshot {
    pub settings: Option<Value>,
    pub refresh: ManagedSettingsRefresh,
}

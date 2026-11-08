use ash_protocol::SessionId;
use ash_protocol::ThreadId;
use serde::Deserialize;
use serde::Serialize;

/// Logical file sizes under the local profile and configured worktree root.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(any(test, feature = "export"), derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct StorageOverview {
    pub profile_root: String,
    pub worktree_root: String,
    #[cfg_attr(any(test, feature = "export"), ts(type = "number"))]
    pub worktree_bytes: u64,
    #[cfg_attr(any(test, feature = "export"), ts(type = "number"))]
    pub session_bytes: u64,
    #[cfg_attr(any(test, feature = "export"), ts(type = "number"))]
    pub other_bytes: u64,
    /// False when part of either root could not be read.
    pub complete: bool,
    pub worktrees: Vec<StorageWorktree>,
}
/// A local archived Thread with a managed Git checkout.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(any(test, feature = "export"), derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase")]
pub struct StorageWorktree {
    pub title: String,
    pub identity: StorageWorktreeCleanupParams,
    #[cfg_attr(any(test, feature = "export"), ts(type = "number | null"))]
    pub size_bytes: Option<u64>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[cfg_attr(any(test, feature = "export"), derive(schemars::JsonSchema, ts_rs::TS))]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StorageWorktreeCleanupParams {
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    #[cfg_attr(any(test, feature = "export"), ts(type = "number"))]
    pub expected_sequence: u64,
    pub checkout_root: String,
}

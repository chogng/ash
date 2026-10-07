//! Immutable history prefixes and exact message/workspace checkpoints used by forks and restore.

use crate::ContentDigest;
use crate::ItemId;
use crate::ThreadId;
use crate::TurnId;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Immutable original event prefix. Its records retain their original Thread IDs and sequences.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct HistoryPrefixRef {
    pub digest: ContentDigest,
    pub source_thread_id: ThreadId,
    #[ts(type = "number")]
    pub source_sequence: u64,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MessageBoundary {
    Before,
    After,
}

/// Exact immutable Git version retained for one repository at a message boundary.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryCheckpoint {
    pub repository_id: String,
    pub relative_path: String,
    pub tree_id: String,
    pub reference: String,
    pub git_directory: String,
    pub target_branch: Option<String>,
    pub target_head: String,
    pub target_unborn: bool,
    pub target_reference: String,
}

/// File restoration evidence. Missing coverage is explicit and cannot restore current files.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum WorkspaceCheckpoint {
    NoFiles,
    Git {
        source_dir_id: String,
        repositories: Vec<RepositoryCheckpoint>,
    },
    Unavailable {
        reason: String,
    },
}

/// A committed message's original location, independent of the branch displaying it.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MessageCheckpoint {
    pub item_id: ItemId,
    pub turn_id: TurnId,
    pub source_thread_id: ThreadId,
    #[ts(type = "number")]
    pub source_sequence: u64,
    pub workspace: WorkspaceCheckpoint,
    /// Includes trailing lifecycle facts from the same atomic message commit.
    #[ts(type = "number")]
    pub after_sequence: u64,
}

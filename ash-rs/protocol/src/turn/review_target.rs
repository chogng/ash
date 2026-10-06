//! The code change selected for a review Turn; unrelated to permission-risk review.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Selects the code change that one review Turn must inspect.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ReviewTarget {
    /// Reviews tracked and untracked changes in the current working tree.
    UncommittedChanges,
    /// Reviews changes relative to the merge base with a named branch.
    BaseBranch { branch: String },
    /// Reviews one commit.
    Commit {
        sha: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional = nullable)]
        title: Option<String>,
    },
    /// Reviews a caller-defined target described in natural language.
    Custom { instructions: String },
}

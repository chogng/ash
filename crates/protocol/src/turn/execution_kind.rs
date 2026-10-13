//! Execution purpose frozen for a Turn, such as an ordinary task or code review.

use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// Product execution purpose frozen for one Agent Turn.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum TurnKind {
    /// Ordinary coding and task execution.
    #[default]
    Coding,
    /// Read-only code review with its own rubric and output contract.
    Review,
    /// One explicit consultation, without a main-model inference.
    Advisor,
    /// An explicit local process command, without a model inference.
    Shell,
    /// One bound tool selected by a product action, without a model inference.
    Tool,
    /// An explicit context compaction, without a user-message inference.
    ContextCompaction,
}

use crate::ContentDigest;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::path::PathBuf;
use ts_rs::TS;

/// Authority that owns one Ash Instruction file.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum InstructionSource {
    User,
    Directory { root: PathBuf },
}

/// Exact catalog entry selected by a user for one Turn.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, Ord, PartialEq, PartialOrd, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct InstructionRef {
    pub source: InstructionSource,
    pub relative_path: PathBuf,
    pub digest: ContentDigest,
}

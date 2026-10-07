//! Stable build identity contract shared by protocols and diagnostics.

use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;

#[derive(
    Clone, Debug, Eq, PartialEq, Serialize, serde::Deserialize, schemars::JsonSchema, ts_rs::TS,
)]
#[serde(rename_all = "camelCase")]
pub struct BuildInfo {
    pub version: String,
    pub commit: Option<String>,
    pub target: String,
    pub build_id: Option<String>,
}

impl BuildInfo {
    /// Combines product-owned provenance with the version and target of this build.
    /// Git identity is supplied by the host so protocol consumers do not recompile on commits.
    pub fn new(commit: Option<&str>, build_id: Option<&str>) -> Self {
        let target = TARGET;
        Self {
            version: env!("CARGO_PKG_VERSION").into(),
            commit: commit.map(str::to_owned),
            target: target.into(),
            build_id: build_id.map(str::to_owned).or_else(|| {
                commit.map(|commit| {
                    format!(
                        "sha256:{:x}",
                        Sha256::digest(format!("git:{commit}:{target}"))
                    )
                })
            }),
        }
    }
}

pub const VERSION: &str = env!("CARGO_PKG_VERSION");
pub const TARGET: &str = env!("ASH_COMPILED_TARGET");

#[cfg(test)]
#[path = "build_info_tests.rs"]
mod tests;

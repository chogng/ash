//! Durable task packages and links between independent execution histories.
//! Queue and Core remain the only owners of message delivery and Turn execution state.
#[cfg(feature = "runtime")]
mod runtime;
#[cfg(feature = "runtime")]
mod store;
#[cfg(feature = "runtime")]
pub use runtime::Peer;
#[cfg(feature = "runtime")]
pub use runtime::PeerFuture;
#[cfg(feature = "runtime")]
pub use runtime::Runtime;
#[cfg(feature = "runtime")]
pub use runtime::RuntimeServices;
#[cfg(feature = "runtime")]
pub use runtime::SendTask;
#[cfg(feature = "runtime")]
pub use store::OutgoingTask;
#[cfg(feature = "runtime")]
pub use store::Store;

use protocol::ContentDigest;
use protocol::SessionId;
use protocol::ThreadId;
use protocol::TurnStatus;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use ts_rs::TS;

pub const MAX_PACK_BYTES: usize = 64 * 1024 * 1024;
pub const MAX_TEXT_BYTES: usize = 64 * 1024;

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceTask {
    pub profile_id: ContentDigest,
    pub session_id: SessionId,
    pub thread_id: ThreadId,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CodeSnapshot {
    pub head: String,
    pub tree: String,
    pub prerequisite: Option<String>,
    /// Base64 Git pack. Transport size is bounded before decoding.
    pub pack: String,
    pub pack_digest: ContentDigest,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskPackage {
    pub delivery_id: ContentDigest,
    pub source: SourceTask,
    pub title: String,
    pub instructions: String,
    /// Explicit handoff context and source acceptance evidence; never hidden reasoning.
    pub context: String,
    pub code: CodeSnapshot,
}

impl TaskPackage {
    pub fn validate(&self) -> Result<()> {
        if self.title.trim().is_empty()
            || self.title.len() > 256
            || self.instructions.trim().is_empty()
            || self.instructions.len() > MAX_TEXT_BYTES
            || self.context.len() > MAX_TEXT_BYTES
            || self.code.pack.len() > MAX_PACK_BYTES.div_ceil(3) * 4
        {
            return Err(Error::Invalid(
                "task package exceeds its text or code limits".into(),
            ));
        }
        for id in [&self.code.head, &self.code.tree]
            .into_iter()
            .chain(self.code.prerequisite.iter())
        {
            if !matches!(id.len(), 40 | 64) || !id.bytes().all(|b| b.is_ascii_hexdigit()) {
                return Err(Error::Invalid("invalid Git object identity".into()));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskReceipt {
    pub delivery_id: ContentDigest,
    pub source: SourceTask,
    pub session_id: SessionId,
    pub thread_id: ThreadId,
    pub directory: String,
    pub head: String,
    pub tree: String,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskReadParams {
    pub delivery_id: ContentDigest,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TaskReport {
    pub receipt: TaskReceipt,
    pub queue_status: queue::QueueStatus,
    pub turn_id: Option<protocol::TurnId>,
    pub turn_status: Option<TurnStatus>,
    pub turn_error: Option<protocol::StableTurnError>,
    pub message: Option<String>,
    pub message_truncated: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SnapshotInfo {
    pub head: String,
}

pub fn digest(bytes: &[u8]) -> ContentDigest {
    ContentDigest::new(format!("sha256:{:x}", sha2::Sha256::digest(bytes)))
        .expect("SHA256 identity")
}

#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("{0}")]
    Runtime(String),
    #[error("{0}")]
    Invalid(String),
    #[error("task delivery identity conflicts with its saved package")]
    Conflict,
    #[error("task delivery was not found")]
    NotFound,
    #[error("task delivery storage: {0}")]
    Storage(String),
    #[error("task delivery encoding: {0}")]
    Encoding(#[from] serde_json::Error),
}
pub type Result<T> = std::result::Result<T, Error>;

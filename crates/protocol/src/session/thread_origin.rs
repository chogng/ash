//! How a Thread entered a session, including roots, forks, and delegated children.

use crate::DelegationId;
use crate::ThreadId;
use crate::TurnId;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

/// How a Thread entered a product Session.
#[derive(Clone, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum ThreadOrigin {
    #[default]
    Root,
    /// A fresh execution replacing an archived branch while retaining its Agent identity.
    Replacement {
        source_thread_id: ThreadId,
        #[ts(type = "number")]
        source_sequence: u64,
    },
    Fork {
        parent_thread_id: ThreadId,
        #[ts(type = "number")]
        parent_sequence: u64,
    },
    Rewind {
        parent_thread_id: ThreadId,
        before_turn_id: TurnId,
    },
    Message {
        parent_thread_id: ThreadId,
        #[ts(type = "number")]
        parent_sequence: u64,
        item_id: crate::ItemId,
        boundary: crate::MessageBoundary,
        workspace: crate::WorkspaceCheckpoint,
    },
    AgentSpawn {
        parent_thread_id: ThreadId,
        #[ts(type = "number")]
        parent_sequence: u64,
        delegation_id: DelegationId,
    },
}

impl ThreadOrigin {
    pub fn is_root(&self) -> bool {
        matches!(self, Self::Root)
    }
}

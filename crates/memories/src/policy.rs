use crate::MemoryMutationDisposition;
use crate::MemoryScope;
use ash_protocol::CommandId;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use ts_rs::TS;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MemoryReadMode {
    #[default]
    Disabled,
    FirstInvocation,
}

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MemoryWriteMode {
    #[default]
    Disabled,
    Enabled,
}

impl MemoryWriteMode {
    fn is_disabled(&self) -> bool {
        *self == Self::Disabled
    }
}

/// Scope-specific consent for automatic reading. Explicit management does not grant this consent.
#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryPolicy {
    pub scope: MemoryScope,
    #[ts(type = "number")]
    pub revision: u64,
    pub automatic_read: MemoryReadMode,
    pub model_write: MemoryWriteMode,
}

impl MemoryPolicy {
    pub fn disabled(scope: MemoryScope) -> Self {
        Self {
            scope,
            revision: 0,
            automatic_read: MemoryReadMode::Disabled,
            model_write: MemoryWriteMode::Disabled,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoryPolicyMutationResult {
    pub disposition: MemoryMutationDisposition,
    #[ts(type = "number")]
    pub catalog_revision: u64,
    pub policy: MemoryPolicy,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct UpdateMemoryPolicyRequest {
    pub command_id: CommandId,
    pub scope: MemoryScope,
    pub expected_revision: u64,
    pub automatic_read: MemoryReadMode,
    #[serde(skip_serializing_if = "MemoryWriteMode::is_disabled")]
    pub model_write: MemoryWriteMode,
}

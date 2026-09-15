use ash_file_access::DirId;
use ash_protocol::ProjectId;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::Serialize;
use std::fmt;
use ts_rs::TS;

const MAX_MEMORY_ID_BYTES: usize = 128;

#[derive(Clone, Debug, Eq, Hash, JsonSchema, Ord, PartialEq, PartialOrd, TS)]
#[schemars(transparent)]
#[ts(type = "string")]
pub struct MemoryId(
    #[schemars(length(min = 1, max = 128), regex(pattern = r"^[A-Za-z0-9._:-]+$"))] String,
);

impl MemoryId {
    pub fn new(value: impl Into<String>) -> Result<Self, InvalidMemoryId> {
        let value = value.into();
        if value.is_empty()
            || value.len() > MAX_MEMORY_ID_BYTES
            || !value.bytes().all(|byte| {
                byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b':')
            })
        {
            return Err(InvalidMemoryId);
        }
        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

impl fmt::Display for MemoryId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl Serialize for MemoryId {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        serializer.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for MemoryId {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        Self::new(String::deserialize(deserializer)?).map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct InvalidMemoryId;

impl fmt::Display for InvalidMemoryId {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(
            "Memory ID must contain 1..=128 ASCII letters, digits, '-', '_', '.', or ':'",
        )
    }
}

impl std::error::Error for InvalidMemoryId {}

#[derive(
    Clone, Debug, Deserialize, Eq, Hash, JsonSchema, Ord, PartialEq, PartialOrd, Serialize, TS,
)]
#[serde(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[ts(
    tag = "type",
    rename_all = "camelCase",
    rename_all_fields = "camelCase"
)]
pub enum MemoryScope {
    Profile,
    Project { project_id: ProjectId },
    Dir { dir_id: DirId },
}

impl MemoryScope {
    pub fn storage_key(&self) -> String {
        match self {
            Self::Profile => "profile".into(),
            Self::Project { project_id } => format!("project:{project_id}"),
            Self::Dir { dir_id } => format!("dir:{dir_id}"),
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase", rename_all_fields = "camelCase")]
#[ts(rename_all = "camelCase", rename_all_fields = "camelCase")]
pub enum MemorySource {
    User,
    Model {
        session_id: ash_protocol::SessionId,
        thread_id: ash_protocol::ThreadId,
        turn_id: ash_protocol::TurnId,
    },
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct Memory {
    pub memory_id: MemoryId,
    pub scope: MemoryScope,
    #[ts(type = "number")]
    pub revision: u64,
    pub title: String,
    pub body: String,
    pub source: MemorySource,
    #[ts(type = "number")]
    pub created_at_unix_ms: u64,
    #[ts(type = "number")]
    pub updated_at_unix_ms: u64,
}

impl Memory {
    pub fn summary(&self) -> MemorySummary {
        MemorySummary {
            memory_id: self.memory_id.clone(),
            scope: self.scope.clone(),
            revision: self.revision,
            title: self.title.clone(),
            source: self.source.clone(),
            created_at_unix_ms: self.created_at_unix_ms,
            updated_at_unix_ms: self.updated_at_unix_ms,
        }
    }
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemorySummary {
    pub memory_id: MemoryId,
    pub scope: MemoryScope,
    #[ts(type = "number")]
    pub revision: u64,
    pub title: String,
    pub source: MemorySource,
    #[ts(type = "number")]
    pub created_at_unix_ms: u64,
    #[ts(type = "number")]
    pub updated_at_unix_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoryListPage {
    #[ts(type = "number")]
    pub catalog_revision: u64,
    pub memories: Vec<MemorySummary>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchMatch {
    pub source: MemorySource,
    pub citation: crate::MemoryCitation,
    pub memory_id: MemoryId,
    pub scope: MemoryScope,
    #[ts(type = "number")]
    pub revision: u64,
    pub title: String,
    pub excerpt: String,
    #[ts(type = "number")]
    pub updated_at_unix_ms: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchPage {
    #[ts(type = "number")]
    pub catalog_revision: u64,
    pub matches: Vec<MemorySearchMatch>,
    pub next_cursor: Option<String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub enum MemoryMutationDisposition {
    Committed,
    Replayed,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoryMutationResult {
    pub disposition: MemoryMutationDisposition,
    #[ts(type = "number")]
    pub catalog_revision: u64,
    pub memory: Memory,
}

#[derive(Clone, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize, TS)]
#[serde(rename_all = "camelCase")]
pub struct MemoryDeleteResult {
    pub disposition: MemoryMutationDisposition,
    #[ts(type = "number")]
    pub catalog_revision: u64,
    pub memory_id: MemoryId,
    pub scope: MemoryScope,
    #[ts(type = "number")]
    pub deleted_revision: u64,
}

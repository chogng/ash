use crate::Memory;
use crate::MemoryAddCommit;
use crate::MemoryDeleteCommit;
use crate::MemoryDeleteResult;
use crate::MemoryId;
use crate::MemoryListPage;
use crate::MemoryMutationResult;
use crate::MemoryScope;
use crate::MemorySearchMatch;
use crate::MemorySearchPage;
use crate::MemorySource;
use crate::MemoryStore;
use crate::MemoryStoreError;
use crate::MemoryStoreListRequest;
use crate::MemoryStoreSearchRequest;
use ash_protocol::CommandId;
use async_utils::CancellationToken;
use base64::Engine;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::sync::Arc;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

const MAX_TITLE_CHARS: usize = 256;
const MAX_BODY_BYTES: usize = 16 * 1024;
const MAX_QUERY_CHARS: usize = 512;
const MAX_PAGE_SIZE: u32 = 50;
const MAX_EXCERPT_BYTES: usize = 1_024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AddMemoryRequest {
    pub command_id: CommandId,
    pub memory_id: MemoryId,
    pub scope: MemoryScope,
    pub title: String,
    pub body: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct UpdateMemoryRequest {
    pub command_id: CommandId,
    pub memory_id: MemoryId,
    pub scope: MemoryScope,
    pub expected_revision: u64,
    pub title: String,
    pub body: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct SaveModelMemoryRequest {
    pub command_id: CommandId,
    pub scope: MemoryScope,
    pub expected_revision: u64,
    pub title: String,
    pub body: String,
    pub session_id: ash_protocol::SessionId,
    pub thread_id: ash_protocol::ThreadId,
    pub turn_id: ash_protocol::TurnId,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DeleteMemoryRequest {
    pub command_id: CommandId,
    pub memory_id: MemoryId,
    pub scope: MemoryScope,
    pub expected_revision: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ReadMemoryRequest {
    pub memory_id: MemoryId,
    pub scope: MemoryScope,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ListMemoriesRequest {
    pub scope: MemoryScope,
    pub cursor: Option<String>,
    pub limit: u32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SearchMemoriesRequest {
    pub scope: MemoryScope,
    pub query: String,
    pub cursor: Option<String>,
    pub limit: u32,
}

pub struct Memories {
    pub(crate) store: Arc<dyn MemoryStore>,
}

impl Memories {
    pub fn new(store: Arc<dyn MemoryStore>) -> Self {
        Self { store }
    }

    pub fn policy(&self, scope: &MemoryScope) -> Result<crate::MemoryPolicy, MemoryError> {
        self.store.policy(scope).map_err(MemoryError::from)
    }

    pub fn update_policy(
        &self,
        request: crate::UpdateMemoryPolicyRequest,
    ) -> Result<crate::MemoryPolicyMutationResult, MemoryError> {
        let fingerprint = fingerprint(&request)?;
        self.store
            .update_policy(&crate::MemoryPolicyCommit {
                request,
                fingerprint,
            })
            .map_err(MemoryError::from)
    }

    /// Adds a user-authored Memory using the caller's cancellation token.
    /// Cancellation is accepted until the store acquires the write transaction and checks it.
    pub fn add_user_memory(
        &self,
        request: AddMemoryRequest,
        cancellation: &CancellationToken,
    ) -> Result<MemoryMutationResult, MemoryError> {
        validate_title(&request.title)?;
        validate_body(&request.body)?;
        let now = now_unix_ms()?;
        let fingerprint = fingerprint(&request)?;
        self.store
            .add(
                &MemoryAddCommit {
                    command_id: request.command_id,
                    fingerprint,
                    normalized_search_text: normalize_search(&format!(
                        "{}\n{}",
                        request.title, request.body
                    )),
                    memory: Memory {
                        memory_id: request.memory_id,
                        scope: request.scope,
                        revision: 1,
                        title: request.title,
                        body: request.body,
                        source: MemorySource::User,
                        created_at_unix_ms: now,
                        updated_at_unix_ms: now,
                    },
                },
                cancellation,
            )
            .map_err(MemoryError::from)
    }

    /// Updates a Memory as a user using the caller's cancellation token.
    /// Cancellation is accepted until the store acquires the write transaction and checks it.
    pub fn update_user_memory(
        &self,
        request: UpdateMemoryRequest,
        cancellation: &CancellationToken,
    ) -> Result<MemoryMutationResult, MemoryError> {
        validate_title(&request.title)?;
        validate_body(&request.body)?;
        if request.expected_revision == 0 {
            return Err(MemoryError::InvalidInput(
                "Memory update requires a positive revision".into(),
            ));
        }
        let fingerprint = fingerprint(&request)?;
        self.store
            .update(
                &crate::MemoryUpdateCommit {
                    command_id: request.command_id,
                    fingerprint,
                    memory_id: request.memory_id,
                    scope: request.scope,
                    expected_revision: request.expected_revision,
                    normalized_search_text: normalize_search(&format!(
                        "{}\n{}",
                        request.title, request.body
                    )),
                    title: request.title,
                    body: request.body,
                    source: MemorySource::User,
                    updated_at_unix_ms: now_unix_ms()?,
                },
                cancellation,
            )
            .map_err(MemoryError::from)
    }

    /// Saves a model-authored fact under a stable scope/title identity, with current write consent.
    /// Updating requires the observed revision and can never overwrite a user-owned Memory.
    /// Cancellation is accepted until the store acquires the write transaction and checks it.
    pub fn save_model_memory(
        &self,
        request: SaveModelMemoryRequest,
        cancellation: &CancellationToken,
    ) -> Result<MemoryMutationResult, MemoryError> {
        validate_title(&request.title)?;
        validate_body(&request.body)?;
        let fingerprint = fingerprint(&request)?;
        let identity = serde_json::to_vec(&(
            request.scope.storage_key(),
            request.title.trim().to_lowercase(),
        ))
        .map_err(|error| MemoryError::Storage(error.to_string()))?;
        let memory_id = MemoryId::new(format!("model-{:x}", Sha256::digest(identity)))
            .map_err(|error| MemoryError::InvalidInput(error.to_string()))?;
        let source = MemorySource::Model {
            session_id: request.session_id,
            thread_id: request.thread_id,
            turn_id: request.turn_id,
        };
        let now = now_unix_ms()?;
        let normalized_search_text =
            normalize_search(&format!("{}\n{}", request.title, request.body));
        if request.expected_revision == 0 {
            return self
                .store
                .add(
                    &MemoryAddCommit {
                        command_id: request.command_id,
                        fingerprint,
                        normalized_search_text,
                        memory: Memory {
                            memory_id,
                            scope: request.scope,
                            revision: 1,
                            title: request.title,
                            body: request.body,
                            source,
                            created_at_unix_ms: now,
                            updated_at_unix_ms: now,
                        },
                    },
                    cancellation,
                )
                .map_err(MemoryError::from);
        }
        self.store
            .update(
                &crate::MemoryUpdateCommit {
                    command_id: request.command_id,
                    fingerprint,
                    memory_id,
                    scope: request.scope,
                    expected_revision: request.expected_revision,
                    title: request.title,
                    body: request.body,
                    source,
                    normalized_search_text,
                    updated_at_unix_ms: now,
                },
                cancellation,
            )
            .map_err(MemoryError::from)
    }

    pub fn delete(&self, request: DeleteMemoryRequest) -> Result<MemoryDeleteResult, MemoryError> {
        let fingerprint = fingerprint(&request)?;
        self.store
            .delete(&MemoryDeleteCommit {
                command_id: request.command_id,
                fingerprint,
                memory_id: request.memory_id,
                scope: request.scope,
                expected_revision: request.expected_revision,
            })
            .map_err(MemoryError::from)
    }

    pub fn read(&self, request: ReadMemoryRequest) -> Result<Memory, MemoryError> {
        self.store
            .read(&request.scope, &request.memory_id)
            .map_err(MemoryError::from)
    }

    pub fn list(&self, request: ListMemoriesRequest) -> Result<MemoryListPage, MemoryError> {
        validate_limit(request.limit)?;
        let cursor = decode_cursor(request.cursor.as_deref(), &request.scope, None)?;
        let page = self
            .store
            .list(&MemoryStoreListRequest {
                scope: request.scope.clone(),
                expected_catalog_revision: cursor.as_ref().map(|cursor| cursor.catalog_revision),
                after: cursor.map(|cursor| cursor.after),
                limit: request.limit as usize,
            })
            .map_err(MemoryError::from)?;
        let next_cursor = next_cursor(
            page.catalog_revision,
            &request.scope,
            None,
            page.has_more,
            page.memories.last().map(|memory| &memory.memory_id),
        )?;
        Ok(MemoryListPage {
            catalog_revision: page.catalog_revision,
            memories: page.memories.iter().map(Memory::summary).collect(),
            next_cursor,
        })
    }

    pub fn search(&self, request: SearchMemoriesRequest) -> Result<MemorySearchPage, MemoryError> {
        validate_limit(request.limit)?;
        let query = request.query.trim();
        if query.is_empty() || query.chars().count() > MAX_QUERY_CHARS {
            return Err(MemoryError::InvalidInput(
                "Memory search query must contain 1..=512 characters".into(),
            ));
        }
        let normalized_query = normalize_search(query);
        let query_digest = format!("{:x}", Sha256::digest(normalized_query.as_bytes()));
        let cursor = decode_cursor(
            request.cursor.as_deref(),
            &request.scope,
            Some(&query_digest),
        )?;
        let page = self
            .store
            .search(&MemoryStoreSearchRequest {
                scope: request.scope.clone(),
                expected_catalog_revision: cursor.as_ref().map(|cursor| cursor.catalog_revision),
                after: cursor.map(|cursor| cursor.after),
                normalized_query,
                limit: request.limit as usize,
            })
            .map_err(MemoryError::from)?;
        let next_cursor = next_cursor(
            page.catalog_revision,
            &request.scope,
            Some(&query_digest),
            page.has_more,
            page.memories.last().map(|memory| &memory.memory_id),
        )?;
        Ok(MemorySearchPage {
            catalog_revision: page.catalog_revision,
            matches: page
                .memories
                .iter()
                .map(|memory| {
                    let (citation, excerpt) =
                        crate::read::excerpt(memory, &[normalize_search(query)], MAX_EXCERPT_BYTES);
                    MemorySearchMatch {
                        source: memory.source.clone(),
                        citation,
                        memory_id: memory.memory_id.clone(),
                        scope: memory.scope.clone(),
                        revision: memory.revision,
                        title: memory.title.clone(),
                        excerpt,
                        updated_at_unix_ms: memory.updated_at_unix_ms,
                    }
                })
                .collect(),
            next_cursor,
        })
    }
}

#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum MemoryError {
    #[error("Memory scope is not authorized for model writing, or the memory is owned by the user")]
    WriteDenied,
    #[error("Memory scope is not authorized for model reading")]
    ReadDenied,
    #[error("{0}")]
    InvalidInput(String),
    #[error("Memory was not found")]
    NotFound,
    #[error("Memory ID already exists or was deleted")]
    AlreadyExists,
    #[error("Memory command ID was reused with different input")]
    CommandConflict,
    #[error("Memory revision conflict: expected {expected}, actual {actual}")]
    RevisionConflict { expected: u64, actual: u64 },
    #[error("Memory cursor is stale: expected catalog {expected}, actual {actual}")]
    StaleCursor { expected: u64, actual: u64 },
    #[error("Memory operation cancelled: {0}")]
    Cancelled(String),
    #[error("Memory storage failed: {0}")]
    Storage(String),
}

impl From<MemoryStoreError> for MemoryError {
    fn from(error: MemoryStoreError) -> Self {
        match error {
            MemoryStoreError::WriteDenied => Self::WriteDenied,
            MemoryStoreError::ReadDenied => Self::ReadDenied,
            MemoryStoreError::NotFound => Self::NotFound,
            MemoryStoreError::AlreadyExists => Self::AlreadyExists,
            MemoryStoreError::CommandConflict => Self::CommandConflict,
            MemoryStoreError::RevisionConflict { expected, actual } => {
                Self::RevisionConflict { expected, actual }
            }
            MemoryStoreError::StaleCursor { expected, actual } => {
                Self::StaleCursor { expected, actual }
            }
            MemoryStoreError::Cancelled(message) => Self::Cancelled(message),
            MemoryStoreError::Storage(message) => Self::Storage(message),
        }
    }
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Cursor {
    catalog_revision: u64,
    scope: MemoryScope,
    query_digest: Option<String>,
    after: MemoryId,
}

fn decode_cursor(
    cursor: Option<&str>,
    scope: &MemoryScope,
    query_digest: Option<&str>,
) -> Result<Option<Cursor>, MemoryError> {
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    let decoded = base64::engine::general_purpose::URL_SAFE_NO_PAD
        .decode(cursor)
        .map_err(|_| MemoryError::InvalidInput("Memory cursor is invalid".into()))?;
    let cursor: Cursor = serde_json::from_slice(&decoded)
        .map_err(|_| MemoryError::InvalidInput("Memory cursor is invalid".into()))?;
    if &cursor.scope != scope || cursor.query_digest.as_deref() != query_digest {
        return Err(MemoryError::InvalidInput(
            "Memory cursor belongs to another query".into(),
        ));
    }
    Ok(Some(cursor))
}

fn next_cursor(
    catalog_revision: u64,
    scope: &MemoryScope,
    query_digest: Option<&str>,
    has_more: bool,
    after: Option<&MemoryId>,
) -> Result<Option<String>, MemoryError> {
    if !has_more {
        return Ok(None);
    }
    let after = after.ok_or_else(|| MemoryError::Storage("Memory page lost its cursor".into()))?;
    let encoded = serde_json::to_vec(&Cursor {
        catalog_revision,
        scope: scope.clone(),
        query_digest: query_digest.map(str::to_owned),
        after: after.clone(),
    })
    .map_err(|error| MemoryError::Storage(error.to_string()))?;
    Ok(Some(
        base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(encoded),
    ))
}

fn validate_title(title: &str) -> Result<(), MemoryError> {
    if title.trim().is_empty() || title.chars().count() > MAX_TITLE_CHARS {
        return Err(MemoryError::InvalidInput(
            "Memory title must contain 1..=256 characters".into(),
        ));
    }
    Ok(())
}

fn validate_body(body: &str) -> Result<(), MemoryError> {
    if body.trim().is_empty() || body.len() > MAX_BODY_BYTES {
        return Err(MemoryError::InvalidInput(
            "Memory body must contain 1..=16384 UTF-8 bytes".into(),
        ));
    }
    Ok(())
}

fn validate_limit(limit: u32) -> Result<(), MemoryError> {
    if !(1..=MAX_PAGE_SIZE).contains(&limit) {
        return Err(MemoryError::InvalidInput(
            "Memory page limit must be in 1..=50".into(),
        ));
    }
    Ok(())
}

pub(crate) fn normalize_search(value: &str) -> String {
    value.to_lowercase()
}

fn now_unix_ms() -> Result<u64, MemoryError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis().min(u128::from(u64::MAX)) as u64)
        .map_err(|error| MemoryError::Storage(error.to_string()))
}

fn fingerprint(value: &impl Serialize) -> Result<String, MemoryError> {
    serde_json::to_vec(value)
        .map(|bytes| format!("sha256:{:x}", Sha256::digest(bytes)))
        .map_err(|error| MemoryError::Storage(error.to_string()))
}

impl Serialize for AddMemoryRequest {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        (
            &self.command_id,
            &self.memory_id,
            &self.scope,
            &self.title,
            &self.body,
        )
            .serialize(serializer)
    }
}

impl Serialize for DeleteMemoryRequest {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: serde::Serializer,
    {
        (
            &self.command_id,
            &self.memory_id,
            &self.scope,
            self.expected_revision,
        )
            .serialize(serializer)
    }
}

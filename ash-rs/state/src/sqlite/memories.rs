use super::connection::from_sql_integer;
use super::connection::to_sql_integer;
use crate::SqliteDurability;
use crate::open_sqlite_database;
use ash_protocol::CommandId;
use async_utils::CancellationToken;
use memories::Memory;
use memories::MemoryAddCommit;
use memories::MemoryDeleteCommit;
use memories::MemoryDeleteResult;
use memories::MemoryId;
use memories::MemoryMutationDisposition;
use memories::MemoryMutationResult;
use memories::MemoryPolicy;
use memories::MemoryPolicyCommit;
use memories::MemoryPolicyMutationResult;
use memories::MemoryReadMode;
use memories::MemoryScope;
use memories::MemorySource;
use memories::MemoryStore;
use memories::MemoryStoreContextRequest;
use memories::MemoryStoreError;
use memories::MemoryStoreListRequest;
use memories::MemoryStorePage;
use memories::MemoryStoreSearchRequest;
use memories::MemoryUpdateCommit;
use memories::MemoryWriteMode;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use rusqlite::params;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

const MEMORIES_COMPONENT: &str = "memories";
const MEMORIES_SCHEMA_VERSION: u32 = 3;

/// SQLite implementation of Memory records, tombstones, catalog revisions, and command receipts.
pub struct SqliteMemoryStore {
    path: PathBuf,
    connection: Mutex<Connection>,
}

impl SqliteMemoryStore {
    pub fn open(path: impl Into<PathBuf>) -> Result<Self, MemoryStoreError> {
        let path = path.into();
        let mut connection = open_sqlite_database(&path, SqliteDurability::Durable)
            .map_err(MemoryStoreError::Storage)?;
        connection
            .pragma_update(None, "secure_delete", "ON")
            .map_err(storage_error)?;
        initialize(&mut connection)?;
        Ok(Self {
            path,
            connection: Mutex::new(connection),
        })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn connection(&self) -> Result<std::sync::MutexGuard<'_, Connection>, MemoryStoreError> {
        self.connection
            .lock()
            .map_err(|_| MemoryStoreError::Storage("Memory SQLite lock poisoned".into()))
    }
}

impl MemoryStore for SqliteMemoryStore {
    fn read_for_context(
        &self,
        scope: &MemoryScope,
        memory_id: &MemoryId,
    ) -> Result<Memory, MemoryStoreError> {
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage_error)?;
        if read_policy(&transaction, scope)?.automatic_read != MemoryReadMode::FirstInvocation {
            return Err(MemoryStoreError::ReadDenied);
        }
        let memory = load_memory(&transaction, scope, memory_id)?;
        transaction.commit().map_err(storage_error)?;
        Ok(memory)
    }

    fn policy(&self, scope: &MemoryScope) -> Result<MemoryPolicy, MemoryStoreError> {
        let connection = self.connection()?;
        read_policy(&connection, scope)
    }

    fn update_policy(
        &self,
        commit: &MemoryPolicyCommit,
    ) -> Result<MemoryPolicyMutationResult, MemoryStoreError> {
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let request = &commit.request;
        if load_command(&transaction, &request.command_id)?.is_some() {
            return Err(MemoryStoreError::CommandConflict);
        }
        let previous: Option<(String, String)> = transaction
            .query_row(
                "SELECT fingerprint, result_json FROM memory_policy_commands WHERE command_id = ?1",
                [request.command_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(storage_error)?;
        if let Some((fingerprint, json)) = previous {
            if fingerprint != commit.fingerprint {
                return Err(MemoryStoreError::CommandConflict);
            }
            let mut result: MemoryPolicyMutationResult =
                serde_json::from_str(&json).map_err(storage_error)?;
            result.disposition = MemoryMutationDisposition::Replayed;
            return Ok(result);
        }
        let current = read_policy(&transaction, &request.scope)?;
        if current.revision != request.expected_revision {
            return Err(MemoryStoreError::RevisionConflict {
                expected: request.expected_revision,
                actual: current.revision,
            });
        }
        let revision = current
            .revision
            .checked_add(1)
            .ok_or_else(|| MemoryStoreError::Storage("Memory policy revision overflow".into()))?;
        let policy = MemoryPolicy {
            scope: request.scope.clone(),
            revision,
            automatic_read: request.automatic_read,
            model_write: request.model_write,
        };
        let result = MemoryPolicyMutationResult {
            disposition: MemoryMutationDisposition::Committed,
            catalog_revision: next_catalog_revision(&transaction)?,
            policy,
        };
        transaction
            .execute(
                "INSERT INTO memory_policies (scope_key, policy_json) VALUES (?1, ?2)
             ON CONFLICT(scope_key) DO UPDATE SET policy_json = excluded.policy_json",
                params![request.scope.storage_key(), serialize(&result.policy)?],
            )
            .map_err(storage_error)?;
        transaction.execute(
            "INSERT INTO memory_policy_commands (command_id, fingerprint, result_json) VALUES (?1, ?2, ?3)",
            params![request.command_id.as_str(), commit.fingerprint, serialize(&result)?],
        ).map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(result)
    }

    fn context(
        &self,
        request: &MemoryStoreContextRequest,
    ) -> Result<Vec<Memory>, MemoryStoreError> {
        if request.normalized_terms.is_empty() || request.limit == 0 {
            return Ok(Vec::new());
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(storage_error)?;
        let mut enabled = Vec::new();
        for scope in &request.scopes {
            if read_policy(&transaction, scope)?.automatic_read == MemoryReadMode::FirstInvocation {
                enabled.push(scope.storage_key());
            }
        }
        if enabled.is_empty() {
            return Ok(Vec::new());
        }
        let scope_slots = (1..=enabled.len())
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(", ");
        let matches = (0..request.normalized_terms.len())
            .map(|index| {
                format!(
                    "(instr(normalized_search, ?{}) > 0)",
                    enabled.len() + index + 1
                )
            })
            .collect::<Vec<_>>();
        let predicates = matches.join(" OR ");
        let score = matches.join(" + ");
        let sql = format!(
            "SELECT memory_id, scope_key, record_revision, record_json FROM memories
            WHERE scope_key IN ({scope_slots}) AND ({predicates})
            ORDER BY ({score}) DESC, memory_id LIMIT ?{}",
            enabled.len() + request.normalized_terms.len() + 1
        );
        let mut values = enabled
            .into_iter()
            .map(rusqlite::types::Value::Text)
            .collect::<Vec<_>>();
        values.extend(
            request
                .normalized_terms
                .iter()
                .cloned()
                .map(rusqlite::types::Value::Text),
        );
        values.push(rusqlite::types::Value::Integer(
            i64::try_from(request.limit).map_err(storage_error)?,
        ));
        let memories = {
            let mut statement = transaction.prepare(&sql).map_err(storage_error)?;
            let rows = statement
                .query_map(rusqlite::params_from_iter(values), row_tuple)
                .map_err(storage_error)?;
            rows.map(|row| decode_row(row.map_err(storage_error)?))
                .collect::<Result<Vec<_>, _>>()?
        };
        transaction.commit().map_err(storage_error)?;
        Ok(memories)
    }

    fn add(
        &self,
        commit: &MemoryAddCommit,
        cancellation: &CancellationToken,
    ) -> Result<MemoryMutationResult, MemoryStoreError> {
        check_cancellation(cancellation)?;
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        check_cancellation(cancellation)?;
        authorize_model_write(&transaction, &commit.memory.scope, &commit.memory.source)?;
        reject_policy_command(&transaction, &commit.command_id)?;
        if let Some(command) = load_command(&transaction, &commit.command_id)? {
            command.matches(
                "add",
                &commit.fingerprint,
                &commit.memory.memory_id,
                &commit.memory.scope,
            )?;
            let memory = load_memory(&transaction, &commit.memory.scope, &commit.memory.memory_id)?;
            if memory.revision != command.record_revision {
                return Err(MemoryStoreError::RevisionConflict {
                    expected: command.record_revision,
                    actual: memory.revision,
                });
            }
            transaction.commit().map_err(storage_error)?;
            return Ok(MemoryMutationResult {
                disposition: MemoryMutationDisposition::Replayed,
                catalog_revision: command.catalog_revision,
                memory,
            });
        }
        if memory_id_exists(&transaction, &commit.memory.memory_id)? {
            return Err(MemoryStoreError::AlreadyExists);
        }
        let catalog_revision = next_catalog_revision(&transaction)?;
        transaction
            .execute(
                "INSERT INTO memories
                 (memory_id, scope_key, record_revision, record_json, normalized_search)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    commit.memory.memory_id.as_str(),
                    commit.memory.scope.storage_key(),
                    to_sql_integer(commit.memory.revision).map_err(MemoryStoreError::Storage)?,
                    serialize(&commit.memory)?,
                    commit.normalized_search_text,
                ],
            )
            .map_err(storage_error)?;
        insert_command(
            &transaction,
            &commit.command_id,
            "add",
            &commit.fingerprint,
            &commit.memory.memory_id,
            &commit.memory.scope,
            commit.memory.revision,
            catalog_revision,
        )?;
        transaction.commit().map_err(storage_error)?;
        Ok(MemoryMutationResult {
            disposition: MemoryMutationDisposition::Committed,
            catalog_revision,
            memory: commit.memory.clone(),
        })
    }

    fn update(
        &self,
        commit: &MemoryUpdateCommit,
        cancellation: &CancellationToken,
    ) -> Result<MemoryMutationResult, MemoryStoreError> {
        check_cancellation(cancellation)?;
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        check_cancellation(cancellation)?;
        authorize_model_write(&transaction, &commit.scope, &commit.source)?;
        reject_policy_command(&transaction, &commit.command_id)?;
        let mut memory = load_memory(&transaction, &commit.scope, &commit.memory_id)?;
        if matches!(&commit.source, MemorySource::Model { .. })
            && memory.source == MemorySource::User
        {
            return Err(MemoryStoreError::WriteDenied);
        }
        if let Some(command) = load_command(&transaction, &commit.command_id)? {
            command.matches(
                "update",
                &commit.fingerprint,
                &commit.memory_id,
                &commit.scope,
            )?;
            if memory.revision != command.record_revision {
                return Err(MemoryStoreError::RevisionConflict {
                    expected: command.record_revision,
                    actual: memory.revision,
                });
            }
            return Ok(MemoryMutationResult {
                disposition: MemoryMutationDisposition::Replayed,
                catalog_revision: command.catalog_revision,
                memory,
            });
        }
        if memory.revision != commit.expected_revision {
            return Err(MemoryStoreError::RevisionConflict {
                expected: commit.expected_revision,
                actual: memory.revision,
            });
        }
        memory.revision = memory
            .revision
            .checked_add(1)
            .ok_or_else(|| MemoryStoreError::Storage("Memory revision overflow".into()))?;
        memory.title = commit.title.clone();
        memory.body = commit.body.clone();
        memory.source = commit.source.clone();
        memory.updated_at_unix_ms = commit.updated_at_unix_ms;
        let catalog_revision = next_catalog_revision(&transaction)?;
        transaction.execute(
            "UPDATE memories SET record_revision = ?1, record_json = ?2, normalized_search = ?3 WHERE memory_id = ?4 AND scope_key = ?5",
            params![to_sql_integer(memory.revision).map_err(MemoryStoreError::Storage)?, serialize(&memory)?, commit.normalized_search_text, memory.memory_id.as_str(), memory.scope.storage_key()],
        ).map_err(storage_error)?;
        insert_command(
            &transaction,
            &commit.command_id,
            "update",
            &commit.fingerprint,
            &memory.memory_id,
            &memory.scope,
            memory.revision,
            catalog_revision,
        )?;
        transaction.commit().map_err(storage_error)?;
        Ok(MemoryMutationResult {
            disposition: MemoryMutationDisposition::Committed,
            catalog_revision,
            memory,
        })
    }

    fn delete(&self, commit: &MemoryDeleteCommit) -> Result<MemoryDeleteResult, MemoryStoreError> {
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        reject_policy_command(&transaction, &commit.command_id)?;
        if let Some(command) = load_command(&transaction, &commit.command_id)? {
            command.matches(
                "delete",
                &commit.fingerprint,
                &commit.memory_id,
                &commit.scope,
            )?;
            transaction.commit().map_err(storage_error)?;
            return Ok(MemoryDeleteResult {
                disposition: MemoryMutationDisposition::Replayed,
                catalog_revision: command.catalog_revision,
                memory_id: commit.memory_id.clone(),
                scope: commit.scope.clone(),
                deleted_revision: command.record_revision,
            });
        }
        let memory = load_memory(&transaction, &commit.scope, &commit.memory_id)?;
        if memory.revision != commit.expected_revision {
            return Err(MemoryStoreError::RevisionConflict {
                expected: commit.expected_revision,
                actual: memory.revision,
            });
        }
        let catalog_revision = next_catalog_revision(&transaction)?;
        let deleted = transaction
            .execute(
                "DELETE FROM memories WHERE memory_id = ?1 AND scope_key = ?2",
                params![commit.memory_id.as_str(), commit.scope.storage_key()],
            )
            .map_err(storage_error)?;
        if deleted != 1 {
            return Err(MemoryStoreError::NotFound);
        }
        transaction
            .execute(
                "INSERT INTO memory_tombstones
                 (memory_id, scope_key, deleted_revision, catalog_revision)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    commit.memory_id.as_str(),
                    commit.scope.storage_key(),
                    to_sql_integer(memory.revision).map_err(MemoryStoreError::Storage)?,
                    to_sql_integer(catalog_revision).map_err(MemoryStoreError::Storage)?,
                ],
            )
            .map_err(storage_error)?;
        insert_command(
            &transaction,
            &commit.command_id,
            "delete",
            &commit.fingerprint,
            &commit.memory_id,
            &commit.scope,
            memory.revision,
            catalog_revision,
        )?;
        transaction.commit().map_err(storage_error)?;
        Ok(MemoryDeleteResult {
            disposition: MemoryMutationDisposition::Committed,
            catalog_revision,
            memory_id: commit.memory_id.clone(),
            scope: commit.scope.clone(),
            deleted_revision: memory.revision,
        })
    }

    fn read(&self, scope: &MemoryScope, memory_id: &MemoryId) -> Result<Memory, MemoryStoreError> {
        let connection = self.connection()?;
        load_memory(&connection, scope, memory_id)
    }

    fn list(&self, request: &MemoryStoreListRequest) -> Result<MemoryStorePage, MemoryStoreError> {
        let connection = self.connection()?;
        page(&connection, request, None)
    }

    fn search(
        &self,
        request: &MemoryStoreSearchRequest,
    ) -> Result<MemoryStorePage, MemoryStoreError> {
        let connection = self.connection()?;
        page(
            &connection,
            &MemoryStoreListRequest {
                scope: request.scope.clone(),
                expected_catalog_revision: request.expected_catalog_revision,
                after: request.after.clone(),
                limit: request.limit,
            },
            Some(&request.normalized_query),
        )
    }
}

fn check_cancellation(cancellation: &CancellationToken) -> Result<(), MemoryStoreError> {
    cancellation
        .check()
        .map_err(|signal| MemoryStoreError::Cancelled(signal.reason().to_string()))
}

fn initialize(connection: &mut Connection) -> Result<(), MemoryStoreError> {
    connection
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS ash_schema_migrations (
                 component TEXT PRIMARY KEY,
                 version INTEGER NOT NULL
             );",
        )
        .map_err(storage_error)?;
    let transaction = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(storage_error)?;
    let version = transaction
        .query_row(
            "SELECT version FROM ash_schema_migrations WHERE component = ?1",
            [MEMORIES_COMPONENT],
            |row| row.get::<_, u32>(0),
        )
        .optional()
        .map_err(storage_error)?;
    match version {
        None => {
            transaction
                .execute_batch(
                    "CREATE TABLE memory_catalog (
                         singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
                         revision INTEGER NOT NULL
                     );
                     INSERT INTO memory_catalog (singleton, revision) VALUES (1, 0);
                     CREATE TABLE memories (
                         memory_id TEXT PRIMARY KEY,
                         scope_key TEXT NOT NULL,
                         record_revision INTEGER NOT NULL,
                         record_json TEXT NOT NULL,
                         normalized_search TEXT NOT NULL
                     );
                     CREATE INDEX memories_scope_id ON memories(scope_key, memory_id);
                     CREATE TABLE memory_tombstones (
                         memory_id TEXT PRIMARY KEY,
                         scope_key TEXT NOT NULL,
                         deleted_revision INTEGER NOT NULL,
                         catalog_revision INTEGER NOT NULL
                     );
                     CREATE TABLE memory_commands (
                         command_id TEXT PRIMARY KEY,
                         operation TEXT NOT NULL,
                         fingerprint TEXT NOT NULL,
                         memory_id TEXT NOT NULL,
                         scope_key TEXT NOT NULL,
                         record_revision INTEGER NOT NULL,
                         catalog_revision INTEGER NOT NULL
                     );",
                )
                .map_err(storage_error)?;
            transaction
                .execute(
                    "INSERT INTO ash_schema_migrations (component, version) VALUES (?1, ?2)",
                    params![MEMORIES_COMPONENT, MEMORIES_SCHEMA_VERSION],
                )
                .map_err(storage_error)?;
        }
        Some(1 | 2 | MEMORIES_SCHEMA_VERSION) => {}
        Some(version) => {
            return Err(MemoryStoreError::Storage(format!(
                "unsupported Memories SQLite schema version {version}"
            )));
        }
    }
    if matches!(version, None | Some(1)) {
        transaction.execute_batch(
            "CREATE TABLE memory_policies (scope_key TEXT PRIMARY KEY, policy_json TEXT NOT NULL);
             CREATE TABLE memory_policy_commands (command_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL);"
        ).map_err(storage_error)?;
        transaction
            .execute(
                "UPDATE ash_schema_migrations SET version = ?1 WHERE component = ?2",
                params![MEMORIES_SCHEMA_VERSION, MEMORIES_COMPONENT],
            )
            .map_err(storage_error)?;
    }
    if version == Some(2) {
        transaction.execute_batch(
            "UPDATE memory_policies SET policy_json = json_set(policy_json, '$.modelWrite', 'disabled');
             UPDATE memory_policy_commands SET result_json = json_set(result_json, '$.policy.modelWrite', 'disabled');"
        ).map_err(storage_error)?;
        transaction
            .execute(
                "UPDATE ash_schema_migrations SET version = ?1 WHERE component = ?2",
                params![MEMORIES_SCHEMA_VERSION, MEMORIES_COMPONENT],
            )
            .map_err(storage_error)?;
    }
    transaction.commit().map_err(storage_error)
}

fn page(
    connection: &Connection,
    request: &MemoryStoreListRequest,
    normalized_query: Option<&str>,
) -> Result<MemoryStorePage, MemoryStoreError> {
    let catalog_revision = read_catalog_revision(connection)?;
    if let Some(expected) = request.expected_catalog_revision
        && expected != catalog_revision
    {
        return Err(MemoryStoreError::StaleCursor {
            expected,
            actual: catalog_revision,
        });
    }
    let after = request.after.as_ref().map(MemoryId::as_str).unwrap_or("");
    let sql = if normalized_query.is_some() {
        "SELECT memory_id, scope_key, record_revision, record_json
         FROM memories
         WHERE scope_key = ?1 AND memory_id > ?2 AND instr(normalized_search, ?3) > 0
         ORDER BY memory_id LIMIT ?4"
    } else {
        "SELECT memory_id, scope_key, record_revision, record_json
         FROM memories
         WHERE scope_key = ?1 AND memory_id > ?2
         ORDER BY memory_id LIMIT ?4"
    };
    let mut statement = connection.prepare(sql).map_err(storage_error)?;
    let row_limit = i64::try_from(request.limit.saturating_add(1))
        .map_err(|_| MemoryStoreError::Storage("Memory page limit overflow".into()))?;
    let mut memories = Vec::new();
    if let Some(query) = normalized_query {
        let rows = statement
            .query_map(
                params![request.scope.storage_key(), after, query, row_limit],
                row_tuple,
            )
            .map_err(storage_error)?;
        for row in rows {
            memories.push(decode_row(row.map_err(storage_error)?)?);
        }
    } else {
        let rows = statement
            .query_map(
                params![request.scope.storage_key(), after, "", row_limit],
                row_tuple,
            )
            .map_err(storage_error)?;
        for row in rows {
            memories.push(decode_row(row.map_err(storage_error)?)?);
        }
    }
    let has_more = memories.len() > request.limit;
    if has_more {
        memories.pop();
    }
    Ok(MemoryStorePage {
        catalog_revision,
        memories,
        has_more,
    })
}

fn row_tuple(row: &rusqlite::Row<'_>) -> rusqlite::Result<(String, String, i64, String)> {
    Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
}

fn decode_row(row: (String, String, i64, String)) -> Result<Memory, MemoryStoreError> {
    let memory = serde_json::from_str::<Memory>(&row.3)
        .map_err(|error| MemoryStoreError::Storage(error.to_string()))?;
    let revision = from_sql_integer(row.2).map_err(MemoryStoreError::Storage)?;
    if memory.memory_id.as_str() != row.0
        || memory.scope.storage_key() != row.1
        || memory.revision != revision
    {
        return Err(MemoryStoreError::Storage(
            "Memory row metadata disagrees with its record".into(),
        ));
    }
    Ok(memory)
}

fn load_memory(
    connection: &Connection,
    scope: &MemoryScope,
    memory_id: &MemoryId,
) -> Result<Memory, MemoryStoreError> {
    let row = connection
        .query_row(
            "SELECT memory_id, scope_key, record_revision, record_json
             FROM memories WHERE memory_id = ?1 AND scope_key = ?2",
            params![memory_id.as_str(), scope.storage_key()],
            row_tuple,
        )
        .optional()
        .map_err(storage_error)?
        .ok_or(MemoryStoreError::NotFound)?;
    decode_row(row)
}

fn memory_id_exists(
    connection: &Connection,
    memory_id: &MemoryId,
) -> Result<bool, MemoryStoreError> {
    connection
        .query_row(
            "SELECT EXISTS(
                 SELECT 1 FROM memories WHERE memory_id = ?1
                 UNION ALL
                 SELECT 1 FROM memory_tombstones WHERE memory_id = ?1
             )",
            [memory_id.as_str()],
            |row| row.get(0),
        )
        .map_err(storage_error)
}

fn read_catalog_revision(connection: &Connection) -> Result<u64, MemoryStoreError> {
    connection
        .query_row(
            "SELECT revision FROM memory_catalog WHERE singleton = 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .map_err(storage_error)
        .and_then(|value| from_sql_integer(value).map_err(MemoryStoreError::Storage))
}

fn next_catalog_revision(connection: &Connection) -> Result<u64, MemoryStoreError> {
    let next = read_catalog_revision(connection)?
        .checked_add(1)
        .ok_or_else(|| MemoryStoreError::Storage("Memory catalog revision overflow".into()))?;
    connection
        .execute(
            "UPDATE memory_catalog SET revision = ?1 WHERE singleton = 1",
            [to_sql_integer(next).map_err(MemoryStoreError::Storage)?],
        )
        .map_err(storage_error)?;
    Ok(next)
}

struct CommandReceipt {
    operation: String,
    fingerprint: String,
    memory_id: String,
    scope_key: String,
    record_revision: u64,
    catalog_revision: u64,
}

impl CommandReceipt {
    fn matches(
        &self,
        operation: &str,
        fingerprint: &str,
        memory_id: &MemoryId,
        scope: &MemoryScope,
    ) -> Result<(), MemoryStoreError> {
        if self.operation != operation
            || self.fingerprint != fingerprint
            || self.memory_id != memory_id.as_str()
            || self.scope_key != scope.storage_key()
        {
            return Err(MemoryStoreError::CommandConflict);
        }
        Ok(())
    }
}

fn load_command(
    connection: &Connection,
    command_id: &CommandId,
) -> Result<Option<CommandReceipt>, MemoryStoreError> {
    connection
        .query_row(
            "SELECT operation, fingerprint, memory_id, scope_key, record_revision, catalog_revision
             FROM memory_commands WHERE command_id = ?1",
            [command_id.as_str()],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                ))
            },
        )
        .optional()
        .map_err(storage_error)?
        .map(|row| {
            Ok(CommandReceipt {
                operation: row.0,
                fingerprint: row.1,
                memory_id: row.2,
                scope_key: row.3,
                record_revision: from_sql_integer(row.4).map_err(MemoryStoreError::Storage)?,
                catalog_revision: from_sql_integer(row.5).map_err(MemoryStoreError::Storage)?,
            })
        })
        .transpose()
}

fn insert_command(
    connection: &Connection,
    command_id: &CommandId,
    operation: &str,
    fingerprint: &str,
    memory_id: &MemoryId,
    scope: &MemoryScope,
    record_revision: u64,
    catalog_revision: u64,
) -> Result<(), MemoryStoreError> {
    connection
        .execute(
            "INSERT INTO memory_commands
             (command_id, operation, fingerprint, memory_id, scope_key,
              record_revision, catalog_revision)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
            params![
                command_id.as_str(),
                operation,
                fingerprint,
                memory_id.as_str(),
                scope.storage_key(),
                to_sql_integer(record_revision).map_err(MemoryStoreError::Storage)?,
                to_sql_integer(catalog_revision).map_err(MemoryStoreError::Storage)?,
            ],
        )
        .map_err(storage_error)?;
    Ok(())
}

fn serialize(value: &impl serde::Serialize) -> Result<String, MemoryStoreError> {
    serde_json::to_string(value).map_err(|error| MemoryStoreError::Storage(error.to_string()))
}

fn storage_error(error: impl std::fmt::Display) -> MemoryStoreError {
    MemoryStoreError::Storage(format!("Memory SQLite error: {error}"))
}

fn read_policy(
    connection: &Connection,
    scope: &MemoryScope,
) -> Result<MemoryPolicy, MemoryStoreError> {
    let json: Option<String> = connection
        .query_row(
            "SELECT policy_json FROM memory_policies WHERE scope_key = ?1",
            [scope.storage_key()],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage_error)?;
    let Some(json) = json else {
        return Ok(MemoryPolicy::disabled(scope.clone()));
    };
    let policy: MemoryPolicy = serde_json::from_str(&json).map_err(storage_error)?;
    if &policy.scope != scope || policy.revision == 0 {
        return Err(MemoryStoreError::Storage(
            "Memory policy metadata disagrees with its record".into(),
        ));
    }
    Ok(policy)
}

fn reject_policy_command(
    connection: &Connection,
    command_id: &CommandId,
) -> Result<(), MemoryStoreError> {
    let exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM memory_policy_commands WHERE command_id = ?1)",
            [command_id.as_str()],
            |row| row.get(0),
        )
        .map_err(storage_error)?;
    if exists {
        return Err(MemoryStoreError::CommandConflict);
    }
    Ok(())
}

fn authorize_model_write(
    connection: &Connection,
    scope: &MemoryScope,
    source: &MemorySource,
) -> Result<(), MemoryStoreError> {
    if matches!(source, MemorySource::Model { .. })
        && read_policy(connection, scope)?.model_write != MemoryWriteMode::Enabled
    {
        return Err(MemoryStoreError::WriteDenied);
    }
    Ok(())
}

#[cfg(test)]
#[path = "memories_tests.rs"]
mod tests;

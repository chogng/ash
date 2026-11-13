use crate::SqliteDurability;
use crate::open_sqlite_database;
use crate::sqlite_migrations::Migration;
use crate::sqlite_migrations::Migrator;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use rusqlite::params;
use std::fmt;
use std::path::Path;
use std::sync::Mutex;
use std::time::SystemTime;
use std::time::UNIX_EPOCH;

const MIGRATOR: Migrator<'_> = Migrator::new(
    "generated-files",
    &[
        Migration::sql(
            1,
            include_str!("../migrations/generated-files/0001_generated_files.sql"),
        ),
        Migration::sql(
            2,
            include_str!("../migrations/generated-files/0002_native_publications.sql"),
        ),
    ],
);

pub const NATIVE_GENERATED_FILE_CLIENT: &str = "ash-native";
const NATIVE_PROVIDER: &str = "local-agent-host";
const NATIVE_PART: &str = "markdown";

pub(crate) fn migrate(connection: &mut Connection) -> Result<(), String> {
    MIGRATOR.run(connection)
}

/// The completion event and its publication must commit together, including if the
/// App Server exits before it can deliver the completion notification.
pub(crate) fn stage_native_turn(
    connection: &Connection,
    thread: &ash_protocol::Thread,
    turn: &ash_protocol::Turn,
) -> Result<(), ash_thread_store::ThreadStoreError> {
    use ash_protocol::MessagePhase;
    use ash_protocol::ThreadItem;

    if !turn.items.iter().any(
        |item| matches!(item, ThreadItem::UserContext { name, .. } if name == "ash.creation.docs"),
    ) {
        return Ok(());
    }
    let mut messages = turn.items.iter().rev().filter_map(|item| match item {
        ThreadItem::AgentMessage {
            item_id,
            text,
            phase,
            ..
        } => Some((item_id, text, phase)),
        _ => None,
    });
    let Some(last) = messages.next() else {
        return Ok(());
    };
    let (item_id, markdown, _) = if *last.2 == Some(MessagePhase::FinalAnswer) {
        last
    } else if let Some(final_answer) =
        messages.find(|item| *item.2 == Some(MessagePhase::FinalAnswer))
    {
        final_answer
    } else if last.2.is_none() {
        last
    } else {
        return Ok(());
    };
    if markdown.trim().is_empty() {
        return Ok(());
    }

    let key = serde_json::json!([
        NATIVE_PROVIDER,
        null,
        thread.session_id.as_str(),
        thread.thread_id.as_str(),
        item_id.as_str(),
        NATIVE_PART
    ]);
    let digest = ash_protocol::ContentDigest::sha256(key.to_string().as_bytes());
    let id = digest
        .as_str()
        .strip_prefix("sha256:")
        .unwrap_or(digest.as_str());
    let title = markdown
        .lines()
        .find_map(|line| {
            let heading = line.trim_start_matches('#');
            (heading.len() < line.len() && heading.starts_with([' ', '\t']))
                .then(|| heading.trim().trim_end_matches('#').trim())
                .filter(|heading| !heading.is_empty())
        })
        .or_else(|| {
            markdown
                .lines()
                .map(str::trim)
                .find(|line| !line.is_empty())
        })
        .unwrap_or(markdown.trim());
    let title: String = title
        .chars()
        .map(|c| if c.is_control() { ' ' } else { c })
        .take(200)
        .collect();
    connection.execute(
        "INSERT OR IGNORE INTO generated_file_publications (id, session_id, thread_id, item_id, title, markdown)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
         WHERE NOT EXISTS (SELECT 1 FROM generated_files WHERE client_id = ?7 AND id = ?1)",
        params![id, thread.session_id.as_str(), thread.thread_id.as_str(), item_id.as_str(), title, markdown, NATIVE_GENERATED_FILE_CLIENT],
    ).map_err(|error| ash_thread_store::ThreadStoreError::Storage(error.to_string()))?;
    Ok(())
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GeneratedFileSource {
    pub provider_id: String,
    pub account_id: Option<String>,
    pub session_id: String,
    pub thread_id: String,
    pub item_id: String,
    pub part_id: String,
}

/// A reference to content already saved by its file-service owner. Neither this
/// descriptor nor its source grants permission to read or write the resource.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GeneratedFileRegistration {
    pub id: String,
    pub resource: String,
    pub title: String,
    pub content_type: String,
    pub source: GeneratedFileSource,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GeneratedFileRecord {
    pub file: GeneratedFileRegistration,
    /// Unix milliseconds assigned by the store on first registration.
    pub created_at: i64,
}

/// Retries preserve the first record, including its title and creation time.
pub enum GeneratedFileRegistrationOutcome {
    Created(GeneratedFileRecord),
    Existing(GeneratedFileRecord),
}

#[derive(Debug)]
pub enum GeneratedFileError {
    Invalid,
    Conflict,
    Storage(String),
}

impl fmt::Display for GeneratedFileError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Invalid => formatter.write_str("invalid generated file registration"),
            Self::Conflict => formatter.write_str("generated file identity conflicts"),
            Self::Storage(detail) => formatter.write_str(detail),
        }
    }
}

impl std::error::Error for GeneratedFileError {}

/// Profile-wide durable references, isolated by the UI storage namespace.
/// After publication, only the file provider owns the document body.
pub struct SqliteGeneratedFileStore {
    connection: Mutex<Connection>,
}

impl SqliteGeneratedFileStore {
    pub fn open(path: &Path) -> Result<Self, GeneratedFileError> {
        let mut connection = open_sqlite_database(path, SqliteDurability::Durable)
            .map_err(GeneratedFileError::Storage)?;
        MIGRATOR
            .run(&mut connection)
            .map_err(GeneratedFileError::Storage)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn register(
        &self,
        client_id: &str,
        file: &GeneratedFileRegistration,
    ) -> Result<GeneratedFileRegistrationOutcome, GeneratedFileError> {
        validate_client_id(client_id)?;
        if client_id == NATIVE_GENERATED_FILE_CLIENT {
            return Err(GeneratedFileError::Invalid);
        }
        validate_registration(file)?;
        let mut connection = self.connection.lock().map_err(storage_error)?;
        // Separate store instances/processes share the same uniqueness and retry
        // decision; a Rust mutex alone cannot protect profile-wide registration.
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let source = &file.source;
        let created_at = unix_millis()?;
        let inserted = transaction
            .execute(
                "INSERT INTO generated_files (client_id, id, resource, title, content_type,
             provider_id, account_id, session_id, thread_id, item_id, part_id, created_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT DO NOTHING",
                params![
                    client_id,
                    file.id,
                    file.resource,
                    file.title,
                    file.content_type,
                    source.provider_id,
                    source.account_id,
                    source.session_id,
                    source.thread_id,
                    source.item_id,
                    source.part_id,
                    created_at
                ],
            )
            .map_err(storage_error)?;
        if inserted == 0 {
            let current = transaction
                .query_row(
                    "SELECT id, resource, title, content_type, provider_id, account_id,
                     session_id, thread_id, item_id, part_id, created_at
                     FROM generated_files WHERE client_id = ?1 AND id = ?2",
                    params![client_id, file.id],
                    read_record,
                )
                .optional()
                .map_err(storage_error)?;
            return match current {
                Some(current)
                    if current.file.resource == file.resource
                        && current.file.source == file.source =>
                {
                    Ok(GeneratedFileRegistrationOutcome::Existing(current))
                }
                _ => Err(GeneratedFileError::Conflict),
            };
        }
        transaction.commit().map_err(storage_error)?;
        Ok(GeneratedFileRegistrationOutcome::Created(
            GeneratedFileRecord {
                file: file.clone(),
                created_at,
            },
        ))
    }

    pub fn pending_native_ids(&self) -> Result<Vec<String>, GeneratedFileError> {
        let connection = self.connection.lock().map_err(storage_error)?;
        let mut statement = connection
            .prepare("SELECT id FROM generated_file_publications ORDER BY id")
            .map_err(storage_error)?;
        statement
            .query_map([], |row| row.get(0))
            .map_err(storage_error)?
            .map(|row| row.map_err(storage_error))
            .collect()
    }

    pub fn pending_native_markdown(&self, id: &str) -> Result<Option<String>, GeneratedFileError> {
        validate_file_id(id)?;
        let connection = self.connection.lock().map_err(storage_error)?;
        connection
            .query_row(
                "SELECT markdown FROM generated_file_publications WHERE id = ?1",
                [id],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage_error)
    }

    /// Called after the producer durably creates the file. Only the producer that
    /// first records the reference needs to notify clients.
    pub fn finish_native_publication(
        &self,
        id: &str,
        resource: &str,
    ) -> Result<bool, GeneratedFileError> {
        let mut connection = self.connection.lock().map_err(storage_error)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage_error)?;
        let inserted = transaction.execute(
            "INSERT INTO generated_files (client_id, id, resource, title, content_type, provider_id, session_id, thread_id, item_id, part_id, created_at)
             SELECT ?1, id, ?2, title, 'text/markdown', ?3, session_id, thread_id, item_id, ?4, ?5
             FROM generated_file_publications WHERE id = ?6
             ON CONFLICT(client_id, id) DO NOTHING",
            params![NATIVE_GENERATED_FILE_CLIENT, resource, NATIVE_PROVIDER, NATIVE_PART, unix_millis()?, id],
        ).map_err(storage_error)?;
        transaction
            .execute(
                "DELETE FROM generated_file_publications WHERE id = ?1",
                [id],
            )
            .map_err(storage_error)?;
        transaction.commit().map_err(storage_error)?;
        Ok(inserted != 0)
    }

    pub fn has_native_file(&self, id: &str) -> Result<bool, GeneratedFileError> {
        validate_file_id(id)?;
        let connection = self.connection.lock().map_err(storage_error)?;
        connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM generated_files WHERE client_id = ?1 AND id = ?2)",
                params![NATIVE_GENERATED_FILE_CLIENT, id],
                |row| row.get(0),
            )
            .map_err(storage_error)
    }

    /// Returns native references and the current client's visible imports in one snapshot.
    /// The native namespace selects only native references.
    pub fn list(
        &self,
        client_id: &str,
        account_ids: &[String],
    ) -> Result<Vec<GeneratedFileRecord>, GeneratedFileError> {
        validate_client_id(client_id)?;
        if account_ids.len() > 64 {
            return Err(GeneratedFileError::Invalid);
        }
        for account in account_ids {
            validate_text(account, 1024)?;
        }
        let accounts = serde_json::to_string(account_ids).map_err(storage_error)?;
        let connection = self.connection.lock().map_err(storage_error)?;
        let mut statement = connection
            .prepare(
                "SELECT id, resource, title, content_type, provider_id, account_id,
             session_id, thread_id, item_id, part_id, created_at FROM generated_files
             WHERE client_id = ?1 OR (
                 client_id = ?2 AND (account_id IS NULL OR account_id IN (SELECT value FROM json_each(?3)))
                 AND NOT EXISTS (
                     SELECT 1 FROM generated_files native WHERE native.client_id = ?1 AND native.id = generated_files.id
                 )
             )
             ORDER BY client_id = ?1 DESC, created_at DESC, id",
            )
            .map_err(storage_error)?;
        statement
            .query_map(
                params![NATIVE_GENERATED_FILE_CLIENT, client_id, accounts],
                read_record,
            )
            .map_err(storage_error)?
            .map(|row| row.map_err(storage_error))
            .collect()
    }
}

fn unix_millis() -> Result<i64, GeneratedFileError> {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(storage_error)?
            .as_millis(),
    )
    .map_err(storage_error)
}

fn validate_client_id(client_id: &str) -> Result<(), GeneratedFileError> {
    validate_text(client_id, 1024)
}

fn validate_file_id(id: &str) -> Result<(), GeneratedFileError> {
    if id.len() == 64
        && id
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        Ok(())
    } else {
        Err(GeneratedFileError::Invalid)
    }
}

fn validate_registration(file: &GeneratedFileRegistration) -> Result<(), GeneratedFileError> {
    validate_file_id(&file.id)?;
    validate_text(&file.resource, 16384)?;
    validate_text(&file.title, 4096)?;
    validate_text(&file.content_type, 256)?;
    validate_text(&file.source.provider_id, 256)?;
    if let Some(account_id) = &file.source.account_id {
        validate_text(account_id, 1024)?;
    }
    for value in [
        &file.source.session_id,
        &file.source.thread_id,
        &file.source.item_id,
        &file.source.part_id,
    ] {
        validate_text(value, 8192)?;
    }
    Ok(())
}

fn validate_text(value: &str, maximum_bytes: usize) -> Result<(), GeneratedFileError> {
    if value.trim().is_empty() || value.len() > maximum_bytes || value.chars().any(char::is_control)
    {
        return Err(GeneratedFileError::Invalid);
    }
    Ok(())
}

fn read_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<GeneratedFileRecord> {
    Ok(GeneratedFileRecord {
        file: GeneratedFileRegistration {
            id: row.get(0)?,
            resource: row.get(1)?,
            title: row.get(2)?,
            content_type: row.get(3)?,
            source: GeneratedFileSource {
                provider_id: row.get(4)?,
                account_id: row.get(5)?,
                session_id: row.get(6)?,
                thread_id: row.get(7)?,
                item_id: row.get(8)?,
                part_id: row.get(9)?,
            },
        },
        created_at: row.get(10)?,
    })
}

fn storage_error(error: impl fmt::Display) -> GeneratedFileError {
    GeneratedFileError::Storage(error.to_string())
}

#[cfg(test)]
#[path = "generated_files_tests.rs"]
mod tests;

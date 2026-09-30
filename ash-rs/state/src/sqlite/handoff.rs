//! One-way history ownership transfer. The wire format carries data, never source SQL or
//! profile configuration. SQLite serializes the freeze with every existing history writer.

use super::history::error;
use super::thread::SqliteThreadStore;
use ash_history::StoredEvent;
use ash_protocol::ContentDigest;
use ash_protocol::SessionExecutionTarget;
use ash_protocol::ThreadEvent;
use ash_protocol::ThreadItem;
use ash_thread_store::ThreadStore;
use ash_thread_store::ThreadStoreError;
use attachment_store::AttachmentStore;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use rusqlite::params;
use serde::Deserialize;
use serde::Serialize;
use sha2::Digest;
use sha2::Sha256;
use std::io::Read;
use std::io::Write;

const MAX_FRAME: usize = 32 * 1024 * 1024;
const MAX_ARCHIVE: u64 = 8 * 1024 * 1024 * 1024;
const VERSION: u32 = 1;

// Column order is part of this versioned data contract. SQL identifiers only come from this
// list, so a remote archive cannot add a table, execute SQL, or import account credentials.
const TABLES: &[(&str, &str)] = &[
    ("history_records", "digest,record_json"),
    ("thread_streams", "thread_id,current_sequence"),
    (
        "thread_batches",
        "thread_id,batch_id,expected_sequence,event_count",
    ),
    (
        "thread_events",
        "thread_id,sequence,event_id,schema_version,record_digest",
    ),
    (
        "thread_catalog",
        "thread_id,session_id,requires_startup_recovery,record_json,record_version,record_digest",
    ),
    (
        "session_catalog",
        "session_id,record_json,record_version,record_digest",
    ),
    ("agents", "agent_id,created_at_unix_ms"),
    (
        "agent_threads",
        "thread_id,agent_id,session_id,spawn_parent_id,replacement_source_id,binding_json",
    ),
    (
        "history_prefixes",
        "digest,source_thread_id,source_sequence",
    ),
    (
        "history_prefix_records",
        "prefix_digest,sequence,record_digest",
    ),
    ("history_prefix_links", "prefix_digest,child_digest"),
    ("thread_history_prefixes", "thread_id,prefix_digest"),
    (
        "history_workspace_refs",
        "record_digest,reference,git_directory,checkpoint_json",
    ),
    ("history_checkpoint_cleanup", "cleanup_key,checkpoint_json"),
    (
        "turn_change_sets",
        "change_set_id,thread_id,revision,record_json",
    ),
    (
        "turn_change_commands",
        "command_id,fingerprint,response_json",
    ),
];

#[derive(Serialize, Deserialize)]
#[serde(untagged)]
enum Cell {
    Integer(i64),
    Text(String),
    Null,
}

impl Cell {
    fn sql(self) -> rusqlite::types::Value {
        match self {
            Self::Integer(value) => value.into(),
            Self::Text(value) => value.into(),
            Self::Null => rusqlite::types::Value::Null,
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase", deny_unknown_fields)]
enum Frame {
    Header {
        version: u32,
        source: String,
        receiver: String,
    },
    Row {
        table: usize,
        cells: Vec<Cell>,
    },
    Attachment {
        digest: ContentDigest,
        size: u64,
    },
    End {
        digest: ContentDigest,
    },
}

/// A committed receipt remains valid when local history has advanced after import. Retrying
/// the same frozen source never merges or replaces that newer local history.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct HistoryImport {
    pub source: String,
    pub digest: ContentDigest,
    pub threads: usize,
}

pub(super) fn create_schema(connection: &Connection) -> Result<(), String> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS history_ownership (singleton INTEGER PRIMARY KEY CHECK(singleton = 1),
             profile_id TEXT NOT NULL UNIQUE, receiver TEXT);
         CREATE TABLE IF NOT EXISTS history_imports (source TEXT PRIMARY KEY, digest TEXT NOT NULL,
             host TEXT NOT NULL, thread_count INTEGER NOT NULL);
         CREATE TABLE IF NOT EXISTS remote_history_bindings (thread_id TEXT PRIMARY KEY REFERENCES thread_streams(thread_id) ON DELETE CASCADE,
             source TEXT NOT NULL REFERENCES history_imports(source), host TEXT NOT NULL, root TEXT);"
    ).map_err(|error| error.to_string())?;
    let mut random = [0_u8; 32];
    getrandom::getrandom(&mut random).map_err(|error| error.to_string())?;
    connection
        .execute(
            "INSERT OR IGNORE INTO history_ownership VALUES (1, ?1, NULL)",
            [ContentDigest::sha256(&random).as_str()],
        )
        .map_err(|error| error.to_string())?;
    for (table, _) in TABLES
        .iter()
        .copied()
        .chain([("remote_history_bindings", "")])
    {
        for operation in ["INSERT", "UPDATE", "DELETE"] {
            connection.execute_batch(&format!(
                "CREATE TRIGGER IF NOT EXISTS history_frozen_{table}_{operation} BEFORE {operation} ON {table}
                 WHEN (SELECT receiver FROM history_ownership WHERE singleton = 1) IS NOT NULL
                 BEGIN SELECT RAISE(ABORT, 'history ownership transferred'); END;"
            )).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

impl SqliteThreadStore {
    /// Hosts whose complete profile history has moved here no longer participate in remote
    /// Agent catalog discovery. Their runtime catalog remains available for execution services.
    pub fn imported_history_hosts(&self) -> Result<Vec<String>, ThreadStoreError> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare("SELECT DISTINCT host FROM history_imports ORDER BY host")
            .map_err(error)?;
        statement
            .query_map([], |row| row.get(0))
            .map_err(error)?
            .collect::<Result<_, _>>()
            .map_err(error)
    }
    /// Host commands stop the profile backend before binding, so no cached Thread can continue
    /// with its previous authority. A committed binding cannot silently move to another root.
    pub fn bind_imported_session(
        &self,
        session: &ash_protocol::SessionId,
        root: &str,
    ) -> Result<(), ThreadStoreError> {
        validate_root(root)?;
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let count: i64 = transaction.query_row("SELECT COUNT(*) FROM remote_history_bindings AS bindings JOIN thread_catalog AS catalog USING(thread_id) WHERE catalog.session_id = ?1", [session.as_str()], |row| row.get(0)).map_err(error)?;
        if count == 0 {
            return Err(error("Session is not imported remote history"));
        }
        let conflicting: bool = transaction.query_row("SELECT EXISTS(SELECT 1 FROM remote_history_bindings AS bindings JOIN thread_catalog AS catalog USING(thread_id) WHERE catalog.session_id = ?1 AND bindings.root IS NOT NULL AND bindings.root != ?2)", params![session.as_str(), root], |row| row.get(0)).map_err(error)?;
        if conflicting {
            return Err(error("Session already has a different execution directory"));
        }
        transaction.execute("UPDATE remote_history_bindings SET root = ?2 WHERE thread_id IN (SELECT thread_id FROM thread_catalog WHERE session_id = ?1) AND root IS NULL", params![session.as_str(), root]).map_err(error)?;
        transaction.commit().map_err(error)
    }
    /// Persistent profile identity is independent of directories, aliases and process IDs.
    pub fn history_identity(&self) -> Result<ContentDigest, ThreadStoreError> {
        let identity: String = self
            .connection()?
            .query_row(
                "SELECT profile_id FROM history_ownership WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .map_err(error)?;
        ContentDigest::new(identity).map_err(error)
    }

    /// A frozen source remains readable, but may never reopen a product history writer.
    pub fn history_receiver(&self) -> Result<Option<ContentDigest>, ThreadStoreError> {
        let receiver: Option<String> = self
            .connection()?
            .query_row(
                "SELECT receiver FROM history_ownership WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .map_err(error)?;
        receiver.map(ContentDigest::new).transpose().map_err(error)
    }

    /// Permanently closes all history writers, including connections opened before this call.
    /// The host stops its old Agent workers after this commit and before reading the archive.
    pub fn freeze_history(&self, receiver: &ContentDigest) -> Result<(), ThreadStoreError> {
        let source = self.history_identity()?;
        if source == *receiver {
            return Err(error("cannot transfer history to the same profile"));
        }
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let current: Option<String> = transaction
            .query_row(
                "SELECT receiver FROM history_ownership WHERE singleton = 1",
                [],
                |row| row.get(0),
            )
            .map_err(error)?;
        if current
            .as_deref()
            .is_some_and(|current| current != receiver.as_str())
        {
            return Err(error("history is already owned by another receiver"));
        }
        let imported: bool = transaction
            .query_row("SELECT EXISTS(SELECT 1 FROM history_imports)", [], |row| {
                row.get(0)
            })
            .map_err(error)?;
        if imported {
            return Err(error(
                "an imported profile cannot be exported as a remote source",
            ));
        }
        transaction.execute("UPDATE history_ownership SET receiver = ?1 WHERE singleton = 1 AND receiver IS NULL", [receiver.as_str()]).map_err(error)?;
        transaction.commit().map_err(error)?;
        Ok(())
    }

    /// IO failure or a lost acknowledgement does not return ownership to the source; the same
    /// receiver can request the same archive again. Original record bytes stay unchanged.
    pub fn export_history(
        &self,
        receiver: &ContentDigest,
        attachments: &dyn AttachmentStore,
        mut output: impl Write,
    ) -> Result<(), ThreadStoreError> {
        self.freeze_history(receiver)?;
        let source = self.history_identity()?;
        let connection = self.connection()?;
        connection.execute_batch("CREATE TEMP TABLE IF NOT EXISTS export_attachments (digest TEXT PRIMARY KEY, size INTEGER NOT NULL); DELETE FROM export_attachments;").map_err(error)?;
        let mut hash = Sha256::new();
        let mut total = 0;
        write_frame(
            &mut output,
            &Frame::Header {
                version: VERSION,
                source: source.to_string(),
                receiver: receiver.to_string(),
            },
            &mut hash,
            &mut total,
        )?;
        for (index, (table, columns)) in TABLES.iter().enumerate() {
            let count = columns.split(',').count();
            let order = (1..=count)
                .map(|column| column.to_string())
                .collect::<Vec<_>>()
                .join(",");
            let mut statement = connection
                .prepare(&format!("SELECT {columns} FROM {table} ORDER BY {order}"))
                .map_err(error)?;
            let mut rows = statement.query([]).map_err(error)?;
            while let Some(row) = rows.next().map_err(error)? {
                let cells = (0..count)
                    .map(|column| match row.get_ref(column).map_err(error)? {
                        rusqlite::types::ValueRef::Integer(value) => Ok(Cell::Integer(value)),
                        rusqlite::types::ValueRef::Text(value) => String::from_utf8(value.to_vec())
                            .map(Cell::Text)
                            .map_err(error),
                        rusqlite::types::ValueRef::Null => Ok(Cell::Null),
                        rusqlite::types::ValueRef::Real(_) | rusqlite::types::ValueRef::Blob(_) => {
                            Err(error("unsupported history cell"))
                        }
                    })
                    .collect::<Result<Vec<_>, _>>()?;
                if *table == "history_records" {
                    let json: String = row.get(1).map_err(error)?;
                    let digest: String = row.get(0).map_err(error)?;
                    let record = super::history::decode_record(&json, &digest)?;
                    record_attachments(&connection, &record)?;
                }
                write_frame(
                    &mut output,
                    &Frame::Row {
                        table: index,
                        cells,
                    },
                    &mut hash,
                    &mut total,
                )?;
            }
        }
        let mut statement = connection
            .prepare("SELECT digest, size FROM export_attachments ORDER BY digest")
            .map_err(error)?;
        let mut rows = statement.query([]).map_err(error)?;
        while let Some(row) = rows.next().map_err(error)? {
            let digest =
                ContentDigest::new(row.get::<_, String>(0).map_err(error)?).map_err(error)?;
            let size = u64::try_from(row.get::<_, i64>(1).map_err(error)?).map_err(error)?;
            let bytes = attachments.read(&digest, size).map_err(error)?;
            write_frame(
                &mut output,
                &Frame::Attachment { digest, size },
                &mut hash,
                &mut total,
            )?;
            write_bytes(&mut output, &bytes, &mut hash, &mut total)?;
        }
        let digest = hash_digest(hash.clone());
        write_frame(&mut output, &Frame::End { digest }, &mut hash, &mut total)?;
        output.flush().map_err(error)
    }

    /// Stages the bounded stream on disk, validates it, then installs the complete history and
    /// its receipt in one SQLite transaction. CAS attachment writes can leave harmless orphan
    /// blobs after failure; no Thread can reference them before the transaction commits.
    pub fn import_history(
        &self,
        host: &str,
        attachments: &dyn AttachmentStore,
        mut input: impl Read,
    ) -> Result<HistoryImport, ThreadStoreError> {
        validate_host(host)?;
        if self.history_receiver()?.is_some() {
            return Err(error("cannot import into a frozen profile"));
        }
        let directory = tempfile::tempdir_in(
            self.path()
                .parent()
                .ok_or_else(|| error("history store has no directory"))?,
        )
        .map_err(error)?;
        let staging = SqliteThreadStore::open(directory.path().join("history.sqlite3"))?;
        let identity = self.history_identity()?;
        let mut hash = Sha256::new();
        let mut total = 0;
        let Frame::Header {
            version: VERSION,
            source,
            receiver,
        } = read_frame(&mut input, &mut hash, &mut total)?
        else {
            return Err(error("invalid history archive header"));
        };
        let source = ContentDigest::new(source).map_err(error)?;
        if source == identity || receiver != identity.as_str() {
            return Err(error("history archive belongs to a different receiver"));
        }
        let digest;
        {
            let mut connection = staging.connection()?;
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .map_err(error)?;
            transaction.execute_batch("PRAGMA defer_foreign_keys = ON; CREATE TEMP TABLE export_attachments (digest TEXT PRIMARY KEY, size INTEGER NOT NULL); CREATE TEMP TABLE received_attachments (digest TEXT PRIMARY KEY, size INTEGER NOT NULL);").map_err(error)?;
            loop {
                let expected = hash_digest(hash.clone());
                match read_frame(&mut input, &mut hash, &mut total)? {
                    Frame::Row { table, cells } => {
                        let (name, columns) = TABLES
                            .get(table)
                            .ok_or_else(|| error("unknown history table"))?;
                        if cells.len() != columns.split(',').count() {
                            return Err(error("invalid history row width"));
                        }
                        let placeholders = vec!["?"; cells.len()].join(",");
                        let values = cells.into_iter().map(Cell::sql).collect::<Vec<_>>();
                        transaction
                            .execute(
                                &format!("INSERT INTO {name} ({columns}) VALUES ({placeholders})"),
                                rusqlite::params_from_iter(values),
                            )
                            .map_err(error)?;
                    }
                    Frame::Attachment { digest, size } => {
                        if size == 0 || size > attachment_store::MAX_ATTACHMENT_BYTES as u64 {
                            return Err(error("invalid archive attachment size"));
                        }
                        let bytes = read_bytes(&mut input, &mut hash, &mut total)?;
                        if bytes.len() as u64 != size || ContentDigest::sha256(&bytes) != digest {
                            return Err(error("archive attachment digest mismatch"));
                        }
                        if attachments.put(bytes.into()).map_err(error)? != digest {
                            return Err(error("attachment store identity mismatch"));
                        }
                        transaction
                            .execute(
                                "INSERT INTO received_attachments VALUES (?1, ?2)",
                                params![digest.as_str(), i64::try_from(size).map_err(error)?],
                            )
                            .map_err(error)?;
                    }
                    Frame::End { digest: actual } => {
                        if actual != expected {
                            return Err(error("history archive digest mismatch"));
                        }
                        let mut tail = [0];
                        if input.read(&mut tail).map_err(error)? != 0 {
                            return Err(error("history archive has trailing data"));
                        }
                        digest = actual;
                        break;
                    }
                    Frame::Header { .. } => return Err(error("duplicate history archive header")),
                }
            }
            verify_records(&transaction)?;
            let incomplete: bool = transaction.query_row("SELECT EXISTS(SELECT * FROM export_attachments EXCEPT SELECT * FROM received_attachments) OR EXISTS(SELECT * FROM received_attachments EXCEPT SELECT * FROM export_attachments)", [], |row| row.get(0)).map_err(error)?;
            if incomplete {
                return Err(error("archive attachments do not match history references"));
            }
            transaction.commit().map_err(error)?;
        }
        validate_store(&staging)?;
        let threads = staging.list_thread_ids()?;
        let receipt = HistoryImport {
            source: source.to_string(),
            digest,
            threads: threads.len(),
        };
        let mut connection = self.connection()?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let previous: Option<(String, String, i64)> = transaction
            .query_row(
                "SELECT digest, host, thread_count FROM history_imports WHERE source = ?1",
                [source.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()
            .map_err(error)?;
        if let Some((digest, previous_host, count)) = previous {
            if digest != receipt.digest.as_str()
                || previous_host != host
                || usize::try_from(count).map_err(error)? != receipt.threads
            {
                return Err(error("history source receipt conflicts"));
            }
            return Ok(receipt);
        }
        transaction
            .execute(
                "INSERT INTO history_imports VALUES (?1, ?2, ?3, ?4)",
                params![
                    source.as_str(),
                    receipt.digest.as_str(),
                    host,
                    i64::try_from(receipt.threads).map_err(error)?
                ],
            )
            .map_err(error)?;
        let staging_connection = staging.connection()?;
        for (name, columns) in TABLES {
            let mut statement = staging_connection
                .prepare(&format!("SELECT {columns} FROM {name}"))
                .map_err(error)?;
            let count = columns.split(',').count();
            let mut rows = statement.query([]).map_err(error)?;
            let placeholders = vec!["?"; count].join(",");
            while let Some(row) = rows.next().map_err(error)? {
                let values = (0..count)
                    .map(|index| row.get::<_, rusqlite::types::Value>(index))
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(error)?;
                // Shared immutable blobs may coincide. Every identity-bearing row uses INSERT
                // so any Thread, Session, Agent or command collision rolls back the whole import.
                if *name == "history_records" {
                    let existing: Option<String> = transaction
                        .query_row(
                            "SELECT record_json FROM history_records WHERE digest = ?1",
                            [&values[0]],
                            |row| row.get(0),
                        )
                        .optional()
                        .map_err(error)?;
                    if let Some(existing) = existing {
                        if values[1] != rusqlite::types::Value::Text(existing) {
                            return Err(error("shared history digest conflicts"));
                        }
                        continue;
                    }
                }
                transaction
                    .execute(
                        &format!("INSERT INTO {name} ({columns}) VALUES ({placeholders})"),
                        rusqlite::params_from_iter(values),
                    )
                    .map_err(error)?;
            }
        }
        drop(staging_connection);
        for thread in threads {
            let events = staging.load(&thread)?;
            let root = match &events
                .first()
                .ok_or_else(|| error("imported Thread is empty"))?
                .event
            {
                ThreadEvent::ThreadCreated {
                    execution_target: Some(SessionExecutionTarget::Local { root }),
                    ..
                } => {
                    let root = root
                        .to_str()
                        .ok_or_else(|| error("remote root is not UTF-8"))?;
                    validate_root(root)?;
                    Some(root.to_string())
                }
                ThreadEvent::ThreadCreated {
                    execution_target: None,
                    ..
                } => None,
                ThreadEvent::ThreadCreated {
                    execution_target: Some(SessionExecutionTarget::Ssh { .. }),
                    ..
                } => return Err(error("remote history cannot contain another SSH authority")),
                _ => return Err(error("imported Thread has no creation event")),
            };
            transaction
                .execute(
                    "INSERT INTO remote_history_bindings VALUES (?1, ?2, ?3, ?4)",
                    params![thread.as_str(), source.as_str(), host, root],
                )
                .map_err(error)?;
        }
        let divergent: bool = transaction.query_row("SELECT EXISTS(SELECT catalog.session_id FROM remote_history_bindings AS bindings JOIN thread_catalog AS catalog USING(thread_id) WHERE bindings.source = ?1 GROUP BY catalog.session_id HAVING COUNT(DISTINCT bindings.root) > 1)", [source.as_str()], |row| row.get(0)).map_err(error)?;
        if divergent {
            return Err(error(
                "Session history records different execution directories",
            ));
        }
        // Descendants share their Session's recorded authority. Only source records can supply
        // this value; a receiver window or export command directory never participates.
        transaction.execute("UPDATE remote_history_bindings AS binding SET root = (SELECT MAX(sibling.root) FROM remote_history_bindings AS sibling JOIN thread_catalog AS catalog ON sibling.thread_id = catalog.thread_id WHERE catalog.session_id = (SELECT session_id FROM thread_catalog WHERE thread_id = binding.thread_id)) WHERE source = ?1 AND root IS NULL", [source.as_str()]).map_err(error)?;
        transaction.commit().map_err(error)?;
        Ok(receipt)
    }
}

pub(super) fn execution_binding(
    connection: &Connection,
    thread: &ash_protocol::ThreadId,
) -> Result<ash_thread_store::ThreadExecutionBinding, ThreadStoreError> {
    let row: Option<(String, Option<String>)> = connection
        .query_row(
            "SELECT host, root FROM remote_history_bindings WHERE thread_id = ?1",
            [thread.as_str()],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()
        .map_err(error)?;
    Ok(match row {
        Some((host, root)) => ash_thread_store::ThreadExecutionBinding::Remote { host, root },
        None => ash_thread_store::ThreadExecutionBinding::Recorded,
    })
}

fn validate_host(host: &str) -> Result<(), ThreadStoreError> {
    if host.is_empty()
        || host.len() > 255
        || host.starts_with('-')
        || !host
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-@:%[]".contains(&byte))
    {
        return Err(error("invalid SSH host identity"));
    }
    Ok(())
}

fn validate_root(root: &str) -> Result<(), ThreadStoreError> {
    if !root.starts_with('/') || root.contains('\0') || root.len() > 4096 {
        return Err(error("invalid remote history root"));
    }
    Ok(())
}

fn validate_store(store: &SqliteThreadStore) -> Result<(), ThreadStoreError> {
    for thread in store.list_thread_ids()? {
        store.load(&thread)?;
    }
    for catalog in store.list_catalog()? {
        let binding = agent_graph_store::AgentGraphStore::read_thread_binding(
            store,
            &catalog.thread.thread_id,
        )
        .map_err(error)?;
        if binding.as_ref() != Some(&catalog.binding) {
            return Err(error("archive Agent binding disagrees with Thread catalog"));
        }
        let events = store.load(&catalog.thread.thread_id)?;
        let first = events
            .first()
            .ok_or_else(|| error("archive Thread has no creation event"))?;
        if ash_history::created_thread_agent_id(first).map_err(error)? != catalog.binding.agent_id {
            return Err(error(
                "archive Agent identity disagrees with original history",
            ));
        }
        let ThreadEvent::ThreadCreated {
            session_id, origin, ..
        } = &first.event
        else {
            return Err(error("archive Thread has no creation event"));
        };
        if session_id != &catalog.session_id {
            return Err(error(
                "archive Session identity disagrees with original history",
            ));
        }
        let mut recorded_origin = origin.clone();
        for record in &events {
            if let Some(inherited) = ash_history::inherited_thread_origin(&record.event) {
                if record.schema_version >= 16 && inherited != catalog.binding.origin {
                    return Err(error("archive inherited history disagrees with its origin"));
                }
                if record.schema_version < 16 {
                    recorded_origin = inherited;
                }
            }
        }
        if recorded_origin != catalog.binding.origin {
            return Err(error(
                "archive Thread origin disagrees with original history",
            ));
        }
        let connection = store.connection()?;
        let (parent, replacement): (Option<String>, Option<String>) = connection
            .query_row(
                "SELECT spawn_parent_id, replacement_source_id FROM agent_threads WHERE thread_id = ?1",
                [catalog.thread.thread_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(error)?;
        let expected_replacement = match &catalog.binding.origin {
            ash_protocol::ThreadOrigin::Replacement {
                source_thread_id, ..
            } => Some(source_thread_id.as_str()),
            _ => None,
        };
        if parent.as_deref()
            != catalog
                .binding
                .spawn_parent()
                .map(ash_protocol::ThreadId::as_str)
            || replacement.as_deref() != expected_replacement
        {
            return Err(error(
                "archive Agent relationship index disagrees with its binding",
            ));
        }
    }
    store.list_sessions()?;
    let connection = store.connection()?;
    // These indexes decide which immutable records survive deletion. Reconstruct their exact
    // edges from history before import, so a valid archive checksum cannot authorize different
    // retention or parentage than the original records describe.
    connection.execute_batch(
        "CREATE TEMP TABLE expected_prefix_links (prefix_digest TEXT, child_digest TEXT, PRIMARY KEY(prefix_digest, child_digest));
         CREATE TEMP TABLE expected_thread_prefixes (thread_id TEXT PRIMARY KEY, prefix_digest TEXT);",
    ).map_err(error)?;
    let mut statement = connection.prepare(
        "SELECT thread_id, record_json, digest FROM thread_events JOIN history_records ON record_digest = digest",
    ).map_err(error)?;
    let mut events = statement.query([]).map_err(error)?;
    while let Some(row) = events.next().map_err(error)? {
        let record = super::history::decode_record(
            &row.get::<_, String>(1).map_err(error)?,
            &row.get::<_, String>(2).map_err(error)?,
        )?;
        if let ThreadEvent::HistoryPrefixBound { thread_id, prefix } = record.event {
            super::history::read_prefix(&connection, &prefix)?;
            connection
                .execute(
                    "INSERT INTO expected_thread_prefixes VALUES (?1, ?2)",
                    params![thread_id.as_str(), prefix.digest.as_str()],
                )
                .map_err(error)?;
        }
    }
    let missing: bool = connection.query_row("SELECT EXISTS(SELECT thread_id FROM thread_streams EXCEPT SELECT thread_id FROM thread_catalog) OR EXISTS(SELECT thread_id FROM thread_streams EXCEPT SELECT thread_id FROM agent_threads)", [], |row| row.get(0)).map_err(error)?;
    if missing {
        return Err(error(
            "archive is missing Thread catalog or Agent identities",
        ));
    }
    let invalid_binding: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM agent_threads WHERE thread_id IS NOT json_extract(binding_json, '$.threadId') OR agent_id IS NOT json_extract(binding_json, '$.agentId') OR session_id IS NOT json_extract(binding_json, '$.sessionId'))", [], |row| row.get(0)).map_err(error)?;
    if invalid_binding {
        return Err(error("archive Agent index disagrees with its binding"));
    }
    let invalid_batches: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM (SELECT expected_sequence, event_count, COALESCE(SUM(event_count) OVER (PARTITION BY thread_id ORDER BY expected_sequence ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING), 0) AS previous FROM thread_batches) WHERE event_count <= 0 OR expected_sequence != previous) OR EXISTS(SELECT 1 FROM thread_streams AS streams WHERE current_sequence != COALESCE((SELECT SUM(event_count) FROM thread_batches WHERE thread_id = streams.thread_id), 0))", [], |row| row.get(0)).map_err(error)?;
    if invalid_batches {
        return Err(error("archive batches disagree with committed history"));
    }
    let mut changes = connection
        .prepare("SELECT change_set_id, thread_id, revision, record_json FROM turn_change_sets")
        .map_err(error)?;
    let mut changes = changes.query([]).map_err(error)?;
    while let Some(row) = changes.next().map_err(error)? {
        let value: git_turn_changes::TurnChangeSet =
            serde_json::from_str(&row.get::<_, String>(3).map_err(error)?).map_err(error)?;
        if value.change_set_id.as_str() != row.get::<_, String>(0).map_err(error)?
            || value.thread_id.as_str() != row.get::<_, String>(1).map_err(error)?
            || value.revision
                != u64::try_from(row.get::<_, i64>(2).map_err(error)?).map_err(error)?
        {
            return Err(error(
                "archive change-set metadata disagrees with its record",
            ));
        }
    }
    let mut statement = connection
        .prepare("SELECT digest, source_thread_id, source_sequence FROM history_prefixes")
        .map_err(error)?;
    let mut rows = statement.query([]).map_err(error)?;
    while let Some(row) = rows.next().map_err(error)? {
        let digest: String = row.get(0).map_err(error)?;
        let prefix = super::history::read_prefix(
            &connection,
            &ash_protocol::HistoryPrefixRef {
                digest: ContentDigest::new(digest.clone()).map_err(error)?,
                source_thread_id: ash_protocol::ThreadId::new(
                    row.get::<_, String>(1).map_err(error)?,
                )
                .map_err(error)?,
                source_sequence: u64::try_from(row.get::<_, i64>(2).map_err(error)?)
                    .map_err(error)?,
            },
        )?;
        for record in prefix.events {
            if let ThreadEvent::HistoryPrefixBound { prefix, .. } = record.event {
                super::history::read_prefix(&connection, &prefix)?;
                connection
                    .execute(
                        "INSERT OR IGNORE INTO expected_prefix_links VALUES (?1, ?2)",
                        params![digest, prefix.digest.as_str()],
                    )
                    .map_err(error)?;
            }
        }
    }
    let invalid_prefixes: bool = connection.query_row(
        "SELECT EXISTS(SELECT * FROM expected_prefix_links EXCEPT SELECT * FROM history_prefix_links)
             OR EXISTS(SELECT * FROM history_prefix_links EXCEPT SELECT * FROM expected_prefix_links)
             OR EXISTS(SELECT * FROM expected_thread_prefixes EXCEPT SELECT * FROM thread_history_prefixes)
             OR EXISTS(SELECT * FROM thread_history_prefixes EXCEPT SELECT * FROM expected_thread_prefixes)
             OR EXISTS(SELECT 1 FROM history_prefix_records JOIN history_records ON record_digest = digest
                 WHERE history_prefix_records.sequence IS NOT json_extract(record_json, '$.sequence'))",
        [], |row| row.get(0),
    ).map_err(error)?;
    if invalid_prefixes {
        return Err(error(
            "archive retained-history indexes disagree with original records",
        ));
    }
    Ok(())
}

fn verify_records(connection: &Connection) -> Result<(), ThreadStoreError> {
    let mut statement = connection
        .prepare("SELECT digest, record_json FROM history_records")
        .map_err(error)?;
    let mut rows = statement.query([]).map_err(error)?;
    while let Some(row) = rows.next().map_err(error)? {
        let record = super::history::decode_record(
            &row.get::<_, String>(1).map_err(error)?,
            &row.get::<_, String>(0).map_err(error)?,
        )?;
        record_attachments(connection, &record)?;
    }
    Ok(())
}

fn record_attachments(
    connection: &Connection,
    record: &StoredEvent,
) -> Result<(), ThreadStoreError> {
    let insert = |digest: &ContentDigest, size: u64| -> Result<(), ThreadStoreError> {
        let existing: Option<i64> = connection
            .query_row(
                "SELECT size FROM export_attachments WHERE digest = ?1",
                [digest.as_str()],
                |row| row.get(0),
            )
            .optional()
            .map_err(error)?;
        if existing.is_some_and(|existing| u64::try_from(existing).ok() != Some(size)) {
            return Err(error("conflicting attachment metadata"));
        }
        connection
            .execute(
                "INSERT OR IGNORE INTO export_attachments VALUES (?1, ?2)",
                params![digest.as_str(), i64::try_from(size).map_err(error)?],
            )
            .map_err(error)?;
        Ok(())
    };
    let item = |item: &ThreadItem| match item {
        ThreadItem::UserImageAttachment { attachment, .. } => {
            insert(&attachment.content_digest, attachment.encoded_bytes)
        }
        ThreadItem::UserAudioAttachment { attachment, .. } => {
            insert(&attachment.content_digest, attachment.encoded_bytes)
        }
        _ => Ok(()),
    };
    match &record.event {
        ThreadEvent::ItemCompleted { item: value, .. } => item(value)?,
        ThreadEvent::HistoryImported { turns, .. }
        | ThreadEvent::ForkHistoryImported { turns, .. } => {
            for turn in turns {
                for value in &turn.items {
                    item(value)?;
                }
            }
        }
        ThreadEvent::ForkTurnImported { turn, .. } => {
            for value in &turn.items {
                item(value)?;
            }
        }
        ThreadEvent::AgentContextSeedCommitted { seed, .. } => {
            for value in &seed.materialized_context {
                match &value.content {
                    ash_protocol::AgentContextContent::UserImageAttachment { attachment } => {
                        insert(&attachment.content_digest, attachment.encoded_bytes)?
                    }
                    ash_protocol::AgentContextContent::UserAudioAttachment { attachment } => {
                        insert(&attachment.content_digest, attachment.encoded_bytes)?
                    }
                    _ => {}
                }
            }
        }
        _ => {}
    }
    Ok(())
}

fn hash_digest(hash: Sha256) -> ContentDigest {
    ContentDigest::new(format!("sha256:{:x}", hash.finalize())).expect("SHA-256 encoding is valid")
}

fn write_frame(
    output: &mut impl Write,
    frame: &Frame,
    hash: &mut Sha256,
    total: &mut u64,
) -> Result<(), ThreadStoreError> {
    write_bytes(
        output,
        &serde_json::to_vec(frame).map_err(error)?,
        hash,
        total,
    )
}

fn write_bytes(
    output: &mut impl Write,
    bytes: &[u8],
    hash: &mut Sha256,
    total: &mut u64,
) -> Result<(), ThreadStoreError> {
    count_bytes(bytes.len(), total)?;
    let length = (bytes.len() as u32).to_be_bytes();
    output.write_all(&length).map_err(error)?;
    output.write_all(bytes).map_err(error)?;
    hash.update(length);
    hash.update(bytes);
    Ok(())
}

fn read_frame(
    input: &mut impl Read,
    hash: &mut Sha256,
    total: &mut u64,
) -> Result<Frame, ThreadStoreError> {
    serde_json::from_slice(&read_bytes(input, hash, total)?).map_err(error)
}

fn read_bytes(
    input: &mut impl Read,
    hash: &mut Sha256,
    total: &mut u64,
) -> Result<Vec<u8>, ThreadStoreError> {
    let mut length = [0; 4];
    input.read_exact(&mut length).map_err(error)?;
    let size = u32::from_be_bytes(length) as usize;
    count_bytes(size, total)?;
    let mut bytes = vec![0; size];
    input.read_exact(&mut bytes).map_err(error)?;
    hash.update(length);
    hash.update(&bytes);
    Ok(bytes)
}

fn count_bytes(size: usize, total: &mut u64) -> Result<(), ThreadStoreError> {
    if size > MAX_FRAME {
        return Err(error("history frame exceeds the byte limit"));
    }
    *total += size as u64 + 4;
    if *total > MAX_ARCHIVE {
        return Err(error("history archive exceeds the byte limit"));
    }
    Ok(())
}

#[cfg(test)]
#[path = "handoff_tests.rs"]
mod tests;

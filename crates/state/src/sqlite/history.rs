use ash_history::HistoryPrefix;
use ash_history::StoredEvent;
use ash_protocol::ContentDigest;
use ash_protocol::HistoryPrefixRef;
use ash_protocol::ThreadEvent;
use ash_thread_store::ThreadStoreError;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::params;

pub(super) fn error(error: impl std::fmt::Display) -> ThreadStoreError {
    ThreadStoreError::Storage(error.to_string())
}

pub(super) fn write_record(
    connection: &Connection,
    record: &StoredEvent,
) -> Result<String, ThreadStoreError> {
    let existing = connection.query_row(
        "SELECT record_digest FROM thread_events WHERE event_id = ?1 AND thread_id = ?2 AND sequence = ?3
         UNION SELECT links.record_digest FROM history_prefix_records links JOIN history_prefixes prefixes ON prefixes.digest = links.prefix_digest
         WHERE prefixes.source_thread_id = ?2 AND links.sequence = ?3 LIMIT 1",
        params![record.event_id.0, record.thread_id.as_str(), i64::try_from(record.sequence).map_err(error)?], |row| row.get::<_, String>(0),
    ).optional().map_err(error)?;
    if let Some(digest) = existing {
        let json: String = connection
            .query_row(
                "SELECT record_json FROM history_records WHERE digest = ?1",
                [&digest],
                |row| row.get(0),
            )
            .map_err(error)?;
        if decode_record(&json, &digest)? != *record {
            return Err(error("retained event identity has conflicting content"));
        }
        return Ok(digest);
    }
    let json = serde_json::to_string(record).map_err(error)?;
    write_blob(connection, &json)
}

fn write_blob(connection: &Connection, json: &str) -> Result<String, ThreadStoreError> {
    let digest = ContentDigest::sha256(json.as_bytes()).as_str().to_string();
    connection
        .execute(
            "INSERT OR IGNORE INTO history_records (digest, record_json) VALUES (?1, ?2)",
            params![digest, json],
        )
        .map_err(error)?;
    let record: StoredEvent = serde_json::from_str(json).map_err(error)?;
    for checkpoint in ash_history::repository_checkpoints(&record.event) {
        connection.execute("INSERT OR IGNORE INTO history_workspace_refs (record_digest, reference, git_directory, checkpoint_json) VALUES (?1, ?2, ?3, ?4)",
            params![digest, checkpoint.reference, checkpoint.git_directory, serde_json::to_string(checkpoint).map_err(error)?]).map_err(error)?;
    }
    Ok(digest)
}

pub(super) fn write_prefix(
    connection: &Connection,
    prefix: &HistoryPrefix,
) -> Result<(), ThreadStoreError> {
    let reference = prefix.reference().map_err(error)?;
    connection.execute("INSERT OR IGNORE INTO history_prefixes (digest, source_thread_id, source_sequence) VALUES (?1, ?2, ?3)",
        params![reference.digest.as_str(), reference.source_thread_id.as_str(), i64::try_from(reference.source_sequence).map_err(error)?]).map_err(error)?;
    for event in &prefix.events {
        let record_digest = write_record(connection, event)?;
        connection.execute("INSERT OR IGNORE INTO history_prefix_records (prefix_digest, sequence, record_digest) VALUES (?1, ?2, ?3)",
            params![reference.digest.as_str(), i64::try_from(event.sequence).map_err(error)?, record_digest]).map_err(error)?;
        if let ThreadEvent::HistoryPrefixBound { prefix, .. } = &event.event {
            read_prefix(connection, prefix)?;
            connection.execute("INSERT OR IGNORE INTO history_prefix_links (prefix_digest, child_digest) VALUES (?1, ?2)",
                params![reference.digest.as_str(), prefix.digest.as_str()]).map_err(error)?;
        }
    }
    read_prefix(connection, &reference)?;
    Ok(())
}

pub(super) fn read_prefix(
    connection: &Connection,
    reference: &HistoryPrefixRef,
) -> Result<HistoryPrefix, ThreadStoreError> {
    let header = connection
        .query_row(
            "SELECT source_thread_id, source_sequence FROM history_prefixes WHERE digest = ?1",
            [reference.digest.as_str()],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
        )
        .optional()
        .map_err(error)?
        .ok_or_else(|| error("retained history prefix is missing"))?;
    if header.0 != reference.source_thread_id.as_str()
        || u64::try_from(header.1).map_err(error)? != reference.source_sequence
    {
        return Err(error(
            "history prefix source metadata disagrees with its reference",
        ));
    }
    let mut statement = connection.prepare("SELECT records.record_json, records.digest FROM history_prefix_records AS links JOIN history_records AS records ON records.digest = links.record_digest WHERE links.prefix_digest = ?1 ORDER BY links.sequence").map_err(error)?;
    let events = statement
        .query_map([reference.digest.as_str()], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(error)?
        .map(|row| {
            let (json, digest) = row.map_err(error)?;
            decode_record(&json, &digest)
        })
        .collect::<Result<Vec<_>, _>>()?;
    let prefix = HistoryPrefix { events };
    prefix.validate(reference).map_err(error)?;
    Ok(prefix)
}

pub(super) fn decode_record(json: &str, digest: &str) -> Result<StoredEvent, ThreadStoreError> {
    if ContentDigest::sha256(json.as_bytes()).as_str() != digest {
        return Err(error("retained history record digest mismatch"));
    }
    serde_json::from_str(json).map_err(error)
}

pub(super) fn bind_prefix(
    connection: &Connection,
    event: &StoredEvent,
) -> Result<(), ThreadStoreError> {
    if let ThreadEvent::HistoryPrefixBound { thread_id, prefix } = &event.event {
        read_prefix(connection, prefix)?;
        connection
            .execute(
                "INSERT INTO thread_history_prefixes (thread_id, prefix_digest) VALUES (?1, ?2)",
                params![thread_id.as_str(), prefix.digest.as_str()],
            )
            .map_err(error)?;
    }
    Ok(())
}

/// Reclaims only prefixes and original record blobs unreachable from every remaining Thread.
pub(super) fn collect(connection: &Connection) -> Result<(), ThreadStoreError> {
    connection.execute_batch("CREATE TEMP TABLE retained_prefixes AS
        WITH RECURSIVE retained(digest) AS (
            SELECT prefix_digest FROM thread_history_prefixes
            UNION SELECT links.child_digest FROM history_prefix_links links JOIN retained ON links.prefix_digest = retained.digest
        ) SELECT digest FROM retained;
        DELETE FROM history_prefix_links WHERE prefix_digest NOT IN (SELECT digest FROM retained_prefixes);
        DELETE FROM history_prefix_records WHERE prefix_digest NOT IN (SELECT digest FROM retained_prefixes);
        DELETE FROM history_prefixes WHERE digest NOT IN (SELECT digest FROM retained_prefixes);
        DROP TABLE retained_prefixes;
        CREATE TEMP TABLE unused_history AS SELECT digest FROM history_records WHERE digest NOT IN (SELECT record_digest FROM thread_events)
            AND digest NOT IN (SELECT record_digest FROM history_prefix_records);").map_err(error)?;
    let checkpoints = {
        let mut statement = connection.prepare("SELECT DISTINCT checkpoint_json FROM history_workspace_refs WHERE record_digest IN (SELECT digest FROM unused_history)").map_err(error)?;
        statement
            .query_map([], |row| row.get::<_, String>(0))
            .map_err(error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(error)?
    };
    connection.execute_batch("DELETE FROM history_workspace_refs WHERE record_digest IN (SELECT digest FROM unused_history);
        DELETE FROM history_records WHERE digest IN (SELECT digest FROM unused_history); DROP TABLE unused_history;").map_err(error)?;
    for json in checkpoints {
        let checkpoint: ash_protocol::RepositoryCheckpoint =
            serde_json::from_str(&json).map_err(error)?;
        let retained = connection.query_row("SELECT 1 FROM history_workspace_refs WHERE reference = ?1 AND git_directory = ?2 LIMIT 1", params![checkpoint.reference, checkpoint.git_directory], |_| Ok(())).optional().map_err(error)?.is_some();
        if !retained {
            connection.execute("INSERT OR IGNORE INTO history_checkpoint_cleanup (cleanup_key, checkpoint_json) VALUES (?1, ?2)", params![ContentDigest::sha256(json.as_bytes()).as_str(), json]).map_err(error)?;
        }
    }
    Ok(())
}

pub(super) fn create_schema(connection: &Connection) -> Result<(), String> {
    connection.execute_batch("CREATE TABLE IF NOT EXISTS history_records (digest TEXT PRIMARY KEY, record_json TEXT NOT NULL);
        CREATE TABLE history_prefixes (digest TEXT PRIMARY KEY, source_thread_id TEXT NOT NULL, source_sequence INTEGER NOT NULL);
        CREATE TABLE history_prefix_records (prefix_digest TEXT NOT NULL REFERENCES history_prefixes(digest), sequence INTEGER NOT NULL, record_digest TEXT NOT NULL REFERENCES history_records(digest), PRIMARY KEY(prefix_digest, sequence));
        CREATE TABLE history_prefix_links (prefix_digest TEXT NOT NULL REFERENCES history_prefixes(digest), child_digest TEXT NOT NULL REFERENCES history_prefixes(digest), PRIMARY KEY(prefix_digest, child_digest));
        CREATE TABLE thread_history_prefixes (thread_id TEXT PRIMARY KEY REFERENCES thread_streams(thread_id), prefix_digest TEXT NOT NULL REFERENCES history_prefixes(digest));
        CREATE TABLE history_workspace_refs (record_digest TEXT NOT NULL REFERENCES history_records(digest), reference TEXT NOT NULL, git_directory TEXT NOT NULL, checkpoint_json TEXT NOT NULL, PRIMARY KEY(record_digest, reference, git_directory));
        CREATE INDEX history_workspace_references ON history_workspace_refs(reference, git_directory);
        CREATE TABLE history_checkpoint_cleanup (cleanup_key TEXT PRIMARY KEY, checkpoint_json TEXT NOT NULL);
        CREATE INDEX history_prefix_records_digest ON history_prefix_records(record_digest);").map_err(|error| error.to_string())
}

/// Moves existing immutable bytes into shared record storage without rewriting their envelopes.
pub(super) fn migrate_records(connection: &Connection) -> Result<(), String> {
    let rows = {
        let mut statement = connection.prepare("SELECT thread_id, sequence, event_id, schema_version, envelope_json FROM thread_events").map_err(|error| error.to_string())?;
        statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                ))
            })
            .map_err(|error| error.to_string())?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| error.to_string())?
    };
    connection.execute_batch("CREATE TABLE thread_event_refs (
        thread_id TEXT NOT NULL REFERENCES thread_streams(thread_id), sequence INTEGER NOT NULL, event_id TEXT NOT NULL UNIQUE,
        schema_version INTEGER NOT NULL, record_digest TEXT NOT NULL REFERENCES history_records(digest), PRIMARY KEY(thread_id, sequence));").map_err(|error| error.to_string())?;
    for (thread, sequence, event, version, json) in rows {
        let digest = write_blob(connection, &json).map_err(|error| error.to_string())?;
        connection
            .execute(
                "INSERT INTO thread_event_refs VALUES (?1, ?2, ?3, ?4, ?5)",
                params![thread, sequence, event, version, digest],
            )
            .map_err(|error| error.to_string())?;
    }
    connection
        .execute_batch(
            "DROP TABLE thread_events; ALTER TABLE thread_event_refs RENAME TO thread_events;",
        )
        .map_err(|error| error.to_string())
}

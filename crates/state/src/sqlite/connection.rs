use ash_protocol::ContentDigest;
use ash_protocol::SessionId;
use ash_sqlite::Migration;
use ash_sqlite::Migrator;
use ash_thread_store::ThreadCatalogRecord;
use ash_thread_store::ThreadStoreError;
use rusqlite::Connection;
use rusqlite::Transaction;
use rusqlite::params;
use std::path::Path;

use crate::SqliteDurability;
use crate::open_sqlite_database;

// Keep the released v17 baseline. Append immutable numbered SQL from v18 onward.
const BASELINE: Migration = Migration::legacy_baseline(17, upgrade_to_v17);
const MIGRATOR: Migrator<'_> = Migrator::new("event-store", &[BASELINE]);

pub(super) fn open(path: &Path) -> Result<Connection, String> {
    let mut connection = open_sqlite_database(path, SqliteDurability::Durable)?;
    MIGRATOR.run(&mut connection)?;
    Ok(connection)
}

// Preserve the released upgrade paths, including the Rust backfills for historical data.
fn upgrade_to_v17(
    transaction: &Transaction<'_>,
    locked_version: Option<u32>,
) -> Result<(), String> {
    match locked_version {
        None => transaction
            .execute_batch(include_str!(
                "../../migrations/event-store/legacy/initial_tables.sql"
            ))
            .map_err(sql_error)?,
        Some(1) => transaction
            .execute_batch(include_str!(
                "../../migrations/event-store/legacy/from_v1_turn_changes.sql"
            ))
            .map_err(sql_error)?,
        Some(2) => transaction
            .execute_batch(include_str!(
                "../../migrations/event-store/legacy/from_v2_turn_change_commands.sql"
            ))
            .map_err(sql_error)?,
        Some(3) => transaction
            .execute_batch(include_str!(
                "../../migrations/event-store/legacy/from_v3_remove_session_streams.sql"
            ))
            .map_err(sql_error)?,
        Some(4..=16) => {}
        Some(version) => {
            return Err(format!(
                "unsupported event-store SQLite schema version {version}"
            ));
        }
    }
    transaction
        .execute_batch(include_str!(
            "../../migrations/event-store/legacy/thread_catalog.sql"
        ))
        .map_err(sql_error)?;
    transaction
        .execute_batch(concat!(
            include_str!("../../migrations/shared/agents.sql"),
            include_str!("../../migrations/event-store/legacy/agent_graph.sql")
        ))
        .map_err(sql_error)?;
    if locked_version.is_some_and(|version| version < 6) {
        super::graph::migrate_bindings(transaction).map_err(sql_error)?;
    }
    if locked_version.is_none_or(|version| version < 7) {
        super::history::create_schema(transaction)?;
        if locked_version.is_some() {
            super::history::migrate_records(transaction)?;
        }
    }
    if locked_version.is_some_and(|version| version < 15) {
        // A Thread history cursor retains both its destination and its Redo source.
        transaction
            .execute_batch(include_str!(
                "../../migrations/event-store/legacy/0015_keep_history_prefix_sources.sql"
            ))
            .map_err(sql_error)?;
    }
    if locked_version.is_some_and(|version| version < 8) {
        let has_record_version = {
            let mut statement = transaction
                .prepare("PRAGMA table_info(thread_catalog)")
                .map_err(sql_error)?;
            statement
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(sql_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sql_error)?
                .into_iter()
                .any(|name| name == "record_version")
        };
        if !has_record_version {
            transaction
                .execute_batch(include_str!(
                    "../../migrations/event-store/legacy/0008_catalog_digests.sql"
                ))
                .map_err(sql_error)?;
        }
        let mut statement = transaction
            .prepare(
                "SELECT catalog.thread_id, catalog.session_id, catalog.requires_startup_recovery,
                        catalog.record_json, streams.current_sequence
                 FROM thread_catalog AS catalog
                 JOIN thread_streams AS streams ON streams.thread_id = catalog.thread_id",
            )
            .map_err(sql_error)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i64>(4)?,
                ))
            })
            .map_err(sql_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(sql_error)?;
        drop(statement);
        for row in rows {
            let (thread_id, session_id, requires_recovery, json, sequence) = row;
            let Ok(record) = serde_json::from_str::<ThreadCatalogRecord>(&json) else {
                continue;
            };
            if record.thread.thread_id.as_str() != thread_id
                || record.session_id.as_str() != session_id
                || i64::from(record.requires_startup_recovery) != requires_recovery
                || i64::try_from(record.sequence).ok() != Some(sequence)
            {
                continue;
            }
            transaction
                .execute(
                    "UPDATE thread_catalog SET record_version = 1, record_digest = ?1
                     WHERE thread_id = ?2",
                    params![ContentDigest::sha256(json.as_bytes()).as_str(), thread_id],
                )
                .map_err(sql_error)?;
        }
    }
    if locked_version.is_none_or(|version| version < 9) {
        transaction
            .execute_batch(include_str!(
                "../../migrations/event-store/legacy/0009_session_catalog.sql"
            ))
            .map_err(sql_error)?;
    }
    if locked_version.is_none_or(|version| version < 11) {
        super::git_turn_commits::create_schema(transaction)?;
    }
    transaction
        .execute_batch(include_str!(
            "../../migrations/event-store/legacy/thread_links.sql"
        ))
        .map_err(sql_error)?;
    if locked_version.is_none_or(|version| version < 16)
        && !transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('thread_pull_requests') WHERE name = 'is_artifact')",
            [],
            |row| row.get::<_, bool>(0),
        ).map_err(sql_error)?
    {
        transaction
            .execute_batch(include_str!("../../migrations/event-store/legacy/0016_mark_pr_artifacts.sql"))
            .map_err(sql_error)?;
    }
    if locked_version.is_none_or(|version| version < 14) {
        super::handoff::create_schema(transaction)?;
    }
    if locked_version.is_none_or(|version| version < 17)
        && !transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('thread_pull_requests') WHERE name = 'artifact_id')",
            [],
            |row| row.get::<_, bool>(0),
        ).map_err(sql_error)?
    {
        transaction
            .execute_batch(include_str!(
                "../../migrations/event-store/0017_pull_request_artifact_identity.sql"
            ))
            .map_err(sql_error)?;
    }
    if locked_version.is_some_and(|version| version < 13) {
        // Session cache format 3 adds branch management from verified catalog rows.
        // Thread rows keep version 2, so opening an old profile does not replay histories.
        let session_ids = {
            let mut statement = transaction
                .prepare("SELECT DISTINCT session_id FROM thread_catalog ORDER BY session_id")
                .map_err(sql_error)?;
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(sql_error)?
                .collect::<Result<Vec<_>, _>>()
                .map_err(sql_error)?
        };
        for session_id in session_ids {
            let session_id = SessionId::new(session_id).map_err(sql_error)?;
            match super::thread::write_session_catalog(transaction, &session_id) {
                Ok(()) | Err(ThreadStoreError::CatalogDamaged(_)) => {}
                Err(error) => return Err(error.to_string()),
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "connection_migrations_tests.rs"]
mod migration_tests;

pub(super) fn to_sql_integer(value: u64) -> Result<i64, String> {
    i64::try_from(value).map_err(|_| "event sequence exceeds SQLite integer range".into())
}

pub(super) fn from_sql_integer(value: i64) -> Result<u64, String> {
    u64::try_from(value).map_err(|_| "event sequence is negative".into())
}

pub(super) fn sql_error(error: impl std::fmt::Display) -> String {
    format!("SQLite event-store error: {error}")
}

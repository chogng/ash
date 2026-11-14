use super::BASELINE;
use super::MIGRATOR;
use super::Migration;
use super::Migrator;
use super::open;
use crate::SqliteDurability;
use crate::SqliteTeamStore;
use crate::SqliteThreadStore;
use crate::open_sqlite_database;
use rusqlite::Connection;
use std::path::Path;
use std::sync::Barrier;
use std::thread;

const CREATE_PROBE: Migration = Migration::sql(
    18,
    "CREATE TABLE migration_probe (step INTEGER NOT NULL);
     INSERT INTO migration_probe VALUES (18);",
);
const MIGRATIONS: &[Migration] = &[
    BASELINE,
    CREATE_PROBE,
    Migration::sql(19, "UPDATE migration_probe SET step = step + 1;"),
];

fn open_with_migrations(path: &Path, migrations: &[Migration]) -> Result<Connection, String> {
    let mut connection = open_sqlite_database(path, SqliteDurability::Durable)?;
    Migrator::new("event-store", migrations).run(&mut connection)?;
    Ok(connection)
}

fn assert_migrated(connection: &Connection) {
    assert_eq!(
        Migrator::new("event-store", MIGRATIONS)
            .version(connection)
            .unwrap(),
        Some(19)
    );
    let steps = connection
        .prepare("SELECT step FROM migration_probe")
        .unwrap()
        .query_map([], |row| row.get::<_, u32>(0))
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(steps, [19]);
}

#[test]
fn empty_database_installs_baseline_then_runs_numbered_sql() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.sqlite3");

    let connection = open_with_migrations(&path, &MIGRATIONS[..2]).unwrap();
    assert_eq!(
        Migrator::new("event-store", MIGRATIONS)
            .version(&connection)
            .unwrap(),
        Some(18)
    );
    let profile_id: String = connection
        .query_row("SELECT profile_id FROM history_ownership", [], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(!profile_id.is_empty());
    drop(connection);

    assert_migrated(&open_with_migrations(&path, MIGRATIONS).unwrap());
    assert_migrated(&open_with_migrations(&path, MIGRATIONS).unwrap());
}

#[test]
fn legacy_database_backfills_artifact_identity_before_numbered_sql() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.sqlite3");
    let connection = open(&path).unwrap();
    connection
        .execute_batch(
            "ALTER TABLE thread_pull_requests DROP COLUMN artifact_source_turn;
             ALTER TABLE thread_pull_requests DROP COLUMN artifact_source_thread;
             ALTER TABLE thread_pull_requests DROP COLUMN artifact_id;
             UPDATE ash_schema_migrations SET version = 16 WHERE component = 'event-store';
             INSERT INTO thread_streams VALUES ('legacy-thread', 0);
             INSERT INTO thread_pull_requests VALUES ('legacy-thread', 'github.com', 'ash', 'ash', 7, 1);",
        )
        .unwrap();
    drop(connection);

    let connection = open_with_migrations(&path, MIGRATIONS).unwrap();
    assert_migrated(&connection);
    let artifact_id: String = connection
        .query_row(
            "SELECT artifact_id FROM thread_pull_requests WHERE thread_id = 'legacy-thread'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(artifact_id.len(), 32);
}

#[test]
fn concurrent_open_applies_numbered_sql_once() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.sqlite3");
    drop(open(&path).unwrap());

    let workers = 4;
    let barrier = Barrier::new(workers);
    thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                barrier.wait();
                assert_migrated(&open_with_migrations(&path, MIGRATIONS).unwrap());
            });
        }
    });
}

#[test]
fn failed_sql_rolls_back_schema_and_version_and_can_be_retried() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.sqlite3");
    drop(open(&path).unwrap());
    let broken = [
        BASELINE,
        CREATE_PROBE,
        Migration::sql(19, "INSERT INTO missing_table VALUES (1);"),
    ];

    let error = open_with_migrations(&path, &broken).unwrap_err();
    assert!(error.contains("event-store SQLite migration 19 failed"));
    let connection = open(&path).unwrap();
    assert_eq!(MIGRATOR.version(&connection).unwrap(), Some(17));
    let probe_exists: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name = 'migration_probe')",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(!probe_exists);
    drop(connection);

    assert_migrated(&open_with_migrations(&path, MIGRATIONS).unwrap());
}

#[test]
fn rejects_a_database_migrated_by_a_newer_binary() {
    let directory = tempfile::tempdir().unwrap();
    let path = directory.path().join("state.sqlite3");
    drop(open_with_migrations(&path, MIGRATIONS).unwrap());

    assert_eq!(
        open(&path).unwrap_err(),
        "unsupported event-store SQLite schema version 19"
    );
    assert_migrated(&open_with_migrations(&path, MIGRATIONS).unwrap());
}

#[test]
fn team_and_event_stores_can_install_their_schemas_in_either_order() {
    let directory = tempfile::tempdir().unwrap();
    for teams_first in [true, false] {
        let path = directory
            .path()
            .join(format!("teams-first-{teams_first}.sqlite3"));
        if teams_first {
            SqliteTeamStore::open(&path).unwrap();
            SqliteThreadStore::open(&path).unwrap();
        } else {
            SqliteThreadStore::open(&path).unwrap();
            SqliteTeamStore::open(&path).unwrap();
        }
        let connection = Connection::open(&path).unwrap();
        let versions = connection
            .prepare("SELECT component, version FROM ash_schema_migrations ORDER BY component")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            versions,
            [
                ("event-store".into(), 17),
                ("teams".into(), 1),
                ("thread-completions".into(), 1),
                ("thread-history-index".into(), 2),
                ("thread-voice-index".into(), 1),
            ]
        );
    }
}

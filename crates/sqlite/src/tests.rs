use crate::Migration;
use crate::Migrator;
use crate::SqliteDurability;
use crate::open_sqlite_database;
use std::sync::Barrier;

const MIGRATIONS: &[Migration] = &[
    Migration::sql(
        1,
        "CREATE TABLE probe (value INTEGER); INSERT INTO probe VALUES (1);",
    ),
    Migration::sql(2, "UPDATE probe SET value = value + 1;"),
];

#[test]
fn concurrent_open_applies_each_component_migration_once() {
    let dir = tempfile::tempdir().unwrap();
    let path = dir.path().join("nested/database.sqlite3");
    let barrier = Barrier::new(4);
    std::thread::scope(|scope| {
        for _ in 0..4 {
            let barrier = &barrier;
            let path = &path;
            scope.spawn(move || {
                barrier.wait();
                let mut connection = open_sqlite_database(path, SqliteDurability::Durable).unwrap();
                Migrator::new("probe", MIGRATIONS)
                    .run(&mut connection)
                    .unwrap();
            });
        }
    });
    let mut connection = open_sqlite_database(&path, SqliteDurability::Durable).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT value FROM probe", [], |row| row.get::<_, i32>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i32>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        connection
            .query_row("PRAGMA synchronous", [], |row| row.get::<_, i32>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        connection
            .query_row("PRAGMA journal_mode", [], |row| row.get::<_, String>(0))
            .unwrap(),
        "wal"
    );
    Migrator::new(
        "other",
        &[Migration::sql(1, "CREATE TABLE other (id INTEGER);")],
    )
    .run(&mut connection)
    .unwrap();
    assert_eq!(
        Migrator::new("probe", MIGRATIONS)
            .version(&connection)
            .unwrap(),
        Some(2)
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            std::fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
}

#[test]
fn failed_migration_rolls_back_schema_data_and_version_together() {
    let dir = tempfile::tempdir().unwrap();
    let mut connection =
        open_sqlite_database(&dir.path().join("probe.sqlite3"), SqliteDurability::Durable).unwrap();
    Migrator::new("probe", &MIGRATIONS[..1])
        .run(&mut connection)
        .unwrap();
    let failed = [
        Migration::sql(1, ""),
        Migration::sql(
            2,
            "UPDATE probe SET value = 99; INSERT INTO missing VALUES (1);",
        ),
    ];
    assert!(
        Migrator::new("probe", &failed)
            .run(&mut connection)
            .is_err()
    );
    assert_eq!(
        connection
            .query_row("SELECT value FROM probe", [], |row| row.get::<_, i32>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        Migrator::new("probe", MIGRATIONS)
            .version(&connection)
            .unwrap(),
        Some(1)
    );
    Migrator::new("probe", MIGRATIONS)
        .run(&mut connection)
        .unwrap();
    assert_eq!(
        connection
            .query_row("SELECT value FROM probe", [], |row| row.get::<_, i32>(0))
            .unwrap(),
        2
    );
}

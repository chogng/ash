use rusqlite::Connection;
use rusqlite::ErrorCode;
use rusqlite::OptionalExtension;
use rusqlite::Transaction;
use rusqlite::TransactionBehavior;
use std::time::Duration;
use std::time::Instant;

pub(crate) type Migration = fn(&Transaction<'_>) -> rusqlite::Result<()>;

pub(crate) fn configure_connection(connection: &Connection) -> rusqlite::Result<()> {
    connection.busy_timeout(Duration::from_secs(5))?;
    connection.pragma_update(None, "foreign_keys", "ON")?;
    // The first WAL switch can report contention before SQLite invokes its busy handler.
    let retry_until = Instant::now() + Duration::from_secs(1);
    loop {
        match connection.pragma_update(None, "journal_mode", "WAL") {
            Err(rusqlite::Error::SqliteFailure(error, _))
                if Instant::now() < retry_until
                    && matches!(
                        error.code,
                        ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked
                    ) =>
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            result => return result,
        }
    }
}

pub(crate) fn migrate(
    connection: &Connection,
    component: &str,
    migrations: &[Migration],
) -> Result<(), String> {
    // Channel resources are shared with the Call store, whose public setup takes &Connection.
    let transaction = Transaction::new_unchecked(connection, TransactionBehavior::Immediate)
        .map_err(sql_error)?;
    transaction
        .execute_batch(
            "CREATE TABLE IF NOT EXISTS ash_schema_migrations (
                 component TEXT PRIMARY KEY, version INTEGER NOT NULL
             );",
        )
        .map_err(sql_error)?;
    let version: Option<u32> = transaction
        .query_row(
            "SELECT version FROM ash_schema_migrations WHERE component = ?1",
            [component],
            |row| row.get(0),
        )
        .optional()
        .map_err(sql_error)?;
    if let Some(version) = version
        && !(1..=migrations.len() as u32).contains(&version)
    {
        return Err(format!(
            "unsupported {component} SQLite schema version {version}"
        ));
    }
    for (target, migration) in (1_u32..)
        .zip(migrations)
        .skip(version.unwrap_or(0) as usize)
    {
        migration(&transaction).map_err(sql_error)?;
        transaction
            .execute(
                "INSERT INTO ash_schema_migrations (component, version) VALUES (?1, ?2)
                 ON CONFLICT(component) DO UPDATE SET version = excluded.version",
                (component, target),
            )
            .map_err(sql_error)?;
    }
    transaction.commit().map_err(sql_error)
}

fn sql_error(error: rusqlite::Error) -> String {
    format!("SQLite collaboration schema: {error}")
}

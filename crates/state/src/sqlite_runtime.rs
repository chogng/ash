use std::fs;
use std::path::Path;
use std::time::Duration;

use rusqlite::{Connection, ErrorCode};

/// Write-safety level selected for one State-owned SQLite database.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SqliteDurability {
    Durable,
    Rebuildable,
}

/// Securely opens one SQLite database using the shared State connection policy.
pub fn open_sqlite_database(
    path: &Path,
    durability: SqliteDurability,
) -> Result<Connection, String> {
    if let Some(parent) = path.parent()
        && !parent.as_os_str().is_empty()
    {
        fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    }
    prepare_private_database_file(path)?;
    let connection = Connection::open(path).map_err(sql_error)?;
    configure_connection(&connection, durability)?;
    Ok(connection)
}

/// Opens an in-memory SQLite database using the same connection policy.
pub fn open_in_memory_database(durability: SqliteDurability) -> Result<Connection, String> {
    let connection = Connection::open_in_memory().map_err(sql_error)?;
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(sql_error)?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(sql_error)?;
    connection
        .pragma_update(
            None,
            "synchronous",
            match durability {
                SqliteDurability::Durable => "FULL",
                SqliteDurability::Rebuildable => "NORMAL",
            },
        )
        .map_err(sql_error)?;
    Ok(connection)
}

fn configure_connection(
    connection: &Connection,
    durability: SqliteDurability,
) -> Result<(), String> {
    connection
        .busy_timeout(Duration::from_secs(5))
        .map_err(sql_error)?;
    enable_wal(connection)?;
    connection
        .pragma_update(None, "foreign_keys", "ON")
        .map_err(sql_error)?;
    connection
        .pragma_update(
            None,
            "synchronous",
            match durability {
                SqliteDurability::Durable => "FULL",
                SqliteDurability::Rebuildable => "NORMAL",
            },
        )
        .map_err(sql_error)
}

fn enable_wal(connection: &Connection) -> Result<(), String> {
    for _ in 0..100 {
        match connection.query_row("PRAGMA journal_mode = WAL", [], |row| {
            row.get::<_, String>(0)
        }) {
            Ok(_) => return Ok(()),
            Err(rusqlite::Error::SqliteFailure(error, _))
                if matches!(
                    error.code,
                    ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked
                ) =>
            {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(sql_error(error)),
        }
    }
    Err("SQLite database remained locked while enabling WAL".into())
}

fn prepare_private_database_file(path: &Path) -> Result<(), String> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.file_type().is_file() => {
            return Err(format!(
                "SQLite database must be a regular file: {}",
                path.display()
            ));
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }

    let mut options = fs::OpenOptions::new();
    options.create(true).append(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn sql_error(error: impl std::fmt::Display) -> String {
    format!("SQLite state error: {error}")
}

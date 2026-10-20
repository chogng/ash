use crate::SqliteDurability;
use crate::open_sqlite_database;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::TransactionBehavior;
use rusqlite::params;
use serde_json::Value;
use std::collections::BTreeMap;
use std::path::Path;
use std::sync::Mutex;

const MAX_KEYS: usize = 256;
const MAX_BYTES: usize = 256 * 1024;

#[derive(Debug)]
pub enum ExtensionStateError {
    Invalid,
    QuotaExceeded,
    Retired,
    Storage(String),
}
impl std::fmt::Display for ExtensionStateError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Invalid => formatter.write_str("invalid extension state"),
            Self::QuotaExceeded => formatter.write_str("extension state quota exceeded"),
            Self::Retired => formatter.write_str("extension state access retired"),
            Self::Storage(detail) => write!(formatter, "extension state unavailable: {detail}"),
        }
    }
}
impl std::error::Error for ExtensionStateError {}

/// Profile-local state shared across extension instances, windows and backend processes.
/// SQLite is authoritative; the store does not retain a second copy of namespace values.
pub struct SqliteExtensionStateStore {
    connection: Mutex<Connection>,
}

impl SqliteExtensionStateStore {
    pub fn open(path: &Path) -> Result<Self, ExtensionStateError> {
        let mut connection = open_sqlite_database(path, SqliteDurability::Durable)
            .map_err(ExtensionStateError::Storage)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        transaction.execute_batch("CREATE TABLE IF NOT EXISTS ash_schema_migrations (component TEXT PRIMARY KEY, version INTEGER NOT NULL);").map_err(storage)?;
        let version: Option<u32> = transaction
            .query_row(
                "SELECT version FROM ash_schema_migrations WHERE component = 'extension_state'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(storage)?;
        match version {
            None => transaction.execute_batch("CREATE TABLE extension_state (namespace TEXT PRIMARY KEY, values_json TEXT NOT NULL); INSERT INTO ash_schema_migrations VALUES ('extension_state', 2);").map_err(storage)?,
            Some(1) => transaction.execute_batch("ALTER TABLE extension_state DROP COLUMN revision; UPDATE ash_schema_migrations SET version=2 WHERE component='extension_state';").map_err(storage)?,
            Some(2) => {}
            Some(_) => return Err(ExtensionStateError::Storage("unsupported schema version".into())),
        }
        transaction.commit().map_err(storage)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    pub fn get(&self, namespace: &str, key: &str) -> Result<Option<Value>, ExtensionStateError> {
        validate_address(namespace, key)?;
        let connection = self.connection.lock().map_err(storage)?;
        Ok(read(&connection, namespace)?.remove(key))
    }

    /// Update one key in the latest namespace under a write transaction. None deletes;
    /// Some(Null) stores JSON null. Check admission after the lock and before commit.
    pub fn update(
        &self,
        namespace: &str,
        key: &str,
        value: Option<&Value>,
        admitted: impl Fn() -> bool,
    ) -> Result<(), ExtensionStateError> {
        validate_address(namespace, key)?;
        if let Some(value) = value {
            validate_value(value, 0)?;
        }
        let mut connection = self.connection.lock().map_err(storage)?;
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(storage)?;
        if !admitted() {
            return Err(ExtensionStateError::Retired);
        }
        let mut values = read(&transaction, namespace)?;
        match value {
            Some(value) => {
                values.insert(key.into(), value.clone());
            }
            None => {
                values.remove(key);
            }
        }
        let json = serde_json::to_string(&values).map_err(storage)?;
        if values.len() > MAX_KEYS || json.len() > MAX_BYTES {
            return Err(ExtensionStateError::QuotaExceeded);
        }
        transaction.execute("INSERT INTO extension_state VALUES (?1, ?2) ON CONFLICT(namespace) DO UPDATE SET values_json=excluded.values_json", params![namespace, json]).map_err(storage)?;
        if !admitted() {
            return Err(ExtensionStateError::Retired);
        }
        transaction.commit().map_err(storage)?;
        Ok(())
    }
}

fn read(
    connection: &Connection,
    namespace: &str,
) -> Result<BTreeMap<String, Value>, ExtensionStateError> {
    let json: Option<String> = connection
        .query_row(
            "SELECT values_json FROM extension_state WHERE namespace=?1",
            [namespace],
            |row| row.get(0),
        )
        .optional()
        .map_err(storage)?;
    let Some(json) = json else {
        return Ok(BTreeMap::new());
    };
    if json.len() > MAX_BYTES {
        return Err(ExtensionStateError::QuotaExceeded);
    }
    let values: BTreeMap<String, Value> = serde_json::from_str(&json).map_err(storage)?;
    if values.len() > MAX_KEYS {
        return Err(ExtensionStateError::QuotaExceeded);
    }
    for (key, value) in &values {
        validate_address(namespace, key)?;
        validate_value(value, 0)?;
    }
    Ok(values)
}
fn validate_address(namespace: &str, key: &str) -> Result<(), ExtensionStateError> {
    if namespace.is_empty()
        || namespace.len() > 4096
        || namespace.chars().any(char::is_control)
        || key.is_empty()
        || key.len() > 1024
        || key.chars().any(char::is_control)
    {
        return Err(ExtensionStateError::Invalid);
    }
    Ok(())
}
fn validate_value(value: &Value, depth: usize) -> Result<(), ExtensionStateError> {
    if depth >= 64 && (value.is_array() || value.is_object()) {
        return Err(ExtensionStateError::Invalid);
    }
    match value {
        Value::Array(values) => {
            for value in values {
                validate_value(value, depth + 1)?;
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                validate_value(value, depth + 1)?;
            }
        }
        Value::Null | Value::Bool(_) | Value::Number(_) | Value::String(_) => {}
    }
    Ok(())
}
fn storage(error: impl std::fmt::Display) -> ExtensionStateError {
    ExtensionStateError::Storage(error.to_string())
}

#[cfg(test)]
#[path = "extension_state_tests.rs"]
mod tests;

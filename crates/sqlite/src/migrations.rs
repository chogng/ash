use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Transaction;
use rusqlite::TransactionBehavior;

type UpgradeBaseline = fn(&Transaction<'_>, Option<u32>) -> Result<(), String>;

enum Operation {
    Sql(&'static str),
    LegacyBaseline(UpgradeBaseline),
}

/// One immutable step in a component's SQLite migration history.
pub struct Migration {
    version: u32,
    operation: Operation,
}

impl Migration {
    /// Registers SQL that runs inside the migrator's write transaction.
    pub const fn sql(version: u32, sql: &'static str) -> Self {
        Self {
            version,
            operation: Operation::Sql(sql),
        }
    }

    /// Adopts an existing schema and upgrades older versions atomically.
    pub const fn legacy_baseline(version: u32, upgrade: UpgradeBaseline) -> Self {
        Self {
            version,
            operation: Operation::LegacyBaseline(upgrade),
        }
    }
}

/// A component owns its migration list even when it shares a database with other components.
pub struct Migrator<'a> {
    component: &'static str,
    migrations: &'a [Migration],
    latest: u32,
}

impl<'a> Migrator<'a> {
    /// Registers a nonempty list of consecutive versions under a stable component key.
    pub const fn new(component: &'static str, migrations: &'a [Migration]) -> Self {
        assert!(!migrations.is_empty() && migrations[0].version > 0);
        let mut index = 1;
        while index < migrations.len() {
            assert!(migrations[index].version == migrations[index - 1].version + 1);
            assert!(matches!(migrations[index].operation, Operation::Sql(_)));
            index += 1;
        }
        Self {
            component,
            migrations,
            latest: migrations[index - 1].version,
        }
    }

    /// Applies pending steps and records the version under the same SQLite write lock.
    pub fn run(&self, connection: &mut Connection) -> Result<(), String> {
        let has_versions = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema
                 WHERE type = 'table' AND name = 'ash_schema_migrations')",
                [],
                |row| row.get::<_, bool>(0),
            )
            .map_err(|error| self.sql_error(error))?;
        if has_versions && self.version(connection)? == Some(self.latest) {
            return Ok(());
        }
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(|error| self.sql_error(error))?;
        self.run_in_transaction(&transaction)?;
        transaction.commit().map_err(|error| self.sql_error(error))
    }

    /// Run under the caller's immediate transaction when initialization has other atomic work.
    pub fn run_in_transaction(&self, transaction: &Transaction<'_>) -> Result<(), String> {
        transaction
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS ash_schema_migrations (
                     component TEXT PRIMARY KEY,
                     version INTEGER NOT NULL
                 );",
            )
            .map_err(|error| self.sql_error(error))?;
        // Another connection may have migrated this component while we waited for the lock.
        let version = self.version(transaction)?;
        if version == Some(self.latest) {
            return Ok(());
        }
        for migration in self
            .migrations
            .iter()
            .filter(|migration| version.is_none_or(|version| migration.version > version))
        {
            let result = match migration.operation {
                Operation::Sql(sql) => transaction.execute_batch(sql).map_err(|e| e.to_string()),
                Operation::LegacyBaseline(upgrade) => upgrade(transaction, version),
            };
            result.map_err(|error| {
                format!(
                    "{} SQLite migration {} failed: {error}",
                    self.component, migration.version
                )
            })?;
        }
        transaction
            .execute(
                "INSERT INTO ash_schema_migrations (component, version) VALUES (?1, ?2)
                 ON CONFLICT(component) DO UPDATE SET version = excluded.version",
                (self.component, self.latest),
            )
            .map_err(|error| self.sql_error(error))?;
        Ok(())
    }

    /// Reads and validates the persisted version for this component.
    pub fn version(&self, connection: &Connection) -> Result<Option<u32>, String> {
        let version = connection
            .query_row(
                "SELECT version FROM ash_schema_migrations WHERE component = ?1",
                [self.component],
                |row| row.get::<_, u32>(0),
            )
            .optional()
            .map_err(|error| self.sql_error(error))?;
        if let Some(version) = version {
            let baseline = &self.migrations[0];
            let supports_earlier = matches!(baseline.operation, Operation::LegacyBaseline(_));
            if version > self.latest
                || version == 0
                || (version < baseline.version && !supports_earlier)
            {
                return Err(format!(
                    "unsupported {} SQLite schema version {version}",
                    self.component
                ));
            }
        }
        Ok(version)
    }

    fn sql_error(&self, error: rusqlite::Error) -> String {
        format!("SQLite {}: {error}", self.component)
    }
}

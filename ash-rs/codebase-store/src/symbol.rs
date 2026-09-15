use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

use ash_codebase::{
    IndexRootId, IndexedLanguage, IndexedSourceReference, IndexedSymbol, SourceRevision,
    SourceSymbols, StoredSymbolProjection, SymbolIndexError, SymbolIndexSnapshot, SymbolIndexStore,
    SymbolKind, SymbolRange, SymbolReference,
};
use ash_state::{SqliteDurability, open_in_memory_database, open_sqlite_database};
use ash_syntax::SYNTAX_FACTS_VERSION;
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::Transaction;
use rusqlite::params;

use crate::CodebaseStoreStorage;

const SCHEMA_VERSION: &str = "1";

type SymbolStoreResult<T> = Result<T, SymbolStoreError>;

enum SymbolStoreError {
    Sqlite(rusqlite::Error),
    Domain(SymbolIndexError),
}

impl From<rusqlite::Error> for SymbolStoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

impl From<SymbolIndexError> for SymbolStoreError {
    fn from(error: SymbolIndexError) -> Self {
        Self::Domain(error)
    }
}

impl From<String> for SymbolStoreError {
    fn from(error: String) -> Self {
        Self::Domain(SymbolIndexError::storage(error))
    }
}

impl From<ash_codebase::CodebaseError> for SymbolStoreError {
    fn from(error: ash_codebase::CodebaseError) -> Self {
        Self::Domain(error.into())
    }
}

impl From<SymbolStoreError> for SymbolIndexError {
    fn from(error: SymbolStoreError) -> Self {
        match error {
            SymbolStoreError::Sqlite(error) => SymbolIndexError::storage(error),
            SymbolStoreError::Domain(error) => error,
        }
    }
}

pub(crate) struct SqliteSymbolIndexStore {
    connection: Mutex<Connection>,
}

impl SqliteSymbolIndexStore {
    pub(crate) fn open(
        storage: &CodebaseStoreStorage,
        root_id: &IndexRootId,
    ) -> Result<Self, SymbolIndexError> {
        Self::open_inner(storage, root_id).map_err(Into::into)
    }

    fn open_inner(
        storage: &CodebaseStoreStorage,
        root_id: &IndexRootId,
    ) -> SymbolStoreResult<Self> {
        let connection = match storage {
            CodebaseStoreStorage::Memory => open_in_memory_database(SqliteDurability::Rebuildable)?,
            CodebaseStoreStorage::Persistent(path) => {
                open_sqlite_database(path, SqliteDurability::Rebuildable)?
            }
        };
        let store = Self {
            connection: Mutex::new(connection),
        };
        store.initialize(root_id)?;
        Ok(store)
    }

    fn snapshot(&self, root_id: &IndexRootId) -> SymbolStoreResult<SymbolIndexSnapshot> {
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        snapshot_from_connection(&connection, root_id)
    }

    fn load_projection(&self, root_id: &IndexRootId) -> SymbolStoreResult<StoredSymbolProjection> {
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let snapshot = snapshot_from_connection(&connection, root_id)?;
        let mut sources = BTreeMap::new();
        let mut statement = connection.prepare(
            "SELECT path, source_revision, language, source_bytes, symbol_limit_hit \
             FROM symbol_index_files ORDER BY path",
        )?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, i64>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?;
        for row in rows {
            let (path, revision, language, source_bytes, symbol_limit_hit) = row?;
            let relative_path = PathBuf::from(path);
            let source = IndexedSourceReference {
                root_id: root_id.clone(),
                relative_path: relative_path.clone(),
                source_revision: SourceRevision::parse(revision)?,
                language: language_from_id(&language),
                source_bytes: to_usize(source_bytes),
            };
            let symbols = load_symbols(&connection, &source)?;
            sources.insert(
                relative_path,
                SourceSymbols {
                    source,
                    symbols,
                    symbol_limit_hit: symbol_limit_hit != 0,
                },
            );
        }
        Ok(StoredSymbolProjection { snapshot, sources })
    }

    fn replace_projection(
        &self,
        root_id: &IndexRootId,
        source_generation: u64,
        sources: &[SourceSymbols],
        symbol_limit_hit: bool,
    ) -> SymbolStoreResult<SymbolIndexSnapshot> {
        let mut connection = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let transaction = connection.transaction()?;
        transaction.execute("DELETE FROM symbol_index_symbols", [])?;
        transaction.execute("DELETE FROM symbol_index_files", [])?;
        for source in sources {
            insert_source(&transaction, source)?;
        }
        let generation = metadata(&transaction, "generation")?
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0)
            .saturating_add(1);
        set_metadata(&transaction, "generation", &generation.to_string())?;
        set_metadata(
            &transaction,
            "source_generation",
            &source_generation.to_string(),
        )?;
        set_metadata(
            &transaction,
            "symbol_limit_hit",
            if symbol_limit_hit { "1" } else { "0" },
        )?;
        transaction.commit()?;
        snapshot_from_connection(&connection, root_id)
    }

    fn initialize(&self, root_id: &IndexRootId) -> SymbolStoreResult<()> {
        let mut connection = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        create_schema(&connection)?;
        let stored_root = metadata(&connection, "root_id")?;
        if stored_root
            .as_deref()
            .is_some_and(|stored| stored != root_id.as_str())
        {
            return Err(SymbolIndexError::StorageRootMismatch.into());
        }
        let incompatible = metadata(&connection, "schema_version")?
            .as_deref()
            .is_some_and(|stored| stored != SCHEMA_VERSION)
            || metadata(&connection, "syntax_facts_version")?
                .as_deref()
                .is_some_and(|stored| stored != SYNTAX_FACTS_VERSION);
        if incompatible {
            reset_projection(&mut connection)?;
        }
        let transaction = connection.transaction()?;
        set_metadata(&transaction, "root_id", root_id.as_str())?;
        set_metadata(&transaction, "schema_version", SCHEMA_VERSION)?;
        set_metadata(&transaction, "syntax_facts_version", SYNTAX_FACTS_VERSION)?;
        for key in ["generation", "source_generation", "symbol_limit_hit"] {
            if metadata(&transaction, key)?.is_none() {
                set_metadata(&transaction, key, "0")?;
            }
        }
        transaction.commit()?;
        Ok(())
    }
}

impl SymbolIndexStore for SqliteSymbolIndexStore {
    fn snapshot(&self, root_id: &IndexRootId) -> Result<SymbolIndexSnapshot, SymbolIndexError> {
        SqliteSymbolIndexStore::snapshot(self, root_id).map_err(Into::into)
    }

    fn load_projection(
        &self,
        root_id: &IndexRootId,
    ) -> Result<StoredSymbolProjection, SymbolIndexError> {
        SqliteSymbolIndexStore::load_projection(self, root_id).map_err(Into::into)
    }

    fn replace_projection(
        &self,
        root_id: &IndexRootId,
        source_generation: u64,
        sources: &[SourceSymbols],
        symbol_limit_hit: bool,
    ) -> Result<SymbolIndexSnapshot, SymbolIndexError> {
        SqliteSymbolIndexStore::replace_projection(
            self,
            root_id,
            source_generation,
            sources,
            symbol_limit_hit,
        )
        .map_err(Into::into)
    }
}

fn create_schema(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS symbol_index_metadata (
             key TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS symbol_index_files (
             path TEXT PRIMARY KEY,
             source_revision TEXT NOT NULL,
             language TEXT NOT NULL,
             source_bytes INTEGER NOT NULL,
             symbol_limit_hit INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS symbol_index_symbols (
             path TEXT NOT NULL REFERENCES symbol_index_files(path) ON DELETE CASCADE,
             ordinal INTEGER NOT NULL,
             name TEXT NOT NULL,
             kind TEXT NOT NULL,
             container_name TEXT,
             declaration_start_byte INTEGER NOT NULL,
             declaration_end_byte INTEGER NOT NULL,
             declaration_start_line INTEGER NOT NULL,
             declaration_start_column INTEGER NOT NULL,
             declaration_end_line INTEGER NOT NULL,
             declaration_end_column INTEGER NOT NULL,
             selection_start_byte INTEGER NOT NULL,
             selection_end_byte INTEGER NOT NULL,
             selection_start_line INTEGER NOT NULL,
             selection_start_column INTEGER NOT NULL,
             selection_end_line INTEGER NOT NULL,
             selection_end_column INTEGER NOT NULL,
             PRIMARY KEY(path, ordinal)
         );
         CREATE INDEX IF NOT EXISTS symbol_index_symbols_name ON symbol_index_symbols(name);",
    )
}

fn reset_projection(connection: &mut Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "DROP TABLE IF EXISTS symbol_index_symbols;
         DROP TABLE IF EXISTS symbol_index_files;
         DROP TABLE IF EXISTS symbol_index_metadata;",
    )?;
    create_schema(connection)
}

fn insert_source(transaction: &Transaction<'_>, source: &SourceSymbols) -> SymbolStoreResult<()> {
    let path = storage_path(&source.source.relative_path);
    transaction.execute(
        "INSERT INTO symbol_index_files(
             path, source_revision, language, source_bytes, symbol_limit_hit
         ) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![
            path,
            source.source.source_revision.as_str(),
            source.source.language.id(),
            to_i64(source.source.source_bytes),
            flag_value(source.symbol_limit_hit),
        ],
    )?;
    for symbol in &source.symbols {
        transaction.execute(
            "INSERT INTO symbol_index_symbols(
                 path, ordinal, name, kind, container_name,
                 declaration_start_byte, declaration_end_byte,
                 declaration_start_line, declaration_start_column,
                 declaration_end_line, declaration_end_column,
                 selection_start_byte, selection_end_byte,
                 selection_start_line, selection_start_column,
                 selection_end_line, selection_end_column
             ) VALUES (
                 ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17
             )",
            params![
                path,
                to_i64(symbol.reference.ordinal),
                symbol.name,
                symbol.kind.id(),
                symbol.container_name,
                to_i64(symbol.reference.declaration_range.start_byte),
                to_i64(symbol.reference.declaration_range.end_byte),
                to_i64(symbol.reference.declaration_range.start_line),
                to_i64(symbol.reference.declaration_range.start_column),
                to_i64(symbol.reference.declaration_range.end_line),
                to_i64(symbol.reference.declaration_range.end_column),
                to_i64(symbol.reference.selection_range.start_byte),
                to_i64(symbol.reference.selection_range.end_byte),
                to_i64(symbol.reference.selection_range.start_line),
                to_i64(symbol.reference.selection_range.start_column),
                to_i64(symbol.reference.selection_range.end_line),
                to_i64(symbol.reference.selection_range.end_column),
            ],
        )?;
    }
    Ok(())
}

fn load_symbols(
    connection: &Connection,
    source: &IndexedSourceReference,
) -> SymbolStoreResult<Vec<IndexedSymbol>> {
    let path = storage_path(&source.relative_path);
    let mut statement = connection.prepare(
        "SELECT ordinal, name, kind, container_name,
                declaration_start_byte, declaration_end_byte,
                declaration_start_line, declaration_start_column,
                declaration_end_line, declaration_end_column,
                selection_start_byte, selection_end_byte,
                selection_start_line, selection_start_column,
                selection_end_line, selection_end_column
         FROM symbol_index_symbols WHERE path = ?1 ORDER BY ordinal",
    )?;
    let rows = statement.query_map([path], |row| {
        let kind = row.get::<_, String>(2)?;
        Ok((
            to_usize(row.get::<_, i64>(0)?),
            row.get::<_, String>(1)?,
            kind,
            row.get::<_, Option<String>>(3)?,
            symbol_range_from_row(row, 4)?,
            symbol_range_from_row(row, 10)?,
        ))
    })?;
    rows.map(|row| {
        let (ordinal, name, kind, container_name, declaration_range, selection_range) = row?;
        let kind = SymbolKind::from_id(&kind)
            .ok_or_else(|| SymbolIndexError::InvalidStoredSymbolKind(kind.clone()))?;
        Ok(IndexedSymbol {
            reference: SymbolReference {
                root_id: source.root_id.clone(),
                relative_path: source.relative_path.clone(),
                source_revision: source.source_revision.clone(),
                language: source.language,
                source_bytes: source.source_bytes,
                ordinal,
                declaration_range,
                selection_range,
            },
            name,
            kind,
            container_name,
        })
    })
    .collect()
}

fn symbol_range_from_row(row: &rusqlite::Row<'_>, start: usize) -> rusqlite::Result<SymbolRange> {
    Ok(SymbolRange {
        start_byte: to_usize(row.get::<_, i64>(start)?),
        end_byte: to_usize(row.get::<_, i64>(start + 1)?),
        start_line: to_usize(row.get::<_, i64>(start + 2)?),
        start_column: to_usize(row.get::<_, i64>(start + 3)?),
        end_line: to_usize(row.get::<_, i64>(start + 4)?),
        end_column: to_usize(row.get::<_, i64>(start + 5)?),
    })
}

fn snapshot_from_connection(
    connection: &Connection,
    root_id: &IndexRootId,
) -> SymbolStoreResult<SymbolIndexSnapshot> {
    Ok(SymbolIndexSnapshot {
        root_id: root_id.clone(),
        generation: metadata(connection, "generation")?
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0),
        source_generation: metadata(connection, "source_generation")?
            .and_then(|value| value.parse::<u64>().ok())
            .unwrap_or(0),
        indexed_source_count: count(connection, "symbol_index_files")?,
        indexed_symbol_count: count(connection, "symbol_index_symbols")?,
        symbol_limit_hit: metadata(connection, "symbol_limit_hit")?.as_deref() == Some("1"),
    })
}

fn count(connection: &Connection, table: &str) -> SymbolStoreResult<usize> {
    let query = match table {
        "symbol_index_files" => "SELECT COUNT(*) FROM symbol_index_files",
        "symbol_index_symbols" => "SELECT COUNT(*) FROM symbol_index_symbols",
        _ => {
            return Err(SymbolIndexError::InvalidLimits("unknown symbol-index table").into());
        }
    };
    Ok(to_usize(
        connection.query_row(query, [], |row| row.get::<_, i64>(0))?,
    ))
}

fn metadata(connection: &Connection, key: &str) -> Result<Option<String>, rusqlite::Error> {
    connection
        .query_row(
            "SELECT value FROM symbol_index_metadata WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()
}

fn set_metadata(transaction: &Transaction<'_>, key: &str, value: &str) -> rusqlite::Result<()> {
    transaction.execute(
        "INSERT INTO symbol_index_metadata(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn language_from_id(value: &str) -> IndexedLanguage {
    match value {
        "javascript" => IndexedLanguage::Javascript,
        "javascriptreact" => IndexedLanguage::JavascriptReact,
        "json" => IndexedLanguage::Json,
        "jsonc" => IndexedLanguage::Jsonc,
        "rust" => IndexedLanguage::Rust,
        "shell" => IndexedLanguage::Shell,
        "typescript" => IndexedLanguage::TypeScript,
        "typescriptreact" => IndexedLanguage::TypeScriptReact,
        _ => IndexedLanguage::PlainText,
    }
}

fn storage_path(path: &Path) -> String {
    path.to_string_lossy()
        .replace(std::path::MAIN_SEPARATOR, "/")
}

fn to_i64(value: usize) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn to_usize(value: i64) -> usize {
    usize::try_from(value).unwrap_or(usize::MAX)
}

fn flag_value(value: bool) -> i64 {
    i64::from(value)
}

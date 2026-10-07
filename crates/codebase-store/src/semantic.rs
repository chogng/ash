use std::num::NonZeroUsize;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Mutex;

use ash_codebase::ChunkContentHash;
use ash_codebase::ChunkKey;
use ash_codebase::ChunkReference;
use ash_codebase::ChunkSpan;
use ash_codebase::IndexRootId;
use ash_codebase::IndexedLanguage;
use ash_codebase::MaterializedChunk;
use ash_codebase::SourceRevision;
use ash_model_provider::EmbeddingVector;
use ash_state::{SqliteDurability, open_in_memory_database, open_sqlite_database};
use rusqlite::Connection;
use rusqlite::OptionalExtension;
use rusqlite::params;

use crate::CodebaseStoreStorage;
use ash_codebase::CodebaseVectorStore;
use ash_codebase::CodebaseVectorStoreError;
use ash_codebase::EmbeddedCodeChunk;
use ash_codebase::EmbeddingIndexKey;
use ash_codebase::VectorSearchHit;

const SCHEMA_VERSION: &str = "5";
const ANN_REVISION: &str = "simhash64-v1";
const ANN_MIN_CHUNKS: usize = 2_048;
const ANN_CANDIDATE_MULTIPLIER: usize = 32;
const ANN_MIN_CANDIDATES: usize = 256;
const ANN_MAX_CANDIDATES: usize = 900;

/// SQLite-backed local semantic projection with exact-generation replacement.
///
/// This store is rebuildable from the authoritative lexical manifest. It keeps chunk content and
/// embeddings locally and rejects stale generations and model identities. Small collections use
/// brute-force cosine search; larger collections use a rebuildable SimHash projection to select
/// candidates before exact cosine scoring, with automatic brute-force fallback.
pub(crate) struct SqliteCodebaseVectorStore {
    connection: Mutex<Connection>,
}

impl SqliteCodebaseVectorStore {
    pub(crate) fn open(storage: &CodebaseStoreStorage) -> Result<Self, CodebaseVectorStoreError> {
        let connection = match storage {
            CodebaseStoreStorage::Memory => open_in_memory_database(SqliteDurability::Rebuildable),
            CodebaseStoreStorage::Persistent(path) => {
                open_sqlite_database(path, SqliteDurability::Rebuildable)
            }
        }
        .map_err(store_error)?;
        create_schema(&connection).map_err(store_error)?;
        let stored_schema = metadata(&connection, "schema_version").map_err(store_error)?;
        if stored_schema
            .as_deref()
            .is_some_and(|stored| stored != SCHEMA_VERSION)
        {
            reset_projection(&connection).map_err(store_error)?;
        }
        set_metadata(&connection, "schema_version", SCHEMA_VERSION).map_err(store_error)?;
        Ok(Self {
            connection: Mutex::new(connection),
        })
    }
}

impl CodebaseVectorStore for SqliteCodebaseVectorStore {
    fn reusable_embeddings(
        &self,
        root_id: &IndexRootId,
        embedding_index_key: &EmbeddingIndexKey,
        chunks: &[MaterializedChunk],
    ) -> Result<Vec<Option<EmbeddingVector>>, CodebaseVectorStoreError> {
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut statement = connection
            .prepare(
                "SELECT embedding FROM semantic_embedding_cache
                 WHERE root_id = ?1 AND embedding_index_key = ?2 AND path = ?3
                   AND chunk_key = ?4 AND content_hash = ?5 AND language = ?6",
            )
            .map_err(store_error)?;
        chunks
            .iter()
            .map(|chunk| {
                let bytes = statement
                    .query_row(
                        params![
                            root_id.as_str(),
                            embedding_index_key.as_str(),
                            storage_path(&chunk.reference.relative_path),
                            chunk.reference.key.as_str(),
                            chunk.reference.content_hash.as_str(),
                            chunk.language.id(),
                        ],
                        |row| row.get::<_, Vec<u8>>(0),
                    )
                    .optional()
                    .map_err(store_error)?;
                bytes.map(|bytes| unpack_embedding(&bytes)).transpose()
            })
            .collect()
    }

    fn cache_embeddings(
        &self,
        root_id: &IndexRootId,
        embedding_index_key: &EmbeddingIndexKey,
        chunks: &[EmbeddedCodeChunk],
    ) -> Result<(), CodebaseVectorStoreError> {
        validate_dimensions(chunks)?;
        let mut connection = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let transaction = connection.transaction().map_err(store_error)?;
        cache_embeddings(&transaction, root_id, embedding_index_key, chunks)?;
        transaction.commit().map_err(store_error)
    }

    fn published_generation(
        &self,
        root_id: &IndexRootId,
        embedding_index_key: &EmbeddingIndexKey,
    ) -> Result<Option<u64>, CodebaseVectorStoreError> {
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if metadata(&connection, "root_id")
            .map_err(store_error)?
            .as_deref()
            != Some(root_id.as_str())
            || metadata(&connection, "embedding_index_key")
                .map_err(store_error)?
                .as_deref()
                != Some(embedding_index_key.as_str())
        {
            return Ok(None);
        }
        metadata(&connection, "generation")
            .map_err(store_error)?
            .map(|generation| generation.parse::<u64>().map_err(store_error))
            .transpose()
    }

    fn replace_generation(
        &self,
        root_id: &IndexRootId,
        generation: u64,
        embedding_index_key: &EmbeddingIndexKey,
        chunks: Vec<EmbeddedCodeChunk>,
    ) -> Result<(), CodebaseVectorStoreError> {
        validate_dimensions(&chunks)?;
        let mut connection = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(stored_root) = metadata(&connection, "root_id").map_err(store_error)?
            && stored_root != root_id.as_str()
        {
            return Err(CodebaseVectorStoreError::new(
                "semantic index belongs to a different directory root",
            ));
        }
        let transaction = connection.transaction().map_err(store_error)?;
        cache_embeddings(&transaction, root_id, embedding_index_key, &chunks)?;
        transaction
            .execute("DELETE FROM semantic_chunks", [])
            .map_err(store_error)?;
        let mut insert = transaction
            .prepare(
                "INSERT INTO semantic_chunks(
                    path, source_revision, chunk_key, content_hash, language,
                    start_byte, end_byte, start_line, end_line_exclusive, content, embedding,
                    ann_signature
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
            )
            .map_err(store_error)?;
        for chunk in chunks {
            insert
                .execute(params![
                    storage_path(&chunk.reference.relative_path),
                    chunk.reference.source_revision.as_str(),
                    chunk.reference.key.as_str(),
                    chunk.reference.content_hash.as_str(),
                    chunk.language.id(),
                    to_i64(chunk.reference.span.start_byte),
                    to_i64(chunk.reference.span.end_byte),
                    to_i64(chunk.reference.span.start_line),
                    to_i64(chunk.reference.span.end_line_exclusive),
                    chunk.content,
                    pack_embedding(&chunk.embedding),
                    ann_signature(&chunk.embedding) as i64,
                ])
                .map_err(store_error)?;
        }
        drop(insert);
        set_metadata(&transaction, "root_id", root_id.as_str()).map_err(store_error)?;
        set_metadata(&transaction, "generation", &generation.to_string()).map_err(store_error)?;
        set_metadata(
            &transaction,
            "embedding_index_key",
            embedding_index_key.as_str(),
        )
        .map_err(store_error)?;
        set_metadata(&transaction, "ann_revision", ANN_REVISION).map_err(store_error)?;
        transaction.commit().map_err(store_error)
    }

    fn search(
        &self,
        root_id: &IndexRootId,
        generation: u64,
        embedding_index_key: &EmbeddingIndexKey,
        query: &EmbeddingVector,
        result_limit: NonZeroUsize,
    ) -> Result<Vec<VectorSearchHit>, CodebaseVectorStoreError> {
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        require_metadata(&connection, "root_id", root_id.as_str())?;
        require_metadata(&connection, "generation", &generation.to_string())?;
        require_metadata(
            &connection,
            "embedding_index_key",
            embedding_index_key.as_str(),
        )?;
        let candidate_rowids = ann_candidate_rowids(&connection, query, result_limit)?;
        let rows = load_search_rows(&connection, candidate_rowids.as_deref())?;
        let mut hits = rows
            .into_iter()
            .map(|row| search_hit(root_id, query, row))
            .collect::<Result<Vec<_>, _>>()?;
        hits.sort_by(|left, right| {
            right
                .similarity
                .total_cmp(&left.similarity)
                .then_with(|| left.chunk.reference.cmp(&right.chunk.reference))
        });
        hits.truncate(result_limit.get());
        Ok(hits)
    }

    fn delete_index(&self, root_id: &IndexRootId) -> Result<(), CodebaseVectorStoreError> {
        let connection = self
            .connection
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(stored_root) = metadata(&connection, "root_id").map_err(store_error)?
            && stored_root != root_id.as_str()
        {
            return Err(CodebaseVectorStoreError::new(
                "semantic index belongs to a different directory root",
            ));
        }
        reset_projection(&connection).map_err(store_error)?;
        set_metadata(&connection, "schema_version", SCHEMA_VERSION).map_err(store_error)
    }
}

fn create_schema(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS semantic_metadata (
             key TEXT PRIMARY KEY,
             value TEXT NOT NULL
         );
         CREATE TABLE IF NOT EXISTS semantic_chunks (
             rowid INTEGER PRIMARY KEY,
             path TEXT NOT NULL,
             source_revision TEXT NOT NULL,
             chunk_key TEXT NOT NULL,
             content_hash TEXT NOT NULL,
             language TEXT NOT NULL,
             start_byte INTEGER NOT NULL,
             end_byte INTEGER NOT NULL,
             start_line INTEGER NOT NULL,
             end_line_exclusive INTEGER NOT NULL,
             content TEXT NOT NULL,
             embedding BLOB NOT NULL,
             ann_signature INTEGER NOT NULL,
             UNIQUE(path, chunk_key, start_byte)
         );
         CREATE TABLE IF NOT EXISTS semantic_embedding_cache (
             root_id TEXT NOT NULL,
             embedding_index_key TEXT NOT NULL,
             path TEXT NOT NULL,
             chunk_key TEXT NOT NULL,
             content_hash TEXT NOT NULL,
             language TEXT NOT NULL,
             embedding BLOB NOT NULL,
             PRIMARY KEY(root_id, embedding_index_key, path, chunk_key, content_hash, language)
         );",
    )
}

fn reset_projection(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "DROP TABLE IF EXISTS semantic_chunks;
         DROP TABLE IF EXISTS semantic_embedding_cache;
         DROP TABLE IF EXISTS semantic_metadata;",
    )?;
    create_schema(connection)
}

fn cache_embeddings(
    connection: &Connection,
    root_id: &IndexRootId,
    embedding_index_key: &EmbeddingIndexKey,
    chunks: &[EmbeddedCodeChunk],
) -> Result<(), CodebaseVectorStoreError> {
    let mut insert = connection
        .prepare(
            "INSERT INTO semantic_embedding_cache(
                root_id, embedding_index_key, path, chunk_key, content_hash, language, embedding
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(root_id, embedding_index_key, path, chunk_key, content_hash, language)
             DO UPDATE SET embedding = excluded.embedding",
        )
        .map_err(store_error)?;
    for chunk in chunks {
        insert
            .execute(params![
                root_id.as_str(),
                embedding_index_key.as_str(),
                storage_path(&chunk.reference.relative_path),
                chunk.reference.key.as_str(),
                chunk.reference.content_hash.as_str(),
                chunk.language.id(),
                pack_embedding(&chunk.embedding),
            ])
            .map_err(store_error)?;
    }
    Ok(())
}

fn metadata(connection: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    connection
        .query_row(
            "SELECT value FROM semantic_metadata WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()
}

fn set_metadata(connection: &Connection, key: &str, value: &str) -> rusqlite::Result<()> {
    connection.execute(
        "INSERT INTO semantic_metadata(key, value) VALUES (?1, ?2)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        params![key, value],
    )?;
    Ok(())
}

fn require_metadata(
    connection: &Connection,
    key: &str,
    expected: &str,
) -> Result<(), CodebaseVectorStoreError> {
    match metadata(connection, key).map_err(store_error)? {
        Some(stored) if stored == expected => Ok(()),
        Some(_) => Err(CodebaseVectorStoreError::new(format!(
            "semantic index {key} is not current"
        ))),
        None => Err(CodebaseVectorStoreError::new(
            "semantic index has not been synchronized",
        )),
    }
}

fn validate_dimensions(chunks: &[EmbeddedCodeChunk]) -> Result<(), CodebaseVectorStoreError> {
    let dimension = chunks.first().map(|chunk| chunk.embedding.values().len());
    if dimension.is_some_and(|dimension| {
        chunks
            .iter()
            .any(|chunk| chunk.embedding.values().len() != dimension)
    }) {
        return Err(CodebaseVectorStoreError::new(
            "stored embedding dimensions are inconsistent",
        ));
    }
    Ok(())
}

type SearchRow = (
    PathBuf,
    String,
    String,
    String,
    String,
    i64,
    i64,
    i64,
    i64,
    String,
    Vec<u8>,
);

fn ann_candidate_rowids(
    connection: &Connection,
    query: &EmbeddingVector,
    result_limit: NonZeroUsize,
) -> Result<Option<Vec<i64>>, CodebaseVectorStoreError> {
    let chunk_count = connection
        .query_row("SELECT COUNT(*) FROM semantic_chunks", [], |row| {
            row.get::<_, i64>(0)
        })
        .map_err(store_error)?;
    let chunk_count = usize::try_from(chunk_count).map_err(store_error)?;
    if chunk_count < ANN_MIN_CHUNKS
        || metadata(connection, "ann_revision")
            .map_err(store_error)?
            .as_deref()
            != Some(ANN_REVISION)
    {
        return Ok(None);
    }
    let query_signature = ann_signature(query);
    let mut statement = match connection.prepare("SELECT rowid, ann_signature FROM semantic_chunks")
    {
        Ok(statement) => statement,
        Err(_) => return Ok(None),
    };
    let rows = match statement.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)? as u64))
    }) {
        Ok(rows) => rows,
        Err(_) => return Ok(None),
    };
    let mut ranked = Vec::with_capacity(chunk_count);
    for row in rows {
        let Ok((rowid, signature)) = row else {
            return Ok(None);
        };
        ranked.push(((query_signature ^ signature).count_ones(), rowid));
    }
    ranked.sort_unstable();
    let candidate_count = result_limit
        .get()
        .saturating_mul(ANN_CANDIDATE_MULTIPLIER)
        .clamp(ANN_MIN_CANDIDATES, ANN_MAX_CANDIDATES)
        .min(ranked.len());
    ranked.truncate(candidate_count);
    Ok(Some(ranked.into_iter().map(|(_, rowid)| rowid).collect()))
}

fn load_search_rows(
    connection: &Connection,
    candidate_rowids: Option<&[i64]>,
) -> Result<Vec<SearchRow>, CodebaseVectorStoreError> {
    const COLUMNS: &str = "path, source_revision, chunk_key, content_hash, language,
        start_byte, end_byte, start_line, end_line_exclusive, content, embedding";
    let sql = match candidate_rowids {
        Some([]) => return Ok(Vec::new()),
        Some(rowids) => format!(
            "SELECT {COLUMNS} FROM semantic_chunks WHERE rowid IN ({})",
            std::iter::repeat_n("?", rowids.len())
                .collect::<Vec<_>>()
                .join(",")
        ),
        None => format!("SELECT {COLUMNS} FROM semantic_chunks"),
    };
    let mut statement = connection.prepare(&sql).map_err(store_error)?;
    let read = |row: &rusqlite::Row<'_>| {
        Ok((
            PathBuf::from(row.get::<_, String>(0)?),
            row.get::<_, String>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, String>(3)?,
            row.get::<_, String>(4)?,
            row.get::<_, i64>(5)?,
            row.get::<_, i64>(6)?,
            row.get::<_, i64>(7)?,
            row.get::<_, i64>(8)?,
            row.get::<_, String>(9)?,
            row.get::<_, Vec<u8>>(10)?,
        ))
    };
    let rows = match candidate_rowids {
        Some(rowids) => statement.query_map(rusqlite::params_from_iter(rowids.iter()), read),
        None => statement.query_map([], read),
    }
    .map_err(store_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(store_error)
}

fn search_hit(
    root_id: &IndexRootId,
    query: &EmbeddingVector,
    row: SearchRow,
) -> Result<VectorSearchHit, CodebaseVectorStoreError> {
    let (
        relative_path,
        source_revision,
        chunk_key,
        content_hash,
        language,
        start_byte,
        end_byte,
        start_line,
        end_line_exclusive,
        content,
        embedding,
    ) = row;
    let embedding = unpack_embedding(&embedding)?;
    let similarity = cosine_similarity(query.values(), embedding.values())?;
    Ok(VectorSearchHit {
        chunk: EmbeddedCodeChunk {
            reference: ChunkReference {
                root_id: root_id.clone(),
                relative_path,
                source_revision: SourceRevision::parse(source_revision)
                    .map_err(index_identity_error)?,
                key: ChunkKey::parse(chunk_key).map_err(index_identity_error)?,
                content_hash: ChunkContentHash::parse(content_hash)
                    .map_err(index_identity_error)?,
                span: ChunkSpan {
                    start_byte: to_usize(start_byte),
                    end_byte: to_usize(end_byte),
                    start_line: to_usize(start_line),
                    end_line_exclusive: to_usize(end_line_exclusive),
                },
            },
            language: parse_language(&language),
            content,
            embedding,
        },
        similarity,
    })
}

fn ann_signature(embedding: &EmbeddingVector) -> u64 {
    let mut signature = 0u64;
    for bit in 0..64u64 {
        let projection = embedding
            .values()
            .iter()
            .enumerate()
            .map(|(dimension, value)| {
                let mixed = mix64(
                    bit.wrapping_mul(0x9e37_79b9_7f4a_7c15)
                        ^ (dimension as u64).wrapping_mul(0xbf58_476d_1ce4_e5b9),
                );
                let weight = ((mixed >> 40) as i32 - (1 << 23)) as f32 / (1 << 23) as f32;
                value * weight
            })
            .sum::<f32>();
        if projection >= 0.0 {
            signature |= 1 << bit;
        }
    }
    signature
}

fn mix64(mut value: u64) -> u64 {
    value ^= value >> 30;
    value = value.wrapping_mul(0xbf58_476d_1ce4_e5b9);
    value ^= value >> 27;
    value = value.wrapping_mul(0x94d0_49bb_1331_11eb);
    value ^ (value >> 31)
}

fn pack_embedding(embedding: &EmbeddingVector) -> Vec<u8> {
    embedding
        .values()
        .iter()
        .flat_map(|value| value.to_le_bytes())
        .collect()
}

fn unpack_embedding(bytes: &[u8]) -> Result<EmbeddingVector, CodebaseVectorStoreError> {
    if bytes.is_empty() || !bytes.len().is_multiple_of(std::mem::size_of::<f32>()) {
        return Err(CodebaseVectorStoreError::new(
            "stored embedding has an invalid binary length",
        ));
    }
    let values = bytes
        .chunks_exact(std::mem::size_of::<f32>())
        .map(|chunk| f32::from_le_bytes(chunk.try_into().expect("four-byte chunk")))
        .collect();
    EmbeddingVector::new(values).map_err(|error| CodebaseVectorStoreError::new(error.to_string()))
}

fn cosine_similarity(left: &[f32], right: &[f32]) -> Result<f32, CodebaseVectorStoreError> {
    if left.len() != right.len() {
        return Err(CodebaseVectorStoreError::new(
            "query and stored embedding dimensions differ",
        ));
    }
    let dot = left
        .iter()
        .zip(right)
        .map(|(left, right)| left * right)
        .sum::<f32>();
    let left_norm = left.iter().map(|value| value * value).sum::<f32>().sqrt();
    let right_norm = right.iter().map(|value| value * value).sum::<f32>().sqrt();
    if left_norm == 0.0 || right_norm == 0.0 {
        Ok(0.0)
    } else {
        Ok(dot / (left_norm * right_norm))
    }
}

fn storage_path(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn parse_language(value: &str) -> IndexedLanguage {
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

fn to_i64(value: usize) -> i64 {
    i64::try_from(value).unwrap_or(i64::MAX)
}

fn to_usize(value: i64) -> usize {
    usize::try_from(value).unwrap_or(usize::MAX)
}

fn store_error(error: impl std::fmt::Display) -> CodebaseVectorStoreError {
    CodebaseVectorStoreError::new(error.to_string())
}

fn index_identity_error(error: ash_codebase::CodebaseError) -> CodebaseVectorStoreError {
    CodebaseVectorStoreError::new(error.to_string())
}

#[cfg(test)]
#[path = "semantic_tests.rs"]
mod tests;

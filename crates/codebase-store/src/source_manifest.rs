use std::path::PathBuf;

use rusqlite::Connection;

use crate::source::SourceResult;
use ash_codebase::{
    ChunkContentHash, ChunkKey, ChunkReference, ChunkSpan, CodebaseManifest, CodebaseSnapshot,
    IndexRootId, IndexedChunkReference, IndexedLanguage, IndexedSourceReference, SourceRevision,
};

pub(crate) fn load_manifest(
    connection: &Connection,
    root_id: &IndexRootId,
) -> SourceResult<CodebaseManifest> {
    let generation = metadata(connection, "generation")?
        .and_then(|value| value.parse::<u64>().ok())
        .unwrap_or(0);
    let snapshot = load_snapshot(connection, root_id, generation)?;
    let mut source_statement = connection.prepare(
        "SELECT path, source_revision, language, source_bytes
         FROM codebase_files ORDER BY path",
    )?;
    let sources = source_statement
        .query_map([], |row| {
            Ok(IndexedSourceReference {
                root_id: root_id.clone(),
                relative_path: PathBuf::from(row.get::<_, String>(0)?),
                source_revision: SourceRevision::new(row.get(1)?),
                language: IndexedLanguage::from_id(&row.get::<_, String>(2)?),
                source_bytes: to_usize(row.get::<_, i64>(3)?),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut chunk_statement = connection.prepare(
        "SELECT path, source_revision, chunk_key, content_hash, language,
                start_byte, end_byte, start_line, end_line_exclusive
         FROM codebase_chunks ORDER BY path, ordinal",
    )?;
    let chunks = chunk_statement
        .query_map([], |row| {
            Ok(IndexedChunkReference {
                reference: ChunkReference {
                    root_id: root_id.clone(),
                    relative_path: PathBuf::from(row.get::<_, String>(0)?),
                    source_revision: SourceRevision::new(row.get(1)?),
                    key: ChunkKey::new(row.get(2)?),
                    content_hash: ChunkContentHash::new(row.get(3)?),
                    span: ChunkSpan {
                        start_byte: to_usize(row.get::<_, i64>(5)?),
                        end_byte: to_usize(row.get::<_, i64>(6)?),
                        start_line: to_usize(row.get::<_, i64>(7)?),
                        end_line_exclusive: to_usize(row.get::<_, i64>(8)?),
                    },
                },
                language: IndexedLanguage::from_id(&row.get::<_, String>(4)?),
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(CodebaseManifest {
        snapshot,
        sources,
        chunks,
    })
}

fn load_snapshot(
    connection: &Connection,
    root_id: &IndexRootId,
    generation: u64,
) -> rusqlite::Result<CodebaseSnapshot> {
    let (file_count, source_bytes) = connection.query_row(
        "SELECT COUNT(*), COALESCE(SUM(source_bytes), 0) FROM codebase_files",
        [],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )?;
    let chunk_count = connection.query_row("SELECT COUNT(*) FROM codebase_chunks", [], |row| {
        row.get::<_, i64>(0)
    })?;
    let truncated_file_count = connection.query_row(
        "SELECT COUNT(*) FROM codebase_files WHERE chunk_limit_hit = 1",
        [],
        |row| row.get::<_, i64>(0),
    )?;
    Ok(CodebaseSnapshot {
        root_id: root_id.clone(),
        generation,
        indexed_file_count: to_usize(file_count),
        indexed_chunk_count: to_usize(chunk_count),
        indexed_source_bytes: to_usize(source_bytes),
        skipped_file_count: metadata(connection, "skipped_file_count")?
            .and_then(|value| value.parse().ok())
            .unwrap_or(0),
        truncated_file_count: to_usize(truncated_file_count),
        file_limit_hit: metadata(connection, "file_limit_hit")?.as_deref() == Some("1"),
        source_bytes_limit_hit: metadata(connection, "source_bytes_limit_hit")?.as_deref()
            == Some("1"),
    })
}

fn metadata(connection: &Connection, key: &str) -> rusqlite::Result<Option<String>> {
    use rusqlite::OptionalExtension;

    connection
        .query_row(
            "SELECT value FROM codebase_metadata WHERE key = ?1",
            [key],
            |row| row.get(0),
        )
        .optional()
}

fn to_usize(value: i64) -> usize {
    usize::try_from(value).unwrap_or(usize::MAX)
}

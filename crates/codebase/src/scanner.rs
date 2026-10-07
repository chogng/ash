use std::fs;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;

use ignore::WalkBuilder;

use crate::CodebaseError;
use crate::CodebaseLimits;
use crate::IndexedLanguage;
use crate::chunker::PreparedChunk;
use crate::chunker::chunk_source;
use crate::chunker::language_for_path;
use crate::chunker::source_revision;
use crate::error::io_error;
use crate::types::SourceRevision;
use ash_file_access::Dir;

#[derive(Clone, Debug)]
pub struct PreparedFile {
    pub relative_path: PathBuf,
    pub source_revision: SourceRevision,
    pub language: IndexedLanguage,
    pub source_bytes: usize,
    pub chunks: Vec<PreparedChunk>,
    pub chunk_limit_hit: bool,
}

#[derive(Debug)]
pub struct DirScan {
    pub files: Vec<PreparedFile>,
    pub skipped_file_count: usize,
    pub file_limit_hit: bool,
    pub source_bytes_limit_hit: bool,
}

pub(crate) fn scan_dir(root: &Dir, limits: &CodebaseLimits) -> Result<DirScan, CodebaseError> {
    let mut builder = WalkBuilder::new(root.canonical_path());
    builder
        .hidden(true)
        .follow_links(false)
        .require_git(true)
        .filter_entry(|entry| {
            entry.depth() == 0
                || !entry.file_type().is_some_and(|kind| kind.is_dir())
                || !matches!(
                    entry.file_name().to_str(),
                    Some(".git" | ".ash" | "node_modules" | "target")
                )
        });
    let mut walk_error_count = 0usize;
    let mut paths = builder
        .build()
        .filter_map(|entry| match entry {
            Ok(entry) => Some(entry),
            Err(_) => {
                walk_error_count = walk_error_count.saturating_add(1);
                None
            }
        })
        .filter(|entry| entry.file_type().is_some_and(|kind| kind.is_file()))
        .filter_map(|entry| {
            entry
                .path()
                .strip_prefix(root.canonical_path())
                .ok()
                .filter(|relative| relative.to_str().is_some())
                .map(Path::to_path_buf)
        })
        .collect::<Vec<_>>();
    paths.sort_unstable();
    paths.dedup();
    let file_limit_hit = paths.len() > limits.max_files;
    let mut skipped_file_count =
        walk_error_count.saturating_add(paths.len().saturating_sub(limits.max_files));
    paths.truncate(limits.max_files);

    let mut files = Vec::new();
    let mut indexed_source_bytes = 0usize;
    let mut source_bytes_limit_hit = false;
    for relative_path in paths {
        let observed_path = root.canonical_path().join(&relative_path);
        let metadata = match fs::symlink_metadata(&observed_path) {
            Ok(metadata) => metadata,
            Err(_) => {
                skipped_file_count += 1;
                continue;
            }
        };
        if !metadata.file_type().is_file() {
            skipped_file_count = skipped_file_count.saturating_add(1);
            continue;
        }
        let file_bytes = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
        if file_bytes > limits.max_file_bytes {
            skipped_file_count += 1;
            continue;
        }
        if indexed_source_bytes.saturating_add(file_bytes) > limits.max_total_source_bytes {
            source_bytes_limit_hit = true;
            skipped_file_count += 1;
            continue;
        }
        match prepare_relative_file(root, relative_path, limits) {
            Ok(Some(file)) => {
                if indexed_source_bytes.saturating_add(file.source_bytes)
                    > limits.max_total_source_bytes
                {
                    source_bytes_limit_hit = true;
                    skipped_file_count = skipped_file_count.saturating_add(1);
                    continue;
                }
                indexed_source_bytes = indexed_source_bytes.saturating_add(file.source_bytes);
                files.push(file);
            }
            Ok(None) | Err(CodebaseError::Io { .. }) => {
                skipped_file_count = skipped_file_count.saturating_add(1)
            }
            Err(error) => return Err(error),
        }
    }
    Ok(DirScan {
        files,
        skipped_file_count,
        file_limit_hit,
        source_bytes_limit_hit,
    })
}

pub(crate) fn prepare_relative_file(
    root: &Dir,
    relative_path: PathBuf,
    limits: &CodebaseLimits,
) -> Result<Option<PreparedFile>, CodebaseError> {
    let observed_path = root.canonical_path().join(&relative_path);
    let metadata =
        fs::symlink_metadata(&observed_path).map_err(|source| io_error(&observed_path, source))?;
    if !metadata.file_type().is_file()
        || usize::try_from(metadata.len()).unwrap_or(usize::MAX) > limits.max_file_bytes
    {
        return Ok(None);
    }
    let absolute_path = root.resolve_existing(&relative_path)?;
    prepare_file(&absolute_path, relative_path, limits)
}

fn prepare_file(
    absolute_path: &Path,
    relative_path: PathBuf,
    limits: &CodebaseLimits,
) -> Result<Option<PreparedFile>, CodebaseError> {
    let file = fs::File::open(absolute_path).map_err(|source| io_error(absolute_path, source))?;
    let read_limit = u64::try_from(limits.max_file_bytes)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    let mut bytes = Vec::with_capacity(limits.max_file_bytes.min(64 * 1024));
    file.take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|source| io_error(absolute_path, source))?;
    if bytes.len() > limits.max_file_bytes || looks_binary(&bytes) {
        return Ok(None);
    }
    let Ok(source) = String::from_utf8(bytes) else {
        return Ok(None);
    };
    let language = language_for_path(&relative_path);
    let chunking = chunk_source(language, &source, limits);
    Ok(Some(PreparedFile {
        relative_path,
        source_revision: source_revision(&source),
        language,
        source_bytes: source.len(),
        chunks: chunking.chunks,
        chunk_limit_hit: chunking.limit_hit,
    }))
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8 * 1024).any(|byte| *byte == 0)
}

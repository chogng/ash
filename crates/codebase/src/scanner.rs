use std::fs;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;

use ignore::WalkBuilder;

use crate::CodebaseError;
use crate::CodebaseLimits;
use crate::chunker::PreparedChunk;
use crate::chunker::chunk_source;
use crate::chunker::source_revision;
use crate::error::io_error;
use crate::types::SourceRevision;
use ash_file_access::Dir;
use ash_language::LanguageId;
use ash_language::detect_language;

#[derive(Clone, Debug)]
pub struct PreparedFile {
    pub relative_path: PathBuf,
    pub source_revision: SourceRevision,
    pub language: LanguageId,
    pub source_bytes: usize,
    pub chunks: Vec<PreparedChunk>,
    pub chunk_limit_hit: bool,
}

#[derive(Debug)]
pub struct DirScan {
    pub files: Vec<PreparedFile>,
    pub chunking_policy: String,
    pub skipped_file_count: usize,
    pub file_limit_hit: bool,
    pub source_bytes_limit_hit: bool,
}

/// A bounded source read, before the more expensive syntax and chunk construction.
pub(crate) struct SourceFile {
    pub(crate) relative_path: PathBuf,
    pub(crate) revision: SourceRevision,
    pub(crate) content: String,
}

impl SourceFile {
    pub(crate) fn prepare(self, limits: &CodebaseLimits) -> PreparedFile {
        let language = detect_language(&self.relative_path, self.content.lines().next());
        let chunking = chunk_source(&language, &self.content, limits);
        PreparedFile {
            relative_path: self.relative_path,
            source_revision: self.revision,
            language,
            source_bytes: self.content.len(),
            chunks: chunking.chunks,
            chunk_limit_hit: chunking.limit_hit,
        }
    }
}

pub(crate) fn scan_dir(root: &Dir, limits: &CodebaseLimits) -> Result<DirScan, CodebaseError> {
    scan_dir_with_cancellation(
        root,
        limits,
        &ash_async_utils::CancellationSource::new().token(),
    )
}

pub(crate) fn scan_dir_with_cancellation(
    root: &Dir,
    limits: &CodebaseLimits,
    cancellation: &ash_async_utils::CancellationToken,
) -> Result<DirScan, CodebaseError> {
    let mut files = Vec::new();
    let summary = scan_sources(root, limits, cancellation, |file| {
        files.push(file.prepare(limits));
    })?;
    Ok(DirScan {
        files,
        chunking_policy: crate::chunker::chunking_policy(limits),
        skipped_file_count: summary.skipped_file_count,
        file_limit_hit: summary.file_limit_hit,
        source_bytes_limit_hit: summary.source_bytes_limit_hit,
    })
}

pub(crate) struct ScanSummary {
    pub skipped_file_count: usize,
    pub file_limit_hit: bool,
    pub source_bytes_limit_hit: bool,
}

/// Reads and hashes the deterministic eligible subset before handing each verified source
/// to its consumer. Reconciliation can reuse unchanged chunks without relaxing scan policy.
pub(crate) fn scan_sources(
    root: &Dir,
    limits: &CodebaseLimits,
    cancellation: &ash_async_utils::CancellationToken,
    mut visit: impl FnMut(SourceFile),
) -> Result<ScanSummary, CodebaseError> {
    cancellation.check().map_err(|_| CodebaseError::Cancelled)?;
    root.directory().ensure_current()?;
    let mut builder = WalkBuilder::new(root.canonical_path());
    builder
        .hidden(true)
        .follow_links(false)
        .require_git(true)
        .filter_entry(|entry| {
            entry.depth() == 0
                || !entry.file_type().is_some_and(|kind| kind.is_dir())
                || !is_hard_excluded_path(Path::new(entry.file_name()))
        });
    let mut walk_error_count = 0usize;
    let mut paths = Vec::new();
    for entry in builder.build() {
        cancellation.check().map_err(|_| CodebaseError::Cancelled)?;
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                walk_error_count = walk_error_count.saturating_add(1);
                continue;
            }
        };
        if entry.file_type().is_some_and(|kind| kind.is_file())
            && let Ok(relative) = entry.path().strip_prefix(root.canonical_path())
            && relative.to_str().is_some()
        {
            paths.push(relative.to_path_buf());
        }
    }
    paths.sort_unstable();
    paths.dedup();
    let file_limit_hit = paths.len() > limits.max_files;
    let mut skipped_file_count =
        walk_error_count.saturating_add(paths.len().saturating_sub(limits.max_files));
    paths.truncate(limits.max_files);

    let mut indexed_source_bytes = 0usize;
    let mut source_bytes_limit_hit = false;
    for relative_path in paths {
        cancellation.check().map_err(|_| CodebaseError::Cancelled)?;
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
        match read_relative_file(root, relative_path, limits) {
            Ok(Some(file)) => {
                if indexed_source_bytes.saturating_add(file.content.len())
                    > limits.max_total_source_bytes
                {
                    source_bytes_limit_hit = true;
                    skipped_file_count = skipped_file_count.saturating_add(1);
                    continue;
                }
                indexed_source_bytes = indexed_source_bytes.saturating_add(file.content.len());
                visit(file);
            }
            Ok(None) | Err(CodebaseError::Io { .. }) => {
                skipped_file_count = skipped_file_count.saturating_add(1)
            }
            Err(error) => return Err(error),
        }
    }
    cancellation.check().map_err(|_| CodebaseError::Cancelled)?;
    root.directory().ensure_current()?;
    Ok(ScanSummary {
        skipped_file_count,
        file_limit_hit,
        source_bytes_limit_hit,
    })
}

// Full scans, watcher invalidations and overlays share these runtime exclusions.
// Other hidden paths may be explicitly included by ignore-file allow rules.
pub(crate) fn is_hard_excluded_path(relative_path: &Path) -> bool {
    relative_path.components().any(|component| {
        component.as_os_str().to_str().is_some_and(|name| {
            matches!(name, ".git" | ".ash" | ".build" | "node_modules" | "target")
        })
    })
}

pub(crate) fn read_relative_file(
    root: &Dir,
    relative_path: PathBuf,
    limits: &CodebaseLimits,
) -> Result<Option<SourceFile>, CodebaseError> {
    let observed_path = root.canonical_path().join(&relative_path);
    let metadata =
        fs::symlink_metadata(&observed_path).map_err(|source| io_error(&observed_path, source))?;
    if !metadata.file_type().is_file()
        || usize::try_from(metadata.len()).unwrap_or(usize::MAX) > limits.max_file_bytes
    {
        return Ok(None);
    }
    let file = open_source_file(root, &relative_path)?;
    let metadata = file
        .metadata()
        .map_err(|source| io_error(&observed_path, source))?;
    if !metadata.is_file()
        || usize::try_from(metadata.len()).unwrap_or(usize::MAX) > limits.max_file_bytes
    {
        return Ok(None);
    }
    let read_limit = u64::try_from(limits.max_file_bytes)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    // Most repository files are small. Metadata is only an allocation hint: the
    // bounded read still handles growth or replacement after the earlier stat.
    let capacity = usize::try_from(metadata.len()).unwrap_or(usize::MAX);
    let mut bytes = Vec::with_capacity(capacity.min(limits.max_file_bytes).min(64 * 1024));
    file.take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|source| io_error(&observed_path, source))?;
    if bytes.len() > limits.max_file_bytes || looks_binary(&bytes) {
        return Ok(None);
    }
    let Ok(source) = String::from_utf8(bytes) else {
        return Ok(None);
    };
    Ok(Some(SourceFile {
        relative_path,
        revision: source_revision(&source),
        content: source,
    }))
}

/// Keep the resolved name relative to the opened root through the actual open.
/// Canonicalization preserves existing in-root aliases, but its returned path is
/// only an observation: cap-std must enforce containment if any component changes.
/// Check the root binding again before exposing the file to a content reader.
pub(crate) fn open_source_file(
    root: &Dir,
    relative_path: &Path,
) -> Result<fs::File, CodebaseError> {
    let absolute_path = root.resolve_existing(relative_path)?;
    #[cfg(all(test, unix))]
    crate::source_read_tests::after_resolution();
    let resolved_relative = absolute_path
        .strip_prefix(root.canonical_path())
        .map_err(|_| ash_file_access::DirPathError::OutsideDir(absolute_path.clone()))?;
    let file = root
        .directory()
        .handle()
        .open(resolved_relative)
        .map_err(|source| io_error(&absolute_path, source))?;
    #[cfg(all(test, unix))]
    crate::source_read_tests::after_open();
    root.directory().ensure_current()?;
    Ok(file.into_std())
}

fn looks_binary(bytes: &[u8]) -> bool {
    bytes.iter().take(8 * 1024).any(|byte| *byte == 0)
}

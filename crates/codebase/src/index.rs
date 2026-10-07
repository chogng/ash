use std::collections::BTreeMap;
use std::fs;
use std::io::Read;
use std::path::Component;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;

use ash_file_access::Dir;
use sha2::Digest;
use sha2::Sha256;

use crate::ChunkContentHash;
use crate::ChunkKey;
use crate::ChunkReference;
use crate::ChunkSpan;
use crate::CodebaseError;
use crate::CodebaseLimits;
use crate::CodebaseManifest;
use crate::CodebaseOverlayDocument;
use crate::CodebaseOverlaySnapshot;
use crate::CodebaseQuery;
use crate::CodebaseSnapshot;
use crate::IndexRootId;
use crate::IndexedChunkReference;
use crate::IndexedSourceReference;
use crate::MaterializedChunk;
use crate::MaterializedExcerpt;
use crate::MaterializedSource;
use crate::RefreshOutcome;
use crate::SearchHit;
use crate::SourceExcerptReference;
use crate::chunker::CHUNKER_VERSION;
use crate::chunker::end_line_exclusive;
use crate::chunker::language_for_path;
use crate::chunker::line_at;
use crate::chunker::line_starts;
use crate::chunker::source_revision;
use crate::error::io_error;
use crate::memory_store::InMemoryCodebaseIndexStore;
use crate::overlay::CodebaseOverlay;
use crate::scanner::prepare_relative_file;
use crate::scanner::scan_dir;
use crate::store::CodebaseIndexStore;
use crate::store::FileUpdate;
use crate::store::StoredSource;

/// One directory Codebase backed by rebuildable local data.
pub struct Codebase {
    root: Dir,
    root_id: IndexRootId,
    limits: CodebaseLimits,
    store: Arc<dyn CodebaseIndexStore>,
    overlay: Arc<CodebaseOverlay>,
}

impl Codebase {
    /// Opens a process-local Codebase for tests and explicitly ephemeral product sessions.
    pub fn open_memory(root: Dir, limits: CodebaseLimits) -> Result<Self, CodebaseError> {
        Self::open(
            root,
            Arc::new(InMemoryCodebaseIndexStore::default()),
            limits,
        )
    }

    /// Opens a local index projection for one already-authorized directory root.
    ///
    /// Opening does not scan the directory. Call [`Self::rebuild`] after watcher registration so
    /// filesystem mutations during the initial scan remain observable to the host.
    pub fn open(
        root: Dir,
        store: Arc<dyn CodebaseIndexStore>,
        limits: CodebaseLimits,
    ) -> Result<Self, CodebaseError> {
        validate_limits(&limits)?;
        let root_id = IndexRootId::from_root(&root);
        Ok(Self {
            root,
            root_id,
            limits,
            store,
            overlay: Arc::new(CodebaseOverlay::default()),
        })
    }

    /// Returns the canonical directory boundary indexed by this instance.
    pub fn root(&self) -> &Dir {
        &self.root
    }

    /// Returns the stable canonical identity of the indexed directory root.
    pub fn root_id(&self) -> &IndexRootId {
        &self.root_id
    }

    /// Returns the currently published projection summary without reading source files.
    pub fn snapshot(&self) -> Result<CodebaseSnapshot, CodebaseError> {
        self.store.snapshot(&self.root_id)
    }

    /// Returns the source and chunk identities published in the current atomic generation.
    pub fn manifest(&self) -> Result<CodebaseManifest, CodebaseError> {
        self.store.manifest(&self.root_id)
    }

    /// Performs a deterministic full scan and atomically replaces the published projection.
    pub fn rebuild(&self) -> Result<CodebaseSnapshot, CodebaseError> {
        let scan = scan_dir(&self.root, &self.limits)?;
        self.store.replace_sources(&self.root_id, scan)
    }

    /// Applies coarse watcher hints, rebuilding when a directory-level change cannot be safely
    /// represented as exact file updates.
    pub fn refresh_observed_paths(
        &self,
        observed_paths: &[PathBuf],
    ) -> Result<RefreshOutcome, CodebaseError> {
        let mut relative_paths = observed_paths
            .iter()
            .filter_map(|path| self.root.project_observed_path(path))
            .collect::<Vec<_>>();
        relative_paths.sort_unstable();
        relative_paths.dedup();
        if relative_paths.is_empty() {
            return Ok(RefreshOutcome::NoChange);
        }

        let snapshot = self.snapshot()?;
        if snapshot.file_limit_hit || snapshot.source_bytes_limit_hit {
            return self.rebuild().map(RefreshOutcome::Rebuilt);
        }

        let mut updates = Vec::new();
        for relative_path in relative_paths {
            if relative_path.as_os_str().is_empty() || is_ignore_control_path(&relative_path) {
                return self.rebuild().map(RefreshOutcome::Rebuilt);
            }
            if is_hard_excluded_path(&relative_path) {
                continue;
            }
            let candidate = self.root.canonical_path().join(&relative_path);
            if candidate.is_dir() {
                return self.rebuild().map(RefreshOutcome::Rebuilt);
            }
            if candidate.is_file() {
                let Some(stored) = self.store.source(&relative_path)? else {
                    return self.rebuild().map(RefreshOutcome::Rebuilt);
                };
                let Some(file) =
                    prepare_relative_file(&self.root, relative_path.clone(), &self.limits)?
                else {
                    return self.rebuild().map(RefreshOutcome::Rebuilt);
                };
                if stored.revision == file.source_revision {
                    continue;
                }
                if exceeds_source_limit(&snapshot, &stored, file.source_bytes, &self.limits) {
                    return self.rebuild().map(RefreshOutcome::Rebuilt);
                }
                updates.push(FileUpdate::Upsert(file));
                continue;
            }
            if self.store.source(&relative_path)?.is_some() {
                updates.push(FileUpdate::Remove(relative_path));
            } else if self.store.has_descendants(&relative_path)? {
                return self.rebuild().map(RefreshOutcome::Rebuilt);
            }
        }
        if updates.is_empty() {
            return Ok(RefreshOutcome::NoChange);
        }
        self.store
            .publish_updates(&self.root_id, updates)
            .map(RefreshOutcome::Published)
    }

    /// Searches indexed path and chunk text using a literal FTS query.
    pub fn search(&self, query: &CodebaseQuery) -> Result<Vec<SearchHit>, CodebaseError> {
        let expression = literal_fts_expression(query.text(), self.limits.max_query_bytes)?;
        let result_limit = self.search_limit(query);
        let dirty_paths = self.overlay.dirty_paths();
        let mut hits = self.overlay.search(query.text(), result_limit);
        hits.extend(
            self.store
                .search(&self.root_id, &expression, self.limits.max_results)?
                .into_iter()
                .filter(|hit| !dirty_paths.contains(&hit.reference.relative_path)),
        );
        hits.sort_by(|left, right| {
            right
                .score
                .total_cmp(&left.score)
                .then_with(|| left.reference.cmp(&right.reference))
        });
        let mut seen = std::collections::BTreeSet::new();
        hits.retain(|hit| seen.insert(hit.reference.clone()));
        hits.truncate(result_limit);
        Ok(hits)
    }

    pub(crate) fn search_limit(&self, query: &CodebaseQuery) -> usize {
        query.result_limit().get().min(self.limits.max_results)
    }

    pub(crate) fn chunks_at_lines(
        &self,
        lines: &[(PathBuf, usize)],
    ) -> Result<Vec<SearchHit>, CodebaseError> {
        self.store.chunks_at_lines(&self.root_id, lines)
    }

    /// Publishes the latest editor snapshot without mutating the persistent disk projection.
    pub fn synchronize_overlay(
        &self,
        document: CodebaseOverlayDocument,
    ) -> Result<CodebaseOverlaySnapshot, CodebaseError> {
        validate_overlay_path(&document.relative_path)?;
        let persistent = self
            .manifest()?
            .sources
            .into_iter()
            .find(|source| source.relative_path == document.relative_path);
        self.overlay.synchronize(
            &self.root_id,
            &self.limits,
            document,
            persistent.as_ref().map(|source| &source.source_revision),
        )
    }

    /// Releases one editor document from the ephemeral overlay.
    pub fn close_overlay(
        &self,
        relative_path: &Path,
    ) -> Result<CodebaseOverlaySnapshot, CodebaseError> {
        validate_overlay_path(relative_path)?;
        Ok(self.overlay.close(relative_path))
    }

    /// Hands matching dirty snapshots back to the persistent generation after a save is observed.
    pub fn handoff_matching_overlays(&self) -> Result<CodebaseOverlaySnapshot, CodebaseError> {
        Ok(self.overlay.handoff(&self.manifest()?))
    }

    /// Returns the current immutable content-bearing overlay projection.
    pub fn overlay_snapshot(&self) -> CodebaseOverlaySnapshot {
        self.overlay.snapshot()
    }

    /// Returns paths whose editor content supersedes every persistent candidate source.
    pub fn dirty_overlay_paths(&self) -> std::collections::BTreeSet<PathBuf> {
        self.overlay.dirty_paths()
    }

    /// Rereads one search result and proves that its revision, range, and chunk identities still
    /// match the current directory file before the content is used as Agent context.
    pub fn materialize(
        &self,
        reference: &ChunkReference,
    ) -> Result<MaterializedChunk, CodebaseError> {
        if reference.root_id != self.root_id {
            return Err(CodebaseError::StorageRootMismatch);
        }
        if let Some(materialized) = self.overlay.materialize_chunk(reference) {
            return materialized;
        }
        let absolute_path = self.root.resolve_existing(&reference.relative_path)?;
        let source = read_source_for_verification(&absolute_path, self.limits.max_file_bytes)?;
        materialize_chunk_from_source(reference, &source)
    }

    /// Rereads one revision-bound excerpt and verifies its current source revision, byte range,
    /// and content hash without requiring the local chunker to have produced the boundary.
    pub fn materialize_excerpt(
        &self,
        reference: &SourceExcerptReference,
    ) -> Result<MaterializedExcerpt, CodebaseError> {
        self.validate_root(&reference.root_id)?;
        if let Some(materialized) = self.overlay.materialize_excerpt(reference) {
            return materialized;
        }
        let absolute_path = self.root.resolve_existing(&reference.relative_path)?;
        let source = read_source_for_verification(&absolute_path, self.limits.max_file_bytes)?;
        validate_source_revision(&source, &reference.source_revision)?;
        let content = verified_span_content(&source, &reference.span)?;
        let content_hash = ChunkContentHash::new(sha256(content.as_bytes()));
        if content_hash != reference.content_hash {
            return Err(CodebaseError::ChunkIdentityMismatch);
        }
        Ok(MaterializedExcerpt {
            reference: reference.clone(),
            language: language_for_path(Path::new(&reference.relative_path)),
            content: content.to_owned(),
        })
    }

    /// Verifies an exact source revision and creates a content-addressed excerpt reference for a
    /// Directory-owned range such as a syntax declaration.
    pub fn materialize_verified_excerpt(
        &self,
        source: &IndexedSourceReference,
        span: ChunkSpan,
    ) -> Result<MaterializedExcerpt, CodebaseError> {
        let materialized = self
            .materialize_sources(std::slice::from_ref(source))?
            .pop()
            .ok_or(CodebaseError::InvalidChunkRange)?;
        let content = verified_span_content(&materialized.content, &span)?;
        let reference = SourceExcerptReference {
            root_id: source.root_id.clone(),
            relative_path: source.relative_path.clone(),
            source_revision: source.source_revision.clone(),
            content_hash: ChunkContentHash::new(sha256(content.as_bytes())),
            span,
        };
        Ok(MaterializedExcerpt {
            reference,
            language: source.language,
            content: content.to_owned(),
        })
    }

    /// Rereads and verifies complete source files selected from one published manifest.
    pub fn materialize_sources(
        &self,
        references: &[IndexedSourceReference],
    ) -> Result<Vec<MaterializedSource>, CodebaseError> {
        references
            .iter()
            .map(|reference| {
                self.validate_root(&reference.root_id)?;
                if let Some(materialized) = self.overlay.materialize_source(reference) {
                    return materialized;
                }
                let absolute_path = self.root.resolve_existing(&reference.relative_path)?;
                let content =
                    read_source_for_verification(&absolute_path, self.limits.max_file_bytes)?;
                validate_source_revision(&content, &reference.source_revision)?;
                Ok(MaterializedSource {
                    reference: reference.clone(),
                    content,
                })
            })
            .collect()
    }

    /// Rereads each selected source at most once and verifies all selected chunk identities.
    pub fn materialize_chunks(
        &self,
        references: &[IndexedChunkReference],
    ) -> Result<Vec<MaterializedChunk>, CodebaseError> {
        let mut by_path = BTreeMap::<PathBuf, Vec<&IndexedChunkReference>>::new();
        for reference in references {
            self.validate_root(&reference.reference.root_id)?;
            by_path
                .entry(reference.reference.relative_path.clone())
                .or_default()
                .push(reference);
        }
        let mut materialized = Vec::with_capacity(references.len());
        for (relative_path, path_references) in by_path {
            let absolute_path = self.root.resolve_existing(&relative_path)?;
            let source = read_source_for_verification(&absolute_path, self.limits.max_file_bytes)?;
            for reference in path_references {
                let mut chunk = materialize_chunk_from_source(&reference.reference, &source)?;
                chunk.language = reference.language;
                materialized.push(chunk);
            }
        }
        Ok(materialized)
    }

    fn validate_root(&self, root_id: &IndexRootId) -> Result<(), CodebaseError> {
        if root_id == &self.root_id {
            Ok(())
        } else {
            Err(CodebaseError::StorageRootMismatch)
        }
    }
}

fn validate_overlay_path(relative_path: &Path) -> Result<(), CodebaseError> {
    if relative_path.as_os_str().is_empty()
        || !relative_path.is_relative()
        || relative_path
            .components()
            .any(|component| !matches!(component, Component::Normal(_)))
        || is_hard_excluded_path(relative_path)
    {
        Err(CodebaseError::InvalidOverlayPath)
    } else {
        Ok(())
    }
}

fn materialize_chunk_from_source(
    reference: &ChunkReference,
    source: &str,
) -> Result<MaterializedChunk, CodebaseError> {
    validate_source_revision(source, &reference.source_revision)?;
    let content = verified_span_content(source, &reference.span)?;
    let content_hash = ChunkContentHash::new(sha256(content.as_bytes()));
    let key = ChunkKey::new(sha256(
        [CHUNKER_VERSION.as_bytes(), b"\0", content.as_bytes()].concat(),
    ));
    if content_hash != reference.content_hash || key != reference.key {
        return Err(CodebaseError::ChunkIdentityMismatch);
    }
    Ok(MaterializedChunk {
        reference: reference.clone(),
        language: language_for_path(Path::new(&reference.relative_path)),
        content: content.to_owned(),
    })
}

pub(crate) fn verified_span_content<'a>(
    source: &'a str,
    span: &crate::ChunkSpan,
) -> Result<&'a str, CodebaseError> {
    if span.start_byte >= span.end_byte || span.start_line >= span.end_line_exclusive {
        return Err(CodebaseError::InvalidChunkRange);
    }
    let Some(content) = source.get(span.byte_range()) else {
        return Err(CodebaseError::InvalidChunkRange);
    };
    let starts = line_starts(source);
    let start_line = line_at(&starts, span.start_byte);
    let end_line = end_line_exclusive(&starts, span.end_byte, source.len());
    if span.start_line != start_line || span.end_line_exclusive != end_line {
        return Err(CodebaseError::ChunkSpanMismatch);
    }
    Ok(content)
}

fn validate_source_revision(
    source: &str,
    expected: &crate::SourceRevision,
) -> Result<(), CodebaseError> {
    let observed = source_revision(source);
    if &observed == expected {
        Ok(())
    } else {
        Err(CodebaseError::StaleRevision {
            expected: expected.clone(),
            observed,
        })
    }
}

fn read_source_for_verification(
    path: &Path,
    max_file_bytes: usize,
) -> Result<String, CodebaseError> {
    let file = fs::File::open(path).map_err(|source| io_error(path, source))?;
    let read_limit = u64::try_from(max_file_bytes)
        .unwrap_or(u64::MAX)
        .saturating_add(1);
    let mut bytes = Vec::with_capacity(max_file_bytes.min(64 * 1024));
    file.take(read_limit)
        .read_to_end(&mut bytes)
        .map_err(|source| io_error(path, source))?;
    if bytes.len() > max_file_bytes {
        return Err(CodebaseError::SourceVerificationLimitExceeded);
    }
    String::from_utf8(bytes).map_err(|source| {
        io_error(
            path,
            std::io::Error::new(std::io::ErrorKind::InvalidData, source),
        )
    })
}

fn exceeds_source_limit(
    snapshot: &CodebaseSnapshot,
    stored: &StoredSource,
    replacement_bytes: usize,
    limits: &CodebaseLimits,
) -> bool {
    snapshot
        .indexed_source_bytes
        .saturating_sub(stored.source_bytes)
        .saturating_add(replacement_bytes)
        > limits.max_total_source_bytes
}

fn is_ignore_control_path(relative_path: &Path) -> bool {
    relative_path
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| matches!(name, ".gitignore" | ".ignore" | ".gitmodules"))
        || relative_path == Path::new(".git/info/exclude")
}

fn is_hard_excluded_path(relative_path: &Path) -> bool {
    relative_path.components().any(|component| {
        component
            .as_os_str()
            .to_str()
            .is_some_and(|name| matches!(name, ".git" | ".ash" | "node_modules" | "target"))
    })
}

fn validate_limits(limits: &CodebaseLimits) -> Result<(), CodebaseError> {
    if limits.target_chunk_bytes > limits.max_chunk_bytes {
        return Err(CodebaseError::InvalidLimits(
            "target chunk size must not exceed the hard chunk size",
        ));
    }
    if limits.max_chunk_bytes > limits.max_file_bytes {
        return Err(CodebaseError::InvalidLimits(
            "hard chunk size must not exceed the maximum file size",
        ));
    }
    if limits.max_file_bytes > limits.max_total_source_bytes {
        return Err(CodebaseError::InvalidLimits(
            "maximum file size must not exceed the total source-byte limit",
        ));
    }
    Ok(())
}

fn literal_fts_expression(text: &str, max_query_bytes: usize) -> Result<String, CodebaseError> {
    let text = text.trim();
    if text.is_empty() {
        return Err(CodebaseError::InvalidQuery("query must not be empty"));
    }
    if text.len() > max_query_bytes {
        return Err(CodebaseError::InvalidQuery("query exceeds the byte limit"));
    }
    let terms = text
        .split_whitespace()
        .map(|term| format!("\"{}\"", term.replace('"', "\"\"")))
        .collect::<Vec<_>>();
    if terms.is_empty() {
        return Err(CodebaseError::InvalidQuery("query must contain text"));
    }
    Ok(terms.join(" AND "))
}

fn sha256(bytes: impl AsRef<[u8]>) -> String {
    let mut digest = Sha256::new();
    digest.update(bytes.as_ref());
    format!("sha256:{:x}", digest.finalize())
}

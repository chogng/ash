use std::collections::BTreeMap;
use std::collections::BTreeSet;
use std::path::Path;
use std::path::PathBuf;
use std::sync::RwLock;

use crate::ChunkContentHash;
use crate::ChunkReference;
use crate::CodebaseError;
use crate::CodebaseLimits;
use crate::CodebaseManifest;
use crate::CodebaseOverlayDocument;
use crate::CodebaseOverlaySnapshot;
use crate::IndexRootId;
use crate::IndexedSourceReference;
use crate::MaterializedChunk;
use crate::MaterializedExcerpt;
use crate::MaterializedOverlayDocument;
use crate::MaterializedSource;
use crate::SearchHit;
use crate::SourceExcerptReference;
use crate::chunker::chunk_source;
use crate::chunker::source_revision;
use crate::index::verified_span_content;
use sha2::Digest;
use sha2::Sha256;

#[derive(Default)]
pub(crate) struct CodebaseOverlay {
    state: RwLock<OverlayState>,
}

#[derive(Default)]
struct OverlayState {
    generation: u64,
    documents: BTreeMap<PathBuf, MaterializedOverlayDocument>,
}

impl CodebaseOverlay {
    pub fn snapshot(&self) -> CodebaseOverlaySnapshot {
        let state = self
            .state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        CodebaseOverlaySnapshot {
            generation: state.generation,
            documents: state.documents.values().cloned().collect(),
        }
    }

    pub fn synchronize(
        &self,
        root_id: &IndexRootId,
        limits: &CodebaseLimits,
        document: CodebaseOverlayDocument,
        persistent_revision: Option<&crate::SourceRevision>,
    ) -> Result<CodebaseOverlaySnapshot, CodebaseError> {
        if document.content.len() > limits.max_file_bytes {
            return Err(CodebaseError::SourceVerificationLimitExceeded);
        }
        let revision = source_revision(&document.content);
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if let Some(current) = state.documents.get(&document.relative_path)
            && (current.editor_revision > document.editor_revision
                || (current.editor_revision == document.editor_revision
                    && (current.source.reference.source_revision != revision
                        || current.source.reference.language != document.language)))
        {
            return Err(CodebaseError::OverlayRevisionConflict);
        }
        if persistent_revision == Some(&revision) {
            if state.documents.remove(&document.relative_path).is_some() {
                state.generation = state.generation.saturating_add(1);
            }
            return Ok(snapshot_from_state(&state));
        }
        let chunking = chunk_source(document.language, &document.content, limits);
        let source = MaterializedSource {
            reference: IndexedSourceReference {
                root_id: root_id.clone(),
                relative_path: document.relative_path.clone(),
                source_revision: revision.clone(),
                language: document.language,
                source_bytes: document.content.len(),
            },
            content: document.content,
        };
        let chunks = chunking
            .chunks
            .into_iter()
            .map(|chunk| MaterializedChunk {
                reference: ChunkReference {
                    root_id: root_id.clone(),
                    relative_path: document.relative_path.clone(),
                    source_revision: revision.clone(),
                    key: chunk.key,
                    content_hash: chunk.content_hash,
                    span: chunk.span,
                },
                language: document.language,
                content: chunk.content,
            })
            .collect();
        let materialized = MaterializedOverlayDocument {
            editor_revision: document.editor_revision,
            source,
            chunks,
        };
        let unchanged = state
            .documents
            .get(&document.relative_path)
            .is_some_and(|current| current == &materialized);
        if !unchanged {
            state.documents.insert(document.relative_path, materialized);
            state.generation = state.generation.saturating_add(1);
        }
        Ok(snapshot_from_state(&state))
    }

    pub fn close(&self, relative_path: &Path) -> CodebaseOverlaySnapshot {
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.documents.remove(relative_path).is_some() {
            state.generation = state.generation.saturating_add(1);
        }
        snapshot_from_state(&state)
    }

    pub fn handoff(&self, manifest: &CodebaseManifest) -> CodebaseOverlaySnapshot {
        let revisions = manifest
            .sources
            .iter()
            .map(|source| (&source.relative_path, &source.source_revision))
            .collect::<BTreeMap<_, _>>();
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let before = state.documents.len();
        state.documents.retain(|path, document| {
            revisions.get(path).copied() != Some(&document.source.reference.source_revision)
        });
        if state.documents.len() != before {
            state.generation = state.generation.saturating_add(1);
        }
        snapshot_from_state(&state)
    }

    pub fn dirty_paths(&self) -> BTreeSet<PathBuf> {
        self.state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .documents
            .keys()
            .cloned()
            .collect()
    }

    pub fn search(&self, query: &str, result_limit: usize) -> Vec<SearchHit> {
        let terms = query
            .split_whitespace()
            .map(str::to_lowercase)
            .collect::<Vec<_>>();
        let state = self
            .state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut hits = state
            .documents
            .values()
            .flat_map(|document| &document.chunks)
            .filter_map(|chunk| {
                let path = chunk
                    .reference
                    .relative_path
                    .to_string_lossy()
                    .to_lowercase();
                let content = chunk.content.to_lowercase();
                if !terms
                    .iter()
                    .all(|term| path.contains(term) || content.contains(term))
                {
                    return None;
                }
                let occurrences = terms
                    .iter()
                    .map(|term| content.matches(term).count() + path.matches(term).count())
                    .sum::<usize>();
                Some(SearchHit {
                    reference: chunk.reference.clone(),
                    language: chunk.language,
                    content: chunk.content.clone(),
                    score: 1_000_000.0 + occurrences as f64,
                })
            })
            .collect::<Vec<_>>();
        hits.sort_by(|left, right| {
            right
                .score
                .total_cmp(&left.score)
                .then_with(|| left.reference.cmp(&right.reference))
        });
        hits.truncate(result_limit);
        hits
    }

    pub fn materialize_chunk(
        &self,
        reference: &ChunkReference,
    ) -> Option<Result<MaterializedChunk, CodebaseError>> {
        let state = self
            .state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let document = state.documents.get(&reference.relative_path)?;
        Some(
            document
                .chunks
                .iter()
                .find(|chunk| chunk.reference == *reference)
                .cloned()
                .ok_or(CodebaseError::OverlaySupersedesPersistentSource),
        )
    }

    pub fn materialize_excerpt(
        &self,
        reference: &SourceExcerptReference,
    ) -> Option<Result<MaterializedExcerpt, CodebaseError>> {
        let state = self
            .state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let document = state.documents.get(&reference.relative_path)?;
        Some(materialize_overlay_excerpt(document, reference))
    }

    pub fn materialize_source(
        &self,
        reference: &IndexedSourceReference,
    ) -> Option<Result<MaterializedSource, CodebaseError>> {
        let state = self
            .state
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let document = state.documents.get(&reference.relative_path)?;
        Some(if document.source.reference == *reference {
            Ok(document.source.clone())
        } else {
            Err(CodebaseError::OverlaySupersedesPersistentSource)
        })
    }
}

fn materialize_overlay_excerpt(
    document: &MaterializedOverlayDocument,
    reference: &SourceExcerptReference,
) -> Result<MaterializedExcerpt, CodebaseError> {
    if document.source.reference.source_revision != reference.source_revision {
        return Err(CodebaseError::OverlaySupersedesPersistentSource);
    }
    let content = verified_span_content(&document.source.content, &reference.span)?;
    let content_hash = ChunkContentHash::new(sha256(content.as_bytes()));
    if content_hash != reference.content_hash {
        return Err(CodebaseError::ChunkIdentityMismatch);
    }
    Ok(MaterializedExcerpt {
        reference: reference.clone(),
        language: document.source.reference.language,
        content: content.to_owned(),
    })
}

fn sha256(bytes: impl AsRef<[u8]>) -> String {
    let mut digest = Sha256::new();
    digest.update(bytes.as_ref());
    format!("sha256:{:x}", digest.finalize())
}

fn snapshot_from_state(state: &OverlayState) -> CodebaseOverlaySnapshot {
    CodebaseOverlaySnapshot {
        generation: state.generation,
        documents: state.documents.values().cloned().collect(),
    }
}

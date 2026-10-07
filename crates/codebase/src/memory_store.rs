use std::collections::BTreeMap;
use std::path::Path;
use std::path::PathBuf;
use std::sync::RwLock;

use crate::{
    ChunkReference, CodebaseError, CodebaseIndexStore, CodebaseManifest, CodebaseSnapshot, DirScan,
    FileUpdate, IndexRootId, IndexedChunkReference, IndexedSourceReference, PreparedFile,
    SearchHit, StoredSource,
};

#[derive(Default)]
pub(crate) struct InMemoryCodebaseIndexStore {
    state: RwLock<State>,
}

#[derive(Default)]
struct State {
    generation: u64,
    files: BTreeMap<std::path::PathBuf, PreparedFile>,
    skipped_file_count: usize,
    file_limit_hit: bool,
    source_bytes_limit_hit: bool,
}

impl CodebaseIndexStore for InMemoryCodebaseIndexStore {
    fn replace_sources(
        &self,
        root_id: &IndexRootId,
        scan: DirScan,
    ) -> Result<CodebaseSnapshot, CodebaseError> {
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|error| error.into_inner());
        state.generation = state.generation.saturating_add(1);
        state.files = scan
            .files
            .into_iter()
            .map(|file| (file.relative_path.clone(), file))
            .collect();
        state.skipped_file_count = scan.skipped_file_count;
        state.file_limit_hit = scan.file_limit_hit;
        state.source_bytes_limit_hit = scan.source_bytes_limit_hit;
        Ok(snapshot(root_id, &state))
    }

    fn publish_updates(
        &self,
        root_id: &IndexRootId,
        updates: Vec<FileUpdate>,
    ) -> Result<CodebaseSnapshot, CodebaseError> {
        let mut state = self
            .state
            .write()
            .unwrap_or_else(|error| error.into_inner());
        for update in updates {
            match update {
                FileUpdate::Remove(path) => {
                    state.files.remove(&path);
                }
                FileUpdate::Upsert(file) => {
                    state.files.insert(file.relative_path.clone(), file);
                }
            }
        }
        state.generation = state.generation.saturating_add(1);
        Ok(snapshot(root_id, &state))
    }

    fn snapshot(&self, root_id: &IndexRootId) -> Result<CodebaseSnapshot, CodebaseError> {
        let state = self.state.read().unwrap_or_else(|error| error.into_inner());
        Ok(snapshot(root_id, &state))
    }

    fn manifest(&self, root_id: &IndexRootId) -> Result<CodebaseManifest, CodebaseError> {
        let state = self.state.read().unwrap_or_else(|error| error.into_inner());
        let sources = state
            .files
            .values()
            .map(|file| IndexedSourceReference {
                root_id: root_id.clone(),
                relative_path: file.relative_path.clone(),
                source_revision: file.source_revision.clone(),
                language: file.language,
                source_bytes: file.source_bytes,
            })
            .collect();
        let chunks = state
            .files
            .values()
            .flat_map(|file| {
                file.chunks.iter().map(|chunk| IndexedChunkReference {
                    reference: ChunkReference {
                        root_id: root_id.clone(),
                        relative_path: file.relative_path.clone(),
                        source_revision: file.source_revision.clone(),
                        key: chunk.key.clone(),
                        content_hash: chunk.content_hash.clone(),
                        span: chunk.span.clone(),
                    },
                    language: file.language,
                })
            })
            .collect();
        Ok(CodebaseManifest {
            snapshot: snapshot(root_id, &state),
            sources,
            chunks,
        })
    }

    fn source(&self, relative_path: &Path) -> Result<Option<StoredSource>, CodebaseError> {
        let state = self.state.read().unwrap_or_else(|error| error.into_inner());
        Ok(state.files.get(relative_path).map(|file| StoredSource {
            revision: file.source_revision.clone(),
            source_bytes: file.source_bytes,
        }))
    }

    fn has_descendants(&self, relative_path: &Path) -> Result<bool, CodebaseError> {
        let state = self.state.read().unwrap_or_else(|error| error.into_inner());
        Ok(state
            .files
            .keys()
            .any(|path| path.starts_with(relative_path)))
    }

    fn chunks_at_lines(
        &self,
        root_id: &IndexRootId,
        lines: &[(PathBuf, usize)],
    ) -> Result<Vec<SearchHit>, CodebaseError> {
        let state = self.state.read().unwrap_or_else(|e| e.into_inner());
        let mut hits = BTreeMap::new();
        for (path, line) in lines {
            let Some(file) = state.files.get(path) else {
                continue;
            };
            for chunk in &file.chunks {
                if *line == 0
                    || *line - 1 < chunk.span.start_line
                    || *line - 1 >= chunk.span.end_line_exclusive
                {
                    continue;
                }
                let reference = ChunkReference {
                    root_id: root_id.clone(),
                    relative_path: path.clone(),
                    source_revision: file.source_revision.clone(),
                    key: chunk.key.clone(),
                    content_hash: chunk.content_hash.clone(),
                    span: chunk.span.clone(),
                };
                hits.insert(
                    reference.clone(),
                    SearchHit {
                        reference,
                        language: file.language,
                        content: chunk.content.clone(),
                        score: 1.0,
                    },
                );
            }
        }
        Ok(hits.into_values().collect())
    }

    fn search(
        &self,
        root_id: &IndexRootId,
        expression: &str,
        result_limit: usize,
    ) -> Result<Vec<SearchHit>, CodebaseError> {
        let terms = expression
            .split(" AND ")
            .map(|term| term.trim_matches('"').replace("\"\"", "\"").to_lowercase())
            .collect::<Vec<_>>();
        let state = self.state.read().unwrap_or_else(|error| error.into_inner());
        let mut hits = state
            .files
            .values()
            .flat_map(|file| {
                let terms = &terms;
                file.chunks.iter().filter_map(move |chunk| {
                    let content = chunk.content.to_lowercase();
                    terms
                        .iter()
                        .all(|term| content.contains(term))
                        .then(|| SearchHit {
                            reference: ChunkReference {
                                root_id: root_id.clone(),
                                relative_path: file.relative_path.clone(),
                                source_revision: file.source_revision.clone(),
                                key: chunk.key.clone(),
                                content_hash: chunk.content_hash.clone(),
                                span: chunk.span.clone(),
                            },
                            language: file.language,
                            content: chunk.content.clone(),
                            score: terms
                                .iter()
                                .filter(|term| content.contains(term.as_str()))
                                .count() as f64,
                        })
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
        Ok(hits)
    }
}

fn snapshot(root_id: &IndexRootId, state: &State) -> CodebaseSnapshot {
    CodebaseSnapshot {
        root_id: root_id.clone(),
        generation: state.generation,
        indexed_file_count: state.files.len(),
        indexed_chunk_count: state.files.values().map(|file| file.chunks.len()).sum(),
        indexed_source_bytes: state.files.values().map(|file| file.source_bytes).sum(),
        skipped_file_count: state.skipped_file_count,
        truncated_file_count: state
            .files
            .values()
            .filter(|file| file.chunk_limit_hit)
            .count(),
        file_limit_hit: state.file_limit_hit,
        source_bytes_limit_hit: state.source_bytes_limit_hit,
    }
}

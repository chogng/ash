use std::path::{Path, PathBuf};

use crate::scanner::{DirScan, PreparedFile};
use crate::{
    CodebaseError, CodebaseManifest, CodebaseSnapshot, IndexRootId, SearchHit, SourceRevision,
};

/// One filesystem change translated into a source-store update.
pub enum FileUpdate {
    Remove(PathBuf),
    Upsert(PreparedFile),
}

/// Stored source metadata needed to decide whether an observed file changed.
pub struct StoredSource {
    pub revision: SourceRevision,
    pub source_bytes: usize,
}

/// Persistence port used by Codebase source construction and lexical retrieval.
pub trait CodebaseIndexStore: Send + Sync {
    fn replace_sources(
        &self,
        root_id: &IndexRootId,
        scan: DirScan,
    ) -> Result<CodebaseSnapshot, CodebaseError>;

    fn publish_updates(
        &self,
        root_id: &IndexRootId,
        updates: Vec<FileUpdate>,
    ) -> Result<CodebaseSnapshot, CodebaseError>;

    fn snapshot(&self, root_id: &IndexRootId) -> Result<CodebaseSnapshot, CodebaseError>;
    fn manifest(&self, root_id: &IndexRootId) -> Result<CodebaseManifest, CodebaseError>;
    fn source(&self, relative_path: &Path) -> Result<Option<StoredSource>, CodebaseError>;
    fn has_descendants(&self, relative_path: &Path) -> Result<bool, CodebaseError>;
    /// Maps one-based grep line hits to existing revision-bound chunks.
    fn chunks_at_lines(
        &self,
        root_id: &IndexRootId,
        lines: &[(PathBuf, usize)],
    ) -> Result<Vec<SearchHit>, CodebaseError>;

    fn search(
        &self,
        root_id: &IndexRootId,
        expression: &str,
        result_limit: usize,
    ) -> Result<Vec<SearchHit>, CodebaseError>;
}

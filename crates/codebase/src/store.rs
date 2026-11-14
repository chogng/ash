use std::path::Path;
use std::path::PathBuf;

use crate::CodebaseError;
use crate::CodebaseManifest;
use crate::CodebaseSnapshot;
use crate::IndexRootId;
use crate::SearchHit;
use crate::SourceRevision;
use crate::scanner::DirScan;
use crate::scanner::PreparedFile;

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

/// Changes from one complete policy scan, with coverage metadata committed in the same
/// generation. Unchanged chunk payloads remain in their owning store.
pub struct SourceReconciliation {
    pub expected_generation: u64,
    pub chunking_policy: String,
    pub updates: Vec<FileUpdate>,
    pub skipped_file_count: usize,
    pub file_limit_hit: bool,
    pub source_bytes_limit_hit: bool,
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

    /// Publishes the changed subset and scan coverage if the planned generation is current.
    fn reconcile_sources(
        &self,
        root_id: &IndexRootId,
        reconciliation: SourceReconciliation,
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

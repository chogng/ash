use std::path::Path;
use std::path::PathBuf;

use ash_diff::DiffDocument;
use ash_diff::DiffRowKind;

use crate::GitClient;
use crate::GitError;
use crate::GitFileRevision;
use crate::GitRepository;
use crate::GitRepositorySnapshot;
use crate::GitResult;

/// Per-file size policy for repository text-diff projection.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GitTextDiffLimits {
    maximum_file_bytes: usize,
}

impl GitTextDiffLimits {
    pub fn new(maximum_file_bytes: usize) -> GitResult<Self> {
        if maximum_file_bytes == 0 {
            return Err(GitError::InvalidConfiguration {
                field: "maximum_file_bytes",
                requirement: "must be non-zero",
            });
        }
        Ok(Self { maximum_file_bytes })
    }

    pub fn maximum_file_bytes(self) -> usize {
        self.maximum_file_bytes
    }
}

/// Added and deleted line totals for one text diff or an aggregate projection.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct GitDiffStatistics {
    files: usize,
    additions: usize,
    deletions: usize,
}

impl GitDiffStatistics {
    pub const fn files(self) -> usize {
        self.files
    }

    pub const fn additions(self) -> usize {
        self.additions
    }

    pub const fn deletions(self) -> usize {
        self.deletions
    }

    pub fn include(&mut self, other: Self) {
        self.files += other.files;
        self.additions += other.additions;
        self.deletions += other.deletions;
    }
}

/// One repository-relative UTF-8 text change from `HEAD` to the current working tree.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitTextDiff {
    path: PathBuf,
    original: String,
    modified: String,
    document: DiffDocument,
    statistics: GitDiffStatistics,
}

impl GitTextDiff {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn original(&self) -> &str {
        &self.original
    }

    pub fn modified(&self) -> &str {
        &self.modified
    }

    pub const fn document(&self) -> &DiffDocument {
        &self.document
    }

    pub const fn statistics(&self) -> GitDiffStatistics {
        self.statistics
    }
}

/// One status snapshot and the bounded text diffs derived from its changed paths.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitTextDiffSnapshot {
    repository: GitRepositorySnapshot,
    diffs: Vec<GitTextDiff>,
    statistics: GitDiffStatistics,
}

impl GitTextDiffSnapshot {
    pub const fn repository(&self) -> &GitRepositorySnapshot {
        &self.repository
    }

    pub fn diffs(&self) -> &[GitTextDiff] {
        &self.diffs
    }

    pub const fn statistics(&self) -> GitDiffStatistics {
        self.statistics
    }
}

impl GitClient {
    /// Captures repository status and derives bounded UTF-8 text diffs against `HEAD`.
    ///
    /// Binary, symlink, non-file, unreadable, oversized, or diff-engine-rejected paths remain in
    /// the returned repository status but are omitted from the text-diff collection and totals.
    pub async fn text_diff_snapshot(
        &self,
        repository: &GitRepository,
        limits: GitTextDiffLimits,
    ) -> GitResult<GitTextDiffSnapshot> {
        self.text_diff_snapshot_in_scope(repository, Path::new(""), limits)
            .await
    }

    /// Captures repository status and derives text diffs only below one repository-relative path.
    pub async fn text_diff_snapshot_under(
        &self,
        repository: &GitRepository,
        path_prefix: &Path,
        limits: GitTextDiffLimits,
    ) -> GitResult<GitTextDiffSnapshot> {
        validate_path_prefix(path_prefix)?;
        self.text_diff_snapshot_in_scope(repository, path_prefix, limits)
            .await
    }

    async fn text_diff_snapshot_in_scope(
        &self,
        repository: &GitRepository,
        path_prefix: &Path,
        limits: GitTextDiffLimits,
    ) -> GitResult<GitTextDiffSnapshot> {
        let snapshot = self.snapshot(repository).await?;
        let mut diffs = Vec::new();
        let mut statistics = GitDiffStatistics::default();
        for change in snapshot
            .changes()
            .iter()
            .filter(|change| change.path().starts_with(path_prefix))
        {
            let original_path = change.original_path().unwrap_or_else(|| change.path());
            let original = match self
                .read_file_at_revision(
                    repository,
                    original_path,
                    GitFileRevision::Head,
                    limits.maximum_file_bytes,
                )
                .await
            {
                Ok(Some(content)) => content,
                Ok(None) => Vec::new(),
                Err(_) => continue,
            };
            let Some(modified) = read_worktree_file(
                repository.worktree_root().join(change.path()),
                limits.maximum_file_bytes,
            ) else {
                continue;
            };
            if is_binary(&original) || is_binary(&modified) {
                continue;
            }
            let (Ok(original), Ok(modified)) = (
                std::str::from_utf8(&original),
                std::str::from_utf8(&modified),
            ) else {
                continue;
            };
            let Ok(document) = DiffDocument::from_text(original, modified) else {
                continue;
            };
            let file_statistics = statistics_for_document(&document);
            statistics.include(file_statistics);
            diffs.push(GitTextDiff {
                path: change.path().to_path_buf(),
                original: original.to_owned(),
                modified: modified.to_owned(),
                document,
                statistics: file_statistics,
            });
        }
        Ok(GitTextDiffSnapshot {
            repository: snapshot,
            diffs,
            statistics,
        })
    }
}

fn validate_path_prefix(path_prefix: &Path) -> GitResult<()> {
    if path_prefix.is_absolute()
        || path_prefix
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(GitError::runtime(
            "validate Git text diff path prefix",
            "path prefix must be repository-relative and cannot contain a parent component",
        ));
    }
    Ok(())
}

fn read_worktree_file(path: PathBuf, maximum_bytes: usize) -> Option<Vec<u8>> {
    let metadata = match path.symlink_metadata() {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Some(Vec::new()),
        Err(_) => return None,
    };
    if metadata.file_type().is_symlink()
        || !metadata.is_file()
        || metadata.len() > maximum_bytes as u64
    {
        return None;
    }
    std::fs::read(path).ok()
}

fn is_binary(content: &[u8]) -> bool {
    content.contains(&0)
}

fn statistics_for_document(document: &DiffDocument) -> GitDiffStatistics {
    let mut statistics = GitDiffStatistics {
        files: 1,
        additions: 0,
        deletions: 0,
    };
    for row in document.rows() {
        match row.kind() {
            DiffRowKind::Context => {}
            DiffRowKind::Added => statistics.additions += 1,
            DiffRowKind::Removed => statistics.deletions += 1,
            DiffRowKind::Modified => {
                statistics.additions += 1;
                statistics.deletions += 1;
            }
        }
    }
    statistics
}

#[cfg(test)]
#[path = "text_diff_tests.rs"]
mod tests;

use crate::GitChangeFileComparison;
use crate::GitClient;
use crate::GitError;
use crate::GitHead;
use crate::GitRepository;
use crate::GitResult;
use ash_diff::DiffDocument;
use ash_diff::DiffLine;
use ash_diff::DiffRowKind;
use ash_diff::LineEnding;
use std::ffi::OsString;
use std::path::Path;
use std::path::PathBuf;

const MAXIMUM_BYTES: usize = 2 * 1024 * 1024;

#[derive(Clone, Debug)]
pub enum GitIndexSelection {
    Hunk { index: usize },
    Lines { start: usize, end: usize },
}

#[derive(Clone, Debug)]
pub struct GitIndexDiff {
    pub original: Option<String>,
    pub modified: Option<String>,
    pub document: DiffDocument,
}

/// Exact reviewed contents bind the selection to one index/worktree comparison.
pub struct GitIndexEdit {
    pub path: PathBuf,
    pub comparison: GitChangeFileComparison,
    pub expected_original: Option<String>,
    pub expected_modified: Option<String>,
    pub selection: GitIndexSelection,
}

impl GitClient {
    pub async fn index_diff(
        &self,
        repository: &GitRepository,
        path: &Path,
        comparison: GitChangeFileComparison,
    ) -> GitResult<GitIndexDiff> {
        let snapshot = self.snapshot(repository).await?;
        let change = snapshot
            .changes()
            .iter()
            .find(|change| change.path() == path)
            .ok_or_else(|| invalid("path is no longer changed"))?;
        if change.is_conflicted()
            || change.original_path().is_some()
            || change.submodule().is_submodule()
        {
            return Err(invalid(
                "partial staging requires an ordinary non-conflicted file",
            ));
        }
        let file = self
            .change_file(repository, change, comparison, MAXIMUM_BYTES)
            .await?;
        let original = text(file.original())?;
        let modified = text(file.modified())?;
        let document = DiffDocument::from_text(
            original.as_deref().unwrap_or(""),
            modified.as_deref().unwrap_or(""),
        )
        .map_err(|_| invalid("diff exceeds partial staging limits"))?;
        Ok(GitIndexDiff {
            original,
            modified,
            document,
        })
    }

    /// Own Git's real index lock while reviewing and replacing the index. Other Git processes
    /// cannot stage changes between the content check and the atomic replacement.
    pub async fn edit_index(
        &self,
        repository: &GitRepository,
        request: &GitIndexEdit,
    ) -> GitResult<()> {
        let index = repository.git_dir().join("index");
        let mut lock = IndexLock::acquire(index.with_extension("lock"))?;
        let reviewed = self
            .index_diff(repository, &request.path, request.comparison)
            .await?;
        if reviewed.original != request.expected_original
            || reviewed.modified != request.expected_modified
        {
            return Err(GitError::IndexChanged);
        }
        let hunk = match request.selection {
            GitIndexSelection::Hunk { index } => Some(
                *reviewed
                    .document
                    .hunks()
                    .get(index)
                    .ok_or_else(|| invalid("hunk does not exist"))?,
            ),
            GitIndexSelection::Lines { start, end } => {
                if start == 0 || end < start {
                    return Err(invalid("invalid line selection"));
                }
                None
            }
        };
        let rows = reviewed.document.rows();
        let mut result = String::new();
        let mut changes = 0;
        let mut retained_changes = 0;
        for (row_index, row) in rows.iter().enumerate() {
            // Deleted rows are anchored to the next modified-side line, or the EOF line.
            let anchor = row.new_line_number().unwrap_or_else(|| {
                rows[row_index..]
                    .iter()
                    .find_map(|row| row.new_line_number())
                    .unwrap_or_else(|| {
                        rows[..row_index]
                            .iter()
                            .rev()
                            .find_map(|row| row.new_line_number())
                            .unwrap_or(1)
                    })
            });
            let selected = match request.selection {
                GitIndexSelection::Hunk { .. } => {
                    hunk.is_some_and(|hunk| (hunk.row_start()..hunk.row_end()).contains(&row_index))
                }
                GitIndexSelection::Lines { start, end } => (start..=end).contains(&anchor),
            };
            let changed = row.kind() != DiffRowKind::Context;
            if selected && changed {
                changes += 1;
            }
            if !selected && changed {
                retained_changes += 1;
            }
            let line = match request.comparison {
                GitChangeFileComparison::Unstaged => {
                    if selected {
                        row.new_line()
                    } else {
                        row.old()
                    }
                }
                GitChangeFileComparison::Staged => {
                    if selected {
                        row.old()
                    } else {
                        row.new_line()
                    }
                }
            };
            if let Some(line) = line {
                append_line(&mut result, line);
            }
        }
        if changes == 0 {
            return Err(invalid("selection contains no changes"));
        }
        let desired_missing = retained_changes == 0
            && match request.comparison {
                GitChangeFileComparison::Unstaged => reviewed.modified.is_none(),
                GitChangeFileComparison::Staged => reviewed.original.is_none(),
            };
        let temporary = tempfile::NamedTempFile::new_in(repository.git_dir())
            .map_err(|_| invalid("cannot prepare index"))?
            .into_temp_path();
        if index.exists() {
            std::fs::copy(&index, &temporary).map_err(|_| invalid("cannot copy index"))?;
        } else {
            std::fs::remove_file(&temporary).map_err(|_| invalid("cannot prepare empty index"))?;
            self.run_mutation_with_index(
                repository.worktree_root(),
                ["read-tree", "--empty"],
                &temporary,
            )
            .await?
            .require_success()?;
        }
        let mode = self.file_mode(repository, &request.path).await?;
        let mut arguments = vec![OsString::from("update-index")];
        if desired_missing {
            arguments.extend([
                OsString::from("--force-remove"),
                OsString::from("--"),
                request.path.as_os_str().to_owned(),
            ]);
        } else {
            let mut filter_path = OsString::from("--path=");
            filter_path.push(&request.path);
            let object = self
                .run_mutation_with_stdin(
                    repository.worktree_root(),
                    [
                        OsString::from("hash-object"),
                        "-w".into(),
                        filter_path,
                        "--stdin".into(),
                    ],
                    result.into_bytes(),
                )
                .await?
                .require_success()?;
            let object =
                String::from_utf8(object.stdout).map_err(|_| invalid("invalid object id"))?;
            arguments.extend([
                OsString::from("--add"),
                OsString::from("--cacheinfo"),
                mode.into(),
                object.trim().into(),
                request.path.as_os_str().to_owned(),
            ]);
        }
        self.run_mutation_with_index(repository.worktree_root(), arguments, &temporary)
            .await?
            .require_success()?;
        let current = self
            .index_diff(repository, &request.path, request.comparison)
            .await?;
        if current.original != reviewed.original || current.modified != reviewed.modified {
            return Err(GitError::IndexChanged);
        }
        std::fs::copy(&temporary, &lock.path).map_err(|_| invalid("cannot write index lock"))?;
        lock.publish(&index)?;
        Ok(())
    }

    async fn file_mode(&self, repository: &GitRepository, path: &Path) -> GitResult<String> {
        let output = self
            .run_query(
                repository.worktree_root(),
                [
                    OsString::from("ls-files"),
                    "--stage".into(),
                    "-z".into(),
                    "--".into(),
                    path.as_os_str().to_owned(),
                ],
            )
            .await?
            .require_success()?;
        if let Some(mode) = std::str::from_utf8(&output.stdout)
            .map_err(|_| invalid("invalid index record"))?
            .split_whitespace()
            .next()
        {
            if !matches!(mode, "100644" | "100755") {
                return Err(invalid("partial staging requires a regular file"));
            }
            return Ok(mode.to_owned());
        }
        // Before the first commit there is no HEAD tree. Otherwise pin the actual commit
        // while looking up a deleted file's mode, rather than rereading a moving HEAD.
        match self.snapshot(repository).await?.head() {
            GitHead::Unborn { .. } => {}
            GitHead::Branch { object_id, .. } | GitHead::Detached { object_id } => {
                let head = self
                    .run_query(
                        repository.worktree_root(),
                        [
                            OsString::from("ls-tree"),
                            object_id.into(),
                            "--".into(),
                            path.as_os_str().to_owned(),
                        ],
                    )
                    .await?;
                if let Some(mode) = std::str::from_utf8(&head.stdout)
                    .map_err(|_| invalid("invalid tree record"))?
                    .split_whitespace()
                    .next()
                {
                    if !matches!(mode, "100644" | "100755") {
                        return Err(invalid("partial staging requires a regular file"));
                    }
                    return Ok(mode.to_owned());
                }
            }
        }
        let metadata = std::fs::symlink_metadata(repository.worktree_root().join(path))
            .map_err(|_| invalid("file disappeared"))?;
        if !metadata.is_file() {
            return Err(invalid("partial staging requires a regular file"));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            Ok(if metadata.permissions().mode() & 0o111 != 0 {
                "100755"
            } else {
                "100644"
            }
            .into())
        }
        #[cfg(not(unix))]
        {
            Ok("100644".into())
        }
    }
}

struct IndexLock {
    path: PathBuf,
    state: IndexLockState,
}

enum IndexLockState {
    Held,
    Published,
}
impl IndexLock {
    fn acquire(path: PathBuf) -> GitResult<Self> {
        std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| invalid("index is locked by another Git operation"))?;
        Ok(Self {
            path,
            state: IndexLockState::Held,
        })
    }
}
impl IndexLock {
    fn publish(&mut self, index: &Path) -> GitResult<()> {
        std::fs::rename(&self.path, index).map_err(|_| invalid("cannot replace index"))?;
        // After rename, the lock path may immediately belong to another Git process.
        self.state = IndexLockState::Published;
        Ok(())
    }
}
impl Drop for IndexLock {
    fn drop(&mut self) {
        if matches!(self.state, IndexLockState::Held) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}
fn text(bytes: Option<&[u8]>) -> GitResult<Option<String>> {
    bytes
        .map(|bytes| {
            if bytes.contains(&0) {
                return Err(invalid("binary files cannot be partially staged"));
            }
            std::str::from_utf8(bytes)
                .map(str::to_owned)
                .map_err(|_| invalid("partial staging requires UTF-8 text"))
        })
        .transpose()
}
fn append_line(text: &mut String, line: &DiffLine) {
    text.push_str(line.text());
    text.push_str(match line.ending() {
        LineEnding::Lf => "\n",
        LineEnding::CrLf => "\r\n",
        LineEnding::Cr => "\r",
        LineEnding::None => "",
    });
}
fn invalid(requirement: &'static str) -> GitError {
    GitError::InvalidConfiguration {
        field: "index selection",
        requirement,
    }
}

#[cfg(test)]
#[path = "index_edit_tests.rs"]
mod tests;

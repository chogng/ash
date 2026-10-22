use sha2::Digest;
use std::collections::VecDeque;
use std::ffi::OsString;
use std::io::Read;
use std::path::Path;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;
use tokio::sync::OnceCell;

use crate::GitChangeStatus;
use crate::GitClient;
use crate::GitError;
use crate::GitRepository;
use crate::GitRepositoryChange;
use crate::GitResult;
use crate::GitTreeId;

/// Repository revision from which a host wants to read one file.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitFileRevision {
    /// The file recorded by the current `HEAD` commit.
    Head,
    /// The file currently recorded in the index.
    Index,
    /// Common ancestor recorded in stage 1 of an unmerged index entry.
    MergeBase,
    /// Our version recorded in stage 2 of an unmerged index entry.
    MergeCurrent,
    /// Their version recorded in stage 3 of an unmerged index entry.
    MergeIncoming,
}

// Derived immutable bytes, never a second working copy. Versions hash the complete
// index (including split-index links), so external writes and skipHash indexes do
// not depend on watcher delivery or coarse filesystem timestamps.
#[derive(Default)]
pub(crate) struct ContentCache {
    entries: VecDeque<(IndexContentKey, Arc<OnceCell<Option<Vec<u8>>>>)>,
}

impl std::fmt::Debug for ContentCache {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ContentCache")
            .field("entries", &self.entries.len())
            .finish()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct IndexVersion {
    digest: [u8; 32],
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    #[cfg(unix)]
    identity: (u64, u64, i64, i64),
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct IndexContentKey {
    git_dir: PathBuf,
    path: PathBuf,
    version: IndexVersion,
    maximum_bytes: usize,
}

const CONTENT_CACHE_ENTRIES: usize = 16;
const CONTENT_CACHE_FILE_BYTES: usize = 512 * 1024;
const VERSIONED_INDEX_BYTES: u64 = 8 * 1024 * 1024;

pub(crate) fn index_version(repository: &GitRepository) -> Option<IndexVersion> {
    // `git show` honors replacement objects. Do not share a plain index baseline
    // when loose/custom replacement refs can change its bytes independently.
    if std::env::var_os("GIT_REPLACE_REF_BASE").is_some()
        || repository.common_dir().join("refs/replace").exists()
    {
        return None;
    }
    let mut file = std::fs::File::open(repository.git_dir().join("index")).ok()?;
    let before = file.metadata().ok()?;
    if !before.is_file() || before.len() > VERSIONED_INDEX_BYTES {
        return None;
    }
    let mut bytes = Vec::with_capacity(before.len() as usize);
    file.by_ref()
        .take(VERSIONED_INDEX_BYTES + 1)
        .read_to_end(&mut bytes)
        .ok()?;
    let after = file.metadata().ok()?;
    if bytes.len() as u64 != before.len()
        || before.len() != after.len()
        || before.modified().ok() != after.modified().ok()
    {
        return None;
    }
    #[cfg(unix)]
    let identity = {
        use std::os::unix::fs::MetadataExt;
        let identity = |m: &std::fs::Metadata| (m.dev(), m.ino(), m.ctime(), m.ctime_nsec());
        if identity(&before) != identity(&after) {
            return None;
        }
        identity(&after)
    };
    let mut digest = sha2::Sha256::new();
    digest.update(bytes);
    // Packed replacement refs need the same invalidation as the index. A missing
    // packed-refs file is normal; unreadable/oversized metadata bypasses sharing.
    match std::fs::File::open(repository.common_dir().join("packed-refs")) {
        Ok(file) => {
            let mut packed = Vec::new();
            file.take(VERSIONED_INDEX_BYTES + 1)
                .read_to_end(&mut packed)
                .ok()?;
            if packed.len() as u64 > VERSIONED_INDEX_BYTES {
                return None;
            }
            if packed
                .windows(b"refs/replace/".len())
                .any(|part| part == b"refs/replace/")
            {
                return None;
            }
            digest.update(packed);
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => return None,
    }
    Some(IndexVersion {
        digest: digest.finalize().into(),
        modified: after.modified().ok(),
        created: after.created().ok(),
        #[cfg(unix)]
        identity,
    })
}

/// Selects the canonical two-sided comparison for one current repository change.
#[derive(Clone, Copy, Debug, Eq, PartialEq, serde::Serialize, serde::Deserialize)]
pub enum GitChangeFileComparison {
    /// Compares the current `HEAD` commit with the index.
    Staged,
    /// Compares the index with the working tree.
    Unstaged,
}

/// Bounded before/after bytes used to open one current repository change.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitChangeFile {
    original: Option<Vec<u8>>,
    modified: Option<Vec<u8>>,
}

/// The three index stages and editable worktree result of one conflict.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitConflictFile {
    stage_ids: [Option<String>; 3],
    result_object_id: Option<String>,
    base: Option<Vec<u8>>,
    current: Option<Vec<u8>>,
    incoming: Option<Vec<u8>>,
    result: Option<Vec<u8>>,
}

/// Explicit index-stage choice for a whole-file conflict resolution.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitConflictChoice {
    Current,
    Incoming,
    Delete,
}

impl GitConflictFile {
    pub fn stage_ids(&self) -> &[Option<String>; 3] {
        &self.stage_ids
    }
    pub fn result_object_id(&self) -> Option<&str> {
        self.result_object_id.as_deref()
    }
    pub fn base(&self) -> Option<&[u8]> {
        self.base.as_deref()
    }
    pub fn current(&self) -> Option<&[u8]> {
        self.current.as_deref()
    }
    pub fn incoming(&self) -> Option<&[u8]> {
        self.incoming.as_deref()
    }
    pub fn result(&self) -> Option<&[u8]> {
        self.result.as_deref()
    }
}

impl GitChangeFile {
    pub fn original(&self) -> Option<&[u8]> {
        self.original.as_deref()
    }

    pub fn modified(&self) -> Option<&[u8]> {
        self.modified.as_deref()
    }
}

impl GitClient {
    /// Reads one repository-relative file at a named Git revision.
    ///
    /// Missing paths, including every path in an unborn `HEAD`, return `Ok(None)`. Hosts use this
    /// distinction to build added and deleted file diffs without parsing Git diagnostics.
    pub async fn read_file_at_revision(
        &self,
        repository: &GitRepository,
        path: &Path,
        revision: GitFileRevision,
        maximum_bytes: usize,
    ) -> GitResult<Option<Vec<u8>>> {
        if revision == GitFileRevision::Index && maximum_bytes > 0 {
            return self
                .read_versioned_index_content(repository, path, maximum_bytes)
                .await;
        }
        let object_prefix = match revision {
            GitFileRevision::Head => OsString::from("HEAD:"),
            GitFileRevision::Index => OsString::from(":"),
            GitFileRevision::MergeBase => OsString::from(":1:"),
            GitFileRevision::MergeCurrent => OsString::from(":2:"),
            GitFileRevision::MergeIncoming => OsString::from(":3:"),
        };
        self.read_content_object(repository, path, object_prefix, maximum_bytes)
            .await
    }

    async fn read_versioned_index_content(
        &self,
        repository: &GitRepository,
        path: &Path,
        maximum_bytes: usize,
    ) -> GitResult<Option<Vec<u8>>> {
        validate_relative_path(path)?;
        for _ in 0..2 {
            let Some(version) = index_version(repository) else {
                break;
            };
            let key = IndexContentKey {
                git_dir: repository.git_dir().to_owned(),
                path: path.to_owned(),
                version,
                maximum_bytes: maximum_bytes.min(self.limits().max_output_bytes()),
            };
            let slot = {
                let mut cache = self
                    .content_cache
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let slot = cache
                    .entries
                    .iter()
                    .position(|(existing, _)| existing == &key)
                    .and_then(|i| cache.entries.remove(i))
                    .map(|(_, slot)| slot)
                    .unwrap_or_else(|| Arc::new(OnceCell::new()));
                if cache.entries.len() == CONTENT_CACHE_ENTRIES {
                    cache.entries.pop_front();
                }
                cache.entries.push_back((key.clone(), Arc::clone(&slot)));
                slot
            };
            // Cancellation leaves an uninitialized cell, so the next waiter retries.
            // Errors are never retained; concurrent consumers share only a successful read.
            let result = slot
                .get_or_try_init(|| async {
                    // Explicit executables retain their own policy. The line-oriented
                    // batch protocol cannot encode a filename containing a newline.
                    if self.uses_system_executable()
                        && !path.as_os_str().as_encoded_bytes().contains(&b'\n')
                    {
                        match self
                            .read_index_batch(repository, path, key.version.clone(), maximum_bytes)
                            .await
                        {
                            Err(GitError::InvalidOutput { .. }) => {}
                            result => return result,
                        }
                    }
                    self.read_content_object(repository, path, OsString::from(":"), maximum_bytes)
                        .await
                })
                .await;
            let unchanged = index_version(repository).as_ref() == Some(&key.version);
            let reusable = unchanged
                && result.as_ref().is_ok_and(|content| {
                    content
                        .as_ref()
                        .is_none_or(|bytes| bytes.len() <= CONTENT_CACHE_FILE_BYTES)
                });
            if !reusable {
                let mut cache = self
                    .content_cache
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                cache
                    .entries
                    .retain(|(_, cached)| !Arc::ptr_eq(cached, &slot));
            }
            if !unchanged {
                continue;
            }
            return result.cloned();
        }
        // Very large/missing indexes and rapid external writers preserve the uncached
        // Git path. No stale cached result is used to make a racing request succeed.
        self.read_content_object(repository, path, OsString::from(":"), maximum_bytes)
            .await
    }

    /// Reads one path from an exact immutable tree object.
    pub async fn read_file_at_tree(
        &self,
        repository: &GitRepository,
        tree: &GitTreeId,
        path: &Path,
        maximum_bytes: usize,
    ) -> GitResult<Option<Vec<u8>>> {
        let mut object_prefix = OsString::from(tree.as_str());
        object_prefix.push(":");
        self.read_content_object(repository, path, object_prefix, maximum_bytes)
            .await
    }

    pub(crate) async fn read_content_object(
        &self,
        repository: &GitRepository,
        path: &Path,
        mut object: OsString,
        maximum_bytes: usize,
    ) -> GitResult<Option<Vec<u8>>> {
        validate_relative_path(path)?;
        if maximum_bytes == 0 {
            return Err(GitError::InvalidConfiguration {
                field: "maximum_bytes",
                requirement: "must be non-zero",
            });
        }
        object.push(path);
        let output = self
            .run_query_unchecked(
                repository.worktree_root(),
                [
                    OsString::from("show"),
                    OsString::from("--no-textconv"),
                    object,
                ],
            )
            .await?;
        if !output.status.success() {
            return if missing_object(&output.stderr) {
                Ok(None)
            } else {
                Err(GitError::CommandFailed {
                    command: output.command,
                    exit_code: output.status.code(),
                    stderr: String::from_utf8_lossy(&output.stderr).trim().to_string(),
                })
            };
        }
        if output.stdout.len() > maximum_bytes {
            return Err(GitError::OutputLimitExceeded {
                command: output.command,
                stream: "stdout",
                limit_bytes: maximum_bytes,
            });
        }
        Ok(Some(output.stdout))
    }

    // HEAD batches belong to one snapshot operation so mutable revision names
    // resolve afresh. Only index reads have a verified generation for reuse.
    pub(super) async fn read_text_diff_bases(
        &self,
        repository: &GitRepository,
        paths: &[&Path],
        maximum_bytes: usize,
    ) -> Vec<GitResult<Option<Vec<u8>>>> {
        if paths.len() > 1
            && paths
                .iter()
                .all(|path| path.to_str().is_some_and(|path| !path.contains('\n')))
        {
            if let Ok(contents) = self
                .read_text_diff_batch(repository, paths, maximum_bytes)
                .await
            {
                return contents;
            }
        }
        // Preserve per-path failure/partial semantics when a batch exceeds its
        // output budget, Git rejects it, or a name cannot use LF framing.
        let mut contents = Vec::with_capacity(paths.len());
        for path in paths {
            contents.push(
                self.read_file_at_revision(repository, path, GitFileRevision::Head, maximum_bytes)
                    .await,
            );
        }
        contents
    }

    async fn read_text_diff_batch(
        &self,
        repository: &GitRepository,
        paths: &[&Path],
        maximum_bytes: usize,
    ) -> GitResult<Vec<GitResult<Option<Vec<u8>>>>> {
        let mut input = Vec::new();
        for path in paths {
            input.extend_from_slice(b"HEAD:");
            input.extend_from_slice(path.as_os_str().as_encoded_bytes());
            input.push(b'\n');
        }
        let metadata = self
            .run_query_with_stdin(
                repository.worktree_root(),
                ["cat-file", "--batch-check"],
                input,
            )
            .await?
            .require_success()?;
        let objects =
            read_batch_metadata(&metadata.stdout, paths, maximum_bytes, &metadata.command)?;
        let mut results = (0..paths.len()).map(|_| None).collect::<Vec<_>>();
        let mut available = Vec::new();
        for (index, object) in objects.iter().enumerate() {
            match object {
                BatchObject::Missing => results[index] = Some(Ok(None)),
                BatchObject::TooLarge => {
                    results[index] = Some(Err(GitError::OutputLimitExceeded {
                        command: metadata.command.clone(),
                        stream: "stdout",
                        limit_bytes: maximum_bytes,
                    }))
                }
                BatchObject::Blob { .. } => available.push(index),
            }
        }
        let mut cursor = 0;
        while cursor < available.len() {
            let start = cursor;
            let mut bytes = 0usize;
            let mut input = Vec::new();
            while let Some(&index) = available.get(cursor) {
                let BatchObject::Blob { object_id, size } = &objects[index] else {
                    unreachable!("only blobs are selected")
                };
                let cost = size.saturating_add(128);
                if bytes.saturating_add(cost) > self.limits().max_output_bytes() {
                    break;
                }
                bytes += cost;
                input.extend_from_slice(object_id.as_bytes());
                input.push(b'\n');
                cursor += 1;
            }
            if start == cursor {
                // A blob can fit raw `show` output but exceed batch framing's budget.
                let index = available[cursor];
                cursor += 1;
                results[index] = Some(
                    self.read_file_at_revision(
                        repository,
                        paths[index],
                        GitFileRevision::Head,
                        maximum_bytes,
                    )
                    .await,
                );
                continue;
            }
            let selected = &available[start..cursor];
            let selected_paths = selected
                .iter()
                .map(|index| paths[*index])
                .collect::<Vec<_>>();
            let output = self
                .run_query_with_stdin(repository.worktree_root(), ["cat-file", "--batch"], input)
                .await?
                .require_success()?;
            let contents = read_content_batch(
                &output.stdout,
                &selected_paths,
                maximum_bytes,
                &output.command,
            )?;
            for (&index, content) in selected.iter().zip(contents) {
                results[index] = Some(content);
            }
        }
        Ok(results
            .into_iter()
            .map(|value| value.expect("every selected path has a batch result"))
            .collect())
    }

    /// Reads the exact sides represented by a staged or unstaged status resource.
    pub async fn change_file(
        &self,
        repository: &GitRepository,
        change: &GitRepositoryChange,
        comparison: GitChangeFileComparison,
        maximum_bytes: usize,
    ) -> GitResult<GitChangeFile> {
        self.change_file_at_paths(
            repository,
            comparison_original_path(change, comparison),
            change.path(),
            comparison,
            maximum_bytes,
        )
        .await
    }

    /// Reads current comparison contents at paths resolved by the caller's status owner.
    pub async fn change_file_at_paths(
        &self,
        repository: &GitRepository,
        original_path: &Path,
        modified_path: &Path,
        comparison: GitChangeFileComparison,
        maximum_bytes: usize,
    ) -> GitResult<GitChangeFile> {
        if maximum_bytes == 0 {
            return Err(GitError::InvalidConfiguration {
                field: "maximum_bytes",
                requirement: "must be non-zero",
            });
        }
        let original = self
            .read_file_at_revision(
                repository,
                original_path,
                match comparison {
                    GitChangeFileComparison::Staged => GitFileRevision::Head,
                    GitChangeFileComparison::Unstaged => GitFileRevision::Index,
                },
                maximum_bytes,
            )
            .await?;
        let modified = match comparison {
            GitChangeFileComparison::Staged => {
                self.read_file_at_revision(
                    repository,
                    modified_path,
                    GitFileRevision::Index,
                    maximum_bytes,
                )
                .await?
            }
            GitChangeFileComparison::Unstaged => {
                read_worktree_file(repository, modified_path, maximum_bytes)?
            }
        };
        Ok(GitChangeFile { original, modified })
    }

    /// Reads the index stages and working file for a change that remains unmerged.
    pub async fn conflict_file(
        &self,
        repository: &GitRepository,
        change: &GitRepositoryChange,
        maximum_bytes: usize,
    ) -> GitResult<GitConflictFile> {
        if !change.is_conflicted() {
            return Err(GitError::runtime(
                "read Git conflict",
                "path is not conflicted",
            ));
        }
        let path = change.path();
        let stage_ids = self.conflict_stage_ids(repository, path).await?;
        if stage_ids[1].is_none() && stage_ids[2].is_none() {
            return Err(GitError::runtime(
                "read Git conflict",
                "index stages changed",
            ));
        }
        let base = self
            .read_file_at_revision(repository, path, GitFileRevision::MergeBase, maximum_bytes)
            .await?;
        let current = self
            .read_file_at_revision(
                repository,
                path,
                GitFileRevision::MergeCurrent,
                maximum_bytes,
            )
            .await?;
        let incoming = self
            .read_file_at_revision(
                repository,
                path,
                GitFileRevision::MergeIncoming,
                maximum_bytes,
            )
            .await?;
        if stage_ids[0].is_some() != base.is_some()
            || stage_ids[1].is_some() != current.is_some()
            || stage_ids[2].is_some() != incoming.is_some()
        {
            return Err(GitError::runtime(
                "read Git conflict",
                "index stages changed",
            ));
        }
        let result = read_worktree_file(repository, path, maximum_bytes)?;
        let result_object_id = if result.is_some() {
            Some(self.worktree_object_id(repository, path).await?)
        } else {
            None
        };
        Ok(GitConflictFile {
            stage_ids,
            result_object_id,
            base,
            current,
            incoming,
            result,
        })
    }

    async fn worktree_object_id(
        &self,
        repository: &GitRepository,
        path: &Path,
    ) -> GitResult<String> {
        validate_relative_path(path)?;
        let output = self
            .run_query_unchecked(
                repository.worktree_root(),
                [
                    OsString::from("hash-object"),
                    OsString::from("--no-filters"),
                    OsString::from("--"),
                    path.as_os_str().to_owned(),
                ],
            )
            .await?
            .require_success()?;
        let object_id = std::str::from_utf8(&output.stdout)
            .map_err(|_| GitError::invalid_output("git hash-object", "invalid object id"))?
            .trim();
        if !matches!(object_id.len(), 40 | 64)
            || !object_id.bytes().all(|byte| byte.is_ascii_hexdigit())
        {
            return Err(GitError::invalid_output(
                "git hash-object",
                "invalid object id",
            ));
        }
        Ok(object_id.to_owned())
    }

    async fn conflict_stage_ids(
        &self,
        repository: &GitRepository,
        path: &Path,
    ) -> GitResult<[Option<String>; 3]> {
        validate_relative_path(path)?;
        let output = self
            .run_query_unchecked(
                repository.worktree_root(),
                [
                    OsString::from("--literal-pathspecs"),
                    OsString::from("ls-files"),
                    OsString::from("--stage"),
                    OsString::from("-z"),
                    OsString::from("--"),
                    path.as_os_str().to_owned(),
                ],
            )
            .await?
            .require_success()?;
        let mut stages = [None, None, None];
        for entry in output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|entry| !entry.is_empty())
        {
            let Some(tab) = entry.iter().position(|byte| *byte == b'\t') else {
                return Err(GitError::invalid_output(
                    "git ls-files --stage",
                    "missing stage path",
                ));
            };
            if crate::path::path_from_git_bytes(&entry[tab + 1..], "git ls-files --stage")? != path
            {
                continue;
            }
            let metadata = std::str::from_utf8(&entry[..tab]).map_err(|_| {
                GitError::invalid_output("git ls-files --stage", "invalid stage metadata")
            })?;
            let mut fields = metadata.split(' ');
            let _mode = fields.next();
            let object_id = fields.next().ok_or_else(|| {
                GitError::invalid_output("git ls-files --stage", "missing stage object")
            })?;
            let stage = fields.next().ok_or_else(|| {
                GitError::invalid_output("git ls-files --stage", "missing stage number")
            })?;
            let index = match stage {
                "1" => 0,
                "2" => 1,
                "3" => 2,
                _ => continue,
            };
            if !matches!(object_id.len(), 40 | 64)
                || !object_id.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Err(GitError::invalid_output(
                    "git ls-files --stage",
                    "invalid stage object",
                ));
            }
            stages[index] = Some(object_id.to_owned());
        }
        Ok(stages)
    }

    /// Applies one validated conflict result while the repository operation lock is held.
    pub async fn complete_conflict(
        &self,
        repository: &GitRepository,
        path: &Path,
    ) -> GitResult<()> {
        validate_relative_path(path)?;
        self.run_mutation(
            repository.worktree_root(),
            [
                OsString::from("--literal-pathspecs"),
                OsString::from("add"),
                OsString::from("--"),
                path.as_os_str().to_owned(),
            ],
        )
        .await?
        .require_success()?;
        Ok(())
    }

    /// Writes the selected index stage to the worktree, or keeps its deletion, then stages it.
    pub async fn choose_conflict_side(
        &self,
        repository: &GitRepository,
        path: &Path,
        choice: GitConflictChoice,
    ) -> GitResult<()> {
        validate_relative_path(path)?;
        if choice != GitConflictChoice::Delete {
            self.run_mutation(
                repository.worktree_root(),
                [
                    OsString::from("--literal-pathspecs"),
                    OsString::from("checkout"),
                    OsString::from(if choice == GitConflictChoice::Current {
                        "--ours"
                    } else {
                        "--theirs"
                    }),
                    OsString::from("--"),
                    path.as_os_str().to_owned(),
                ],
            )
            .await?
            .require_success()?;
            self.complete_conflict(repository, path).await
        } else {
            self.run_mutation(
                repository.worktree_root(),
                [
                    OsString::from("--literal-pathspecs"),
                    OsString::from("rm"),
                    OsString::from("-f"),
                    OsString::from("--"),
                    path.as_os_str().to_owned(),
                ],
            )
            .await?
            .require_success()?;
            Ok(())
        }
    }
}

fn comparison_original_path(
    change: &GitRepositoryChange,
    comparison: GitChangeFileComparison,
) -> &Path {
    let status = match comparison {
        GitChangeFileComparison::Staged => change.index_status(),
        GitChangeFileComparison::Unstaged => change.worktree_status(),
    };
    if matches!(status, GitChangeStatus::Renamed | GitChangeStatus::Copied) {
        change.original_path().unwrap_or_else(|| change.path())
    } else {
        change.path()
    }
}

fn read_worktree_file(
    repository: &GitRepository,
    path: &Path,
    maximum_bytes: usize,
) -> GitResult<Option<Vec<u8>>> {
    validate_relative_path(path)?;
    let absolute_path = repository.worktree_root().join(path);
    let metadata = match absolute_path.symlink_metadata() {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(GitError::io("inspect Git working-tree file", error)),
    };
    if metadata.file_type().is_symlink() || !metadata.is_file() {
        return Err(GitError::runtime(
            "read Git working-tree file",
            "path is not a regular file",
        ));
    }
    if metadata.len() > maximum_bytes as u64 {
        return Err(GitError::OutputLimitExceeded {
            command: format!("read working-tree file {}", path.to_string_lossy()),
            stream: "file",
            limit_bytes: maximum_bytes,
        });
    }
    std::fs::read(absolute_path)
        .map(Some)
        .map_err(|error| GitError::io("read Git working-tree file", error))
}

fn validate_relative_path(path: &Path) -> GitResult<()> {
    if path.as_os_str().is_empty()
        || path.is_absolute()
        || path
            .components()
            .any(|component| matches!(component, std::path::Component::ParentDir))
    {
        return Err(GitError::runtime(
            "validate Git file path",
            "path must be a non-empty repository-relative path",
        ));
    }
    Ok(())
}

fn missing_object(stderr: &[u8]) -> bool {
    let stderr = String::from_utf8_lossy(stderr);
    stderr.contains("does not exist in")
        || stderr.contains("does not exist (neither on disk nor in the index)")
        || stderr.contains("exists on disk, but not in")
        || stderr.contains("invalid object name")
        || stderr.contains("unknown revision")
        || stderr.contains("bad revision")
        || stderr.contains("Path '")
        || stderr.contains("but not at stage")
        || stderr.contains("not in the index")
}

#[cfg(test)]
#[path = "content_tests.rs"]
mod tests;

fn read_content_batch(
    mut output: &[u8],
    paths: &[&Path],
    maximum_bytes: usize,
    command: &str,
) -> GitResult<Vec<GitResult<Option<Vec<u8>>>>> {
    let mut contents = Vec::with_capacity(paths.len());
    for path in paths {
        let missing = format!("HEAD:{} missing\n", path.display());
        if output.starts_with(missing.as_bytes()) {
            output = &output[missing.len()..];
            contents.push(Ok(None));
            continue;
        }
        let end = output
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or_else(|| GitError::invalid_output(command, "missing batch object header"))?;
        let (_, length) = read_blob_header(&output[..end], command)?;
        output = &output[end + 1..];
        if output.get(length) != Some(&b'\n') {
            return Err(GitError::invalid_output(command, "truncated batch blob"));
        }
        contents.push(if length > maximum_bytes {
            Err(GitError::OutputLimitExceeded {
                command: command.into(),
                stream: "stdout",
                limit_bytes: maximum_bytes,
            })
        } else {
            Ok(Some(output[..length].to_vec()))
        });
        output = &output[length + 1..];
    }
    if !output.is_empty() {
        return Err(GitError::invalid_output(
            command,
            "unexpected batch response tail",
        ));
    }
    Ok(contents)
}

enum BatchObject {
    Missing,
    TooLarge,
    Blob { object_id: String, size: usize },
}

fn read_batch_metadata(
    mut output: &[u8],
    paths: &[&Path],
    maximum_bytes: usize,
    command: &str,
) -> GitResult<Vec<BatchObject>> {
    let mut objects = Vec::with_capacity(paths.len());
    for path in paths {
        let missing = format!("HEAD:{} missing\n", path.display());
        if output.starts_with(missing.as_bytes()) {
            output = &output[missing.len()..];
            objects.push(BatchObject::Missing);
            continue;
        }
        let end = output
            .iter()
            .position(|byte| *byte == b'\n')
            .ok_or_else(|| GitError::invalid_output(command, "missing batch metadata header"))?;
        let (object_id, size) = read_blob_header(&output[..end], command)?;
        objects.push(if size > maximum_bytes {
            BatchObject::TooLarge
        } else {
            BatchObject::Blob { object_id, size }
        });
        output = &output[end + 1..];
    }
    if !output.is_empty() {
        return Err(GitError::invalid_output(
            command,
            "unexpected batch metadata tail",
        ));
    }
    Ok(objects)
}

fn read_blob_header(header: &[u8], command: &str) -> GitResult<(String, usize)> {
    let header = std::str::from_utf8(header)
        .map_err(|_| GitError::invalid_output(command, "batch object header is not UTF-8"))?;
    let mut fields = header.split(' ');
    let object_id = fields.next().unwrap_or_default();
    let kind = fields.next();
    let length = fields.next().and_then(|size| size.parse::<usize>().ok());
    if !matches!(object_id.len(), 40 | 64)
        || !object_id.bytes().all(|byte| byte.is_ascii_hexdigit())
        || kind != Some("blob")
        || length.is_none()
        || fields.next().is_some()
    {
        return Err(GitError::invalid_output(
            command,
            "invalid batch blob header",
        ));
    }
    Ok((object_id.into(), length.unwrap()))
}
